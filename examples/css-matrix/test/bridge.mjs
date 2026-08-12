// Dev-manifest bridge test: the plugin's HTTP fallback for isolated SSR
// runners (nitro's dev worker, workerd) that can't see the process-global
// resolver registry. Boots a listening dev server over the css-matrix app
// and asserts, in one process:
//   - protocol: GET /@solidjs/vite-plugin/dev-manifest?key=<module key>
//     answers ResolvedAssets JSON ({ js, css }) with the module's dev URL
//     and its transitively imported CSS; a missing key is a 400,
//   - serve-side hardening: a registry miss logs a loud [@solidjs/vite-plugin]
//     error and answers null (the runtime's no-assets warning stays the
//     final catch-all),
//   - fallback consumer: with the registry entry removed, the dev flavor of
//     virtual:solid-manifest evaluates to a bridge resolver that fetches
//     the endpoint (simulating an isolated runner, where the module is
//     evaluated without the shared global) — full assets round-trip, and
//     once a key's assets are known both resolve and resolveSync answer
//     synchronously from the cache (the render-pass convergence contract:
//     a fresh pending promise per retry suspends nested lazy SSR forever),
//   - fetch-side hardening: a non-OK bridge response logs and resolves
//     null; so does a network failure — and neither poisons the cache
//     (the key resolves fully once the bridge is reachable again),
//   - short-circuit: with the registry intact the module exports the
//     in-process resolver itself — no HTTP involved (fetch disabled hard).
//
// Requires the plugin built (pnpm build at the repo root). No browser.
// Usage: node test/bridge.mjs

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REGISTRY_KEY = Symbol.for('@solidjs/vite-plugin:dev-manifest');
const ENDPOINT = '/@solidjs/vite-plugin/dev-manifest';
const LAZY_KEY = 'src/routes/Lazy.tsx';
// Distinctive rule from src/routes/lazy.css.
const LAZY_CSS_COLOR = 'rgb(70, 80, 90)';
// A second module key the bridge cache has not seen when the fetch-side
// hardening runs (cached keys answer without touching fetch, by design).
const GLOB_KEY = 'src/routes/LazyGlob.tsx';
// Distinctive rule from src/routes/lazyGlob.css.
const GLOB_CSS_COLOR = 'rgb(80, 90, 100)';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [bridge] ${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

function captureConsoleErrors() {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  return { errors, restore: () => (console.error = original) };
}

const server = await createServer({
  root: exampleDir,
  logLevel: 'silent',
  server: { port: 0 },
});
await server.listen();

try {
  const origin = new URL(server.resolvedUrls.local[0]).origin;
  const root = server.config.root;
  const registry = globalThis[REGISTRY_KEY];
  const registeredResolver = registry?.[root];
  record('resolver registered for root', !!registeredResolver);

  const ssrEnv = server.environments.ssr;
  const loadManifestModule = async () => {
    const node = ssrEnv.moduleGraph.getModuleById('\0virtual:solid-manifest');
    if (node) ssrEnv.moduleGraph.invalidateModule(node);
    return (await server.ssrLoadModule('virtual:solid-manifest')).default;
  };

  // ---- Protocol over plain HTTP ------------------------------------------
  const missingKey = await fetch(origin + ENDPOINT);
  record('missing key answers 400', missingKey.status === 400);

  const hit = await fetch(`${origin}${ENDPOINT}?key=${encodeURIComponent(LAZY_KEY)}`);
  record('resolved key answers 200 JSON', hit.status === 200 && (hit.headers.get('content-type') || '').includes('application/json'));
  const assets = await hit.json();
  record(
    'protocol carries the module dev URL',
    Array.isArray(assets?.js) && assets.js.includes('/' + LAZY_KEY),
    JSON.stringify(assets?.js),
  );
  record(
    'protocol carries transitively imported CSS (inline descriptors)',
    Array.isArray(assets?.css) &&
      assets.css.some((c) => typeof c === 'object' && c.content?.includes(LAZY_CSS_COLOR)),
    JSON.stringify(assets?.css)?.slice(0, 200),
  );

  // ---- Serve-side hardening: registry miss --------------------------------
  {
    const spy = captureConsoleErrors();
    let missBody;
    try {
      delete registry[root];
      const miss = await fetch(`${origin}${ENDPOINT}?key=${encodeURIComponent(LAZY_KEY)}`);
      missBody = await miss.json();
    } finally {
      registry[root] = registeredResolver;
      spy.restore();
    }
    record('registry miss answers null (runtime catch-all preserved)', missBody === null);
    record(
      'registry miss logs a loud plugin error',
      spy.errors.some((e) => e.includes('[@solidjs/vite-plugin]') && e.includes('no resolver for root')),
      spy.errors.join(' | '),
    );
  }

  // ---- Fallback consumer: virtual:solid-manifest without the registry -----
  // Evaluated in-process but with the registry entry removed, exactly what
  // an isolated runner sees. Re-register before resolving so the endpoint
  // (the Vite process side) can answer.
  delete registry[root];
  const bridgeResolver = await loadManifestModule();
  registry[root] = registeredResolver;
  record('registry miss binds a bridge resolver (not the in-process one)', bridgeResolver !== registeredResolver);
  const coldSync = bridgeResolver.resolveSync(LAZY_KEY);
  record(
    'bridge resolveSync before the cache warms stays js-only (no sync HTTP)',
    coldSync?.js?.includes('/' + LAZY_KEY) && coldSync?.css?.length === 0,
    JSON.stringify(coldSync),
  );
  const bridged = await bridgeResolver.resolve(LAZY_KEY);
  record(
    'bridge resolver answers full assets over HTTP',
    Array.isArray(bridged?.js) &&
      bridged.js.includes('/' + LAZY_KEY) &&
      bridged.css?.some((c) => c.content?.includes(LAZY_CSS_COLOR)),
    JSON.stringify(bridged)?.slice(0, 200),
  );
  // Render-pass convergence contract: the runtime retries a suspended SSR
  // pass by re-creating the lazy component, which re-requests its assets —
  // a fresh pending promise per call would suspend every retry anew until
  // the render stack overflowed. Once cached, resolve must answer with a
  // plain object, not a thenable.
  const warm = bridgeResolver.resolve(LAZY_KEY);
  record(
    'cached key resolves synchronously (render-pass convergence)',
    !!warm && typeof warm.then !== 'function' && warm.css?.some((c) => c.content?.includes(LAZY_CSS_COLOR)),
    warm && typeof warm.then === 'function' ? 'answered a promise' : JSON.stringify(warm)?.slice(0, 200),
  );
  const warmSync = bridgeResolver.resolveSync(LAZY_KEY);
  record(
    'bridge resolveSync answers full assets once cached',
    warmSync?.js?.includes('/' + LAZY_KEY) && warmSync?.css?.some((c) => c.content?.includes(LAZY_CSS_COLOR)),
    JSON.stringify(warmSync)?.slice(0, 200),
  );

  // ---- Fetch-side hardening: non-OK response and network failure ----------
  // Against a key the cache has not seen — cached keys never touch fetch.
  const realFetch = globalThis.fetch;
  {
    const spy = captureConsoleErrors();
    let nonOk, netFail;
    try {
      globalThis.fetch = async () => new Response('boom', { status: 500 });
      nonOk = await bridgeResolver.resolve(GLOB_KEY);
      globalThis.fetch = async () => {
        throw new Error('connection refused');
      };
      netFail = await bridgeResolver.resolve(GLOB_KEY);
    } finally {
      globalThis.fetch = realFetch;
      spy.restore();
    }
    record('non-OK bridge response resolves null', nonOk === null);
    record(
      'non-OK bridge response logs a loud plugin error',
      spy.errors.some((e) => e.includes('[@solidjs/vite-plugin]') && e.includes('status 500')),
      spy.errors.join(' | '),
    );
    record('bridge network failure resolves null', netFail === null);
    record(
      'bridge network failure logs a loud plugin error',
      spy.errors.some((e) => e.includes('[@solidjs/vite-plugin]') && e.includes('connection refused')),
      spy.errors.join(' | '),
    );
    // A failure must stay retryable: caching the null would silently strip
    // this module's client assets for the rest of the dev session.
    const recovered = await bridgeResolver.resolve(GLOB_KEY);
    record(
      'bridge failure is not cached — key recovers once the bridge is back',
      recovered?.js?.includes('/' + GLOB_KEY) &&
        recovered.css?.some((c) => c.content?.includes(GLOB_CSS_COLOR)),
      JSON.stringify(recovered)?.slice(0, 200),
    );
  }

  // ---- Registry hit short-circuits: no HTTP at all -------------------------
  const inProcess = await loadManifestModule();
  record('registry hit exports the in-process resolver', inProcess === registeredResolver);
  {
    globalThis.fetch = () => {
      throw new Error('HTTP must not be used on a registry hit');
    };
    let direct;
    try {
      direct = await inProcess.resolve(LAZY_KEY);
    } finally {
      globalThis.fetch = realFetch;
    }
    record(
      'registry-hit resolution works with fetch disabled',
      direct?.js?.includes('/' + LAZY_KEY) &&
        direct.css?.some((c) => c.content?.includes(LAZY_CSS_COLOR)),
      JSON.stringify(direct)?.slice(0, 200),
    );
  }
} finally {
  await server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bridge assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name} — ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
