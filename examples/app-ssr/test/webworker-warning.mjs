// Build-level test for the worker-target warning (solidjs/solid#3597). The
// generated server code (the app-mode handler and the server-function
// handler module) imports `@solidjs/web/storage`, which needs
// `node:async_hooks`. On a worker runtime without Node compat that fails at
// deploy with a bare module-not-found, so a build whose ssr environment
// targets a worker (`ssr.target: 'webworker'`, what Shopify Oxygen's Vite
// plugin sets) must warn at build time naming the requirement and both fixes
// (compatibility_date >= 2026-08-04, or the nodejs_compat flag). Asserts:
//   - a full SSR app-mode `vite build` (client + ssr environments) with
//     `ssr.target: 'webworker'` warns EXACTLY once — the default builder
//     resolves the config once per environment on top of its own pass, so a
//     configResolved-time warning would print three times; the text names
//     node:async_hooks, the compatibility date, the nodejs_compat flag, and
//     links the issue,
//   - the same build with the default node target is silent,
//   - a client app-mode build with `serverFunctions` (dist/server kept for
//     the endpoint) warns once too,
//   - a `serverFunctions`-only ssr build (no `app`) warns — its handler
//     module carries the same storage import,
//   - a transform-only `ssr: true` build (no generated server code) is silent,
//   - `vite dev` with the webworker target is silent — the dev server runs
//     the ssr environment in Node, so the warning is build-only.
//
// Real in-process builds into the example's dist/ (no browser); dev via a
// non-listening createServer. Requires the plugin built (pnpm build at the
// repo root). Usage: node test/webworker-warning.mjs

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createBuilder, createServer, createLogger } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NEEDLE = 'targets a worker runtime';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

function capturingLogger(warnings) {
  const logger = createLogger('warn', { allowClearScreen: false });
  const originalWarn = logger.warn;
  logger.warn = (msg, opts) => {
    warnings.push(String(msg));
    originalWarn(msg, opts);
  };
  return logger;
}

function inlineConfig(solidOptions, ssr, extra = {}) {
  return {
    root: exampleDir,
    configFile: false,
    logLevel: 'warn',
    ssr,
    plugins: [solidPlugin(solidOptions)],
    ...extra,
  };
}

/** One plain `vite build` — every environment, like the CLI. */
async function buildAppWith(solidOptions, ssr) {
  const warnings = [];
  const builder = await createBuilder(
    inlineConfig(solidOptions, ssr, {
      customLogger: capturingLogger(warnings),
    }),
  );
  await builder.buildApp();
  return warnings.filter((w) => w.includes(NEEDLE));
}

/**
 * The ssr environment alone, with an explicit input: the shape of a host
 * that owns its server entry and only uses the plugin's transforms (and,
 * optionally, its server-function handler module).
 */
async function buildSsrWith(solidOptions, ssr) {
  const warnings = [];
  const builder = await createBuilder(
    inlineConfig(solidOptions, ssr, {
      customLogger: capturingLogger(warnings),
      environments: {
        ssr: {
          build: {
            outDir: 'dist/webworker-warning-ssr',
            rollupOptions: { input: path.join(exampleDir, 'src/api.ts') },
          },
        },
      },
    }),
  );
  await builder.build(builder.environments.ssr);
  return warnings.filter((w) => w.includes(NEEDLE));
}

async function devWith(solidOptions, ssr) {
  const warnings = [];
  const server = await createServer(
    inlineConfig(solidOptions, ssr, {
      customLogger: capturingLogger(warnings),
      server: { middlewareMode: true, hmr: false, watch: null },
    }),
  );
  try {
    // Environments (and their plugin containers' buildStart) initialize in
    // createServer; nothing has to listen or be requested.
    await Promise.all(Object.values(server.environments).map((env) => env.init?.()));
  } finally {
    await server.close();
  }
  return warnings.filter((w) => w.includes(NEEDLE));
}

const appSsr = { ssr: true, app: {}, serverFunctions: true };

// ---- SSR app-mode build, webworker target: warns once, full text --------
{
  const warnings = await buildAppWith(appSsr, { target: 'webworker' });
  record(
    'app-mode build with ssr.target webworker warns exactly once',
    warnings.length === 1,
    `${warnings.length} warnings`,
  );
  const text = warnings[0] ?? '';
  record('warning names ssr.target = "webworker"', text.includes('ssr.target = "webworker"'), text);
  record(
    'warning names node:async_hooks / AsyncLocalStorage',
    text.includes('node:async_hooks') && text.includes('AsyncLocalStorage'),
    text,
  );
  record(
    'warning gives the compatibility_date route (>= 2026-08-04)',
    text.includes('compatibility_date') && text.includes('2026-08-04'),
    text,
  );
  record('warning gives the nodejs_compat flag route', text.includes('nodejs_compat'), text);
  record('warning mentions Shopify Oxygen', text.includes('Shopify Oxygen'), text);
  record(
    'warning links solidjs/solid#3597',
    text.includes('https://github.com/solidjs/solid/issues/3597'),
    text,
  );
}

// ---- Same build, default node target: silent -------------------------------
{
  const warnings = await buildAppWith(appSsr, {});
  record('app-mode build with the node target does not warn', warnings.length === 0, warnings);
}

// ---- Client app mode + serverFunctions: dist/server handler, warns once --
{
  const warnings = await buildAppWith(
    { app: {}, serverFunctions: true },
    { target: 'webworker' },
  );
  record(
    'client app mode with serverFunctions and webworker target warns once',
    warnings.length === 1,
    `${warnings.length} warnings`,
  );
}

// ---- serverFunctions only (no app): the handler module imports storage --
{
  const warnings = await buildSsrWith(
    { ssr: true, serverFunctions: true },
    { target: 'webworker' },
  );
  record(
    'serverFunctions-only ssr build with webworker target warns once',
    warnings.length === 1,
    `${warnings.length} warnings`,
  );
}

// ---- Transform-only ssr: true (no generated server code): silent ----------
{
  const warnings = await buildSsrWith({ ssr: true }, { target: 'webworker' });
  record(
    'transform-only ssr build with webworker target does not warn',
    warnings.length === 0,
    warnings,
  );
}

// ---- Dev with the webworker target: build-only, so silent -----------------
{
  const warnings = await devWith(appSsr, { target: 'webworker' });
  record('vite dev with ssr.target webworker does not warn', warnings.length === 0, warnings);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name} — ${f.detail}`);
  process.exit(1);
}
