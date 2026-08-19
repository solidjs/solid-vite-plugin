// Start-mode kitchen-sink fixture test: proves `solid({ start: {}, ssr: true,
// serverFunctions: true })` gives a plain Vite app working streaming SSR
// *and* "use server"
// server functions with zero wiring — no entry files, no index.html, no dev
// server script. Union of the former ssr-turnkey and server-functions
// suites. Asserts, in both dev (`vite`) and production (`vite build` + the
// one-line handler in server.js):
//   - the SSR response actually streams: the shell arrives first with the
//     Loading fallback, the async content follows in a later chunk,
//   - the generated document shell carries the hydration script and the
//     client entry (dev: /@id/virtual URL; prod: hashed asset + css link),
//   - dev injects the Vite client + dev style patch into <head> and inlines
//     the entry graph's CSS (App.css rules SSR'd as <style data-vite-dev-id>
//     tags — the no-FOUC guarantee) with exactly one surviving style element
//     per dev id after hydration and after CSS HMR; prod does not leak dev
//     injections (CSS ships as a hashed <link>),
//   - hydration is clean and the app is interactive (counter),
//   - server functions compose: cold dispatch is served by the dev
//     middleware before anything has rendered in the SSR environment
//     (exercising the function-ID → module manifest mapping), unknown ids
//     are rejected, and in prod the same handleRequest handler serves the
//     endpoint (module-level and function-level functions, getRequestEvent,
//     the respond() envelope — all round-trip from the browser),
//   - server-only module code (the secret) never reaches the SSR html, the
//     transformed client module, or any client asset,
//   - HMR works through the start-mode dev middleware under the native
//     (Babel-free) pipeline: the solid-js/refresh wrapper is active, an
//     on-disk edit hot-applies without a reload, sibling client state
//     survives, and a CSS edit hot-applies into a single style element; the
//     babel-hmr mode repeats those checks on a dev server forced to
//     `compiler: 'babel'`,
//   - the `start.document` escape hatch swaps the document shell and the
//     `serverFunctions.endpoint` option threads through middleware and
//     runtime configure calls (separate dev servers, no browser),
//   - `serverFunctions.configure` pins src/serverConfig.ts into the handler
//     graph: its `transformResult` hook is live on a cold dev dispatch
//     (before anything rendered), an edit to it hot-applies without a
//     restart, and in prod the module is bundled into the handler chunk
//     (and absent from client assets) with the same observable effect,
//   - `serverFunctions.devMiddleware: false` keeps compilation on while the
//     middleware no longer intercepts `/_server` (a dev POST 404s), and a
//     host emulation (test/host-dispatch.mjs) proves the manifest + handler
//     virtual modules still dispatch through `ssrLoadModule`,
//   - builder-order: with an adversarial `builder.buildApp` that builds the
//     ssr environment first (mimicking e.g. @cloudflare/vite-plugin), the
//     plugin's client-build-first hook still gets the client manifest baked
//     into the server bundle,
//   - builder-prepare: with a nitro-v3-shaped host — a pre-order `buildApp`
//     hook that rm -rf's the output directory (`nitro:prepare`) plus a
//     post-order orchestrator that builds ssr and skips already-built
//     environments (`nitro:main`) — the client build lands *after* the
//     wipe (hashed assets + manifest survive, the server bundle references
//     them) and the plugin's /complete hook leaves the ssr build to the
//     host's orchestrator instead of preempting it,
//   - the conventional-entries path: when src/entry-server.tsx and
//     src/entry-client.tsx exist (written temporarily by the test), they are
//     used instead of the generated ones, and in prod the authored
//     `/src/entry-client.tsx` script reference is rewritten to the hashed
//     asset,
//   - frames (server components, enabled by the single option
//     `serverFunctions: { components: true }` — SOLID_SERVER_COMPONENTS in
//     vite.config.ts), in dev and prod: the plugin's generated entries emit
//     all the wiring (render plugin, installServerComponents(); the _$SC
//     registry self-bootstraps from serialized references, no head splice),
//     document SSR renders a server component
//     inline with t=0 slot records and the SC bootstrap, the boundary is
//     adopted at boot with zero `/_server` requests, refetch/navigation
//     morph the boundary over the existing endpoint with client wrapper
//     state + DOM identity surviving (policy A), an adopted boundary's
//     nested regions survive the first morph (dom-expressions#547), a
//     never-SSR'd boundary mounts and morphs from post-boot streams, a
//     mutation via a plain data server function rides the same endpoint,
//     the server component's JSX never reaches client assets, and the
//     fragment-rooted page survives a signal-nav unmount → remount cycle
//     (frame insertable in an array insert position, dom-expressions#550).
//     The app surface lives in src/frames/,
//   - the option is pure codegen: the plain dev/prod modes assert the
//     generated entries and client assets carry no reference to the
//     server-components runtime when the option is off.
//
//   - the response-head lifecycle in dev, prod, and preview (App.tsx's
//     path-keyed surfaces): httpStatus(404)/httpHeader reach the wire, a
//     pre-flush Location is a real 3xx with no body, a post-flush Location
//     emits the script-redirect fallback on the streamed 200,
//   - `start.middleware` (SSR_MIDDLEWARE=1, src/middleware.ts): composition
//     order, locals decoration visible to the page and to a server function
//     over /_server (one request event fronts both), short-circuiting —
//     with the handler edge's commitEventResponse fold carrying an
//     early-return's stub cookie onto the wire exactly once — error
//     middleware catching a render throw, and the post-next()
//     header-mutation window on a streamed response — in dev and prod,
//     plus codegen string assertions that the generated handler resolves
//     commitEventResponse from @solidjs/web and folds after the unwind,
//   - `vite preview` serves the production artifact with no server file:
//     dist/client statically, everything else (pages, /_server, middleware,
//     the lifecycle) through the built handler,
//   - lazy asset keys survive module identities beyond plain root-relative
//     paths (the /lazy-assets surface, dev and prod): a query-suffixed lazy
//     import keeps its query through the manifest key / dev URL (#299), and
//     a root-external module gets a /@fs/ dev URL (#298),
//   - a non-root Vite `base` (base mode, SOLID_BASE=/app/) holds end to end:
//     dev pages/assets/endpoint and preview pages/statics/endpoint all serve
//     base-prefixed, the built handler receives base-restored URLs from the
//     preview adapter (#300), and dev lazy asset URLs carry the base (#298).
//
// Requires the plugin built (pnpm build at the repo root) and Google Chrome.
// Usage: node test/run.mjs
// [dev|prod|document|entries|endpoint|configure|no-middleware|middleware|preview|base|builder-order|builder-prepare|babel-hmr|frames]
// (default: all)

import { spawn, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import {
  createServer,
  createServerHotChannel,
  createServerModuleRunner,
  DevEnvironment,
  isRunnableDevEnvironment,
  resolveConfig,
} from 'vite';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Deliberately no process.chdir(exampleDir): the in-process modes (external,
// detect) create the dev server with `root: exampleDir` while the runner's
// cwd stays wherever it was invoked from — regression coverage for the
// plugin resolving relative filter globs against process.cwd() instead of
// the Vite root (spawned modes pass explicit cwds either way).
const CHROME =
  process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = 9337;

const SECRET = 'SERVER-ONLY-SECRET';

// Server-function round-trips driven from the hydrated page.
const CALLS = [
  { name: 'module-level fn (message)', button: '#call-message', target: '#message', expected: 'hello client from the server' },
  { name: 'function-level fn (double)', button: '#call-double', target: '#doubled', expected: '42' },
  { name: 'getRequestEvent in fn (method)', button: '#call-method', target: '#method', expected: 'POST' },
  { name: 'server-only secret usable (secret)', button: '#call-secret', target: '#secret', expected: 'true' },
  { name: 'respond() helper round-trip (greeting)', button: '#call-respond', target: '#greeting', expected: 'hi client' },
];

// ---------------------------------------------------------------------------
// Small process / http helpers
// ---------------------------------------------------------------------------
const children = new Set();
function cleanup(code = 0) {
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      try {
        c.kill('SIGTERM');
      } catch {}
    }
  }
  process.exit(code);
}
process.on('SIGINT', () => cleanup(1));
process.on('SIGTERM', () => cleanup(1));

function startProcess(cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

async function waitForHttp(url, timeoutMs = 30000, init) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, init);
      if (res.ok || res.status === 404) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Reads an SSR response chunk by chunk, recording arrival order. */
async function fetchStreamed(url) {
  const res = await fetch(url, { headers: { accept: 'text/html' } });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let html = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    chunks.push(chunk);
    html += chunk;
  }
  return { status: res.status, headers: res.headers, chunks, html };
}

// ---------------------------------------------------------------------------
// CDP driver
// ---------------------------------------------------------------------------
async function connectChrome() {
  let target;
  // 30s: the first headless Chrome launch on a cold CI runner can exceed 10s.
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      target = (await res.json()).find((t) => t.type === 'page');
      if (target) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!target) throw new Error('Chrome CDP not reachable');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const exceptions = [];
  const requests = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(
        msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text,
      );
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      exceptions.push(
        'console.error: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '),
      );
    } else if (msg.method === 'Network.requestWillBeSent') {
      requests.push(msg.params.request.url);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await new Promise((r) => (ws.onopen = r));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');

  const evalJs = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error('eval failed: ' + JSON.stringify(res.result.exceptionDetails.text));
    }
    return res.result?.result?.value;
  };

  const waitFor = async (expression, timeoutMs = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await evalJs(expression)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  return { send, evalJs, waitFor, exceptions, requests, close: () => ws.close() };
}

// ---------------------------------------------------------------------------
// Assertion collection
// ---------------------------------------------------------------------------
const results = [];
function record(mode, phase, name, ok, detail = '') {
  results.push({ mode, phase, name, ok, detail });
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mode}/${phase}] ${status} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

// Dev function IDs are `hash-count-name`; pull the one for `name` out of the
// client-transformed module so the endpoint can be hit directly.
function extractFunctionId(transformedCode, name) {
  // The import identifier may be aliased (e.g. createServerReference_1), and
  // newer compilers pass the function name as a second argument after the id.
  const match = transformedCode.match(new RegExp(`createServerReference\\w*\\("([^"]*-${name})"`));
  return match ? match[1] : null;
}

// Distinctive rule from src/App.css: proves real styles (not just the dev
// style patch) reached the page. Keep in sync with the stylesheet.
const APP_CSS_COLOR = 'rgb(20, 40, 60)';
// Selects style tags for App.css whatever the id shape (absolute fs path in
// dev; never present in prod, where CSS ships as a hashed <link>).
const APP_CSS_STYLE_SELECTOR = 'style[data-vite-dev-id$="App.css"]';

// Shared SSR + streaming assertions against a running server.
async function runSsrChecks(mode, origin) {
  const { status, chunks, html } = await fetchStreamed(origin + '/');
  record(mode, 'ssr', 'responds 200 to HTML-accepting GET', status === 200);
  record(mode, 'ssr', 'app server-rendered', html.includes('SSR Start Mode'));
  record(
    mode,
    'ssr',
    'full document rendered (doctype + html)',
    html.startsWith('<!DOCTYPE html><html'),
  );
  record(mode, 'ssr', 'hydration script present', html.includes('_$HY'));
  record(mode, 'ssr', `no "${SECRET}" in SSR html`, !html.includes(SECRET));

  const contentAt = chunks.findIndex((c) => c.includes('STREAMED-ASYNC-CONTENT'));
  const shellChunks = chunks.slice(0, contentAt === -1 ? undefined : contentAt).join('');
  record(
    mode,
    'stream',
    'response streams (multiple chunks)',
    chunks.length > 1,
    `${chunks.length} chunk(s)`,
  );
  record(
    mode,
    'stream',
    'shell flushed before async content (fallback first)',
    contentAt > 0 && shellChunks.includes('stream-fallback') && shellChunks.includes('</html>'),
    `content in chunk ${contentAt}`,
  );
  record(mode, 'stream', 'async content streamed in', html.includes('STREAMED-ASYNC-CONTENT'));

  // clientOnly's server contract: the import never starts on the server, so
  // only the fallback may appear in the document — the widget's own marker
  // text must not (it lives solely in the client chunk).
  record(
    mode,
    'ssr',
    'clientOnly SSRs its fallback only',
    html.includes('client-only-fallback') && !html.includes('CLIENT-ONLY-WIDGET'),
  );

  // Router-style nested lazy components (src/NestedLazy.tsx): a provider
  // whose children re-create lazy() components on every retry of the
  // suspended render pass. Convergence regressed when the dev asset resolver
  // answered every call with a fresh pending promise — each retry then
  // suspended anew and the pass never converged (any nested fs-route hung
  // dev, or overflowed the render stack and killed the server). Time-bounded
  // so a regression fails fast instead of hanging the suite.
  const nested = await Promise.race([
    fetchStreamed(origin + '/nested-lazy'),
    new Promise((resolve) => setTimeout(() => resolve(null), 15000)),
  ]);
  record(
    mode,
    'ssr',
    'nested lazy components converge (layout + leaf rendered)',
    !!nested &&
      nested.status === 200 &&
      nested.html.includes('NESTED-LAZY-LEAF') &&
      nested.html.includes('nested-layout'),
    nested
      ? `status ${nested.status}`
      : 'timed out after 15s (render pass never converged)',
  );
  return html;
}

// Response-head lifecycle checks (App.tsx's path-keyed surfaces), shared by
// dev, prod, and preview: httpStatus/httpHeader reach the wire, a pre-flush
// Location is a real 3xx with no body, a post-flush Location (written after
// the shell streamed) falls back to the script redirect on a 200.
async function runHttpChecks(mode, origin) {
  const missing = await fetchStreamed(origin + '/missing');
  record(
    mode,
    'http',
    'httpStatus(404) reaches the wire',
    missing.status === 404,
    `status ${missing.status}`,
  );
  record(
    mode,
    'http',
    'httpHeader lands on the response',
    missing.headers.get('x-page') === 'missing',
    `x-page: ${JSON.stringify(missing.headers.get('x-page'))}`,
  );
  record(mode, 'http', '404 still renders its page', missing.html.includes('NOT-FOUND-PAGE'));

  const pre = await fetch(origin + '/redirect-pre', {
    headers: { accept: 'text/html' },
    redirect: 'manual',
  });
  record(
    mode,
    'http',
    'pre-flush Location becomes a real 3xx',
    pre.status === 302,
    `status ${pre.status}`,
  );
  record(
    mode,
    'http',
    'pre-flush redirect keeps its Location',
    pre.headers.get('location') === '/redirected-target',
  );
  record(mode, 'http', 'pre-flush redirect ships no body', (await pre.text()) === '');

  const post = await fetchStreamed(origin + '/redirect-post');
  record(
    mode,
    'http',
    'post-flush redirect stays 200 (head already committed)',
    post.status === 200,
    `status ${post.status}`,
  );
  record(
    mode,
    'http',
    'post-flush redirect emits the script fallback',
    post.html.includes('window.location') && post.html.includes('/redirected-target'),
  );
}

// Lazy asset-key checks (the /lazy-assets surface, src/App.tsx): a
// query-suffixed lazy import and a root-external one. Regression coverage
// for #299 (the query is part of the module identity — manifest key, dev
// URL — and must survive the SSR asset lookup) and #298 (dev URLs must be
// base-prefixed, and root-external modules must resolve to /@fs/ URLs, not
// "/../…"). `basePrefix` is the configured Vite base without its trailing
// slash ('' for the default '/'), asserted on every emitted URL.
async function runLazyAssetChecks(mode, origin, { dev, basePrefix = '' } = {}) {
  const page = await fetchStreamed(origin + basePrefix + '/lazy-assets');
  record(
    mode,
    'lazy',
    'query-suffixed and root-external lazy components SSR',
    page.status === 200 &&
      page.html.includes('QUERY-LAZY-CONTENT') &&
      page.html.includes('EXTERNAL-LAZY-CONTENT'),
    `status ${page.status}`,
  );
  const preloads = [...page.html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(
    (m) => m[1],
  );
  const queryHref = preloads.find((href) => href.includes('QueryLazy'));
  const externalHref = preloads.find((href) => href.includes('LazyOutside'));

  if (dev) {
    record(
      mode,
      'lazy',
      'queried module preloaded by its queried dev URL (base applied)',
      queryHref === `${basePrefix}/src/QueryLazy.tsx?variant=a`,
      `modulepreloads: ${preloads.join(', ') || '(none)'}`,
    );
    record(
      mode,
      'lazy',
      'root-external module preloaded via base-prefixed /@fs/ URL',
      !!externalHref &&
        externalHref.startsWith(`${basePrefix}/@fs/`) &&
        externalHref.endsWith('turnkey-external/LazyOutside.tsx'),
      `modulepreloads: ${preloads.join(', ') || '(none)'}`,
    );
  } else {
    const clientManifest = JSON.parse(
      readFileSync(path.join(exampleDir, 'dist/client/.vite/manifest.json'), 'utf-8'),
    );
    const queryEntry = clientManifest['src/QueryLazy.tsx?variant=a'];
    record(
      mode,
      'lazy',
      'queried module manifest-keyed with its query',
      !!queryEntry?.file,
      `manifest keys: ${Object.keys(clientManifest).join(', ')}`,
    );
    record(
      mode,
      'lazy',
      'queried module preload resolved through the manifest',
      !!queryEntry?.file && queryHref === `${basePrefix}/${queryEntry.file}`,
      `modulepreloads: ${preloads.join(', ') || '(none)'}`,
    );
    const externalEntry = clientManifest['../turnkey-external/LazyOutside.tsx'];
    record(
      mode,
      'lazy',
      'root-external module preload resolved through the manifest',
      !!externalEntry?.file && externalHref === `${basePrefix}/${externalEntry.file}`,
      `modulepreloads: ${preloads.join(', ') || '(none)'}`,
    );
  }

  // The emitted URLs must actually be servable — a wrong base or a mangled
  // /@fs/ path 404s (dev) or misses the static handler (preview/prod).
  for (const [name, href] of [
    ['queried module', queryHref],
    ['root-external module', externalHref],
  ]) {
    if (!href) {
      record(mode, 'lazy', `${name} preload URL serves JS`, false, 'no modulepreload emitted');
      continue;
    }
    const res = await fetch(origin + href);
    const body = res.ok ? await res.text() : '';
    record(
      mode,
      'lazy',
      `${name} preload URL serves JS`,
      res.ok && body.includes('LAZY-CONTENT'),
      `GET ${href} → ${res.status}`,
    );
  }
}

// HMR checks against a running dev server: fresh page load (hydrated SSR),
// refresh-wrapper sanity on the served module, then edit HmrTarget.tsx on
// disk and assert the update lands hot: new text rendered, no full reload
// (window marker survives), sibling client state (the counter owned by App)
// preserved; finally a CSS edit must hot-apply into a single style element
// (the SSR-inlined tag must not linger next to Vite's updated one). Files
// restored afterwards. `expectCompiler` asserts which JSX backend served the
// page via the config's define-injected marker (the backends' outputs are
// otherwise parity-identical, so the marker is the only reliable
// discriminator).
async function runHmrChecks(mode, cdp, origin, { expectCompiler } = {}) {
  const hmrFile = path.join(exampleDir, 'src/HmrTarget.tsx');
  const originalSource = readFileSync(hmrFile, 'utf-8');
  try {
    cdp.exceptions.length = 0;
    await cdp.send('Page.navigate', { url: origin + '/' });
    await cdp.waitFor('document.readyState === "complete"');
    await new Promise((r) => setTimeout(r, 750));

    const hydrationErrs = cdp.exceptions.filter((e) => /hydrat|mismatch/i.test(e));
    record(
      mode,
      'hmr',
      'clean hydration (no hydration console errors)',
      hydrationErrs.length === 0,
      hydrationErrs.join(' | '),
    );

    // Refresh must actually be wired: the served module carries the
    // refresh wrapper importing the solid-js/refresh runtime (Vite may
    // rewrite the specifier to its pre-bundled /node_modules/.vite/deps
    // URL, so match both spellings).
    const served = await (await fetch(origin + '/src/HmrTarget.tsx')).text();
    record(
      mode,
      'hmr',
      'refresh active (solid-js/refresh wrapper in served module)',
      /solid-js[/_]refresh/.test(served) &&
        served.includes('$$registry') &&
        served.includes('import.meta.hot'),
    );
    if (expectCompiler) {
      record(
        mode,
        'hmr',
        `${expectCompiler} JSX backend active (define marker)`,
        (await cdp.evalJs('document.querySelector("#jsx-compiler")?.textContent')) ===
          expectCompiler,
      );
    }

    // Reload marker + client state that must survive the hot update.
    await cdp.evalJs('window.__HMR_NO_RELOAD_MARKER = 1');
    await cdp.evalJs('document.querySelector("#increment").click()');
    await cdp.evalJs('document.querySelector("#increment").click()');
    record(
      mode,
      'hmr',
      'counter incremented before edit',
      await cdp.waitFor('document.querySelector("#count")?.textContent === "2"'),
    );

    writeFileSync(hmrFile, originalSource.replace('HMR-ORIGINAL', 'HMR-UPDATED'));
    const updated = await cdp.waitFor(
      'document.querySelector("#hmr-text")?.textContent === "HMR-UPDATED"',
      15000,
    );
    record(
      mode,
      'hmr',
      'hot update applied (edited text rendered)',
      updated,
      `hmr-text: ${JSON.stringify(
        await cdp.evalJs('document.querySelector("#hmr-text")?.textContent'),
      )}`,
    );
    record(
      mode,
      'hmr',
      'no full page reload (window marker survived)',
      (await cdp.evalJs('window.__HMR_NO_RELOAD_MARKER')) === 1,
    );
    record(
      mode,
      'hmr',
      'client state preserved (counter still 2)',
      (await cdp.evalJs('document.querySelector("#count")?.textContent')) === '2',
    );
  } finally {
    writeFileSync(hmrFile, originalSource);
  }

  // CSS HMR: edit App.css on disk, assert the new rule hot-applies and the
  // update lands in a single style element.
  const cssFile = path.join(exampleDir, 'src/App.css');
  const originalCss = readFileSync(cssFile, 'utf-8');
  const HMR_CSS_COLOR = 'rgb(200, 100, 50)';
  try {
    writeFileSync(cssFile, originalCss.replace('rgb(20, 40, 60)', HMR_CSS_COLOR));
    record(
      mode,
      'hmr',
      'CSS hot update applied (computed color changed)',
      await cdp.waitFor(
        `getComputedStyle(document.querySelector("#title")).color === ${JSON.stringify(HMR_CSS_COLOR)}`,
        15000,
      ),
    );
    record(
      mode,
      'hmr',
      'no duplicate App.css style tag after CSS HMR',
      (await cdp.evalJs(
        `document.querySelectorAll(${JSON.stringify(APP_CSS_STYLE_SELECTOR)}).length`,
      )) === 1,
    );
  } finally {
    writeFileSync(cssFile, originalCss);
  }
}

async function runBrowserChecks(mode, origin, { hmr, devCss, expectCompiler } = {}) {
  const chrome = startProcess(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=/tmp/turnkey-chrome-${mode}`,
    '--no-first-run',
    '--disable-extensions',
    'about:blank',
  ]);
  const cdp = await connectChrome();
  try {
    cdp.exceptions.length = 0;
    await cdp.send('Page.navigate', { url: origin + '/' });
    await cdp.waitFor('document.readyState === "complete"');
    await new Promise((r) => setTimeout(r, 750));

    const hydrationErrs = cdp.exceptions.filter((e) => /hydrat|mismatch/i.test(e));
    record(
      mode,
      'browser',
      'clean hydration (no hydration console errors)',
      hydrationErrs.length === 0,
      hydrationErrs.join(' | '),
    );

    await cdp.evalJs('document.querySelector("#increment").click()');
    await cdp.evalJs('document.querySelector("#increment").click()');
    record(
      mode,
      'browser',
      'hydrated app is interactive (counter)',
      await cdp.waitFor('document.querySelector("#count")?.textContent === "2"'),
    );

    for (const call of CALLS) {
      await cdp.evalJs(`document.querySelector(${JSON.stringify(call.button)}).click()`);
      const ok = await cdp.waitFor(
        `document.querySelector(${JSON.stringify(call.target)})?.textContent === ${JSON.stringify(call.expected)}`,
      );
      const actual = ok
        ? call.expected
        : await cdp.evalJs(`document.querySelector(${JSON.stringify(call.target)})?.textContent`);
      record(
        mode,
        'rpc',
        call.name,
        ok,
        `${call.target}: ${JSON.stringify(actual)} != ${JSON.stringify(call.expected)}`,
      );
    }

    record(
      mode,
      'browser',
      'streamed content settled in the DOM',
      (await cdp.evalJs('document.querySelector("#streamed")?.textContent')) ===
        'STREAMED-ASYNC-CONTENT',
    );

    // The clientOnly swap runs post-settle: the real widget must land and
    // replace the SSR'd fallback.
    record(
      mode,
      'browser',
      'clientOnly widget swapped in after settle',
      await cdp.waitFor(
        'document.querySelector("#client-only-widget")?.textContent === "CLIENT-ONLY-WIDGET"',
      ),
    );
    record(
      mode,
      'browser',
      'clientOnly fallback removed after swap',
      (await cdp.evalJs('document.querySelector("#client-only-fallback")')) === null,
    );

    // App.css actually applies after hydration, dev and prod alike.
    record(
      mode,
      'browser',
      'App.css styles applied (computed color)',
      (await cdp.evalJs('getComputedStyle(document.querySelector("#title")).color')) ===
        APP_CSS_COLOR,
    );

    if (devCss) {
      // Exactly one active style element for the dev id after hydration:
      // Vite's client either adopts the SSR'd tag on startup (seeding its
      // registry from the DOM) or, when it injects its own twin, the dev
      // style patch drops the SSR'd copy (data-asset). Either way a
      // duplicate means double style application — the bug being guarded.
      record(
        mode,
        'browser',
        'exactly one App.css style tag after hydration (dedup)',
        (await cdp.evalJs(
          `document.querySelectorAll(${JSON.stringify(APP_CSS_STYLE_SELECTOR)}).length`,
        )) === 1,
      );
    }

    const errs = cdp.exceptions.filter((e) => !/favicon/i.test(e));
    record(mode, 'browser', 'no page errors', errs.length === 0, errs.join(' | '));

    if (hmr) {
      await runHmrChecks(mode, cdp, origin, { expectCompiler });
    }
  } finally {
    cdp.close();
    const exited = new Promise((r) => chrome.once('exit', r));
    try {
      process.kill(-chrome.pid, 'SIGTERM');
    } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    try {
      rmSync(`/tmp/turnkey-chrome-${mode}`, { recursive: true, force: true, maxRetries: 5 });
    } catch {}
  }
}

async function runDevMode() {
  const mode = 'dev';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const port = 3160;
  const origin = `http://localhost:${port}`;

  // Cold start: clear Vite's dep cache so the dependency scanner actually
  // runs. The scanner crawls the RAW graph from the plugin's injected scan
  // entries (App.tsx) straight through the 'use server' module into
  // src/db.ts's `server-only` import — the boundary guard must not treat
  // that as a client-graph violation (it aborts the whole scan with a
  // "Failed to run dependency scan" banner), asserted below once the mode's
  // requests have let the optimizer finish.
  rmSync(path.join(exampleDir, 'node_modules/.vite'), { recursive: true, force: true });

  // The start-mode promise: the dev server is the plain `vite` CLI.
  const server = startProcess('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
    cwd: exampleDir,
    env: { ...process.env },
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  try {
    // Wait on a plain module transform instead of `/` so nothing has touched
    // the SSR environment before the cold-dispatch checks below.
    await waitForHttp(origin + '/src/api.ts', 30000);

    // ---- Server functions first: cold dispatch, no wiring ---------------
    // The SSR environment has rendered nothing yet, so the middleware must
    // map the function ID to its module via the compiler manifest and load
    // it before dispatching.
    const clientModule = await (await fetch(origin + '/src/api.ts')).text();
    record(
      mode,
      'sf',
      'client module compiled to references',
      clientModule.includes('createServerReference'),
    );
    record(mode, 'sf', 'secret absent from transformed module', !clientModule.includes(SECRET));
    const functionId = extractFunctionId(clientModule, 'getServerMessage');
    // POST-only by default in @solidjs/web 2.0; args still come
    // from the query string when no instance header is present.
    const cold = functionId
      ? await fetch(
          `${origin}/_server?id=${encodeURIComponent(functionId)}&args=${encodeURIComponent('["turnkey"]')}`,
          { method: 'POST' },
        )
      : null;
    const coldText = cold ? await cold.text() : '';
    record(
      mode,
      'sf',
      'cold dispatch before any SSR render (dev middleware)',
      coldText === 'hello turnkey from the server',
      functionId ? `got ${JSON.stringify(coldText)}` : 'could not extract function id',
    );
    const bogus = await fetch(origin + '/_server?id=bogus-0');
    record(mode, 'sf', 'dev middleware rejects unknown id', bogus.status === 404);

    const html = await runSsrChecks(mode, origin);
    record(mode, 'dev', 'Vite client injected into <head>', html.includes('/@vite/client'));
    // The patch script's own source references the selector; match it inside
    // an inline <script> so the check can't be satisfied by a style tag.
    record(
      mode,
      'dev',
      'dev style patch injected',
      /<script>[^<]*style\[data-vite-dev-id\]/.test(html),
    );
    // The no-FOUC guarantee: the SSR response itself carries App.css inlined
    // as a dedup-ready style tag — not just the patch script, actual rules.
    const styleTag = /<style[^>]*data-vite-dev-id="[^"]*App\.css"[^>]*>([\s\S]*?)<\/style>/.exec(
      html,
    );
    record(
      mode,
      'dev',
      'entry CSS inlined in SSR head (App.css rules present)',
      !!styleTag && styleTag[1].includes('#title') && styleTag[1].includes(APP_CSS_COLOR),
      styleTag ? `style content: ${JSON.stringify(styleTag[1].slice(0, 120))}` : 'no App.css style tag',
    );
    record(
      mode,
      'dev',
      'inlined SSR style marked data-asset (dedup patch contract)',
      !!styleTag && styleTag[0].includes('data-asset='),
    );
    record(
      mode,
      'dev',
      'generated client entry script injected',
      html.includes('/@id/virtual:solid-ssr-entry-client.tsx'),
    );
    // Tree-shaking guarantee: `serverFunctions.components` is pure codegen,
    // so with the option off the generated entries must not reference the
    // server-components runtime at all (guards against the wiring becoming
    // an unconditional import behind a runtime flag).
    const generatedEntry = await (
      await fetch(origin + '/@id/virtual:solid-ssr-entry-client.tsx')
    ).text();
    record(
      mode,
      'dce',
      'no server-components runtime in generated client entry (option off)',
      !generatedEntry.includes('installServerComponents') &&
        !generatedEntry.includes('@solidjs/web/frames'),
    );

    await runHttpChecks(mode, origin);

    await runLazyAssetChecks(mode, origin, { dev: true });

    await runBrowserChecks(mode, origin, { hmr: true, devCss: true, expectCompiler: 'native' });

    // ---- Cold-start dep scan (boundary-guard false positive) -------------
    // Counterpart: the ssr example's boundary.mjs proves the guard still
    // errors on real client-graph imports of 'server-only'.
    record(
      mode,
      'scan',
      'dep scan completed (no failure banner)',
      !serverLog.includes('Failed to run dependency scan'),
      serverLog.slice(-1000),
    );
    record(
      mode,
      'scan',
      'dependency pre-bundling wrote its metadata',
      existsSync(path.join(exampleDir, 'node_modules/.vite/deps/_metadata.json')),
    );
  } catch (e) {
    record(
      mode,
      'run',
      'mode completed',
      false,
      String(e) + (serverLog ? `\nserver: ${serverLog.slice(-2000)}` : ''),
    );
  } finally {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
  }
}

async function runProdMode() {
  const mode = 'prod';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const port = 3161;
  const origin = `http://localhost:${port}`;

  console.log('  building…');
  // The start-mode promise: one plain `vite build` produces both bundles.
  execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe' });
  record(
    mode,
    'build',
    'client bundle + manifest emitted',
    existsSync(path.join(exampleDir, 'dist/client/.vite/manifest.json')),
  );
  record(
    mode,
    'build',
    'server handler bundle emitted',
    existsSync(path.join(exampleDir, 'dist/server/server.js')),
  );
  // The virtual handler's manifest import must keep the registrations in the
  // SSR bundle even though the render graph also reaches them.
  const serverBundle = readFileSync(path.join(exampleDir, 'dist/server/server.js'), 'utf-8');
  const builtHandler = await import(
    pathToFileURL(path.join(exampleDir, 'dist/server/server.js')).href + `?fetchable=${Date.now()}`
  );
  record(
    mode,
    'build',
    'server handler exposes a default Fetchable entry',
    typeof builtHandler.default?.fetch === 'function',
  );
  const fetchableResponse = await builtHandler.default.fetch(
    new Request(origin + '/'),
    // Fetch hosts commonly pass bindings and execution context after the
    // request. The wrapper must ignore them rather than forwarding this
    // object as handleRequest's Solid options bag.
    { clientEntry: '/provider-argument-must-not-be-forwarded.js' },
  );
  const fetchableHtml = await fetchableResponse.text();
  record(
    mode,
    'build',
    'default Fetchable ignores provider arguments',
    fetchableResponse.status === 200 &&
      fetchableHtml.includes('SSR Start Mode') &&
      !fetchableHtml.includes('provider-argument-must-not-be-forwarded'),
  );
  const nonceResponse = await builtHandler.handleRequest(new Request(origin + '/'), {
    nonce: 'test"<&',
  });
  const nonceHtml = await nonceResponse.text();
  record(
    mode,
    'build',
    'client entry carries the escaped CSP nonce',
    nonceHtml.includes('<script type="module" nonce="test&quot;&lt;&amp;" src="'),
  );
  record(
    mode,
    'build',
    'server-function registrations bundled eagerly',
    serverBundle.includes('registerServerReference'),
  );
  // Every client asset must be free of the module-level secret.
  const assetsDir = path.join(exampleDir, 'dist/client/assets');
  const leaks = readdirSync(assetsDir).filter((f) =>
    readFileSync(path.join(assetsDir, f), 'utf-8').includes(SECRET),
  );
  record(mode, 'dce', 'secret absent from client assets', leaks.length === 0, leaks.join(', '));
  // Tree-shaking guarantee: with `serverFunctions.components` off, neither
  // bundle may reference the server-components runtime — the client via the
  // minification-proof runtime marker, the (unminified) server bundle via
  // the emitted import/transform names.
  const scLeaks = readdirSync(assetsDir).filter((f) => {
    const source = readFileSync(path.join(assetsDir, f), 'utf-8');
    return source.includes(FRAMES_CLIENT_RUNTIME_MARKER) || source.includes('installServerComponents');
  });
  record(
    mode,
    'dce',
    'no server-components runtime in client assets (option off)',
    scLeaks.length === 0,
    scLeaks.join(', '),
  );
  record(
    mode,
    'dce',
    'no server-components transform in server bundle (option off)',
    !serverBundle.includes('@solidjs/web/frames') && !serverBundle.includes('frameTransformResult'),
  );

  const server = startProcess('node', ['server.js'], {
    cwd: exampleDir,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  try {
    await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });

    const bogus = await fetch(origin + '/_server?id=bogus-0');
    record(mode, 'sf', 'prod handler rejects unknown id', bogus.status === 404);

    const html = await runSsrChecks(mode, origin);
    record(
      mode,
      'prod',
      'hashed client entry script injected',
      /<script type="module" src="\/assets\/[^"]+\.js" async><\/script>/.test(html),
    );
    record(
      mode,
      'prod',
      'entry css linked',
      /<link rel="stylesheet" href="\/assets\/[^"]+\.css">/.test(html),
    );
    record(mode, 'prod', 'no dev injections leaked', !html.includes('/@vite/client'));

    // clientOnly preload contract (compiler 0.50.0-next.35 + @solidjs/web
    // 2.0): the module-URL pass annotates the clientOnly() call,
    // the server half resolves the chunk through the client manifest and
    // emits a PLAIN modulepreload hint. The chunk URL must appear exactly
    // once in the document — the link only, never a hydration asset map
    // entry (the module is not required for hydration; the fallback is what
    // hydrates).
    const clientManifest = JSON.parse(
      readFileSync(path.join(exampleDir, 'dist/client/.vite/manifest.json'), 'utf-8'),
    );
    const widgetKey = Object.keys(clientManifest).find((k) => k.endsWith('ClientOnlyWidget.tsx'));
    const widgetFile = widgetKey && clientManifest[widgetKey].file;
    record(
      mode,
      'prod',
      'clientOnly chunk emitted and manifest-keyed',
      !!widgetFile,
      `manifest keys: ${Object.keys(clientManifest).slice(0, 10).join(', ')}`,
    );
    record(
      mode,
      'prod',
      'clientOnly chunk modulepreload hint in SSR head',
      !!widgetFile && html.includes(`<link rel="modulepreload" href="/${widgetFile}">`),
    );
    record(
      mode,
      'prod',
      'clientOnly chunk absent from hydration asset map (URL appears once)',
      !!widgetFile && html.split(widgetFile).length - 1 === 1,
      widgetFile ? `${html.split(widgetFile).length - 1} occurrence(s)` : '',
    );

    await runHttpChecks(mode, origin);

    await runLazyAssetChecks(mode, origin, { dev: false });

    await runBrowserChecks(mode, origin);
  } catch (e) {
    record(
      mode,
      'run',
      'mode completed',
      false,
      String(e) + (serverLog ? `\nserver: ${serverLog.slice(-2000)}` : ''),
    );
  } finally {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
  }
}

// Document escape hatch: a separate dev server with `start.document` pointing
// at src/CustomDocument.tsx (via SSR_DOCUMENT in vite.config.ts); the custom
// shell's <title> must show up in the SSR output. No browser needed.
async function runDocumentMode() {
  const mode = 'document';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const port = 3162;
  const origin = `http://localhost:${port}`;

  const server = startProcess('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
    cwd: exampleDir,
    env: { ...process.env, SSR_DOCUMENT: './src/CustomDocument.tsx' },
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  try {
    await waitForHttp(origin + '/src/api.ts', 30000);
    const { html } = await fetchStreamed(origin + '/');
    record(
      mode,
      'document',
      'custom document shell rendered',
      html.includes('<title>Custom Document</title>'),
    );
    record(mode, 'document', 'app rendered inside custom shell', html.includes('SSR Start Mode'));
  } catch (e) {
    record(
      mode,
      'run',
      'mode completed',
      false,
      String(e) + (serverLog ? `\nserver: ${serverLog.slice(-2000)}` : ''),
    );
  } finally {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
  }
}

// Conventional entries: authored src/entry-server.tsx / src/entry-client.tsx
// (written temporarily) take precedence over the generated ones. Dev serves
// them as-is; the prod handler rewrites the authored `/src/entry-client.tsx`
// script reference to the hashed asset (the classic harness convention).
const ENTRY_FIXTURES = {
  'src/TestShell.tsx': `import type { ParentProps } from 'solid-js';
import { HydrationScript } from '@solidjs/web';
import App from './App';

export default function TestShell() {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Authored Entries</title>
        <HydrationScript />
      </head>
      <body>
        <App />
        <script type="module" src="/src/entry-client.tsx" async />
      </body>
    </html>
  );
}
`,
  'src/entry-server.tsx': `import { renderToStream } from '@solidjs/web';
import manifest from 'virtual:solid-manifest';
import TestShell from './TestShell';

export function render() {
  return renderToStream(() => <TestShell />, { manifest });
}
`,
  'src/entry-client.tsx': `import { hydrate } from '@solidjs/web';
import TestShell from './TestShell';

hydrate(() => <TestShell />, document);
`,
};

async function runEntriesMode() {
  const mode = 'entries';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const port = 3163;
  const origin = `http://localhost:${port}`;

  for (const [file, source] of Object.entries(ENTRY_FIXTURES)) {
    writeFileSync(path.join(exampleDir, file), source);
  }
  let server;
  try {
    server = startProcess('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
      cwd: exampleDir,
      env: { ...process.env },
    });
    await waitForHttp(origin + '/src/api.ts', 30000);
    const { html } = await fetchStreamed(origin + '/');
    record(
      mode,
      'dev',
      'authored entries used (custom title)',
      html.includes('<title>Authored Entries</title>'),
    );
    record(
      mode,
      'dev',
      'authored client entry served as-is',
      html.includes('src="/src/entry-client.tsx"') &&
        !html.includes('virtual:solid-ssr-entry-client'),
    );
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
    server = undefined;

    console.log('  building…');
    execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe' });
    server = startProcess('node', ['server.js'], {
      cwd: exampleDir,
      env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
    });
    await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });
    const prod = await fetchStreamed(origin + '/');
    record(
      mode,
      'prod',
      'authored entries rendered in prod',
      prod.html.includes('<title>Authored Entries</title>'),
    );
    record(
      mode,
      'prod',
      'client entry reference rewritten to hashed asset',
      !prod.html.includes('/src/entry-client.tsx') &&
        /<script type="module" src="\/assets\/[^"]+\.js" async>/.test(prod.html),
    );
    await runBrowserChecks(mode, origin);
  } catch (e) {
    record(mode, 'run', 'mode completed', false, String(e));
  } finally {
    if (server) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {}
    }
    for (const file of Object.keys(ENTRY_FIXTURES)) {
      rmSync(path.join(exampleDir, file), { force: true });
    }
    // Leave dist in the generated-entries state for anyone poking at it.
    try {
      execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe' });
    } catch {}
  }
}

// Endpoint override: a separate dev server with `serverFunctions.endpoint`
// set, asserting the option threads through the middleware and the runtime
// configure calls appended to compiled client modules. No browser needed —
// the endpoint is exercised over plain HTTP.
async function runEndpointMode() {
  const mode = 'endpoint';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const port = 3164;
  const origin = `http://localhost:${port}`;
  const endpoint = '/custom-fn-endpoint';

  const server = startProcess('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
    cwd: exampleDir,
    env: { ...process.env, SERVER_FN_ENDPOINT: endpoint },
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  try {
    await waitForHttp(origin + '/src/api.ts', 30000);

    const clientModule = await (await fetch(origin + '/src/api.ts')).text();
    record(
      mode,
      'config',
      'client module configures the custom endpoint',
      clientModule.includes('configureServerFunctionsClient') && clientModule.includes(endpoint),
    );

    const functionId = extractFunctionId(clientModule, 'getServerMessage');
    const custom = functionId
      ? await fetch(
          `${origin}${endpoint}?id=${encodeURIComponent(functionId)}&args=${encodeURIComponent('["endpoint"]')}`,
          { method: 'POST' },
        )
      : null;
    const customText = custom ? await custom.text() : '';
    record(
      mode,
      'rpc',
      'middleware serves the custom endpoint',
      customText === 'hello endpoint from the server',
      functionId ? `got ${JSON.stringify(customText)}` : 'could not extract function id',
    );

    const fallback = await fetch(`${origin}/_server?id=${encodeURIComponent(functionId || '')}`);
    record(
      mode,
      'rpc',
      'default endpoint no longer handled',
      fallback.status !== 200,
      `status ${fallback.status}`,
    );
  } catch (e) {
    record(
      mode,
      'run',
      'mode completed',
      false,
      String(e) + (serverLog ? `\nserver: ${serverLog.slice(-2000)}` : ''),
    );
  } finally {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
  }
}

// `serverFunctions.configure`: SERVER_FN_CONFIGURE=1 pins src/serverConfig.ts
// into the `virtual:solid-server-function-handler` graph. Its
// `transformResult` hook rewrites the configureProbe result and stamps a
// response header — both observable over plain HTTP, so no browser needed.
// Asserted where it matters:
// - dev, cold: the very first request to the server is the dispatch itself
//   (nothing has rendered in the SSR environment), so the hook being live
//   proves the module rides the handler graph — immune to the dev-restart
//   race where app-graph registration only loads with the first render,
// - dev, HMR: an edit to the configure module must invalidate the handler
//   (the import edge) so the next dispatch sees the new config, no restart,
// - prod: the module is bundled into the handler chunk (marker in the server
//   bundle, absent from client assets) and the same dispatch observes it.
async function runConfigureMode() {
  const mode = 'configure';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const port = 3168;
  const origin = `http://localhost:${port}`;
  const env = { ...process.env, SERVER_FN_CONFIGURE: '1' };
  const configFile = path.join(exampleDir, 'src/serverConfig.ts');
  const originalConfigSource = readFileSync(configFile, 'utf-8');

  let server;
  let serverLog = '';
  const captureLog = (child) => {
    child.stdout.on('data', (d) => (serverLog += d));
    child.stderr.on('data', (d) => (serverLog += d));
  };
  const dispatch = async (id) => {
    const res = await fetch(
      `${origin}/_server?id=${encodeURIComponent(id)}&args=${encodeURIComponent('[]')}`,
      { method: 'POST' },
    );
    return {
      status: res.status,
      header: res.headers.get('x-configure-module'),
      body: await res.text(),
    };
  };
  let functionId = null;
  try {
    // ---- Dev --------------------------------------------------------------
    server = startProcess('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
      cwd: exampleDir,
      env,
    });
    captureLog(server);
    await waitForHttp(origin + '/src/api.ts', 30000);
    const clientModule = await (await fetch(origin + '/src/api.ts')).text();
    functionId = extractFunctionId(clientModule, 'configureProbe');
    const cold = functionId ? await dispatch(functionId) : null;
    record(
      mode,
      'dev',
      'configure hook live on cold dispatch (value transformed)',
      cold?.body.includes('configure-probe+transformed'),
      functionId ? JSON.stringify(cold) : 'could not extract function id',
    );
    record(
      mode,
      'dev',
      'configure hook header stamped',
      cold?.header === 'configure-v1',
      JSON.stringify(cold),
    );

    writeFileSync(configFile, originalConfigSource.replace(/configure-v1/g, 'configure-v2'));
    let hot = cold;
    const deadline = Date.now() + 15000;
    while (functionId && Date.now() < deadline && hot?.header !== 'configure-v2') {
      await new Promise((r) => setTimeout(r, 250));
      hot = await dispatch(functionId);
    }
    record(
      mode,
      'hmr',
      'configure module edit hot-applies to the handler graph',
      hot?.header === 'configure-v2',
      JSON.stringify(hot),
    );
    writeFileSync(configFile, originalConfigSource);
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
    server = undefined;

    // ---- Prod -------------------------------------------------------------
    console.log('  building…');
    execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe', env });
    const serverBundle = readFileSync(path.join(exampleDir, 'dist/server/server.js'), 'utf-8');
    record(
      mode,
      'build',
      'configure module bundled into the handler chunk',
      serverBundle.includes('x-configure-module'),
    );
    const assetsDir = path.join(exampleDir, 'dist/client/assets');
    const leaks = readdirSync(assetsDir).filter((f) =>
      readFileSync(path.join(assetsDir, f), 'utf-8').includes('x-configure-module'),
    );
    record(
      mode,
      'build',
      'configure module absent from client assets',
      leaks.length === 0,
      leaks.join(', '),
    );

    server = startProcess('node', ['server.js'], {
      cwd: exampleDir,
      env: { ...env, PORT: String(port), NODE_ENV: 'production' },
    });
    captureLog(server);
    await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });
    // Production ids are the dev id minus its dev-only trailing `-name`
    // segment (`hash-count` vs `hash-count-name`), so the dev phase's id
    // carries over. Dispatch before any page render, like dev.
    const prodId = functionId ? functionId.replace(/-configureProbe$/, '') : null;
    const prod = prodId ? await dispatch(prodId) : null;
    record(
      mode,
      'prod',
      'configure hook live in the prod handler (value transformed)',
      prod?.body.includes('configure-probe+transformed'),
      JSON.stringify(prod),
    );
    record(
      mode,
      'prod',
      'configure hook header stamped in prod',
      prod?.header === 'configure-v1',
      JSON.stringify(prod),
    );
  } catch (e) {
    record(
      mode,
      'run',
      'mode completed',
      false,
      String(e) + (serverLog ? `\nserver: ${serverLog.slice(-2000)}` : ''),
    );
  } finally {
    writeFileSync(configFile, originalConfigSource);
    if (server) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {}
    }
    // Leave dist in the standard state for anyone poking at it.
    try {
      execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe' });
    } catch {}
  }
}

// `serverFunctions.devMiddleware: false`: a dev server whose `/_server` the
// plugin no longer owns. Compilation must keep working (the module still
// compiles to references) while an endpoint POST falls through to Vite's
// 404. Then test/host-dispatch.mjs emulates the host that owns dispatch
// instead (a metaframework or an environment plugin like
// @cloudflare/vite-plugin): manifest + handler virtual modules loaded
// through `ssrLoadModule`, request dispatched like production.
async function runNoMiddlewareMode() {
  const mode = 'no-middleware';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const port = 3169;
  const origin = `http://localhost:${port}`;
  const env = { ...process.env, SERVER_FN_DEV_MIDDLEWARE: '0' };

  const server = startProcess('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
    cwd: exampleDir,
    env,
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  try {
    await waitForHttp(origin + '/src/api.ts', 30000);

    const clientModule = await (await fetch(origin + '/src/api.ts')).text();
    record(
      mode,
      'compile',
      'compilation still on (client module compiled to references)',
      clientModule.includes('createServerReference'),
    );
    record(mode, 'compile', 'secret absent from transformed module', !clientModule.includes(SECRET));

    const functionId = extractFunctionId(clientModule, 'getServerMessage');
    const res = functionId
      ? await fetch(
          `${origin}/_server?id=${encodeURIComponent(functionId)}&args=${encodeURIComponent('["nobody"]')}`,
          { method: 'POST' },
        )
      : null;
    const body = res ? await res.text() : '';
    record(
      mode,
      'dev',
      'middleware does not intercept /_server (request falls through, 404)',
      res?.status === 404,
      functionId ? `status ${res?.status}` : 'could not extract function id',
    );
    record(
      mode,
      'dev',
      'no server-function result served by the dev server',
      !body.includes('hello nobody from the server'),
      JSON.stringify(body.slice(0, 120)),
    );

    // The host's side of the contract, in-process against the dev API.
    let hostOut = '';
    let hostOk = false;
    try {
      hostOut = execSync('node test/host-dispatch.mjs', {
        cwd: exampleDir,
        env,
        stdio: 'pipe',
        timeout: 120000,
      }).toString();
      hostOk = true;
    } catch (e) {
      hostOut = String(e.stdout || '') + String(e.stderr || '');
    }
    record(
      mode,
      'host',
      'host-owned dispatch through the handler module works',
      hostOk && hostOut.includes('HOST-DISPATCH 200 hello host from the server'),
      hostOut.slice(-500),
    );
    record(
      mode,
      'host',
      'options.event reaches the standalone handler event (nativeEvent echo)',
      hostOk && hostOut.includes('HOST-DISPATCH-NATIVE 200 198.51.100.7'),
      hostOut.slice(-500),
    );
  } catch (e) {
    record(
      mode,
      'run',
      'mode completed',
      false,
      String(e) + (serverLog ? `\nserver: ${serverLog.slice(-2000)}` : ''),
    );
  } finally {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
  }
}

// Builder-mode ordering: BUILD_SSR_FIRST=1 installs an adversarial
// `builder.buildApp` in vite.config.ts that builds the ssr environment
// before the client — the @cloudflare/vite-plugin shape that used to force
// users to hand-write a client-first ordering plugin. The plugin's own
// client-build-first hook must have built the client (manifest included)
// before that orchestrator runs, so the server bundle bakes real hashed
// assets instead of the manifest-less dev fallback. dist is cleaned first so
// a stale manifest from an earlier mode can't mask a regression.
async function runBuilderOrderMode() {
  const mode = 'builder-order';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const port = 3170;
  const origin = `http://localhost:${port}`;
  const env = { ...process.env, BUILD_SSR_FIRST: '1' };

  let server;
  let serverLog = '';
  try {
    rmSync(path.join(exampleDir, 'dist'), { recursive: true, force: true });
    console.log('  building…');
    execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe', env });
    record(
      mode,
      'build',
      'client bundle + manifest emitted',
      existsSync(path.join(exampleDir, 'dist/client/.vite/manifest.json')),
    );
    const serverBundle = readFileSync(path.join(exampleDir, 'dist/server/server.js'), 'utf-8');
    record(
      mode,
      'build',
      'server bundle baked the client manifest (hashed assets, ordering held)',
      /"file":\s*"assets\//.test(serverBundle) && /"isEntry":\s*true/.test(serverBundle),
    );

    server = startProcess('node', ['server.js'], {
      cwd: exampleDir,
      env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
    });
    server.stdout.on('data', (d) => (serverLog += d));
    server.stderr.on('data', (d) => (serverLog += d));
    await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });
    const { html } = await fetchStreamed(origin + '/');
    record(mode, 'prod', 'app server-rendered', html.includes('SSR Start Mode'));
    record(
      mode,
      'prod',
      'hashed client entry script injected',
      /<script type="module" src="\/assets\/[^"]+\.js" async><\/script>/.test(html),
    );
  } catch (e) {
    record(
      mode,
      'run',
      'mode completed',
      false,
      String(e) + (serverLog ? `\nserver: ${serverLog.slice(-2000)}` : ''),
    );
  } finally {
    if (server) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {}
    }
    // Leave dist in the standard state for anyone poking at it.
    try {
      execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe' });
    } catch {}
  }
}

// Builder-mode preparation: BUILD_PRE_WIPE=1 installs a nitro-v3-shaped
// host in vite.config.ts — a pre-order `buildApp` hook that rm -rf's dist
// before anything builds (nitro's `nitro:prepare`) and a post-order
// orchestrator that builds the ssr environment, skipping anything already
// built (nitro's `nitro:main`). The regression under test: the plugin's
// client-build-first hook used to run at pre order, so it built the client
// *before* the wipe hook (which sorts later among pre hooks) deleted it —
// no client assets in the final output and a manifest-less fallback baked
// into the server bundle. At normal order the client build lands after
// every pre-order prepare hook while still preceding the host's post-order
// (and any config-level) server-first orchestration. The markers the host
// writes into dist prove the wipe really ran and that the ssr build was
// left to the host's orchestrator (the /complete hook must defer to a
// plugin that declares its own non-pre buildApp hook, not preempt its
// staged build).
async function runBuilderPrepareMode() {
  const mode = 'builder-prepare';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const port = 3171;
  const origin = `http://localhost:${port}`;
  const env = { ...process.env, BUILD_PRE_WIPE: '1' };

  let server;
  let serverLog = '';
  try {
    rmSync(path.join(exampleDir, 'dist'), { recursive: true, force: true });
    console.log('  building…');
    execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe', env });
    record(
      mode,
      'build',
      'adversarial pre-order wipe ran (marker present)',
      existsSync(path.join(exampleDir, 'dist/.pre-wipe')),
    );
    record(
      mode,
      'build',
      'client manifest survived the wipe (built after it)',
      existsSync(path.join(exampleDir, 'dist/client/.vite/manifest.json')),
    );
    const assetsDir = path.join(exampleDir, 'dist/client/assets');
    record(
      mode,
      'build',
      'hashed client assets survived the wipe',
      existsSync(assetsDir) && readdirSync(assetsDir).some((f) => f.endsWith('.js')),
    );
    const serverBundle = readFileSync(path.join(exampleDir, 'dist/server/server.js'), 'utf-8');
    record(
      mode,
      'build',
      'server bundle baked the client manifest (hashed assets, ordering held)',
      /"file":\s*"assets\//.test(serverBundle) && /"isEntry":\s*true/.test(serverBundle),
    );
    const hostBuilt = existsSync(path.join(exampleDir, 'dist/.host-built'))
      ? readFileSync(path.join(exampleDir, 'dist/.host-built'), 'utf-8')
      : '(missing)';
    record(
      mode,
      'build',
      "host's post-order orchestrator built ssr (plugin deferred, client already built)",
      hostBuilt === 'ssr',
      `.host-built: ${hostBuilt}`,
    );

    server = startProcess('node', ['server.js'], {
      cwd: exampleDir,
      env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
    });
    server.stdout.on('data', (d) => (serverLog += d));
    server.stderr.on('data', (d) => (serverLog += d));
    await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });
    const { html } = await fetchStreamed(origin + '/');
    record(mode, 'prod', 'app server-rendered', html.includes('SSR Start Mode'));
    record(
      mode,
      'prod',
      'hashed client entry script injected',
      /<script type="module" src="\/assets\/[^"]+\.js" async><\/script>/.test(html),
    );
  } catch (e) {
    record(
      mode,
      'run',
      'mode completed',
      false,
      String(e) + (serverLog ? `\nserver: ${serverLog.slice(-2000)}` : ''),
    );
  } finally {
    if (server) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {}
    }
    // Leave dist in the standard state for anyone poking at it.
    try {
      execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe' });
    } catch {}
  }
}

// Frames: server components (`use server` functions returning a function)
// enabled by the single config line `serverFunctions: { components: true }`
// (via SOLID_SERVER_COMPONENTS in vite.config.ts, which also points
// `start.app` at the server-components page). Everything else is the stock
// start-mode surface: generated entries carry the wiring the plugin emits for
// the option — the render plugin + direct-call transform in the server
// entry, installServerComponents() in the client entry (the _$SC registry
// self-bootstraps from serialized references; nothing is spliced into
// <head>) — and the untouched dev middleware / virtual prod handler
// serve component responses through the config-level response transform.
// The app surface (server component module, client Row wrapper, page) is
// permanent code in src/frames/.
const FRAMES_SECRET = 'SERVER-ROW-TEXT';
// Distinctive string literal from the server-components client runtime that
// survives minification — the positive/negative bundling probe.
const FRAMES_CLIENT_RUNTIME_MARKER = 'sc:region:';

// The frames assertion body, shared by dev and prod: document SSR +
// adoption, adopted-boundary morphs (including the dom-expressions#547
// nested-region case), a fresh (never-SSR'd) boundary's full loop, and a
// plain data server function on the same endpoint.
async function runFramesChecks(mode, origin) {
  // ---- The document over plain HTTP ------------------------------------
  const html = await (await fetch(origin + '/', { headers: { accept: 'text/html' } })).text();
  // (`panel:` not `panel:alpha`: hydration comment markers split the text.)
  // A boundary SSRs as a real <dx-frame data-fid> element
  // (display:contents); slot records remain comment markers.
  record(
    mode,
    'document',
    'server component SSR\'d inline (frame markers in document)',
    html.includes('panel:') &&
      html.includes('<dx-frame') &&
      html.includes('data-fid=') &&
      html.includes(':start-->'),
  );
  record(
    mode,
    'document',
    'server content exactly once in document',
    html.split(`${FRAMES_SECRET}-one`).length === 2,
  );
  record(mode, 'document', 't=0 slot records shipped (sc:slot)', html.includes('sc:slot:'));
  // The registry must be defined before any placeholder reference reads it.
  // Since runtime next.37 nothing is spliced into <head> (a head-open script
  // drifted every positional hydration claim after it): the FIRST serialized
  // server-component reference in each hydration script carries the registry
  // bootstrap as an idempotent expression, making definition and read
  // atomic. This document adopts its boundaries from markup and serializes
  // no reference, so `_$SC` absent entirely is the expected shape — what
  // must never appear is a bare `self._$SC.r(` read ahead of any
  // definition (the pre-splice crash: "Cannot read properties of undefined
  // (reading 'r')").
  const scFirst = html.indexOf('self._$SC');
  record(
    mode,
    'document',
    'no bare _$SC read before a definition (self-bootstrapping references, no head splice)',
    scFirst === -1 || html.startsWith('(self._$SC||(self._$SC={', scFirst - 1),
  );

  const chrome = startProcess(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=/tmp/turnkey-chrome-${mode}`,
    '--no-first-run',
    '--disable-extensions',
    'about:blank',
  ]);
  const cdp = await connectChrome();
  try {
    cdp.exceptions.length = 0;
    cdp.requests.length = 0;
    await cdp.send('Page.navigate', { url: origin + '/' });
    await cdp.waitFor('document.readyState === "complete"');
    await new Promise((r) => setTimeout(r, 750));

    // ---- Boot: hydration + t=0 adoption ---------------------------------
    const hydrationErrs = cdp.exceptions.filter((e) => /hydrat|mismatch/i.test(e));
    record(
      mode,
      'boot',
      'clean hydration (no hydration console errors)',
      hydrationErrs.length === 0,
      hydrationErrs.join(' | '),
    );
    record(
      mode,
      'boot',
      'panel server-rendered and adopted',
      (await cdp.evalJs('document.querySelector("#panel-name")?.textContent')) === 'panel:alpha',
    );
    const bootFetches = cdp.requests.filter((u) => u.includes('/_server'));
    record(
      mode,
      'boot',
      'zero /_server requests at boot (t=0 adoption)',
      bootFetches.length === 0,
      `${bootFetches.length} request(s)`,
    );
    await cdp.evalJs('document.querySelectorAll(".row-bump")[0].click()');
    await cdp.evalJs('document.querySelectorAll(".row-bump")[0].click()');
    record(
      mode,
      'boot',
      'client wrapper interactive on adopted DOM',
      await cdp.waitFor('document.querySelectorAll(".row-count")[0]?.textContent === "2"'),
    );
    await cdp.evalJs('document.querySelector("#draft").value = "typed-draft"');

    // ---- Adopted-boundary morphs ----------------------------------------
    cdp.requests.length = 0;
    await cdp.evalJs('document.querySelector("#refetch").click()');
    record(
      mode,
      'morph',
      'refetch morphs adopted boundary (version advances)',
      await cdp.waitFor('document.querySelector("#server-version")?.textContent === "version:1"'),
      `got ${JSON.stringify(await cdp.evalJs('document.querySelector("#server-version")?.textContent'))}`,
    );
    record(
      mode,
      'morph',
      'refetch went over /_server',
      cdp.requests.some((u) => u.includes('/_server')),
    );
    record(
      mode,
      'morph',
      'draft input (direct-insert slot) survives adopted morph',
      (await cdp.evalJs('document.querySelector("#draft")?.value')) === 'typed-draft',
    );
    await new Promise((r) => setTimeout(r, 300));
    const adoptedBodies = await cdp.evalJs('document.querySelectorAll(".rows .row-body").length');
    record(
      mode,
      'morph',
      'adopted nested regions survive first morph (dom-expressions#547)',
      adoptedBodies === 2,
      `${adoptedBodies}/2 row bodies left`,
    );
    await cdp.evalJs('document.querySelector("#nav-beta").click()');
    record(
      mode,
      'morph',
      'navigation re-renders adopted server content',
      await cdp.waitFor('document.querySelector("#panel-name")?.textContent === "panel:beta"'),
    );

    // ---- Fresh (never-SSR'd) boundary: the post-boot stream loop --------
    cdp.requests.length = 0;
    await cdp.evalJs('document.querySelector("#show-fresh").click()');
    record(
      mode,
      'fresh',
      'fresh boundary mounts from a post-boot stream',
      await cdp.waitFor('document.querySelector("#fresh-name")?.textContent === "fresh:beta"'),
    );
    record(
      mode,
      'fresh',
      'fresh mount fetched over /_server',
      cdp.requests.some((u) => u.includes('/_server')),
    );
    await new Promise((r) => setTimeout(r, 300));
    record(
      mode,
      'fresh',
      'fresh boundary renders nested regions',
      (await cdp.evalJs('document.querySelectorAll(".fresh-rows .row-body").length')) === 2,
    );
    await cdp.evalJs('document.querySelectorAll(".fresh-rows .row-bump")[0].click()');
    record(
      mode,
      'fresh',
      'fresh wrapper interactive',
      await cdp.waitFor('document.querySelectorAll(".fresh-rows .row-count")[0]?.textContent === "1"'),
    );
    await cdp.evalJs('window.__freshRow = document.querySelectorAll(".fresh-rows .row")[0]');

    await cdp.evalJs('document.querySelector("#refetch").click()');
    record(
      mode,
      'fresh',
      'fresh morph streams (fversion advances)',
      await cdp.waitFor(
        '/fversion:[0-9]+/.test(document.querySelector("#fresh-version")?.textContent) && document.querySelector("#fresh-version")?.textContent !== "fversion:1"',
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    record(
      mode,
      'fresh',
      'client wrapper state survives fresh morph (policy A)',
      (await cdp.evalJs('document.querySelectorAll(".fresh-rows .row-count")[0]?.textContent')) ===
        '1',
    );
    record(
      mode,
      'fresh',
      'client wrapper DOM identity survives fresh morph',
      await cdp.evalJs('window.__freshRow === document.querySelectorAll(".fresh-rows .row")[0]'),
    );
    record(
      mode,
      'fresh',
      'nested regions survive fresh morph',
      (await cdp.evalJs('document.querySelectorAll(".fresh-rows .row-body").length')) === 2,
    );

    // ---- Plain data server function + mutation on the same endpoint -----
    await cdp.evalJs('document.querySelector("#mutate").click()');
    record(
      mode,
      'data',
      'mutation via data server function reflected in next stream',
      await cdp.waitFor('/counter:[1-9]/.test(document.querySelector("#server-counter")?.textContent)'),
      `got ${JSON.stringify(await cdp.evalJs('document.querySelector("#server-counter")?.textContent'))}`,
    );
    record(
      mode,
      'data',
      'region content follows server input after morphs',
      await cdp.waitFor(
        'document.querySelectorAll(".fresh-rows .row-body")[0]?.textContent?.endsWith(":beta")',
      ),
    );

    // ---- Unmount → remount over the fragment-rooted boundary -------------
    // The page root is a fragment and the boundaries live under a reactive
    // page conditional, so the frame insertable sits in an array insert
    // position — the shape that used to crash insertBefore
    // (dom-expressions#550). Navigate away (tears the regions down) and
    // back: content must re-stream and reappear, and the remounted client
    // wrappers must be live (the StackBlitz disappearing-server-component
    // symptom). The trailing no-page-errors check covers the whole cycle.
    await cdp.evalJs('document.querySelector("#nav-away").click()');
    record(
      mode,
      'nav',
      'navigating away tears the boundaries down',
      await cdp.waitFor(
        '!document.querySelector("#panel-name") && !!document.querySelector("#away-page")',
      ),
    );
    await cdp.evalJs('document.querySelector("#nav-home").click()');
    record(
      mode,
      'nav',
      'boundary remounts after navigating back (dom-expressions#550)',
      await cdp.waitFor('document.querySelector("#panel-name")?.textContent === "panel:beta"'),
      `got ${JSON.stringify(await cdp.evalJs('document.querySelector("#panel-name")?.textContent'))}`,
    );
    record(
      mode,
      'nav',
      'remounted boundary renders nested regions',
      await cdp.waitFor('document.querySelectorAll(".rows .row-body").length === 2'),
    );
    await cdp.evalJs('document.querySelectorAll(".rows .row-bump")[0].click()');
    record(
      mode,
      'nav',
      'remounted wrapper interactive (no reactivity halt)',
      await cdp.waitFor('document.querySelectorAll(".rows .row-count")[0]?.textContent === "1"'),
    );

    const errs = cdp.exceptions.filter((e) => !/favicon/i.test(e));
    record(mode, 'browser', 'no page errors', errs.length === 0, errs.join(' | '));
  } finally {
    cdp.close();
    const exited = new Promise((r) => chrome.once('exit', r));
    try {
      process.kill(-chrome.pid, 'SIGTERM');
    } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    try {
      rmSync(`/tmp/turnkey-chrome-${mode}`, { recursive: true, force: true, maxRetries: 5 });
    } catch {}
  }
}

async function runFramesMode() {
  console.log(`\n=== FRAMES ===`);
  const devPort = 3166;
  const prodPort = 3167;
  // The one-line enablement under test: the env flag flips
  // `serverFunctions: { components: true }` + `start.app` in vite.config.ts.
  // No entry files — the plugin's generated entries carry all the wiring.
  const env = { ...process.env, SOLID_SERVER_COMPONENTS: '1' };

  let server;
  let serverLog = '';
  const captureLog = (child) => {
    child.stdout.on('data', (d) => (serverLog += d));
    child.stderr.on('data', (d) => (serverLog += d));
  };
  try {
    // ---- Dev: the plain `vite` CLI, frames through the dev middleware ----
    const devOrigin = `http://localhost:${devPort}`;
    server = startProcess('pnpm', ['exec', 'vite', '--port', String(devPort), '--strictPort'], {
      cwd: exampleDir,
      env,
    });
    captureLog(server);
    await waitForHttp(devOrigin + '/src/frames/data.tsx', 30000);
    // The option's generated client entry is the whole client-side wiring —
    // fetching it doubles as a pre-warm of the client transform graph.
    const entryClient = await (
      await fetch(devOrigin + '/@id/virtual:solid-ssr-entry-client.tsx')
    ).text();
    record(
      'frames-dev',
      'wiring',
      'generated client entry installs server components',
      entryClient.includes('installServerComponents'),
    );
    await new Promise((r) => setTimeout(r, 1500));
    const clientModule = await (await fetch(devOrigin + '/src/frames/data.tsx')).text();
    record(
      'frames-dev',
      'dce',
      'server JSX absent from transformed client module',
      !clientModule.includes(FRAMES_SECRET),
    );
    record(
      'frames-dev',
      'dce',
      'client module compiled to references',
      clientModule.includes('createServerReference'),
    );
    await runFramesChecks('frames-dev', devOrigin);
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
    server = undefined;

    // ---- Prod: one `vite build`, frames through the virtual handler ------
    console.log('  building…');
    execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe', env });
    const assetsDir = path.join(exampleDir, 'dist/client/assets');
    const leaks = readdirSync(assetsDir).filter((f) =>
      readFileSync(path.join(assetsDir, f), 'utf-8').includes(FRAMES_SECRET),
    );
    record(
      'frames-prod',
      'dce',
      'server JSX absent from client assets',
      leaks.length === 0,
      leaks.join(', '),
    );
    record(
      'frames-prod',
      'wiring',
      'server-components client runtime bundled (option codegen)',
      readdirSync(assetsDir).some((f) =>
        readFileSync(path.join(assetsDir, f), 'utf-8').includes(FRAMES_CLIENT_RUNTIME_MARKER),
      ),
    );
    const prodOrigin = `http://localhost:${prodPort}`;
    server = startProcess('node', ['server.js'], {
      cwd: exampleDir,
      env: { ...env, PORT: String(prodPort), NODE_ENV: 'production' },
    });
    captureLog(server);
    await waitForHttp(prodOrigin + '/', 30000, { headers: { accept: 'text/html' } });
    await runFramesChecks('frames-prod', prodOrigin);
  } catch (e) {
    record(
      'frames',
      'run',
      'mode completed',
      false,
      String(e) + (serverLog ? `\nserver: ${serverLog.slice(-2000)}` : ''),
    );
  } finally {
    if (server) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {}
    }
    // Leave dist in the standard (no server components) state for anyone
    // poking at it.
    try {
      execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe' });
    } catch {}
  }
}

// `start.middleware`: SSR_MIDDLEWARE=1 wires src/middleware.ts (two fetch-style
// functions, composed in order) through the generated handler. Asserted over
// plain HTTP in dev and prod (the same chain fronts both):
// - composition + the post-next() window: the streamed page carries headers
//   the outermost middleware set AFTER awaiting next() — while the body
//   still streams (multiple chunks, late content present), proving nothing
//   hit the wire before the chain unwound,
// - locals decoration visible to the page render (/whoami) and to a server
//   function over /_server (the endpoint shares the chain's request event),
// - short-circuit (/blocked never reaches the render), and the handler
//   edge's commit fold: the stub cookie the middleware appended inside the
//   request scope arrives on the early-return Response exactly once,
// - error middleware (/boom: a render throw becomes the middleware's 500).
async function runMiddlewareChecksOverHttp(mode, origin, functionId) {
  const page = await fetchStreamed(origin + '/');
  record(
    mode,
    'mw',
    'middleware composed in order (x-mw-order header)',
    page.headers.get('x-mw-order') === 'first,second',
    `x-mw-order: ${JSON.stringify(page.headers.get('x-mw-order'))}`,
  );
  record(
    mode,
    'mw',
    'post-next() header mutation lands on a streamed response',
    page.headers.get('x-after-next') === 'set-after-next' &&
      page.chunks.length > 1 &&
      page.html.includes('STREAMED-ASYNC-CONTENT'),
    `x-after-next: ${JSON.stringify(page.headers.get('x-after-next'))}, ${page.chunks.length} chunk(s)`,
  );

  // (`mw-user` alone: hydration comment markers split the `user:` prefix
  // into its own text node.)
  const whoami = await fetchStreamed(origin + '/whoami');
  record(
    mode,
    'mw',
    'locals decoration visible to the page render',
    whoami.html.includes('mw-user'),
  );

  const blocked = await fetch(origin + '/blocked', { headers: { accept: 'text/html' } });
  const blockedBody = await blocked.text();
  record(
    mode,
    'mw',
    'middleware short-circuits before the render',
    blocked.status === 403 && blockedBody === 'blocked-by-middleware',
    `status ${blocked.status}, body ${JSON.stringify(blockedBody.slice(0, 60))}`,
  );
  // The early return skipped createSSRResponse, so the stub cookie the
  // middleware appended inside the request scope can only arrive through
  // the handler edge's commitEventResponse fold — and exactly once (the
  // fold is idempotent; nothing double-applies it).
  const blockedCookies = (blocked.headers.getSetCookie ? blocked.headers.getSetCookie() : []).filter(
    (cookie) => cookie.startsWith('mw-blocked='),
  );
  record(
    mode,
    'mw',
    'early-return stub cookie arrives exactly once (edge commit fold)',
    blockedCookies.length === 1 && blockedCookies[0].startsWith('mw-blocked=1'),
    `set-cookie: ${JSON.stringify(blockedCookies)}`,
  );

  const boom = await fetch(origin + '/boom', { headers: { accept: 'text/html' } });
  const boomBody = await boom.text();
  record(
    mode,
    'mw',
    'error middleware catches a render throw',
    boom.status === 500 && boom.headers.get('x-mw-caught') === '1' && boomBody.includes('boom-page'),
    `status ${boom.status}, body ${JSON.stringify(boomBody.slice(0, 60))}`,
  );

  // ---- API-style dispatch (dev must match prod: these run in both) -------
  // A fetch() client: non-HTML GET reaches the chain and sees the locals the
  // earlier middleware decorated.
  const info = await fetch(origin + '/api/info', { headers: { accept: 'application/json' } });
  const infoBody = info.ok ? await info.json() : null;
  record(
    mode,
    'mw',
    'API GET (non-HTML accept) dispatches through the chain',
    info.status === 200 && infoBody?.user === 'mw-user' && infoBody?.order?.join(',') === 'first,second',
    `status ${info.status}, body ${JSON.stringify(infoBody)}`,
  );

  // The `options.event` seam, live end to end: the plugin's dev/preview
  // middlewares and the prod Node entry (server.js) all pass the raw Node
  // request as `event: { nativeEvent: req }`, so getRequestEvent() inside
  // app code (the /api/native middleware route) sees the IncomingMessage —
  // with a readable loopback socket.remoteAddress — identically on every
  // surface.
  const native = await fetch(origin + '/api/native', { headers: { accept: 'application/json' } });
  const nativeBody = native.ok ? await native.json() : null;
  record(
    mode,
    'mw',
    'request event exposes nativeEvent (Node req, readable remote address)',
    native.status === 200 &&
      nativeBody?.hasNativeEvent === true &&
      typeof nativeBody?.remoteAddress === 'string' &&
      nativeBody.remoteAddress.length > 0,
    `status ${native.status}, body ${JSON.stringify(nativeBody)}`,
  );

  // POST with a JSON body: the node->web request bridge must carry the body.
  const echo = await fetch(origin + '/api/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ping: 'pong' }),
  });
  const echoBody = echo.ok ? await echo.json() : null;
  record(
    mode,
    'mw',
    'API POST body round-trips through the chain',
    echo.status === 200 && echoBody?.method === 'POST' && echoBody?.echoed?.ping === 'pong',
    `status ${echo.status}, body ${JSON.stringify(echoBody)}`,
  );

  // The no-JS form pattern: an HTML-accepting POST answered with a
  // post-redirect-get by the middleware.
  const form = await fetch(origin + '/form', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    body: new URLSearchParams({ name: 'solid' }).toString(),
  });
  record(
    mode,
    'mw',
    'no-JS form POST reaches the chain (303 redirect)',
    form.status === 303 && form.headers.get('location') === '/?submitted=solid',
    `status ${form.status}, location ${JSON.stringify(form.headers.get('location'))}`,
  );

  if (functionId) {
    const fn = await fetch(
      `${origin}/_server?id=${encodeURIComponent(functionId)}&args=${encodeURIComponent('[]')}`,
      { method: 'POST' },
    );
    const fnBody = await fn.text();
    record(
      mode,
      'mw',
      'server function sees middleware locals (shared request event)',
      fnBody === 'mw-user',
      `body ${JSON.stringify(fnBody.slice(0, 60))}`,
    );
    record(
      mode,
      'mw',
      'middleware fronts the /_server endpoint (headers on the response)',
      fn.headers.get('x-mw-order') === 'first,second',
      `x-mw-order: ${JSON.stringify(fn.headers.get('x-mw-order'))}`,
    );
  }

  // ---- Per-request app setup (start.setup, src/setup.tsx) ----------------
  // The hook runs between the middleware chain and renderToStream: its
  // marker carries the request pathname, the locals the middleware
  // decorated (ordering), and an invocation counter. It must land in the
  // FIRST chunk — the hook is awaited before the shell streams.
  const setupFirst = await fetchStreamed(origin + '/');
  const setupMarker = (html) => {
    const match = html.match(/setup:([^:<]*):([^:<]*):(\d+)/);
    return match && { pathname: match[1], user: match[2], seq: Number(match[3]) };
  };
  const first = setupMarker(setupFirst.html);
  record(
    mode,
    'setup',
    'setup hook ran with the event and middleware locals (marker in shell)',
    !!first && first.pathname === '/' && first.user === 'mw-user',
    first ? JSON.stringify(first) : 'no marker in html',
  );
  record(
    mode,
    'setup',
    'async setup completes before the shell flushes (marker in first chunk)',
    setupFirst.chunks.length > 0 && !!setupMarker(setupFirst.chunks[0]),
  );
  record(
    mode,
    'setup',
    'app still renders inside the setup-provided root',
    setupFirst.html.includes('SSR Start Mode'),
  );
  const setupSecond = await fetchStreamed(origin + '/');
  const second = setupMarker(setupSecond.html);
  record(
    mode,
    'setup',
    'setup runs per request (invocation counter advances)',
    !!first && !!second && second.seq > first.seq,
    `seq ${first?.seq} then ${second?.seq}`,
  );
}

async function runMiddlewareMode() {
  console.log(`\n=== MIDDLEWARE ===`);
  const devPort = 3172;
  const prodPort = 3173;
  // SSR_SETUP rides the middleware mode: the hook's contract (ordering
  // after the chain, shared locals) is only observable with a middleware
  // in front anyway.
  const env = { ...process.env, SSR_MIDDLEWARE: '1', SSR_SETUP: '1' };

  let server;
  let serverLog = '';
  const captureLog = (child) => {
    child.stdout.on('data', (d) => (serverLog += d));
    child.stderr.on('data', (d) => (serverLog += d));
  };
  let functionId = null;
  try {
    // ---- Codegen: the generated handler folds at the edge ----------------
    // String assertions on the handler module the plugin generates (no
    // execution): every response leaves through commitEventResponse —
    // a plain named import from @solidjs/web since the .40 repin collapsed
    // the local fallback — strictly AFTER the middleware chain unwinds, so
    // early-return Responses get their stub writes and post-next() header
    // mutation stays possible through the whole unwind.
    process.env.SSR_MIDDLEWARE = '1';
    process.env.SSR_SETUP = '1';
    let probe;
    try {
      probe = await createServer({ root: exampleDir, server: { middlewareMode: true } });
      const transformed = await probe.environments.ssr.transformRequest('virtual:solid-ssr-handler');
      const code = transformed?.code || '';
      const unwind = code.indexOf('runMiddleware(request');
      // The SSR transform rewrites the imported binding to a member access
      // on the vite import handle (`(0, handle.commitEventResponse)(...)`),
      // so match the rewritten call site rather than the source text.
      const fold = code.search(/\.commitEventResponse\s*\)?\s*\(\s*response,\s*event\s*\)/);
      record(
        'mw-codegen',
        'gen',
        'handler imports commitEventResponse from @solidjs/web (fallback collapsed by the .40 repin)',
        fold !== -1 && !code.includes('.commitEventResponse ??'),
      );
      record(
        'mw-codegen',
        'gen',
        'edge fold runs after the middleware chain unwinds',
        unwind !== -1 && fold !== -1 && fold > unwind,
        `runMiddleware @ ${unwind}, fold @ ${fold}`,
      );
      // The generated entry-server threads start.setup: awaited with the
      // request event before renderToStream, its result (or App) rendered.
      const entry = await probe.environments.ssr.transformRequest(
        'virtual:solid-ssr-entry-server.tsx',
      );
      const entryCode = entry?.code || '';
      // The SSR transform rewrites imported bindings (`setup` becomes a
      // member access on the import handle), so match the surviving locals:
      // the prepared setup result, and the boxed-stream protocol that keeps
      // an async setup from buffering the render (a promise resolving to
      // the stream bare would adopt its thenable).
      record(
        'mw-codegen',
        'gen',
        'generated entry threads start.setup and boxes the async stream',
        entryCode.includes('const prepared = ') &&
          entryCode.includes('__solidSetupStream'),
      );
      // The `options.event` seam on an external handleRequest call: a
      // host-shaped direct dispatch (no dev middleware involved) passes a
      // synthetic nativeEvent, and the event the app sees (the /api/native
      // middleware route reading getRequestEvent()) carries exactly those
      // fields — createRequestEvent(request, options.event) spreads them
      // over the event defaults.
      const handlerModule = await probe.ssrLoadModule('virtual:solid-ssr-handler');
      const seamResponse = await handlerModule.handleRequest(
        new Request('http://localhost/api/native', { headers: { accept: 'application/json' } }),
        { event: { nativeEvent: { socket: { remoteAddress: '203.0.113.7' } } } },
      );
      const seamBody = seamResponse.ok ? await seamResponse.json() : null;
      record(
        'mw-codegen',
        'event',
        'options.event spreads into the request event (external handleRequest)',
        seamResponse.status === 200 &&
          seamBody?.hasNativeEvent === true &&
          seamBody?.remoteAddress === '203.0.113.7',
        `status ${seamResponse.status}, body ${JSON.stringify(seamBody)}`,
      );
      // And without options at all the event creation stays safe (the init
      // spread is a no-op) — the same route answers with no nativeEvent.
      const bareResponse = await handlerModule.handleRequest(
        new Request('http://localhost/api/native', { headers: { accept: 'application/json' } }),
      );
      const bareBody = bareResponse.ok ? await bareResponse.json() : null;
      record(
        'mw-codegen',
        'event',
        'handleRequest without options.event keeps the default event shape',
        bareResponse.status === 200 && bareBody?.hasNativeEvent === false,
        `status ${bareResponse.status}, body ${JSON.stringify(bareBody)}`,
      );
    } finally {
      await probe?.close();
      delete process.env.SSR_MIDDLEWARE;
      delete process.env.SSR_SETUP;
    }

    // ---- Dev: the chain fronts the dev middlewares -----------------------
    const devOrigin = `http://localhost:${devPort}`;
    server = startProcess('pnpm', ['exec', 'vite', '--port', String(devPort), '--strictPort'], {
      cwd: exampleDir,
      env,
    });
    captureLog(server);
    await waitForHttp(devOrigin + '/src/api.ts', 30000);
    const clientModule = await (await fetch(devOrigin + '/src/api.ts')).text();
    functionId = extractFunctionId(clientModule, 'whoAmI');
    await runMiddlewareChecksOverHttp('mw-dev', devOrigin, functionId);
    // Dev-only: a non-page request the chain does NOT handle falls back to
    // Vite's pipeline (its 404) instead of getting the page rendered at it.
    const unhandledPost = await fetch(devOrigin + '/no-such-route', { method: 'POST' });
    const unhandledPostBody = await unhandledPost.text();
    record(
      'mw-dev',
      'mw',
      'unhandled non-page POST falls back to Vite (404, no rendered page)',
      // Connect's final handler answers ("Cannot POST ..."); a rendered dev
      // page would carry the vite client script instead.
      unhandledPost.status === 404 &&
        unhandledPostBody.includes('Cannot POST') &&
        !unhandledPostBody.includes('/@vite/client'),
      `status ${unhandledPost.status}, body ${JSON.stringify(unhandledPostBody.slice(0, 60))}`,
    );
    const unhandledGet = await fetch(devOrigin + '/no-such.json', {
      headers: { accept: 'application/json' },
    });
    record(
      'mw-dev',
      'mw',
      'unhandled non-HTML GET falls back to Vite (404)',
      unhandledGet.status === 404,
      `status ${unhandledGet.status}`,
    );
    // The lifecycle keeps working with middleware in front.
    await runHttpChecks('mw-dev', devOrigin);
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
    server = undefined;

    // ---- Prod: the same chain in the virtual handler ---------------------
    console.log('  building…');
    execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe', env });
    const prodOrigin = `http://localhost:${prodPort}`;
    server = startProcess('node', ['server.js'], {
      cwd: exampleDir,
      env: { ...env, PORT: String(prodPort), NODE_ENV: 'production' },
    });
    captureLog(server);
    await waitForHttp(prodOrigin + '/', 30000, { headers: { accept: 'text/html' } });
    // Prod ids drop the dev-only trailing `-name` segment.
    const prodId = functionId ? functionId.replace(/-whoAmI$/, '') : null;
    await runMiddlewareChecksOverHttp('mw-prod', prodOrigin, prodId);
    await runHttpChecks('mw-prod', prodOrigin);
  } catch (e) {
    record(
      'middleware',
      'run',
      'mode completed',
      false,
      String(e) + (serverLog ? `\nserver: ${serverLog.slice(-2000)}` : ''),
    );
  } finally {
    if (server) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {}
    }
    // Leave dist in the standard state for anyone poking at it.
    try {
      execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe' });
    } catch {}
  }
}

// `vite preview`: `vite build && vite preview` must serve the production
// artifact with no server file — dist/client statically (Vite's preview
// statics), everything else through the built handler (pages, /_server,
// the middleware chain, the response-head lifecycle).
async function runPreviewMode() {
  const mode = 'preview';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const port = 3174;
  const origin = `http://localhost:${port}`;
  // SSR_SETUP rides along like in middleware mode: the shared chain checks
  // assert the per-request setup hook, and preview must serve the built
  // entry that threads it exactly like dev and prod.
  const env = { ...process.env, SSR_MIDDLEWARE: '1', SSR_SETUP: '1' };

  let server;
  let serverLog = '';
  try {
    console.log('  building…');
    execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe', env });
    server = startProcess(
      'pnpm',
      ['exec', 'vite', 'preview', '--port', String(port), '--strictPort'],
      { cwd: exampleDir, env },
    );
    serverLog = '';
    server.stdout.on('data', (d) => (serverLog += d));
    server.stderr.on('data', (d) => (serverLog += d));
    await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });

    const page = await fetchStreamed(origin + '/');
    record(
      mode,
      'ssr',
      'preview serves the SSR page through the built handler',
      page.status === 200 && page.html.includes('SSR Start Mode'),
    );
    record(
      mode,
      'ssr',
      'preview response streams',
      page.chunks.length > 1 && page.html.includes('STREAMED-ASYNC-CONTENT'),
      `${page.chunks.length} chunk(s)`,
    );
    const entryMatch = /<script type="module" src="(\/assets\/[^"]+\.js)" async>/.exec(page.html);
    record(mode, 'ssr', 'hashed client entry script injected', !!entryMatch);
    if (entryMatch) {
      const asset = await fetch(origin + entryMatch[1]);
      record(
        mode,
        'static',
        'hashed client asset served statically from dist/client',
        asset.status === 200 && /javascript/.test(asset.headers.get('content-type') || ''),
        `status ${asset.status}, content-type ${asset.headers.get('content-type')}`,
      );
      await asset.arrayBuffer();
    }

    // The endpoint dispatches through the same handler.
    const bogus = await fetch(origin + '/_server?id=bogus-0', { method: 'POST' });
    record(mode, 'sf', 'preview dispatches /_server (unknown id rejected)', bogus.status === 404);

    // Middleware fronts preview exactly like dev and prod.
    record(
      mode,
      'mw',
      'middleware chain live under preview',
      page.headers.get('x-mw-order') === 'first,second' &&
        page.headers.get('x-after-next') === 'set-after-next',
      `x-mw-order: ${JSON.stringify(page.headers.get('x-mw-order'))}`,
    );
    // The full chain contract — API GETs/POSTs and no-JS form POSTs
    // included — holds under preview like dev and prod.
    await runMiddlewareChecksOverHttp(mode, origin, null);

    await runHttpChecks(mode, origin);
  } catch (e) {
    record(
      mode,
      'run',
      'mode completed',
      false,
      String(e) + (serverLog ? `\nserver: ${serverLog.slice(-2000)}` : ''),
    );
  } finally {
    if (server) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {}
    }
    // Leave dist in the standard state for anyone poking at it.
    try {
      execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe' });
    } catch {}
  }
}

// Non-root Vite `base` (SOLID_BASE=/app/): the base must hold end to end on
// every start-mode surface. Regression coverage for the brenelz base cluster:
// - #300: `vite preview` strips the base from req.url before the plugin's
//   post middleware runs, so the built handler's base-prefixed endpoint
//   comparison never matched — /app/_server fell through to page rendering
//   (HTML instead of the server-function response). The preview adapter now
//   restores the base before dispatch.
// - #298: dev SSR lazy asset URLs were emitted as "/" + key, which Vite
//   rejects outside the base; they must be base-prefixed (and root-external
//   modules must use /@fs/ URLs — covered by runLazyAssetChecks here and in
//   the default dev/prod modes).
// - #299 rides along via the same lazy-assets surface under a base.
// Also asserts the dev page dispatch restores the base (App sees
// production-shaped, base-prefixed request URLs) and the dev /_server
// endpoint round-trips under the base. No browser needed.
async function runBaseMode() {
  const mode = 'base';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const basePrefix = '/app';
  const env = { ...process.env, SOLID_BASE: '/app/' };

  // ---- dev under base ------------------------------------------------
  const devPort = 3176;
  const devOrigin = `http://localhost:${devPort}`;
  const devServer = startProcess(
    'pnpm',
    ['exec', 'vite', '--port', String(devPort), '--strictPort'],
    { cwd: exampleDir, env },
  );
  let devLog = '';
  devServer.stdout.on('data', (d) => (devLog += d));
  devServer.stderr.on('data', (d) => (devLog += d));

  try {
    await waitForHttp(devOrigin + basePrefix + '/src/api.ts', 30000);

    const page = await fetchStreamed(devOrigin + basePrefix + '/');
    record(
      mode,
      'dev',
      'SSR page served under the base',
      page.status === 200 && page.html.includes('SSR Start Mode'),
      `status ${page.status}`,
    );
    record(
      mode,
      'dev',
      'generated client entry injected base-prefixed',
      page.html.includes(`src="${basePrefix}/@id/virtual:solid-ssr-entry-client.tsx"`),
    );
    record(
      mode,
      'dev',
      'Vite client injected base-prefixed',
      page.html.includes(`${basePrefix}/@vite/client`),
    );

    // The dev page dispatch restores the base, so the app sees the same
    // request URLs as the deployed production handler (App.tsx strips
    // import.meta.env.BASE_URL before keying its path surfaces).
    const missing = await fetchStreamed(devOrigin + basePrefix + '/missing');
    record(
      mode,
      'dev',
      'path-keyed surface works under the base (request URL restored)',
      missing.status === 404 &&
        missing.headers.get('x-page') === 'missing' &&
        missing.html.includes('NOT-FOUND-PAGE'),
      `status ${missing.status}, x-page: ${JSON.stringify(missing.headers.get('x-page'))}`,
    );

    // Dev server functions under the base: full round-trip over the
    // base-prefixed endpoint.
    const clientModule = await (await fetch(devOrigin + basePrefix + '/src/api.ts')).text();
    const functionId = extractFunctionId(clientModule, 'getServerMessage');
    const call = functionId
      ? await fetch(
          `${devOrigin}${basePrefix}/_server?id=${encodeURIComponent(functionId)}&args=${encodeURIComponent('["base"]')}`,
          { method: 'POST' },
        )
      : null;
    const callText = call ? await call.text() : '';
    record(
      mode,
      'sf',
      'dev server function round-trips over the based endpoint',
      callText === 'hello base from the server',
      functionId ? `got ${JSON.stringify(callText)}` : 'could not extract function id',
    );

    await runLazyAssetChecks(mode, devOrigin, { dev: true, basePrefix });
  } catch (e) {
    record(
      mode,
      'run',
      'dev half completed',
      false,
      String(e) + (devLog ? `\nserver: ${devLog.slice(-2000)}` : ''),
    );
  } finally {
    try {
      process.kill(-devServer.pid, 'SIGTERM');
    } catch {}
  }

  // ---- build + preview under base --------------------------------------
  const previewPort = 3177;
  const previewOrigin = `http://localhost:${previewPort}`;
  let previewServer;
  let previewLog = '';
  try {
    console.log('  building…');
    execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe', env });
    previewServer = startProcess(
      'pnpm',
      ['exec', 'vite', 'preview', '--port', String(previewPort), '--strictPort'],
      { cwd: exampleDir, env },
    );
    previewServer.stdout.on('data', (d) => (previewLog += d));
    previewServer.stderr.on('data', (d) => (previewLog += d));
    await waitForHttp(previewOrigin + basePrefix + '/', 30000, {
      headers: { accept: 'text/html' },
    });

    const page = await fetchStreamed(previewOrigin + basePrefix + '/');
    record(
      mode,
      'preview',
      'preview serves the SSR page under the base',
      page.status === 200 && page.html.includes('SSR Start Mode'),
      `status ${page.status}`,
    );
    const entryMatch = new RegExp(
      `<script type="module" src="(${basePrefix}/assets/[^"]+\\.js)" async>`,
    ).exec(page.html);
    record(mode, 'preview', 'hashed client entry injected base-prefixed', !!entryMatch);

    // #300: the server-function endpoint must dispatch through the built
    // handler even though preview stripped the base from req.url. Under the
    // bug this request fell through to page rendering (200 text/html).
    const bogus = await fetch(previewOrigin + basePrefix + '/_server?id=bogus-0', {
      method: 'POST',
    });
    record(
      mode,
      'sf',
      'preview dispatches the based endpoint (unknown id rejected, not HTML)',
      bogus.status === 404 && !(bogus.headers.get('content-type') || '').includes('text/html'),
      `status ${bogus.status}, content-type ${bogus.headers.get('content-type')}`,
    );
    await bogus.arrayBuffer();

    // Full round-trip: the (unminified) server bundle carries the function
    // registrations (`registerServerReference("hash-n", async function name`),
    // so the production function id can be read off it.
    const serverBundle = readFileSync(path.join(exampleDir, 'dist/server/server.js'), 'utf-8');
    const prodId = /registerServerReference\("([\w-]+)",\s*async function getServerMessage\b/.exec(
      serverBundle,
    )?.[1];
    const call = prodId
      ? await fetch(
          `${previewOrigin}${basePrefix}/_server?id=${encodeURIComponent(prodId)}&args=${encodeURIComponent('["preview"]')}`,
          { method: 'POST' },
        )
      : null;
    const callText = call ? await call.text() : '';
    record(
      mode,
      'sf',
      'preview server function round-trips over the based endpoint',
      callText === 'hello preview from the server',
      prodId ? `got ${JSON.stringify(callText)}` : 'could not extract function id from server bundle',
    );

    await runLazyAssetChecks(mode, previewOrigin, { dev: false, basePrefix });
  } catch (e) {
    record(
      mode,
      'run',
      'preview half completed',
      false,
      String(e) + (previewLog ? `\nserver: ${previewLog.slice(-2000)}` : ''),
    );
  } finally {
    if (previewServer) {
      try {
        process.kill(-previewServer.pid, 'SIGTERM');
      } catch {}
    }
    // Leave dist in the standard (base '/') state for anyone poking at it.
    try {
      execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe' });
    } catch {}
  }
}

// Babel-JSX HMR: a separate dev server forced to `compiler: 'babel'` via
// SOLID_JSX_COMPILER, proving the native refresh pass and the
// solid-js/refresh core runtime also work when the JSX transform runs
// through babel-preset-solid.
async function runBabelHmrMode() {
  const mode = 'babel-hmr';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const port = 3165;
  const origin = `http://localhost:${port}`;

  const server = startProcess('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
    cwd: exampleDir,
    env: { ...process.env, SOLID_JSX_COMPILER: 'babel' },
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  try {
    await waitForHttp(origin + '/src/api.ts', 30000);

    const chrome = startProcess(CHROME, [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=/tmp/turnkey-chrome-${mode}`,
      '--no-first-run',
      '--disable-extensions',
      'about:blank',
    ]);
    const cdp = await connectChrome();
    try {
      await runHmrChecks(mode, cdp, origin, { expectCompiler: 'babel' });
    } finally {
      cdp.close();
      const exited = new Promise((r) => chrome.once('exit', r));
      try {
        process.kill(-chrome.pid, 'SIGTERM');
      } catch {}
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      try {
        rmSync(`/tmp/turnkey-chrome-${mode}`, { recursive: true, force: true, maxRetries: 5 });
      } catch {}
    }
  } catch (e) {
    record(
      mode,
      'run',
      'mode completed',
      false,
      String(e) + (serverLog ? `\nserver: ${serverLog.slice(-2000)}` : ''),
    );
  } finally {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
  }
}

async function runExternalMode() {
  const mode = 'external';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  process.env.SOLID_EXTERNAL = '1';
  let server;

  try {
    server = await createServer({ root: exampleDir, server: { middlewareMode: true } });
    const clientModule = await server.environments.client.transformRequest('/src/api.ts');
    const functionId = extractFunctionId(clientModule?.code || '', 'getServerMessage');
    const handler = await server.ssrLoadModule('virtual:solid-ssr-handler');
    const response = await handler.handleRequest(new Request('http://localhost/'));
    const html = await response.text();
    record(
      mode,
      'ssr',
      'external handler renders the app',
      response.status === 200 && html.includes('SSR Start Mode'),
    );
    record(
      mode,
      'css',
      'virtual styles module inlines entry CSS',
      html.includes('data-vite-dev-id') && html.includes('rgb(20, 40, 60)'),
    );

    const functionResponse = functionId
      ? await handler.handleRequest(
          new Request(
            `http://localhost/_server?id=${encodeURIComponent(functionId)}&args=${encodeURIComponent('["external"]')}`,
            { method: 'POST' },
          ),
        )
      : null;
    record(
      mode,
      'sf',
      'external handler composes server functions in dev',
      functionResponse
        ? (await functionResponse.text()) === 'hello external from the server'
        : false,
      functionId ? undefined : 'could not extract function id',
    );
  } catch (error) {
    record(mode, 'run', 'mode completed', false, String(error));
  } finally {
    await server?.close();
    delete process.env.SOLID_EXTERNAL;
  }
}

// The automatic-detection counterpart to the external mode: no option set,
// but the `ssr` environment slot holds a plain (non-runnable) DevEnvironment
// — the shape a provider like @cloudflare/vite-plugin leaves behind. The
// plugin must notice on its own (`isRunnableDevEnvironment`) and stand both
// dev middlewares down, while the generated handler keeps self-serving when
// the host imports it through its own environment.
async function runDetectMode() {
  const mode = 'detect';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  let server;
  let httpServer;

  try {
    server = await createServer({
      root: exampleDir,
      server: { middlewareMode: true },
      environments: {
        ssr: {
          dev: {
            createEnvironment: (name, config) =>
              new DevEnvironment(name, config, { hot: true, transport: createServerHotChannel() }),
          },
        },
      },
    });
    record(
      mode,
      'env',
      'probe ssr environment is non-runnable',
      !isRunnableDevEnvironment(server.environments.ssr),
    );
    const ssrInput = server.environments.ssr.config.build.rollupOptions.input;
    record(
      mode,
      'env',
      'provider environment sees the Fetchable index service entry',
      !!ssrInput &&
        typeof ssrInput === 'object' &&
        ssrInput.index === 'virtual:solid-ssr-handler',
    );

    httpServer = http.createServer(server.middlewares);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${httpServer.address().port}`;

    const endpointResponse = await fetch(`${origin}/_server?id=x&args=%5B%5D`, { method: 'POST' });
    record(
      mode,
      'sf',
      'server-function middleware stands down (endpoint falls through)',
      endpointResponse.status === 404,
    );
    const htmlResponse = await fetch(origin + '/', { headers: { accept: 'text/html' } });
    record(
      mode,
      'ssr',
      'SSR middleware stands down (HTML request falls through)',
      htmlResponse.status === 404,
    );

    // Provider-style import: a module runner over the environment's channel.
    const runner = createServerModuleRunner(server.environments.ssr);
    const handler = await runner.import('virtual:solid-ssr-handler');
    const response = await handler.handleRequest(new Request('http://localhost/'));
    const html = await response.text();
    record(
      mode,
      'handler',
      'handler self-serves through the provider environment',
      response.status === 200 && html.includes('SSR Start Mode'),
    );
    record(
      mode,
      'css',
      'self-served HTML inlines entry CSS',
      html.includes('data-vite-dev-id') && html.includes(APP_CSS_COLOR),
    );
    await runner.close();
  } catch (error) {
    record(mode, 'run', 'mode completed', false, String(error));
  } finally {
    await server?.close();
    httpServer?.close();
  }
}

// Vitest posture: even though this app is `ssr: true`, tests compile and
// resolve with the client posture — dom codegen, non-hydratable, browser
// conditions, jsdom default — with no `test` block and no
// `ssr: mode !== 'test'` workaround in the config. src/posture.test.tsx
// carries the actual assertions (isServer false, non-hydratable codegen, a
// DOM component rendering and updating under jsdom); this mode just runs it.
async function runVitestMode() {
  const mode = 'vitest';
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  let out = '';
  let ok = false;
  try {
    out = execSync('pnpm exec vitest run src/posture.test.tsx', {
      cwd: exampleDir,
      stdio: 'pipe',
      timeout: 180000,
      // NO_COLOR: CI runners advertise color support, and colored vitest
      // output renders project badges without the |name| pipes (and threads
      // ANSI codes through "(3 tests)") that the assertions below match on.
      env: { ...process.env, NO_COLOR: '1' },
    }).toString();
    ok = true;
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  const testPass = ok && /3 passed/.test(out);
  record(
    mode,
    'test',
    'DOM component tests pass with the client posture under ssr: true',
    testPass,
    // Attach output on ANY failure: exit 0 with unmatched output previously
    // recorded an empty detail, leaving CI failures undiagnosable.
    testPass ? undefined : out.slice(-2000),
  );

  // Both postures in ONE workspace (VITEST_PROJECTS=1 adds test.projects to
  // the config): the jsdom project keeps the client posture while the node
  // project gets the server posture end to end just by writing
  // `environment: 'node'` — server conditions (isServer true), ssr codegen,
  // and the framework inlined so the shared worker pool's root-derived
  // native `--conditions` (which carry 'browser') never decide a resolution.
  // src/server-posture.test.tsx carries the server assertions, including the
  // request-event storage round-trip the fullstack session suite lives on.
  let projectsOut = '';
  let projectsOk = false;
  try {
    projectsOut = execSync('pnpm exec vitest run', {
      cwd: exampleDir,
      stdio: 'pipe',
      timeout: 180000,
      env: { ...process.env, VITEST_PROJECTS: '1', NO_COLOR: '1' },
    }).toString();
    projectsOk = true;
  } catch (e) {
    projectsOut = String(e.stdout || '') + String(e.stderr || '');
  }
  const projectsPass =
    projectsOk &&
    /\|client\|.*posture\.test\.tsx \(3 tests\)/.test(projectsOut) &&
    /\|server\|.*server-posture\.test\.tsx \(3 tests\)/.test(projectsOut) &&
    /6 passed/.test(projectsOut);
  record(
    mode,
    'projects',
    'DOM (jsdom) and server (node) posture projects coexist in one workspace',
    projectsPass,
    projectsPass ? undefined : projectsOut.slice(-2000),
  );

  // Browser-mode projects must NOT get the jsdom default: vitest 4 probes
  // for the environment's package at startup (getEnvPackageName →
  // ensureInstalled) and sets a failing exit code when jsdom isn't
  // installed — even though the suite itself runs (and passes) in the real
  // browser. The gate mirrors the plugin's jest-dom one (`browser.enabled`
  // skips the injection); everything else keeps the jsdom default. Asserted
  // at the config-resolution level: jsdom IS installed in this example, so
  // a full browser run couldn't reproduce the missing-package probe.
  const resolveTestEnvironment = async (testBlock) => {
    const resolved = await resolveConfig(
      { root: exampleDir, mode: 'test', test: testBlock },
      'serve',
    );
    return resolved.test?.environment;
  };
  let browserEnv;
  let defaultEnv;
  let envError = '';
  try {
    browserEnv = await resolveTestEnvironment({
      browser: { enabled: true, provider: 'playwright', instances: [{ browser: 'chromium' }] },
    });
    defaultEnv = await resolveTestEnvironment({});
  } catch (e) {
    envError = String(e);
  }
  const browserEnvPass = !envError && browserEnv === undefined && defaultEnv === 'jsdom';
  record(
    mode,
    'browser-env',
    'browser-mode project gets no injected jsdom environment (non-browser keeps the jsdom default)',
    browserEnvPass,
    browserEnvPass ? undefined : envError || `browser: ${browserEnv}, default: ${defaultEnv}`,
  );
}

const ALL_MODES = [
  'dev',
  'prod',
  'document',
  'entries',
  'endpoint',
  'configure',
  'no-middleware',
  'middleware',
  'preview',
  'base',
  'builder-order',
  'builder-prepare',
  'frames',
  'babel-hmr',
  'external',
  'detect',
  'vitest',
];
const arg = process.argv[2];
const modes = ALL_MODES.includes(arg) ? [arg] : ALL_MODES;
for (const mode of modes) {
  if (mode === 'dev') await runDevMode();
  else if (mode === 'prod') await runProdMode();
  else if (mode === 'document') await runDocumentMode();
  else if (mode === 'entries') await runEntriesMode();
  else if (mode === 'endpoint') await runEndpointMode();
  else if (mode === 'configure') await runConfigureMode();
  else if (mode === 'no-middleware') await runNoMiddlewareMode();
  else if (mode === 'middleware') await runMiddlewareMode();
  else if (mode === 'preview') await runPreviewMode();
  else if (mode === 'base') await runBaseMode();
  else if (mode === 'builder-order') await runBuilderOrderMode();
  else if (mode === 'builder-prepare') await runBuilderPrepareMode();
  else if (mode === 'frames') await runFramesMode();
  else if (mode === 'babel-hmr') await runBabelHmrMode();
  else if (mode === 'external') await runExternalMode();
  else if (mode === 'vitest') await runVitestMode();
  else await runDetectMode();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  [${f.mode}/${f.phase}] ${f.name} — ${f.detail}`);
}
cleanup(failed.length ? 1 : 0);
