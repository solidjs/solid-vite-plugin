// Manual-wiring SSR fixture test: proves the integrator / meta-framework
// path (`ssr: true` + your own middleware-mode dev server and production
// server, see server.js) still works end to end. Deliberately lean — the
// heavy assertions (streaming order, hydration, HMR, server functions, CSS
// dedup) live in the app-ssr suite; this one guards the escape hatch the
// `app` option is built on:
//   - dev: `node server.js` (Vite in middleware mode) serves the SSR'd
//     document with the Vite client injected,
//   - prod: the classic two-step `vite build` (client) + `vite build --ssr`
//     (server) + `node server.js` serves the SSR'd document with the
//     authored `/src/entry-client.tsx` reference rewritten to the hashed
//     asset from the manifest,
//   - with no server functions in the app (and no `serverFunctions` option),
//     the served client entry and the built client assets carry no
//     server-function runtime references.
//
// Requires the plugin built (pnpm build at the repo root). No browser.
// Usage: node test/run.mjs [dev|prod]   (default: both)

import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// This example has no server functions and no `serverFunctions` option, so
// no client output may reference the server-function runtime. The guarantee
// is structural — the directive transform only emits runtime imports into
// modules containing "use server", and nothing imports it unconditionally —
// and these probes pin it against future codegen/endpoint-threading changes.
const SERVER_FN_RUNTIME_PROBES = [
  '@solidjs/web/server-functions',
  'createServerReference',
  'configureServerFunctionsClient',
];
const findServerFnProbe = (source) =>
  SERVER_FN_RUNTIME_PROBES.find((probe) => source.includes(probe));

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

const results = [];
function record(mode, name, ok, detail = '') {
  results.push({ mode, name, ok, detail });
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mode}] ${status} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

async function runMode(mode) {
  console.log(`\n=== ${mode.toUpperCase()} ===`);
  const isProd = mode === 'prod';
  const port = isProd ? 3151 : 3150;
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
    const html = await (await fetch(origin + '/', { headers: { accept: 'text/html' } })).text();

    record(mode, 'responds with SSR html', html.startsWith('<!DOCTYPE html>'));
    record(
      mode,
      'app server-rendered (document + route content)',
      html.includes('Solid SSR Document Example') &&
        html.includes('Welcome to the Solid SSR example'),
    );
    record(mode, 'hydration script present', html.includes('_$HY'));

    if (isProd) {
      record(
        mode,
        'client entry rewritten to hashed asset',
        !html.includes('/src/entry-client.tsx') &&
          /<script type="module" src="\/assets\/[^"]+\.js" async>/.test(html),
      );
      record(mode, 'no dev injections leaked', !html.includes('/@vite/client'));
      const assetsDir = path.join(exampleDir, 'dist/client/assets');
      const leaks = readdirSync(assetsDir)
        .map((f) => {
          const probe = findServerFnProbe(readFileSync(path.join(assetsDir, f), 'utf-8'));
          return probe ? `${f}: ${probe}` : null;
        })
        .filter(Boolean);
      record(
        mode,
        'no server-function runtime in client assets (unused)',
        leaks.length === 0,
        leaks.join(', '),
      );
    } else {
      record(mode, 'Vite client injected into <head>', html.includes('/@vite/client'));
      record(
        mode,
        'authored client entry served as-is',
        html.includes('src="/src/entry-client.tsx"'),
      );
      const entryClient = await (await fetch(origin + '/src/entry-client.tsx')).text();
      record(
        mode,
        'no server-function runtime in served client entry (unused)',
        !findServerFnProbe(entryClient),
        findServerFnProbe(entryClient) || '',
      );
    }
  } catch (e) {
    record(
      mode,
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

const arg = process.argv[2];
const modes = arg === 'dev' ? ['dev'] : arg === 'prod' ? ['prod'] : ['dev', 'prod'];
for (const mode of modes) await runMode(mode);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  [${f.mode}] ${f.name} — ${f.detail}`);
}
cleanup(failed.length ? 1 : 0);
