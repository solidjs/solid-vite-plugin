// Start-mode typed-env fixture test: proves `start.env` gives a start-mode app
// first-party typed environment variables from a root env.ts of Standard
// Schema validators (zod + valibot mixed per key), with the validator never
// reaching any bundle:
//   - dev (ssr mode): the app SSRs with virtual:env/client values, a
//     server-only middleware reads virtual:env/server (validated output —
//     the defaulted/coerced number, not a raw string), the secret never
//     appears in HTML, solid-env.d.ts is generated, and editing .env
//     revalidates live (invalid -> error overlay 500, restored -> 200),
//   - guards: a client-graph import of virtual:env/server fails the build
//     with the server-only error; a hand-inlined secret literal trips the
//     client-chunk leak scan; a missing SERVER var only warns at build
//     time (runtime env — deferred to boot) while a missing CLIENT var
//     (baked) fails the build; a non-VITE_ client key is a config-time
//     error; an async SERVER validator is a config-time error (boot
//     validation is synchronous — no top-level await in the server chunk),
//   - prod (ssr mode): client chunks carry the client values and neither
//     the secret, the server key names, nor any '~standard' validator
//     machinery; dist/server bakes NO server values — it reads process.env
//     at boot through the user's schema (validator is server-only), so the
//     same artifact serves a rotated secret without a rebuild and fails
//     boot with the per-key report when the runtime env is invalid; every
//     server chunk bundles at target es2020 (no top-level await — the
//     Nitro node-server / non-esnext-target regression guard);
//     preview folds .env into process.env (zero-config smoke test) and serves
//     with the middleware headers live,
//   - client mode: the same env layer on a static build — index.html shell,
//     no dist/server, no secret anywhere in dist/client, and the app boots
//     in a browser reading virtual:env/client.
//
// Requires the plugin built (pnpm build at the repo root) and Google Chrome.
//
// Usage: node test/run.mjs [dev|guards|prod|client] (default: all)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME =
  process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = 9351;
const DEV_PORT = 5291;
const PREVIEW_PORT = 5292;

const SECRET = 'test-session-secret-0123456789abcdef';
const ENV_FILE = path.join(exampleDir, '.env');
const ENV_CONTENT = readFileSync(ENV_FILE, 'utf-8');

// ---------------------------------------------------------------------------
// Process / http helpers
// ---------------------------------------------------------------------------
const children = new Set();
function cleanup(code = 0) {
  writeFileSync(ENV_FILE, ENV_CONTENT); // dev mode mutates it; always restore
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

/** Runs a command expected to FAIL; resolves with its combined output. */
function runCommandExpectFailure(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('exit', (code) => {
      children.delete(child);
      code === 0
        ? reject(new Error(`${cmd} ${args.join(' ')} unexpectedly succeeded:\n${output}`))
        : resolve(output);
    });
  });
}

/** Runs a command capturing its combined output and exit code. */
function runCommandCapture(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('exit', (code) => {
      children.delete(child);
      resolve({ code, output });
    });
  });
}

async function waitForHttp(url, timeoutMs = 30000, init) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, init);
      if (res.ok || res.status === 404 || res.status === 500) return res;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { accept: 'text/html' } });
  return { status: res.status, html: await res.text(), headers: res.headers };
}

async function pollUntil(fn, timeoutMs = 10000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    // Transient fetch failures are expected mid-poll (Vite restarts the dev
    // server on .env changes).
    last = await fn().catch(() => null);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

function readDistFiles(dir) {
  const files = {};
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath ?? entry.path, entry.name);
    files[path.relative(dir, abs)] = readFileSync(abs, 'utf-8');
  }
  return files;
}

// ---------------------------------------------------------------------------
// CDP driver (compact copy of the start-ssr harness's)
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

async function browserCheck(mode, origin, checks) {
  const chrome = startProcess(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=/tmp/start-env-chrome-${mode}`,
    '--no-first-run',
    '--disable-extensions',
    'about:blank',
  ]);
  const cdp = await connectChrome();
  try {
    cdp.exceptions.length = 0;
    await cdp.send('Page.navigate', { url: origin + '/' });
    await cdp.waitFor('document.readyState === "complete"');
    await checks(cdp);
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
// Assertions
// ---------------------------------------------------------------------------
const results = [];
function record(mode, phase, name, ok, detail = '') {
  results.push({ mode, phase, name, ok, detail });
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mode}/${phase}] ${status} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

function checkEnvHeaders(mode, phase, headers, secretLen = SECRET.length) {
  record(mode, phase, 'middleware sees the server secret (length only)', headers.get('x-env-secret-len') === String(secretLen), `got ${headers.get('x-env-secret-len')}, want ${secretLen}`);
  record(mode, phase, 'validated output served (defaulted number, not raw string)', headers.get('x-env-port') === '8080' && headers.get('x-env-port-type') === 'number', `port ${headers.get('x-env-port')} type ${headers.get('x-env-port-type')}`);
  record(mode, phase, 'client vars visible server-side too', headers.get('x-env-app-name') === 'EnvApp');
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
async function devMode() {
  console.log('\n== dev (ssr mode) ==');
  rmSync(path.join(exampleDir, 'solid-env.d.ts'), { force: true });
  const server = startProcess('pnpm', ['exec', 'vite', '--port', String(DEV_PORT), '--strictPort'], {
    cwd: exampleDir,
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  const origin = `http://localhost:${DEV_PORT}`;
  await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });

  try {
    const { status, html, headers } = await fetchPage(origin + '/');
    record('dev', 'ssr', 'responds 200', status === 200);
    record('dev', 'ssr', 'app SSRs with virtual:env/client value', html.includes('EnvApp') && html.includes('ENV-APP-OK'));
    record('dev', 'ssr', 'server secret never in HTML', !html.includes(SECRET));
    checkEnvHeaders('dev', 'ssr', headers);

    const dts = existsSync(path.join(exampleDir, 'solid-env.d.ts'))
      ? readFileSync(path.join(exampleDir, 'solid-env.d.ts'), 'utf-8')
      : '';
    record('dev', 'types', 'solid-env.d.ts generated', dts.length > 0);
    record(
      'dev',
      'types',
      'both virtual modules declared with inferred fields',
      dts.includes(`declare module 'virtual:env/client'`) &&
        dts.includes(`declare module 'virtual:env/server'`) &&
        dts.includes('"VITE_APP_NAME"') &&
        dts.includes('"SESSION_SECRET"') &&
        dts.includes(`typeof import("./env")`),
    );

    await browserCheck('dev', origin, async (cdp) => {
      record(
        'dev',
        'browser',
        'hydrated app renders the typed client env',
        await cdp.waitFor('document.querySelector("#app-name")?.textContent === "EnvApp"'),
      );
    });

    // Live revalidation: an invalid .env must flip the page to the error
    // overlay 500 carrying the report; restoring it must recover — no
    // restart either way.
    writeFileSync(ENV_FILE, ENV_CONTENT.replace(SECRET, 'short'));
    const failed = await pollUntil(async () => {
      const page = await fetchPage(origin + '/');
      return page.status === 500 && /env validation failed/.test(page.html) ? page : null;
    });
    record('dev', 'watch', 'invalid .env edit -> 500 with the schema report', !!failed, failed ? '' : 'never became 500');
    record('dev', 'watch', 'report names the failing key', !!failed && failed.html.includes('SESSION_SECRET'));
    writeFileSync(ENV_FILE, ENV_CONTENT);
    const recovered = await pollUntil(async () => {
      const page = await fetchPage(origin + '/');
      return page.status === 200 && page.html.includes('EnvApp') ? page : null;
    });
    record('dev', 'watch', 'restored .env -> 200 again (revalidated live)', !!recovered);
  } finally {
    writeFileSync(ENV_FILE, ENV_CONTENT);
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
  }
}

async function guardsMode() {
  console.log('\n== guards (builds that must fail) ==');
  const build = (env) =>
    runCommandExpectFailure('pnpm', ['exec', 'vite', 'build'], {
      cwd: exampleDir,
      env: { ...process.env, ...env },
    });

  let out = await build({ ENV_APP: 'src/BadApp.tsx' }).catch((e) => e.message);
  record('guards', 'server-only', 'client-graph import of virtual:env/server fails the build', /virtual:env\/server is server-only/.test(out), out.slice(0, 400));
  record('guards', 'server-only', 'error names the importer', /BadApp/.test(out));

  out = await build({ ENV_APP: 'src/LeakApp.tsx' }).catch((e) => e.message);
  record('guards', 'leak-scan', 'hand-inlined secret literal trips the client-chunk scan', /leaked into client chunks/.test(out) && /SESSION_SECRET/.test(out), out.slice(0, 400));

  // Server env is runtime env: a missing required SERVER var must NOT fail
  // the build (platform-injected vars may not exist on the build machine)
  // — it warns and defers to boot validation instead.
  const deferred = await runCommandCapture('pnpm', ['exec', 'vite', 'build'], {
    cwd: exampleDir,
    env: { ...process.env, ENV_SCHEMA: './env.fail.ts' },
  });
  record('guards', 'deferred', 'missing SERVER var builds anyway (deferred to boot)', deferred.code === 0, deferred.output.slice(-400));
  record('guards', 'deferred', 'build warns with the deferred report', /deferred to boot/.test(deferred.output) && /MISSING_REQUIRED_VAR/.test(deferred.output), deferred.output.slice(-400));

  // Client values are baked, so a missing CLIENT var still fails the build.
  out = await build({ ENV_SCHEMA: './env.failclient.ts' }).catch((e) => e.message);
  record('guards', 'validation', 'missing client var fails the build with the report', /env validation failed/.test(out) && /VITE_MISSING_CLIENT/.test(out), out.slice(0, 400));

  out = await build({ ENV_SCHEMA: './env.badprefix.ts' }).catch((e) => e.message);
  record('guards', 'prefix', 'non-VITE_ client key is a config-time error', /must carry the public env prefix/.test(out) && /APP_NAME/.test(out), out.slice(0, 400));

  // The reverse: Vite bakes every VITE_-prefixed var into the browser's
  // import.meta.env regardless of schema side, so a prefixed SERVER key
  // is a leak the moment it exists — reject it before anything builds.
  out = await build({ ENV_SCHEMA: './env.serverprefix.ts' }).catch((e) => e.message);
  record('guards', 'prefix', 'VITE_-prefixed server key is a config-time error', /cannot keep it secret/.test(out) && /VITE_API_SECRET/.test(out), out.slice(0, 400));

  // Async validators are rejected for `server` keys at config time: boot
  // validation is synchronous (the generated server env module carries no
  // top-level await so server bundles work on non-esnext targets), so a
  // Promise-returning server validator could only ever fail at deploy
  // boot — fail fast at build instead, with the fix in the message.
  out = await build({ ENV_SCHEMA: './env.async.ts' }).catch((e) => e.message);
  record('guards', 'sync-only', 'async server validator is a config-time error', /async validator/.test(out) && /SESSION_SECRET/.test(out), out.slice(0, 400));
}

async function prodMode() {
  console.log('\n== prod (ssr mode) ==');
  rmSync(path.join(exampleDir, 'dist'), { recursive: true, force: true });
  await runCommand('pnpm', ['exec', 'vite', 'build'], { cwd: exampleDir });

  const clientFiles = readDistFiles(path.join(exampleDir, 'dist/client'));
  const clientJs = Object.entries(clientFiles)
    .filter(([name]) => name.endsWith('.js'))
    .map(([, content]) => content)
    .join('\n');
  record('prod', 'client-bundle', 'client value baked into client chunks', clientJs.includes('EnvApp'));
  record('prod', 'client-bundle', 'server secret absent from every client file', !Object.values(clientFiles).some((c) => c.includes(SECRET)));
  record('prod', 'client-bundle', 'server key names absent from client chunks', !clientJs.includes('SESSION_SECRET'));
  record('prod', 'client-bundle', 'no validator machinery in client chunks (~standard)', !clientJs.includes('~standard'));

  // Server values are RUNTIME env: nothing baked into the server bundle —
  // it imports the schema (validator is server-only, so that's fine) and
  // reads process.env at boot, so secrets rotate without a rebuild and no
  // secret exists in any dist artifact.
  const serverJs = readFileSync(path.join(exampleDir, 'dist/server/server.js'), 'utf-8');
  record('prod', 'server-bundle', 'server secret NOT baked into the server bundle', !serverJs.includes(SECRET));
  record('prod', 'server-bundle', 'server bundle validates process.env at boot (schema shipped server-side)', serverJs.includes('~standard') && serverJs.includes('validation failed at boot') && /process\.env/.test(serverJs));

  // TLA regression guard: the env module's boot validation used to emit a
  // top-level await (the conditional Standard Schema promise await), which
  // made any downstream bundler with a non-esnext target — Nitro's
  // node-server preset in practice — reject the whole server chunk unless
  // deployments overrode the build target to esnext. esbuild at target
  // es2020 refuses TLA at parse time (it can lower everything else, TLA it
  // cannot), which is exactly the check a downstream bundler applies: every
  // server chunk must pass it.
  const esbuild = await import('esbuild');
  let tlaFailure = '';
  for (const [name, code] of Object.entries(readDistFiles(path.join(exampleDir, 'dist/server')))) {
    if (!/\.m?js$/.test(name)) continue;
    try {
      await esbuild.transform(code, { format: 'esm', target: 'es2020' });
    } catch (error) {
      tlaFailure = `${name}: ${error.message}`;
      break;
    }
  }
  record('prod', 'server-bundle', 'no top-level await in any server chunk (bundles at target es2020)', !tlaFailure, tlaFailure.slice(0, 300));

  const preview = (env) => {
    const child = startProcess(
      'pnpm',
      ['exec', 'vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
      { cwd: exampleDir, env: { ...process.env, ...env } },
    );
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    return { child, getLog: () => log };
  };
  const stop = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    await exited;
  };
  const origin = `http://localhost:${PREVIEW_PORT}`;

  // 1. Plain preview: the plugin folds .env into process.env (preview
  //    smoke-tests the artifact as hands-off as dev), boot validation passes.
  let server = preview({}).child;
  await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });
  const { status, html, headers } = await fetchPage(origin + '/');
  record('prod', 'preview', 'responds 200 through the built handler', status === 200);
  record('prod', 'preview', 'app SSRs with the client env value', html.includes('EnvApp'));
  record('prod', 'preview', 'server secret never in HTML', !html.includes(SECRET));
  checkEnvHeaders('prod', 'preview', headers);
  await stop(server);

  // 2. Rotation without rebuild: the same artifact, a different secret in
  //    the process environment (real env wins over the .env fold) — the
  //    middleware must see the ROTATED value.
  const ROTATED = 'rotated-secret-after-deploy-0123456789abcdef';
  server = preview({ SESSION_SECRET: ROTATED }).child;
  await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });
  const rotated = await fetchPage(origin + '/');
  record('prod', 'rotation', 'rotated secret visible without a rebuild (runtime env)', rotated.headers.get('x-env-secret-len') === String(ROTATED.length), `len ${rotated.headers.get('x-env-secret-len')}, want ${ROTATED.length}`);
  await stop(server);

  // 3. Boot validation: the same artifact with an invalid environment (no
  //    SESSION_SECRET anywhere) must fail at boot with the per-key report.
  writeFileSync(ENV_FILE, ENV_CONTENT.replace(/^SESSION_SECRET=.*$/m, ''));
  const failing = preview({});
  const boot = await waitForHttp(origin + '/', 30000, {
    headers: { accept: 'text/html' },
  });
  const bootReport = (await boot.text().catch(() => '')) + failing.getLog();
  record('prod', 'boot', 'invalid runtime env fails boot (no page served)', boot.status !== 200, `status ${boot.status}`);
  record('prod', 'boot', 'boot failure carries the per-key report', /server env validation failed at boot/.test(bootReport) && /SESSION_SECRET/.test(bootReport), bootReport.slice(0, 300));
  await stop(failing.child);
  writeFileSync(ENV_FILE, ENV_CONTENT);
}

async function clientMode() {
  console.log('\n== client mode (static build, same env layer) ==');
  rmSync(path.join(exampleDir, 'dist'), { recursive: true, force: true });
  await runCommand('pnpm', ['exec', 'vite', 'build'], {
    cwd: exampleDir,
    env: { ...process.env, CLIENT_MODE: '1' },
  });

  const indexPath = path.join(exampleDir, 'dist/client/index.html');
  record('client', 'build', 'static dist/client/index.html emitted', existsSync(indexPath));
  record('client', 'build', 'no dist/server (purely static output)', !existsSync(path.join(exampleDir, 'dist/server')));
  const files = readDistFiles(path.join(exampleDir, 'dist/client'));
  record('client', 'build', 'server secret absent from every static file', !Object.values(files).some((c) => c.includes(SECRET)));
  const js = Object.entries(files)
    .filter(([name]) => name.endsWith('.js'))
    .map(([, content]) => content)
    .join('\n');
  record('client', 'build', 'client value baked into the client bundle', js.includes('EnvApp'));
  const html = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : '';
  record('client', 'build', 'app not prerendered into the shell', !html.includes('ENV-APP-OK'));

  const server = startProcess(
    'pnpm',
    ['exec', 'vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
    { cwd: exampleDir, env: { ...process.env, CLIENT_MODE: '1' } },
  );
  server.stderr.on('data', (d) => process.stderr.write(d));
  const origin = `http://localhost:${PREVIEW_PORT}`;
  await waitForHttp(origin + '/', 30000, { headers: { accept: 'text/html' } });

  await browserCheck('client', origin, async (cdp) => {
    record(
      'client',
      'browser',
      'client-rendered app reads virtual:env/client',
      await cdp.waitFor('document.querySelector("#app-name")?.textContent === "EnvApp"'),
    );
    record(
      'client',
      'browser',
      'marker mounted',
      await cdp.waitFor('document.querySelector("#marker")?.textContent === "ENV-APP-OK"'),
    );
  });

  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {}
}

// ---------------------------------------------------------------------------
const requested = process.argv[2];
const modes = requested ? [requested] : ['dev', 'guards', 'prod', 'client'];
// Config-level: `start.env: false` removes the env plugin entirely; the
// default (probe) includes it under start mode; without `start` there is no
// env layer at all.
{
  const { default: solid } = await import('@solidjs/vite-plugin');
  const names = (opts) => solid(opts).map((p) => p.name);
  record(
    'config',
    'gating',
    'env plugin gated on start (+ env: false opt-out)',
    names({ start: true }).includes('solid:start-env') &&
      !names({ start: { env: false } }).includes('solid:start-env') &&
      !names({}).includes('solid:start-env'),
  );
}
try {
  for (const mode of modes) {
    if (mode === 'dev') await devMode();
    else if (mode === 'guards') await guardsMode();
    else if (mode === 'prod') await prodMode();
    else if (mode === 'client') await clientMode();
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
