// CSS matrix test runner: enumerates the CSS entry vectors (after
// @katywings' SolidStart compatibility matrix) and asserts each one in both
// dev and production, server-side (SSR output must carry the styles content
// needs before it reveals — the no-FOUC guarantee) and client-side (computed
// styles after hydration and after client-side navigation).
//
// Requires the plugin built (pnpm build at the repo root) and Google Chrome.
// Usage: node test/run.mjs [dev|prod]   (default: both)

import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rmSync } from 'node:fs';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME =
  process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = 9334;

const COLORS = {
  entry: 'rgb(1, 2, 3)',
  app: 'rgb(10, 20, 30)',
  route: 'rgb(20, 30, 40)',
  routeModule: 'rgb(30, 40, 50)',
  virtual: 'rgb(50, 60, 70)',
  url: 'rgb(60, 70, 80)',
  default: 'rgb(0, 0, 0)',
  lazy: 'rgb(70, 80, 90)',
  lazyVirtual: 'rgb(75, 85, 95)',
  lazyGlob: 'rgb(80, 90, 100)',
  lazyLink: 'rgb(90, 100, 110)',
  shared: 'rgb(100, 110, 120)',
};

// ---------------------------------------------------------------------------
// Matrix definition. `ssrCss` lists rule markers that must be present in the
// CSS reachable from the SSR response (inline styles + linked stylesheets)
// before any client JS runs; `ssrCssDev: false` opts a row out in dev, where
// Vite owns entry-graph CSS injection client-side by design. `probes` maps
// selectors to expected computed colors after hydration / navigation.
// ---------------------------------------------------------------------------
const ROUTES = [
  {
    page: 'home',
    path: '/',
    rows: [
      { name: 'Entry Client import', marker: '.entry-probe', ssrCssDev: false, probe: ['.entry-probe', COLORS.entry] },
      { name: 'App import', marker: '.app-probe', ssrCssDev: false, probe: ['.app-probe', COLORS.app] },
      { name: 'Route import', marker: '.route-probe', ssrCssDev: false, probe: ['.route-probe', COLORS.route] },
      // CSS modules hash the class name, so match on the declaration —
      // either rgb form (dev) or the minifier's hex rewrite (prod).
      { name: 'Route import module', marker: [COLORS.routeModule, '#1e2832'], ssrCssDev: false, probe: ['[data-probe="module"]', COLORS.routeModule] },
      { name: 'Route virtual import', marker: '.virtual-probe', ssrCssDev: false, probe: ['.virtual-probe', COLORS.virtual] },
      { name: 'Route ?url + link', marker: '.url-probe', ssrCssDev: true, probe: ['.url-probe', COLORS.url] },
      { name: 'Route ?url without render', absent: '.not-rendered-probe', probe: ['.not-rendered-probe', COLORS.default] },
    ],
  },
  {
    page: 'lazy',
    path: '/lazy',
    rows: [
      { name: 'Lazy import', marker: '.lazy-probe', probe: ['.lazy-probe', COLORS.lazy] },
      { name: 'Lazy virtual import', marker: '.lazy-virtual-probe', probe: ['.lazy-virtual-probe', COLORS.lazyVirtual] },
    ],
  },
  {
    page: 'lazy-glob',
    path: '/lazy-glob',
    rows: [{ name: 'LazyGlob import', marker: '.lazy-glob-probe', probe: ['.lazy-glob-probe', COLORS.lazyGlob] }],
  },
  {
    page: 'lazy-link',
    path: '/lazy-link',
    rows: [{ name: 'LazyLink ?url + link', marker: '.lazy-link-probe', probe: ['.lazy-link-probe', COLORS.lazyLink] }],
  },
  {
    page: 'lazy-link-tmp',
    path: '/lazy-link-tmp',
    settle: 900,
    rows: [
      // Final state: the fallback (and its red link) unmounted with the load.
      { name: 'LazyLinkTmp fallback link', probe: ['.tmp-probe', COLORS.default] },
    ],
  },
  {
    page: 'shared-a',
    path: '/shared-a',
    rows: [{ name: 'SharedChunk import (A)', marker: '.shared-probe', probe: ['.shared-probe', COLORS.shared] }],
  },
  {
    page: 'shared-b',
    path: '/shared-b',
    rows: [{ name: 'SharedChunk import (B)', marker: '.shared-probe', probe: ['.shared-probe', COLORS.shared] }],
  },
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

async function fetchHtml(origin, pathname) {
  const res = await fetch(origin + pathname, { headers: { accept: 'text/html' } });
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}`);
  return res.text();
}

// Collect all CSS text reachable from an SSR response with no JS: inline
// <style> contents plus the contents of every <link rel="stylesheet">.
async function collectSsrCss(origin, html) {
  let css = '';
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) css += m[1] + '\n';
  for (const m of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*>/g)) {
    const href = /href="([^"]+)"/.exec(m[0])?.[1];
    if (!href) continue;
    const url = href.startsWith('http') ? href : origin + href;
    const res = await fetch(url).catch(() => null);
    if (res?.ok) css += (await res.text()) + '\n';
  }
  return css;
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
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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

const probeExpr = (selector) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
  ` return el ? getComputedStyle(el).color : null; })()`;

// ---------------------------------------------------------------------------
// Assertion collection
// ---------------------------------------------------------------------------
const results = [];
function record(mode, phase, name, ok, detail = '') {
  results.push({ mode, phase, name, ok, detail });
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mode}/${phase}] ${status} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

async function runMode(mode) {
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const isProd = mode === 'prod';
  const port = isProd ? 3131 : 3130;
  const origin = `http://localhost:${port}`;

  if (isProd) {
    console.log('  building…');
    execSync('pnpm run build', { cwd: exampleDir, stdio: 'pipe' });
  }

  const server = startProcess('node', ['server.js'], {
    cwd: exampleDir,
    env: { ...process.env, PORT: String(port), NODE_ENV: isProd ? 'production' : 'development' },
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  try {
    await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });

    // ---- Phase 1: SSR output (no JS) ------------------------------------
    for (const route of ROUTES) {
      const html = await fetchHtml(origin, route.path);
      // Whitespace-insensitive: minified prod css drops spaces inside rules.
      const css = (await collectSsrCss(origin, html)).replace(/\s+/g, '');
      for (const row of route.rows) {
        if (row.absent) {
          record(mode, 'ssr', `${row.name} (absent)`, !css.includes(row.absent));
          continue;
        }
        if (!row.marker) continue;
        if (row.ssrCssDev === false && !isProd) continue; // Vite owns dev entry CSS
        const markers = Array.isArray(row.marker) ? row.marker : [row.marker];
        record(
          mode,
          'ssr',
          row.name,
          markers.some((m) => css.includes(m.replace(/\s+/g, ''))),
          `none of "${markers.join('" / "')}" in SSR-reachable CSS`,
        );
      }
    }

    // Shared chunk sanity (prod): the two shared routes must actually share
    // a chunk, or the SharedChunk rows aren't testing anything.
    if (isProd) {
      const manifest = JSON.parse(
        execSync('cat dist/client/.vite/manifest.json', { cwd: exampleDir }).toString(),
      );
      const files = Object.values(manifest)
        .filter((e) => e.file?.endsWith('.js'))
        .map((e) => e.file);
      const sharedChunks = new Set(files.filter((f) => f.includes('shared')));
      record(
        mode,
        'ssr',
        'SharedChunk routes forced into one chunk',
        sharedChunks.size === 1,
        `expected 1 shared chunk, saw ${sharedChunks.size} (${[...sharedChunks].join(', ')})`,
      );
      // Emitted lazy facade chunks must be reclassified as dynamic entries in
      // the output bundle itself — downstream plugins (and this manifest,
      // which Vite generates from the bundle) must see exactly one real entry.
      const entries = Object.keys(manifest).filter((k) => manifest[k].isEntry);
      record(
        mode,
        'ssr',
        'single application entry in client manifest',
        entries.length === 1 && entries[0] === 'src/entry-client.tsx',
        `entries: ${entries.join(', ')}`,
      );
    }

    // ---- Phase 2: browser ------------------------------------------------
    const chrome = startProcess(CHROME, [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=/tmp/css-matrix-chrome-${mode}`,
      '--no-first-run',
      '--disable-extensions',
      'about:blank',
    ]);
    const cdp = await connectChrome();

    try {
      // Direct navigation to each route: SSR + hydration must style every probe.
      for (const route of ROUTES) {
        cdp.exceptions.length = 0;
        await cdp.send('Page.navigate', { url: origin + route.path });
        await cdp.waitFor('document.readyState === "complete"');
        await new Promise((r) => setTimeout(r, route.settle ?? 400));
        for (const row of route.rows) {
          if (!row.probe) continue;
          const [selector, expected] = row.probe;
          const actual = await cdp.evalJs(probeExpr(selector));
          record(mode, 'load', row.name, actual === expected, `${selector}: ${actual} != ${expected}`);
        }
        const errs = cdp.exceptions.filter((e) => !/favicon/i.test(e));
        record(mode, 'load', `${route.page}: no page errors`, errs.length === 0, errs.join(' | '));
      }

      // Dev only: SSR'd style tags must have deduped against Vite's twins.
      if (!isProd) {
        await cdp.send('Page.navigate', { url: origin + '/lazy' });
        await cdp.waitFor('document.readyState === "complete"');
        await new Promise((r) => setTimeout(r, 800));
        const dupCount = await cdp.evalJs(
          `(() => { const ids = {}; for (const el of document.querySelectorAll('style[data-vite-dev-id]')) {` +
            ` const id = el.getAttribute('data-vite-dev-id'); ids[id] = (ids[id] || 0) + 1; }` +
            ` return Object.values(ids).filter(n => n > 1).length; })()`,
        );
        record(mode, 'load', 'no duplicate dev style tags', dupCount === 0, `${dupCount} duplicated ids`);
      }

      // Client-side navigation: start at home, click through every page.
      cdp.exceptions.length = 0;
      await cdp.send('Page.navigate', { url: origin + '/' });
      await cdp.waitFor('document.readyState === "complete"');
      await new Promise((r) => setTimeout(r, 600));
      for (const route of ROUTES) {
        if (route.page === 'home') continue;
        await cdp.evalJs(`document.querySelector('[data-nav="${route.page}"]').click()`);
        await new Promise((r) => setTimeout(r, route.settle ?? 700));
        for (const row of route.rows) {
          if (!row.probe) continue;
          const [selector, expected] = row.probe;
          const actual = await cdp.evalJs(probeExpr(selector));
          record(mode, 'nav', row.name, actual === expected, `${selector}: ${actual} != ${expected}`);
        }
      }
      const navErrs = cdp.exceptions.filter((e) => !/favicon/i.test(e));
      record(mode, 'nav', 'no page errors during navigation', navErrs.length === 0, navErrs.join(' | '));
    } finally {
      cdp.close();
      const exited = new Promise((r) => chrome.once('exit', r));
      try {
        process.kill(-chrome.pid, 'SIGTERM');
      } catch {}
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      try {
        rmSync(`/tmp/css-matrix-chrome-${mode}`, { recursive: true, force: true, maxRetries: 5 });
      } catch {}
    }
  } catch (e) {
    record(mode, 'run', 'mode completed', false, String(e) + (serverLog ? `\nserver: ${serverLog.slice(-2000)}` : ''));
  } finally {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
  }
}

const arg = process.argv[2];
const modes = arg === 'dev' ? ['dev'] : arg === 'prod' ? ['prod'] : ['dev', 'prod'];
for (const mode of modes) await runMode(mode);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  [${f.mode}/${f.phase}] ${f.name} — ${f.detail}`);
}
cleanup(failed.length ? 1 : 0);
