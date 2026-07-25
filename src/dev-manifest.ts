import path from 'path';
import type { DevEnvironment, EnvironmentModuleNode, ViteDevServer } from 'vite';

/**
 * Dev-mode asset resolution: the `virtual:solid-manifest` module exports a
 * resolver function in dev (instead of the static object a build produces),
 * and the runtime installs it as `context.resolveAssets` verbatim. When
 * server-side `lazy()` resolves a module key, the resolver walks the SSR
 * environment's live module graph collecting transitively imported CSS and
 * answers with inline-style descriptors — SSR'd `<style data-vite-dev-id>`
 * tags that Vite's HMR client adopts on startup, so dev CSS is styled from
 * the first streamed byte without fighting Vite's own style injection.
 *
 * The walk design follows SolidStart's collect-styles (by @katywings): crawl
 * `transformResult.deps` on the SSR environment (the client environment's
 * transform results don't list CSS deps), skipping dynamic imports since
 * dynamically imported modules register their own styles when they render.
 */

export type DevStyleDescriptor = { id: string; content: string; attrs?: Record<string, string> };
export type DevStyleSource = { id: string; url: string };

export type ResolvedAssets = {
  js: string[];
  css: (string | DevStyleDescriptor)[];
};

export type DevAssetResolver = {
  resolve: (key: string) => Promise<ResolvedAssets | null>;
  /**
   * Synchronous fast path used by sync consumers (a lazy component's
   * `moduleUrl` getter for islands): the module's dev URL is knowable
   * without the async CSS graph walk.
   */
  resolveSync: (key: string) => ResolvedAssets;
};

// The resolver is created plugin-side (it closes over the dev server) but is
// called from the SSR module runner, which only shares `globalThis` with the
// plugin when it runs in-process (the default). The primary channel is a
// `Symbol.for`-keyed registry mapping project roots to resolvers; isolated
// runners (nitro's dev worker, workerd) won't find it and instead fall back
// to fetching the HTTP bridge endpoint below.
export const DEV_MANIFEST_REGISTRY_KEY = 'vite-plugin-solid:dev-manifest';

export function registerDevAssetResolver(root: string, resolver: DevAssetResolver): void {
  const key = Symbol.for(DEV_MANIFEST_REGISTRY_KEY);
  const registry: Record<string, DevAssetResolver> = ((globalThis as any)[key] ??= {});
  registry[root] = resolver;
}

/**
 * HTTP bridge endpoint for isolated SSR runners. Hosts that evaluate server
 * modules outside the Vite process (nitro's dev worker, workerd via
 * @cloudflare/vite-plugin) can't see the `globalThis` registry, so the dev
 * server itself serves asset resolution: `GET
 * /@vite-plugin-solid/dev-manifest?key=<module key>` answers with the
 * resolver's `ResolvedAssets` JSON (`null` when the key can't be resolved).
 * The dev flavor of `virtual:solid-manifest` falls back to fetching it when
 * the registry has no entry for the root — in-process consumers hit the
 * registry and never touch HTTP.
 */
export const DEV_MANIFEST_ENDPOINT = '/@vite-plugin-solid/dev-manifest';

export function installDevManifestBridge(server: ViteDevServer): void {
  // configureServer middlewares run ahead of Vite's internals, so `req.url`
  // may or may not still carry the configured `base` — accept both forms.
  const base = (server.config.base || '/').replace(/\/$/, '');
  const basedEndpoint = base + DEV_MANIFEST_ENDPOINT;
  server.middlewares.use(async (req, res, next) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== DEV_MANIFEST_ENDPOINT && url.pathname !== basedEndpoint) return next();

    const key = url.searchParams.get('key');
    if (!key) {
      res.statusCode = 400;
      return res.end('Missing asset key');
    }

    try {
      const registry: Record<string, DevAssetResolver> | undefined = (globalThis as any)[
        Symbol.for(DEV_MANIFEST_REGISTRY_KEY)
      ];
      const resolver = registry?.[server.config.root];
      if (!resolver) {
        // A silent null strips the module's client assets from the SSR'd
        // hydration asset map and hydration fails much later with a cryptic
        // client-side error — report the miss where it happens.
        console.error(
          `[vite-plugin-solid] The dev manifest registry has no resolver for root "${server.config.root}" ` +
            `(requested asset key "${key}"). The module's client assets cannot be resolved and hydration ` +
            'will fail for it. Typical causes: the dev server was not restarted after dependency changes, ' +
            'or the install is stale.',
        );
      }
      const assets = resolver ? await resolver.resolve(key) : null;
      if (resolver && assets == null) {
        console.error(
          `[vite-plugin-solid] Dev manifest resolver returned no assets for key "${key}" (root "${server.config.root}"). ` +
            "The module's hydration preload entry will be missing.",
        );
      }
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      return res.end(JSON.stringify(assets));
    } catch (error) {
      return next(error);
    }
  });
}

/**
 * The absolute URL isolated runners should fetch the bridge from, baked into
 * the dev flavor of `virtual:solid-manifest` when its code is generated.
 * Generation happens while serving an SSR request, so the server is already
 * listening and `resolvedUrls` carries the real origin (a config-time define
 * could only guess the port). Middleware-mode servers have no origin of
 * their own to advertise — returns null there, and the manifest module keeps
 * the js-only fallback (in-process registry hits are unaffected either way).
 */
export function devManifestBridgeUrl(server: ViteDevServer): string | null {
  const local = server.resolvedUrls?.local?.[0];
  let origin: string | null = null;
  if (local) {
    origin = new URL(local).origin;
  } else if (!server.config.server.middlewareMode) {
    const address = server.httpServer?.address();
    if (address && typeof address === 'object') {
      const https = !!server.config.server.https;
      origin = `${https ? 'https' : 'http'}://localhost:${address.port}`;
    }
  }
  if (!origin) return null;
  const base = (server.config.base || '/').replace(/\/$/, '');
  return origin + base + DEV_MANIFEST_ENDPOINT;
}

// https://github.com/vitejs/vite/blob/main/packages/vite/src/node/constants.ts
const cssFileRegExp = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)$/;
// Queried css imports (?url, ?inline, ?raw) are not ambient styles — the
// importer controls them — so they must not be SSR'd as style tags.
const nonAmbientQueryRegExp = /[?&](url|inline|raw)\b/;

const NULL_BYTE_PLACEHOLDER = '/@id/__x00__';

// Per Vite's convention virtual module ids are prefixed with `\0`, which
// cannot appear in an HTML attribute (the parser replaces it). Serialize the
// same placeholder form Vite's own URLs use. Adoption of virtual-module
// styles additionally needs `devStylePatch` (below) to run client-side;
// fs-backed CSS (the overwhelmingly common case) adopts without it.
function wrapId(id: string): string {
  return id.replace(/^\0/, NULL_BYTE_PLACEHOLDER);
}

/**
 * Inline dev script reconciling SSR'd style tags with Vite's HMR client.
 * Frameworks that server-render whole documents should inline this in dev,
 * in `<head>` before any module script. It does two things, via a
 * MutationObserver so styles appended by streamed boundaries are handled as
 * they arrive (Vite's client seeds its stylesheet registry from the DOM only
 * once, when its module evaluates):
 *
 * - Rewrites serialized virtual-module ids (`/@id/__x00__…`) back to Vite's
 *   null-byte form so seeding matches (a raw `\0` can't survive HTML).
 * - Dedupes twins: a style tag that streams in after Vite's client has
 *   seeded is missed by the scan, so the CSS module injects its own copy
 *   client-side. Whenever two style tags share a `data-vite-dev-id`, the
 *   SSR'd one (marked `data-asset`) is removed in favor of the Vite-owned
 *   one, which is the tag HMR updates.
 *
 * Observation is two-phase to stay cheap: a document-wide subtree observer
 * only for the streaming window (SSR tags can only arrive while the parser
 * is consuming the stream; DOMContentLoaded marks its end), then a
 * childList-only observer on `document.head` for the page lifetime — Vite
 * injects twins into the head during hydration, which continues past
 * DOMContentLoaded, and a non-subtree head observer never fires on app DOM
 * churn, only on head insertions.
 *
 * Descends from SolidStart's PatchVirtualDevStyles (by @katywings); this
 * belongs in Vite itself eventually.
 */
export const devStylePatch = `(function(){var P=${JSON.stringify(
  NULL_BYTE_PLACEHOLDER,
)};var handle=function(el){var v=el.getAttribute("data-vite-dev-id");if(!v)return;if(v.indexOf(P)===0){v="\\0"+v.slice(P.length);el.setAttribute("data-vite-dev-id",v)}var all=document.querySelectorAll("style[data-vite-dev-id]");for(var i=0;i<all.length;i++){var o=all[i];if(o!==el&&o.getAttribute("data-vite-dev-id")===v){var ssr=o.hasAttribute("data-asset")?o:el.hasAttribute("data-asset")?el:null;if(ssr)ssr.remove();break}}};var scan=function(n){if(n.nodeType!==1)return;if(n.tagName==="STYLE")handle(n);else if(n.querySelectorAll)n.querySelectorAll("style[data-vite-dev-id]").forEach(handle)};var onMuts=function(muts){for(var i=0;i<muts.length;i++)muts[i].addedNodes.forEach(scan)};var headPhase=function(){scan(document.documentElement);new MutationObserver(onMuts).observe(document.head,{childList:true})};scan(document.documentElement);if(document.readyState==="loading"){var mo=new MutationObserver(onMuts);mo.observe(document.documentElement,{childList:true,subtree:true});document.addEventListener("DOMContentLoaded",function(){mo.disconnect();headPhase()})}else headPhase()})();`;

async function getModuleNode(
  env: DevEnvironment,
  file: string,
): Promise<EnvironmentModuleNode | undefined> {
  try {
    let node = env.moduleGraph.getModuleById(file) ?? (await env.moduleGraph.getModuleByUrl(file));
    if (!node?.transformResult) {
      await env.transformRequest(node?.url ?? file);
      node = env.moduleGraph.getModuleById(file) ?? (await env.moduleGraph.getModuleByUrl(file));
    }
    return node;
  } catch {
    return;
  }
}

async function collectModuleDeps(
  env: DevEnvironment,
  file: string,
  deps: Set<EnvironmentModuleNode>,
  crawled: Set<string>,
  onFile?: (file: string) => void,
): Promise<void> {
  crawled.add(file);
  const node = await getModuleNode(env, file);
  if (!node?.id || deps.has(node)) return;
  deps.add(node);
  if (node.file && !node.id.includes('node_modules')) onFile?.(node.file);

  if (cssFileRegExp.test(node.url.split('?')[0]) || node.id.includes('node_modules')) return;

  if (!node.transformResult) {
    await env.transformRequest(node.url).catch(() => {});
  }
  const directDeps = node.transformResult?.deps;
  if (!directDeps) return;

  // transformResult.deps (unlike importedModules) separates static imports
  // from dynamicDeps — dynamic imports load their own styles when rendered.
  for (const dep of directDeps) {
    if (crawled.has(dep)) continue;
    await collectModuleDeps(env, dep, deps, crawled, onFile);
  }
}

function injectQuery(url: string, query: string): string {
  return url.includes('?') ? `${url}&${query}` : `${url}?${query}`;
}

/** Discovers ambient CSS in an entry graph without choosing how it is transported. */
export async function collectDevStyleSources(
  env: DevEnvironment,
  files: string[],
  onFile?: (file: string) => void,
): Promise<DevStyleSource[]> {
  const deps = new Set<EnvironmentModuleNode>();
  const crawled = new Set<string>();
  for (const file of files) {
    await collectModuleDeps(env, file, deps, crawled, onFile);
  }

  const css: DevStyleSource[] = [];
  const seen = new Set<string>();
  for (const node of deps) {
    if (!node.id) continue;
    const cleanUrl = node.url.split('?')[0];
    if (!cssFileRegExp.test(cleanUrl) || nonAmbientQueryRegExp.test(node.url)) continue;
    const id = wrapId(node.id);
    if (seen.has(id)) continue;
    seen.add(id);
    css.push({ id, url: node.url });
  }
  return css;
}

/**
 * Walks the SSR module graph from `files` (root-relative or absolute) and
 * returns inline-style descriptors for every transitively imported CSS
 * module — the same shape the dev asset resolver answers with for lazy
 * modules. Used by the turnkey SSR dev middleware to inline the root entry's
 * CSS into `<head>` so server-painted content is styled from the first byte
 * (no FOUC while waiting for Vite's client-side style injection).
 */
export async function collectDevStyles(
  server: ViteDevServer,
  files: string[],
): Promise<DevStyleDescriptor[]> {
  const ssrEnv = server.environments?.ssr;
  const clientEnv = server.environments?.client;
  if (!ssrEnv || !clientEnv) return [];

  const sources = await collectDevStyleSources(
    ssrEnv,
    files.map((file) => path.resolve(server.config.root, file)),
  );

  const css: DevStyleDescriptor[] = [];
  for (const source of sources) {
    // `?direct` yields the compiled stylesheet text (what Vite serves for
    // <link> requests) — through the client environment, whose css
    // pipeline matches what the browser will run for HMR updates.
    const result = await clientEnv
      .transformRequest(injectQuery(source.url, 'direct'))
      .catch(() => null);
    if (result?.code == null) continue;
    css.push({
      id: source.id,
      content: result.code,
      attrs: { 'data-vite-dev-id': source.id },
    });
  }
  return css;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Serializes a dev style descriptor to the exact tag shape the SSR runtime
 * emits for lazy-registered assets (`data-asset` marks the SSR'd copy so
 * `devStylePatch` knows which twin to drop when Vite's client injects its
 * own), so the dedup story is identical for entry styles and lazy styles.
 */
export function renderDevStyleTag(desc: DevStyleDescriptor): string {
  let attrs = '';
  for (const name in desc.attrs) {
    attrs += ` ${name}="${escapeAttr(String(desc.attrs![name]))}"`;
  }
  const content = desc.content.replace(/<\/(style)/gi, '<\\/$1');
  return `<style data-asset="${escapeAttr(desc.id)}"${attrs}>${content}</style>`;
}

export function createDevAssetResolver(server: ViteDevServer): DevAssetResolver {
  const resolve = async function resolveDevAssets(key: string): Promise<ResolvedAssets | null> {
    // The module's dev URL doubles as its client entry: modulepreload hint
    // and hydration module-map value.
    const js = ['/' + key];
    const css = await collectDevStyles(server, [key]);
    return { js, css };
  };
  return {
    resolve,
    resolveSync: (key: string) => ({ js: ['/' + key], css: [] }),
  };
}
