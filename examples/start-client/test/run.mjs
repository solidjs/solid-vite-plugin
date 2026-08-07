// Turnkey client-mode fixture test: proves `solid({ start: true })` (the
// zero-config sugar for `start: {}`, without `ssr: true`) gives a plain
// Vite app the turnkey conventions (src/App.tsx, optional src/Document.tsx,
// no index.html, no mount file) with client-only rendering:
//   - dev: every HTML-accepting GET streams the rendered document shell —
//     WITHOUT the app markup (nothing server-renders the app) — carrying the
//     generated client entry script, the Vite client, and the entry graph's
//     CSS inlined (anti-flash); deep links get the same shell (history-
//     fallback semantics),
//   - the client entry render()s (not hydrates): the app mounts, is
//     interactive, styles apply, a lazy chunk loads — with zero hydration
//     artifacts (no _$HY) anywhere, even though src/Document.tsx carries
//     <HydrationScript /> (shared with flip mode; the plugin strips its
//     script from client-mode shells),
//   - build: `vite build` emits a purely static dist/client — index.html is
//     the shell prerendered through the built handler, referencing the
//     hashed entry script and CSS links — and NO dist/server,
//   - preview: `vite preview` serves the static build with history fallback
//     and the app boots from it.
//
// Requires the plugin built (pnpm build at the repo root) and Google Chrome.
//   - flip: the identical app with `ssr: true` (SOLID_FLIP_SSR=1) SSRs and
//     hydrates with zero source changes — the one-boolean flip, proven.
//
// Usage: node test/run.mjs [dev|prod|flip] (default: all)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = 9341;
const DEV_PORT = 5191;
const PREVIEW_PORT = 5192;

// ---------------------------------------------------------------------------
// Process / http helpers
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

function runCommand(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: 'inherit' });
    children.add(child);
    child.on('exit', (code) => {
      children.delete(child);
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
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

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { accept: 'text/html' } });
  return { status: res.status, html: await res.text() };
}

// ---------------------------------------------------------------------------
// CDP driver (compact copy of the turnkey harness's)
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

  return { send, evalJs, waitFor, exceptions, close: () => ws.close() };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const results = [];
function record(mode, phase, name, ok, detail = '') {
  results.push({ mode, phase, name, ok, detail });
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mode}/${phase}] ${status} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

const APP_CSS_COLOR = 'rgb(20, 40, 60)';

// Shell assertions shared by dev and preview: full document, no app markup,
// no hydration artifacts, deep links get the same shell.
async function runShellChecks(mode, origin, { entryPattern }) {
  const { status, html } = await fetchHtml(origin + '/');
  record(mode, 'shell', 'responds 200 to HTML-accepting GET', status === 200);
  record(mode, 'shell', 'full document (doctype + html)', html.startsWith('<!DOCTYPE html><html'));
  record(mode, 'shell', 'app NOT server-rendered', !html.includes('CLIENT-RENDERED-APP'));
  // src/Document.tsx carries <HydrationScript /> (shared with flip mode);
  // the plugin must strip its event-capture script from client-mode shells.
  record(mode, 'shell', 'no hydration script (_$HY stripped from Document)', !html.includes('_$HY'));
  record(
    mode,
    'shell',
    'client entry script injected',
    entryPattern.test(html),
    html.match(/<script[^>]*>/g)?.join(' ') || 'no scripts',
  );

  const deep = await fetchHtml(origin + '/deep/link');
  record(
    mode,
    'shell',
    'deep link serves the shell (history fallback)',
    deep.status === 200 && deep.html.includes('<html'),
    `status ${deep.status}`,
  );
  return html;
}

// Boots the app in Chrome and proves client-only rendering works: mount,
// interactivity, CSS applied, lazy chunk loaded, no exceptions.
async function runBrowserChecks(mode, origin) {
  const chrome = startProcess(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=/tmp/start-client-chrome-${mode}`,
    '--no-first-run',
    '--disable-extensions',
    'about:blank',
  ]);
  const cdp = await connectChrome();
  try {
    cdp.exceptions.length = 0;
    await cdp.send('Page.navigate', { url: origin + '/' });
    await cdp.waitFor('document.readyState === "complete"');

    record(
      mode,
      'browser',
      'app client-rendered (marker mounted)',
      await cdp.waitFor('document.querySelector("#marker")?.textContent === "CLIENT-RENDERED-APP"'),
    );
    await cdp.evalJs('document.querySelector("#increment").click()');
    await cdp.evalJs('document.querySelector("#increment").click()');
    record(
      mode,
      'browser',
      'interactive (counter increments)',
      await cdp.waitFor('document.querySelector("#count")?.textContent === "2"'),
    );
    record(
      mode,
      'browser',
      'lazy chunk loaded',
      await cdp.waitFor('document.querySelector("#lazy")?.textContent === "LAZY-SECTION-CONTENT"'),
    );
    record(
      mode,
      'browser',
      'App.css applied (computed color)',
      await cdp.waitFor(
        `getComputedStyle(document.querySelector("#title")).color === ${JSON.stringify(APP_CSS_COLOR)}`,
      ),
    );

    // Deep-link boot: the same shell must boot the app on a non-root path.
    await cdp.send('Page.navigate', { url: origin + '/deep/link' });
    await cdp.waitFor('document.readyState === "complete"');
    record(
      mode,
      'browser',
      'app boots from a deep link',
      await cdp.waitFor('document.querySelector("#marker")?.textContent === "CLIENT-RENDERED-APP"'),
    );

    const errs = cdp.exceptions.filter((e) => !/favicon/i.test(e));
    record(mode, 'browser', 'no page exceptions/console errors', errs.length === 0, errs.join(' | '));
  } finally {
    cdp.close();
    try {
      process.kill(-chrome.pid, 'SIGTERM');
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
async function devMode() {
  console.log('\n== dev ==');
  const server = startProcess('pnpm', ['exec', 'vite', '--port', String(DEV_PORT), '--strictPort'], {
    cwd: exampleDir,
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  const origin = `http://localhost:${DEV_PORT}`;
  await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });

  const html = await runShellChecks('dev', origin, {
    entryPattern: /<script type="module" src="\/@id\/virtual:solid-ssr-entry-client\.tsx">/,
  });
  record('dev', 'shell', 'Vite client injected', html.includes('/@vite/client'));
  record(
    'dev',
    'shell',
    "entry graph CSS inlined (App.css style tag)",
    /<style[^>]*data-vite-dev-id="[^"]*App\.css"/.test(html),
  );

  await runBrowserChecks('dev', origin);

  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {}
}

async function prodMode() {
  console.log('\n== prod ==');
  rmSync(path.join(exampleDir, 'dist'), { recursive: true, force: true });
  await runCommand('pnpm', ['exec', 'vite', 'build'], { cwd: exampleDir });

  const indexPath = path.join(exampleDir, 'dist/client/index.html');
  record('prod', 'build', 'dist/client/index.html emitted', existsSync(indexPath));
  record(
    'prod',
    'build',
    'no dist/server (purely static output)',
    !existsSync(path.join(exampleDir, 'dist/server')),
  );
  const html = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : '';
  record('prod', 'build', 'full document (doctype + html)', html.startsWith('<!DOCTYPE html><html'));
  record(
    'prod',
    'build',
    'hashed entry script referenced',
    /<script type="module" src="\/assets\/[^"]+\.js">/.test(html),
  );
  record(
    'prod',
    'build',
    'entry CSS linked',
    /<link rel="stylesheet" href="\/assets\/[^"]+\.css">/.test(html),
  );
  record('prod', 'build', 'app NOT prerendered into the shell', !html.includes('CLIENT-RENDERED-APP'));
  // The fixture Document carries <HydrationScript />; the prerendered shell
  // must not (the handler strips the event-capture script in client mode).
  record('prod', 'build', 'no hydration script (_$HY stripped from Document)', !html.includes('_$HY'));
  // The runtime links entry CSS during the shell render; nothing may add a
  // second copy (the prerender step used to double-link every stylesheet).
  const cssLinks = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  record(
    'prod',
    'build',
    'each stylesheet linked exactly once',
    cssLinks.length > 0 && new Set(cssLinks).size === cssLinks.length,
    cssLinks.join(', '),
  );
  const assets = existsSync(path.join(exampleDir, 'dist/client/assets'))
    ? readdirSync(path.join(exampleDir, 'dist/client/assets'))
    : [];
  record(
    'prod',
    'build',
    'lazy chunk emitted separately',
    assets.filter((f) => f.endsWith('.js')).length >= 2,
    assets.join(', '),
  );

  const server = startProcess(
    'pnpm',
    ['exec', 'vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
    { cwd: exampleDir },
  );
  server.stderr.on('data', (d) => process.stderr.write(d));
  const origin = `http://localhost:${PREVIEW_PORT}`;
  await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });

  await runShellChecks('preview', origin, {
    entryPattern: /<script type="module" src="\/assets\/[^"]+\.js">/,
  });
  await runBrowserChecks('preview', origin);

  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {}
}

// The one-boolean flip: the identical app with `ssr: true` (SOLID_FLIP_SSR=1)
// must server-render and hydrate with zero source changes — the shell that
// client mode leaves empty now carries the app markup and hydration script,
// and the counter is interactive after hydration.
async function flipMode() {
  console.log('\n== flip (same app with ssr: true) ==');
  const server = startProcess(
    'pnpm',
    ['exec', 'vite', '--port', String(DEV_PORT), '--strictPort'],
    { cwd: exampleDir, env: { ...process.env, SOLID_FLIP_SSR: '1' } },
  );
  server.stderr.on('data', (d) => process.stderr.write(d));
  const origin = `http://localhost:${DEV_PORT}`;
  await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });

  const { status, html } = await fetchHtml(origin + '/');
  record('flip', 'ssr', 'responds 200', status === 200);
  record('flip', 'ssr', 'app IS server-rendered now', html.includes('CLIENT-RENDERED-APP'));
  record('flip', 'ssr', 'hydration script present (_$HY)', html.includes('_$HY'));

  const chrome = startProcess(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=/tmp/start-client-chrome-flip`,
    '--no-first-run',
    '--disable-extensions',
    'about:blank',
  ]);
  const cdp = await connectChrome();
  try {
    cdp.exceptions.length = 0;
    await cdp.send('Page.navigate', { url: origin + '/' });
    await cdp.waitFor('document.readyState === "complete"');
    await cdp.evalJs('document.querySelector("#increment").click()');
    await cdp.evalJs('document.querySelector("#increment").click()');
    record(
      'flip',
      'browser',
      'interactive after hydration (counter increments)',
      await cdp.waitFor('document.querySelector("#count")?.textContent === "2"'),
    );
    const hydrationErrs = cdp.exceptions.filter((e) => /hydrat|mismatch/i.test(e));
    record('flip', 'browser', 'clean hydration', hydrationErrs.length === 0, hydrationErrs.join(' | '));
  } finally {
    cdp.close();
    try {
      process.kill(-chrome.pid, 'SIGTERM');
    } catch {}
  }

  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {}
}

// ---------------------------------------------------------------------------
const requested = process.argv[2];
const modes = requested ? [requested] : ['dev', 'prod', 'flip'];
// `start: true` is pure sugar for `start: {}` (this suite's vite.config runs
// on the boolean form): both spellings must construct the identical plugin
// set, and `start: false` must mean off exactly like omission.
{
  const { default: solid } = await import('vite-plugin-solid');
  const names = (opts) => solid(opts).map((p) => p.name).join(',');
  record(
    'config',
    'sugar',
    'start: true constructs the same plugins as start: {}',
    names({ start: true }) === names({ start: {} }) &&
      names({ start: true }) !== names({}) &&
      names({ start: false }) === names({}),
  );
}
try {
  for (const mode of modes) {
    if (mode === 'dev') await devMode();
    else if (mode === 'prod') await prodMode();
    else if (mode === 'flip') await flipMode();
    else throw new Error(`Unknown mode: ${mode}`);
  }
} catch (error) {
  console.error(error);
  cleanup(1);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL [${f.mode}/${f.phase}] ${f.name} — ${f.detail}`);
}
cleanup(failed.length ? 1 : 0);
