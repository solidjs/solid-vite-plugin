// Turnkey kitchen-sink fixture test: proves `solid({ ssr: {}, serverFunctions:
// true })` gives a plain Vite app working streaming SSR *and* "use server"
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
//   - HMR works through the turnkey dev middleware under the native
//     (Babel-free) pipeline: the solid-js/refresh wrapper is active, an
//     on-disk edit hot-applies without a reload, sibling client state
//     survives, and a CSS edit hot-applies into a single style element; the
//     babel-hmr mode repeats those checks on a dev server forced to
//     `compiler: 'babel'`,
//   - the `ssr.document` escape hatch swaps the document shell and the
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
//     all the wiring (render plugin, bootstrap script,
//     installServerComponents()), document SSR renders a server component
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
// Requires the plugin built (pnpm build at the repo root) and Google Chrome.
// Usage: node test/run.mjs
// [dev|prod|document|entries|endpoint|configure|no-middleware|builder-order|builder-prepare|babel-hmr|frames]
// (default: all)

import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import {
  createServer,
  createServerHotChannel,
  createServerModuleRunner,
  DevEnvironment,
  isRunnableDevEnvironment,
} from 'vite';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Deliberately no process.chdir(exampleDir): the in-process modes (external,
// detect) create the dev server with `root: exampleDir` while the runner's
// cwd stays wherever it was invoked from — regression coverage for the
// plugin resolving relative filter globs against process.cwd() instead of
// the Vite root (spawned modes pass explicit cwds either way).
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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
  return { status: res.status, chunks, html };
}

// ---------------------------------------------------------------------------
// CDP driver
// ---------------------------------------------------------------------------
async function connectChrome() {
  let target;
  for (let i = 0; i < 40; i++) {
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
  record(mode, 'ssr', 'app server-rendered', html.includes('Turnkey SSR'));
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
  return html;
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

  // The turnkey promise: the dev server is the plain `vite` CLI.
  const server = startProcess('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
    cwd: exampleDir,
    env: { ...process.env },
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  try {
    // Wait on a plain module transform instead of `/` so nothing has touched
    // the SSR environment before the cold turnkey checks below.
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
    // POST-only by default as of @solidjs/web 2.0.0-beta.21; args still come
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

    await runBrowserChecks(mode, origin, { hmr: true, devCss: true, expectCompiler: 'native' });
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
  // The turnkey promise: one plain `vite build` produces both bundles.
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

// Document escape hatch: a separate dev server with `ssr.document` pointing
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
    record(mode, 'document', 'app rendered inside custom shell', html.includes('Turnkey SSR'));
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
    record(mode, 'prod', 'app server-rendered', html.includes('Turnkey SSR'));
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
    record(mode, 'prod', 'app server-rendered', html.includes('Turnkey SSR'));
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
// `ssr.app` at the server-components page). Everything else is the stock
// turnkey surface: generated entries carry the wiring the plugin emits for
// the option — the render plugin + direct-call transform in the server
// entry, the bootstrap script in <head>, installServerComponents() in the
// client entry — and the untouched dev middleware / virtual prod handler
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
  // As of beta.26 a boundary SSRs as a real <dx-frame data-fid> element
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
  // Presence is not enough: the bootstrap must run before hydration data,
  // but adding a separate script before the document's declared head nodes
  // shifts Solid's structural hydration cursor. It belongs at the front of
  // the existing HydrationScript instead.
  const scBootstrapAt = html.indexOf('self._$SC=');
  const hydrationRuntimeAt = html.indexOf('window._$HY');
  const hydrationDataAt = html.indexOf('_$HY.r[');
  record(
    mode,
    'document',
    'SC bootstrap starts the hydration script before hydration data',
    scBootstrapAt !== -1 &&
      hydrationRuntimeAt > scBootstrapAt &&
      html.lastIndexOf('<script', scBootstrapAt) ===
        html.lastIndexOf('<script', hydrationRuntimeAt) &&
      (hydrationDataAt === -1 || scBootstrapAt < hydrationDataAt),
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
  // `serverFunctions: { components: true }` + `ssr.app` in vite.config.ts.
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
      response.status === 200 && html.includes('Turnkey SSR'),
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
      response.status === 200 && html.includes('Turnkey SSR'),
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

const ALL_MODES = [
  'dev',
  'prod',
  'document',
  'entries',
  'endpoint',
  'configure',
  'no-middleware',
  'builder-order',
  'builder-prepare',
  'frames',
  'babel-hmr',
  'external',
  'detect',
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
  else if (mode === 'builder-order') await runBuilderOrderMode();
  else if (mode === 'builder-prepare') await runBuilderPrepareMode();
  else if (mode === 'frames') await runFramesMode();
  else if (mode === 'babel-hmr') await runBabelHmrMode();
  else if (mode === 'external') await runExternalMode();
  else await runDetectMode();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  [${f.mode}/${f.phase}] ${f.name} — ${f.detail}`);
}
cleanup(failed.length ? 1 : 0);
