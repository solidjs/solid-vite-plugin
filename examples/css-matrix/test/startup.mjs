// Dev-manifest startup cases (#414): virtual:solid-manifest evaluated in an
// isolated runner (no shared globalThis, like nitro's dev worker) before or
// around listen(). Requires the plugin built. Usage: node test/startup.mjs

import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createRunnableDevEnvironment, createServer, createServerModuleRunner } from 'vite';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REGISTRY_KEY = Symbol.for('@solidjs/vite-plugin:dev-manifest');
const MANIFEST_ID = '\0virtual:solid-manifest';
const LAZY_KEY = 'src/routes/Lazy.tsx';
// Distinctive rule from src/routes/lazy.css.
const LAZY_CSS_COLOR = 'rgb(70, 80, 90)';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [startup] ${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` : ${detail}` : ''}`);
}

async function within(promise, label, ms = 15_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// fetch as seen by the isolated runner; swapped per case.
let isolatedFetch = fetch;

function createIsolatedRunner(environment) {
  return createServerModuleRunner(environment, {
    hmr: false,
    sourcemapInterceptor: false,
    evaluator: {
      async runInlinedModule(context, code) {
        await runInNewContext(`(async () => {"use strict";\n${code}\n})()`, {
          ...context,
          fetch: (...args) => isolatedFetch(...args),
          URL,
          console,
        });
      },
      runExternalModule: (file) => import(file),
    },
  });
}

// Resolves when the manifest load starts (pre-ordered to run first).
function manifestLoadProbe() {
  let entered;
  const seen = new Promise((resolve) => (entered = resolve));
  return {
    seen,
    plugin: {
      name: 'startup:manifest-load-probe',
      load: {
        order: 'pre',
        handler(id) {
          if (id === MANIFEST_ID) entered();
        },
      },
    },
  };
}

const hasLazyCss = (assets) =>
  Array.isArray(assets?.css) && assets.css.some((c) => c?.content?.includes(LAZY_CSS_COLOR));
const isJsOnly = (assets) =>
  Array.isArray(assets?.js) && assets.js.includes('/' + LAZY_KEY) && assets.css?.length === 0;
const isThenable = (value) => !!value && typeof value.then === 'function';
const short = (value) => JSON.stringify(value)?.slice(0, 200);

async function runCase(name, body) {
  const cleanup = [];
  try {
    await body(cleanup);
  } catch (error) {
    record(name, false, error?.stack || String(error));
  } finally {
    for (const dispose of cleanup.reverse()) {
      await within(Promise.resolve().then(dispose), `${name} cleanup`).catch((error) =>
        record(`${name} cleanup`, false, String(error)),
      );
    }
  }
}

await runCase('eager import before listen', async (cleanup) => {
  const occupied = createHttpServer().listen(0, '127.0.0.1');
  cleanup.push(() => new Promise((resolve) => occupied.close(resolve)));
  await once(occupied, 'listening');
  const occupiedPort = occupied.address().port;

  const probe = manifestLoadProbe();
  const server = await createServer({
    root: exampleDir,
    logLevel: 'silent',
    plugins: [probe.plugin],
    server: { host: '127.0.0.1', port: occupiedPort, strictPort: false },
  });
  cleanup.push(() => server.close());
  const runner = createIsolatedRunner(server.environments.ssr);
  cleanup.push(() => runner.close());

  const imported = runner.import('virtual:solid-manifest');
  imported.catch(() => {});
  await within(probe.seen, 'manifest load');
  await setImmediate();
  await within(server.listen(), 'listen()');
  const port = server.httpServer.address().port;
  record('Vite moved off the occupied port', port !== occupiedPort, `port ${port}`);

  const manifest = (await within(imported, 'eager manifest import')).default;
  const registered = globalThis[REGISTRY_KEY]?.[server.config.root];
  record(
    'isolated runner binds a resolver other than the registry one',
    !!manifest && manifest !== registered,
  );
  const assets = await within(Promise.resolve(manifest.resolve(LAZY_KEY)), 'resolve()');
  record(
    'manifest imported before listen resolves lazy CSS once listening (#414)',
    hasLazyCss(assets),
    short(assets),
  );
  const warm = manifest.resolve(LAZY_KEY);
  record(
    'warm key answers synchronously (render-pass convergence)',
    !isThenable(warm) && hasLazyCss(warm),
    isThenable(warm) ? 'answered a promise' : short(warm),
  );
  record('resolveSync answers full assets once warm', hasLazyCss(manifest.resolveSync(LAZY_KEY)));
});

await runCase('environment listen() imports the manifest', async (cleanup) => {
  let imported;
  let listeningAtImport;
  let importError;
  let envRunner;
  const server = await createServer({
    root: exampleDir,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    environments: {
      ssr: {
        dev: {
          createEnvironment(name, config) {
            const environment = createRunnableDevEnvironment(name, config);
            const listen = environment.listen.bind(environment);
            environment.listen = async (viteServer) => {
              await listen(viteServer);
              envRunner = createIsolatedRunner(environment);
              try {
                imported = (
                  await within(
                    envRunner.import('virtual:solid-manifest'),
                    'manifest import in listen()',
                  )
                ).default;
                listeningAtImport = viteServer.httpServer.listening;
              } catch (error) {
                importError = error;
              }
            };
            return environment;
          },
        },
      },
    },
  });
  cleanup.push(() => server.close());
  cleanup.push(() => envRunner?.close());

  await within(server.listen(), 'listen()');
  record(
    "manifest import inside an environment's listen() completes before the port opens",
    !!imported && listeningAtImport === false,
    importError ? String(importError) : `listening at import: ${listeningAtImport}`,
  );
  const assets = await within(Promise.resolve(imported?.resolve(LAZY_KEY)), 'resolve()');
  record('that manifest resolves lazy CSS once listening', hasLazyCss(assets), short(assets));
  const warm = imported?.resolve(LAZY_KEY);
  record('its warm key answers synchronously', !isThenable(warm) && hasLazyCss(warm));
});

await runCase('server that never listens', async (cleanup) => {
  const server = await createServer({ root: exampleDir, logLevel: 'silent', server: { port: 0 } });
  cleanup.push(() => server.close());

  const inProcess = (
    await within(
      server.environments.ssr.runner.import('virtual:solid-manifest'),
      'in-process manifest import',
    )
  ).default;
  record(
    'in-process import settles without listen() and binds the registry resolver',
    inProcess === globalThis[REGISTRY_KEY]?.[server.config.root],
  );
});

await runCase('lookup before listen', async (cleanup) => {
  const server = await createServer({
    root: exampleDir,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
  });
  cleanup.push(() => server.close());
  const runner = createIsolatedRunner(server.environments.ssr);
  cleanup.push(() => runner.close());
  const manifest = (await within(runner.import('virtual:solid-manifest'), 'manifest import'))
    .default;

  const first = await within(
    Promise.resolve(manifest.resolve(LAZY_KEY)),
    'resolve() before listen',
  );
  record('lookup with no origin yet answers js-only', isJsOnly(first), short(first));
  const again = manifest.resolve(LAZY_KEY);
  record(
    'repeated lookup with no origin answers synchronously',
    !isThenable(again) && isJsOnly(again),
    isThenable(again) ? 'answered a promise' : short(again),
  );

  await within(server.listen(), 'listen()');
  // Recovery is eventual: early answers after listen() can be js-only.
  let recovered;
  for (let attempt = 0; attempt < 50 && !hasLazyCss(recovered); attempt++) {
    recovered = await within(Promise.resolve(manifest.resolve(LAZY_KEY)), 'resolve() after listen');
    if (!hasLazyCss(recovered)) await delay(20);
  }
  record(
    'the same resolver and key recover lazy CSS after listen()',
    hasLazyCss(recovered),
    short(recovered),
  );
  const warm = manifest.resolve(LAZY_KEY);
  record('the recovered key answers synchronously', !isThenable(warm) && hasLazyCss(warm));
});

await runCase('close before listen', async (cleanup) => {
  const probe = manifestLoadProbe();
  const server = await createServer({
    root: exampleDir,
    logLevel: 'silent',
    plugins: [probe.plugin],
    server: { port: 0 },
  });
  const runner = createIsolatedRunner(server.environments.ssr);
  cleanup.push(() => runner.close());
  const imported = runner.import('virtual:solid-manifest');
  imported.catch(() => {});
  await within(probe.seen, 'manifest load');
  await setImmediate();
  // A load parked on the port would hang close().
  await within(server.close(), 'close()').then(
    () => record('close() before listen() settles with an eager import in flight', true),
    (error) =>
      record(
        'close() before listen() settles with an eager import in flight',
        false,
        String(error),
      ),
  );
});

await runCase('middleware mode', async (cleanup) => {
  const server = await createServer({
    root: exampleDir,
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false },
  });
  cleanup.push(() => server.close());
  const runner = createIsolatedRunner(server.environments.ssr);
  cleanup.push(() => runner.close());
  let fetched = false;
  isolatedFetch = async () => {
    fetched = true;
    throw new Error('middleware mode has no origin to fetch from');
  };
  cleanup.push(() => (isolatedFetch = fetch));
  const manifest = (await within(runner.import('virtual:solid-manifest'), 'manifest import'))
    .default;
  const answer = manifest.resolve(LAZY_KEY);
  record(
    'middleware mode answers js-only synchronously, without HTTP',
    !isThenable(answer) && isJsOnly(answer) && !fetched,
    isThenable(answer) ? 'answered a promise' : short(answer),
  );
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} startup assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name} : ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
