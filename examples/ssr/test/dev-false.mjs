// Regression for #62. With `dev: false`, `vite dev` must resolve Solid's
// production builds: the plugin drops its own `development` condition, but
// Vite's default `development|production` token still resolves to
// `development` in any non-production mode, so the client was pre-bundling
// `dist/solid.dev.js` and SSR was loading `dist/server.dev.js`.
//
// Asserts, for client and SSR:
//   - `dev: false` during `vite dev` (`command === 'serve'`, mode not
//     `test`) rewrites that token to `production` and `resolveId('solid-js')`
//     ends at `dist/solid.js` / `dist/server.js`,
//   - default serve (`dev` unset and `dev: true`), `mode: 'test'` (including
//     `dev: false`, which must not opt tests into the rewrite), and
//     `vite build` leave the token alone. Resolution then follows Vite:
//     `development` under serve (test mode also injects `browser`, so SSR
//     lands on the browser dev build) and `production` under build.
//
// Serve goes through `pluginContainer.resolveId`. When the client optimizer
// rewrites that id to a prebundle, the recorded `metadata.src` is the Solid
// file it resolved. Build uses Vite's `createIdResolver` (`resolveId` against
// the build config; `vite build` pins NODE_ENV=production). SSR externalizes
// `solid-js` during build, so that case sets `ssr.noExternal` to ask the same
// resolver for the file path. No browser.
// Requires the plugin built (pnpm build at the repo root).
// Usage: node test/dev-false.mjs

import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBuilder, createIdResolver, createServer } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'development|production';
const CLIENT_PROD = '/dist/solid.js';
const CLIENT_DEV = '/dist/solid.dev.js';
const SSR_PROD = '/dist/server.js';
const SSR_DEV = '/dist/server.dev.js';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(
    `  [dev-false] ${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`,
  );
}

function inlineConfig(solidOptions, { mode } = {}) {
  return {
    root: exampleDir,
    configFile: false,
    logLevel: 'silent',
    ...(mode ? { mode } : {}),
    plugins: [solidPlugin({ ssr: true, ...solidOptions })],
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  };
}

function fileName(id) {
  return String(id ?? '')
    .split('?')[0]
    .replace(/\\/g, '/');
}

/** Package file `resolveId` selected, following an optimized dep back to its src. */
function packagePath(environment, resolved) {
  const id = fileName(typeof resolved === 'string' ? resolved : resolved?.id);
  if (id.includes('/node_modules/solid-js/dist/')) return id;
  const meta = environment.depsOptimizer?.metadata;
  const info = meta?.optimized?.['solid-js'] ?? meta?.discovered?.['solid-js'];
  return fileName(info?.src || '');
}

function conditionsFollow(conditions, force) {
  return force
    ? conditions.includes('production') && !conditions.includes(TOKEN)
    : conditions.includes(TOKEN) && !conditions.includes('production');
}

async function withNodeEnv(nodeEnv, fn) {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

async function resolveServe(solidOptions, { mode } = {}) {
  // `vite dev` leaves NODE_ENV unset, and resolveConfig then pins development.
  // A fresh cache so a previous case's prebundle can't answer this resolve.
  return withNodeEnv('development', async () => {
    const server = await createServer({
      ...inlineConfig(solidOptions, { mode }),
      cacheDir: mkdtempSync(path.join(os.tmpdir(), 'solid-dev-false-')),
    });
    try {
      const [client, ssr] = await Promise.all([
        server.environments.client.pluginContainer.resolveId('solid-js'),
        server.environments.ssr.pluginContainer.resolveId('solid-js'),
      ]);
      return {
        clientConditions: server.environments.client.config.resolve.conditions,
        ssrConditions: server.environments.ssr.config.resolve.conditions,
        client: packagePath(server.environments.client, client),
        ssr: packagePath(server.environments.ssr, ssr),
      };
    } finally {
      await server.close();
    }
  });
}

async function resolveBuild(solidOptions) {
  // `vite build` pins NODE_ENV=production, which is what expands the token.
  // `ssr.noExternal` only so the externalized SSR id is the file path; it
  // does not rewrite conditions.
  return withNodeEnv('production', async () => {
    const builder = await createBuilder({
      ...inlineConfig(solidOptions),
      ssr: { noExternal: ['solid-js'] },
    });
    const resolveId = createIdResolver(builder.config);
    const [client, ssr] = await Promise.all([
      resolveId(builder.environments.client, 'solid-js'),
      resolveId(builder.environments.ssr, 'solid-js'),
    ]);
    return {
      clientConditions: builder.environments.client.config.resolve.conditions,
      ssrConditions: builder.environments.ssr.config.resolve.conditions,
      client: packagePath(builder.environments.client, client),
      ssr: packagePath(builder.environments.ssr, ssr),
    };
  });
}

function check(name, result, { force, client, ssr }) {
  const listed = `client [${result.clientConditions.join(', ')}] -> ${result.client}; ssr [${result.ssrConditions.join(', ')}] -> ${result.ssr}`;
  record(
    `${name}: client conditions ${force ? 'force production' : 'keep the token'}`,
    conditionsFollow(result.clientConditions, force),
    listed,
  );
  record(
    `${name}: ssr conditions ${force ? 'force production' : 'keep the token'}`,
    conditionsFollow(result.ssrConditions, force),
    listed,
  );
  record(
    `${name}: client resolveId ends at ${client}`,
    result.client.endsWith(client),
    result.client,
  );
  record(`${name}: ssr resolveId ends at ${ssr}`, result.ssr.endsWith(ssr), result.ssr);
}

const cases = [
  {
    name: 'vite dev with dev: false',
    run: () => resolveServe({ dev: false }),
    force: true,
    client: CLIENT_PROD,
    ssr: SSR_PROD,
  },
  {
    name: 'vite dev (dev unset)',
    run: () => resolveServe({}),
    force: false,
    client: CLIENT_DEV,
    ssr: SSR_DEV,
  },
  {
    name: 'vite dev with dev: true',
    run: () => resolveServe({ dev: true }),
    force: false,
    client: CLIENT_DEV,
    ssr: SSR_DEV,
  },
  {
    name: "vite dev in mode 'test'",
    run: () => resolveServe({}, { mode: 'test' }),
    force: false,
    client: CLIENT_DEV,
    ssr: CLIENT_DEV,
  },
  {
    name: "vite dev in mode 'test' with dev: false",
    run: () => resolveServe({ dev: false }, { mode: 'test' }),
    force: false,
    client: CLIENT_DEV,
    ssr: CLIENT_DEV,
  },
  {
    name: 'vite build (dev unset)',
    run: () => resolveBuild({}),
    force: false,
    client: CLIENT_PROD,
    ssr: SSR_PROD,
  },
  {
    name: 'vite build with dev: false',
    run: () => resolveBuild({ dev: false }),
    force: false,
    client: CLIENT_PROD,
    ssr: SSR_PROD,
  },
];

for (const entry of cases) {
  check(entry.name, await entry.run(), entry);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} dev-false assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name} — ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
