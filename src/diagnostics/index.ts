/**
 * Agent diagnostics surface (dev serve only).
 *
 * Enabled automatically when the app has `@solidjs/diagnostics` installed
 * (the `diagnostics` option overrides: `true` forces it on and errors if
 * the package is missing, `false` opts out entirely).
 *
 * Three pieces:
 * - an injected client module (virtual, imported by index.html or the
 *   start-mode client entry) that installs the in-page bridge from the
 *   app's own `@solidjs/diagnostics` and answers requests over Vite's
 *   WebSocket custom events;
 * - a collector that forwards requests to the page and correlates
 *   responses by id;
 * - an HTTP endpoint (`/__solid/diagnostics`) fronting that round-trip so
 *   any out-of-process consumer (agent, MCP tool, curl) can drive capture
 *   sessions without holding a WebSocket.
 *
 * `@solidjs/diagnostics` is deliberately a type-only dependency of this
 * plugin: the runtime bridge always comes from the app's own installed
 * copy, so plugin releases and diagnostics releases stay uncoupled. The
 * wire constants are re-declared here with types imported from the
 * package, so drift fails the plugin's own compile.
 */
import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Plugin } from 'vite';
import { joinBase } from '../http.js';

type Protocol = typeof import('@solidjs/diagnostics/protocol');
const DIAGNOSTICS_ENDPOINT: Protocol['DIAGNOSTICS_ENDPOINT'] = '/__solid/diagnostics';
const REQUEST_EVENT: Protocol['DIAGNOSTICS_REQUEST_EVENT'] = 'solid:diagnostics:request';
const RESPONSE_EVENT: Protocol['DIAGNOSTICS_RESPONSE_EVENT'] = 'solid:diagnostics:response';

type DiagnosticsResponse = import('@solidjs/diagnostics/protocol').DiagnosticsResponse;

export const DIAGNOSTICS_PACKAGE = '@solidjs/diagnostics';
export const DIAGNOSTICS_CLIENT_ID = 'virtual:solid-diagnostics/client';

const METHODS = ['begin', 'end', 'active', 'whyDidRun', 'costs'] as const satisfies readonly (
  | import('@solidjs/diagnostics/protocol').DiagnosticsMethod
)[];

/** How long the endpoint waits for a page to answer before failing the call. */
const RESPONSE_TIMEOUT_MS = 10_000;

/**
 * Whether the app has `@solidjs/diagnostics` installed — the auto-enable
 * signal. A plain node_modules walk (project root upward) rather than
 * module resolution: the package is ESM-only, so `require.resolve` can't
 * probe it, and this also matches hoisted installs. Yarn PnP has no
 * node_modules and isn't detected — `diagnostics: true` is the escape
 * hatch there.
 */
export function detectDiagnosticsPackage(root: string): boolean {
  let dir = path.resolve(root);
  while (true) {
    if (
      fs.existsSync(path.join(dir, 'node_modules', DIAGNOSTICS_PACKAGE, 'package.json'))
    ) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function diagnosticsClientModuleCode(): string {
  // Runtime imports resolve to the APP's diagnostics package (see the
  // resolveId assist below) — the page speaks its own package's protocol.
  return [
    `import { installDiagnosticsBridge } from '${DIAGNOSTICS_PACKAGE}/browser';`,
    `import {`,
    `  DIAGNOSTICS_REQUEST_EVENT,`,
    `  DIAGNOSTICS_RESPONSE_EVENT,`,
    `} from '${DIAGNOSTICS_PACKAGE}/protocol';`,
    ``,
    `const bridge = installDiagnosticsBridge();`,
    ``,
    `async function dispatch(request) {`,
    `  switch (request.method) {`,
    `    case 'begin': bridge.begin(request.params); return true;`,
    `    case 'end': return bridge.end();`,
    `    case 'active': return bridge.active();`,
    `    case 'whyDidRun': return bridge.whyDidRun(request.params.name);`,
    `    case 'costs': return bridge.costs();`,
    `    default: throw new Error('Unknown diagnostics method: ' + request.method);`,
    `  }`,
    `}`,
    ``,
    `if (import.meta.hot) {`,
    `  import.meta.hot.on(DIAGNOSTICS_REQUEST_EVENT, async (request) => {`,
    `    let response;`,
    `    try {`,
    `      response = { id: request.id, result: await dispatch(request) };`,
    `    } catch (error) {`,
    `      response = {`,
    `        id: request.id,`,
    `        error: error instanceof Error ? error.message : String(error),`,
    `      };`,
    `    }`,
    `    import.meta.hot.send(DIAGNOSTICS_RESPONSE_EVENT, response);`,
    `  });`,
    `}`,
  ].join('\n');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function solidDiagnostics(mode: true | 'auto' = 'auto'): Plugin {
  let root = process.cwd();
  let base = '/';
  // Resolved at configResolved: explicit `true` is unconditional (missing
  // package becomes a hard error at bridge resolution); `'auto'` enables
  // only when the app has the package installed.
  let enabled = mode === true;

  return {
    name: 'solid:diagnostics',
    // Dev-serve only: the channels this fronts exist in dev builds only.
    apply(_config, env) {
      return env.command === 'serve' && !env.isPreview;
    },

    configResolved(config) {
      root = config.root;
      base = config.base;
      if (mode === 'auto') enabled = detectDiagnosticsPackage(root);
    },

    async resolveId(source, importer) {
      if (source === DIAGNOSTICS_CLIENT_ID) {
        return { id: DIAGNOSTICS_CLIENT_ID, moduleSideEffects: true };
      }
      // The virtual module has no directory to resolve bare imports from;
      // resolve the app's diagnostics package from the project root.
      if (importer === DIAGNOSTICS_CLIENT_ID && source.startsWith(DIAGNOSTICS_PACKAGE)) {
        const resolved = await this.resolve(source, path.resolve(root, 'index.html'), {
          skipSelf: true,
        });
        if (!resolved || resolved.id.startsWith('__vite-optional-peer-dep:')) {
          this.error(
            `[@solidjs/vite-plugin] the diagnostics surface requires ${DIAGNOSTICS_PACKAGE} ` +
              'installed in the app (it provides the in-page bridge). Install it as a ' +
              'development dependency, or set `diagnostics: false` to opt out.',
          );
        }
        return resolved;
      }
      return null;
    },

    load(id) {
      if (id === DIAGNOSTICS_CLIENT_ID) return diagnosticsClientModuleCode();
      return null;
    },

    // Plain (index.html) apps get the client module injected here;
    // start-mode apps import it from the generated client entry instead.
    transformIndexHtml() {
      if (!enabled) return undefined;
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: joinBase(base, '/@id/' + DIAGNOSTICS_CLIENT_ID) },
          injectTo: 'head' as const,
        },
      ];
    },

    configureServer(server) {
      // The whole surface (announcement, middleware, bridge injection) only
      // exists when enabled, so the discovery breadcrumb never lies about
      // a dead endpoint.
      if (!enabled) return;

      // Announce the surface in the startup block. This is a discovery
      // channel: agents watching dev-server output learn the endpoint and
      // the skill documents without any project-level pointer (AGENTS.md).
      const originalPrintUrls = server.printUrls.bind(server);
      server.printUrls = () => {
        originalPrintUrls();
        const local = server.resolvedUrls?.local[0];
        const endpoint = local
          ? new URL(DIAGNOSTICS_ENDPOINT, local).href
          : DIAGNOSTICS_ENDPOINT;
        server.config.logger.info(
          `  ➜  Solid diagnostics: ${endpoint} ` +
            `(GET status; POST {"method":"begin"|"end"|"whyDidRun"|"costs"})` +
            (mode === 'auto' ? ' — auto-enabled; `diagnostics: false` opts out' : '') +
            `\n  ➜  Agent skills: node_modules/${DIAGNOSTICS_PACKAGE}/skills/agent-loops/SKILL.md, ` +
            `node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md`,
        );
      };

      interface Pending {
        resolve: (response: DiagnosticsResponse) => void;
        timer: ReturnType<typeof setTimeout>;
      }
      const pending = new Map<number, Pending>();
      let nextId = 1;

      server.ws.on(RESPONSE_EVENT, (data: DiagnosticsResponse) => {
        const entry = pending.get(data?.id as number);
        if (!entry) return;
        pending.delete(data.id);
        clearTimeout(entry.timer);
        entry.resolve(data);
      });

      // No host/origin validation here: on all supported Vite versions
      // (peer range ^8) Vite's own DNS-rebinding host check runs ahead of
      // plugin middleware — verified: requests with a disallowed Host
      // header get Vite's 403 before reaching this handler.
      server.middlewares.use(DIAGNOSTICS_ENDPOINT, async (req, res) => {
        // The middleware mounts on the exact path; anything deeper is 404.
        if (req.url && req.url !== '/' && req.url !== '') {
          sendJson(res, 404, { error: `Unknown diagnostics path ${req.url}` });
          return;
        }
        if (req.method === 'GET') {
          sendJson(res, 200, {
            ok: true,
            methods: METHODS,
            clients: server.ws.clients.size,
          });
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Use GET for status or POST { method, params }' });
          return;
        }

        let body: { method?: string; params?: unknown };
        try {
          body = (await readJsonBody(req)) as { method?: string; params?: unknown };
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
          return;
        }
        if (!body.method || !(METHODS as readonly string[]).includes(body.method)) {
          sendJson(res, 400, {
            error: `Unknown method ${JSON.stringify(body.method)}; expected one of: ${METHODS.join(', ')}`,
          });
          return;
        }
        if (server.ws.clients.size === 0) {
          sendJson(res, 503, {
            error:
              'No connected page. Open the app in a browser (dev server) so the ' +
              'diagnostics bridge can answer.',
          });
          return;
        }

        const id = nextId++;
        // Broadcast; with several open tabs the first responder wins. Good
        // enough for the agent loop (one page under test); revisit with
        // client targeting if multi-page capture ever matters.
        const response = await new Promise<DiagnosticsResponse | { timeout: string }>(
          (resolve) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              resolve({
                timeout:
                  `No page answered within ${RESPONSE_TIMEOUT_MS}ms. The connected page ` +
                  'may predate `diagnostics: true` — reload it.',
              });
            }, RESPONSE_TIMEOUT_MS);
            pending.set(id, { resolve, timer });
            server.ws.send(REQUEST_EVENT, { id, method: body.method, params: body.params });
          },
        );

        if ('timeout' in response) {
          sendJson(res, 504, { error: response.timeout });
        } else if (response.error !== undefined) {
          sendJson(res, 400, { error: response.error });
        } else {
          sendJson(res, 200, { result: response.result });
        }
      });
    },
  };
}
