// Non-JSX lazy module URLs (#406). `transform()` used to return before the
// lazy pipeline for anything that was not JSX, so a `routes.ts` of
// `lazy(() => import(...))` never got a callsite module URL and an SSR
// `.ts` target never got `$$moduleUrl`. Primitive naming is forced off
// (`solid.sourceNames: false`) — in dev it would otherwise be on, and the
// pipeline must not be gated on it. A production build is asserted as well
// as the dev transform: module URLs stay project-relative manifest keys
// (no leading slash, no dist path), the same contract as the JSX path and
// the #390 slash-key coverage.
//
// Requires the plugin built (pnpm build at the repo root). No browser.
// Usage: node test/ts-module-url.mjs

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build, createServer } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = (name) => path.join(exampleDir, 'test/fixtures/ts-lazy', name);
const routesFile = fixture('routes.ts');
const PAGE_KEY = 'test/fixtures/ts-lazy/page.ts';
// The compiler's third `lazy()` argument. Vite rewrites the import specifier
// (dev URL, or a hashed chunk in the build); this key stays project-relative.
const PAGE_CALLSITE = `, void 0, "${PAGE_KEY}"`;
const PAGE_MODULE_URL = `$$moduleUrl = "${PAGE_KEY}"`;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(
    `  [ts-module-url] ${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`,
  );
}

function plugin() {
  return solidPlugin({ ssr: true, solid: { sourceNames: false } });
}

function hasCallsite(code) {
  return !!code && code.includes(PAGE_CALLSITE) && !code.includes('__SOLID_LAZY_MODULE__');
}

async function bundle(ssr) {
  const result = await build({
    root: exampleDir,
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin()],
    build: {
      write: false,
      minify: false,
      ssr: ssr ? routesFile : false,
      rollupOptions: ssr ? {} : { input: routesFile },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  return outputs
    .flatMap((output) => ('output' in output ? output.output : []))
    .map((chunk) => (chunk.type === 'chunk' ? chunk.code : ''))
    .join('\n');
}

const server = await createServer({
  root: exampleDir,
  configFile: false,
  logLevel: 'silent',
  plugins: [plugin()],
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});

try {
  const ssrRoutes = await server.environments.ssr.transformRequest(
    '/test/fixtures/ts-lazy/routes.ts',
  );
  const ssrPage = await server.environments.ssr.transformRequest('/test/fixtures/ts-lazy/page.ts');
  const clientRoutes = await server.environments.client.transformRequest(
    '/test/fixtures/ts-lazy/routes.ts',
  );
  const clientPage = await server.environments.client.transformRequest(
    '/test/fixtures/ts-lazy/page.ts',
  );
  let dtsCode = '';
  try {
    const dts = await server.environments.ssr.transformRequest('/test/fixtures/ts-lazy/types.d.ts');
    dtsCode = dts?.code ?? '';
  } catch (error) {
    dtsCode = String(error);
  }

  record(
    'dev SSR callsite gets the project-relative module URL',
    hasCallsite(ssrRoutes?.code),
    ssrRoutes?.code ?? 'no code',
  );
  record(
    'dev SSR lazy target exports $$moduleUrl',
    !!ssrPage?.code?.includes(PAGE_MODULE_URL),
    ssrPage?.code ?? 'no code',
  );
  record(
    'dev client callsite gets the module URL and no refresh runtime',
    hasCallsite(clientRoutes?.code) && !clientRoutes.code.includes('solid-js/refresh'),
    clientRoutes?.code ?? 'no code',
  );
  record(
    'dev client lazy target has no $$moduleUrl',
    !clientPage?.code?.includes('$$moduleUrl'),
    clientPage?.code ?? 'no code',
  );
  record(
    'dev SSR does not stamp $$moduleUrl onto .d.ts',
    !dtsCode.includes('$$moduleUrl'),
    dtsCode.slice(0, 300),
  );
} finally {
  await server.close();
}

{
  const serverBundle = await bundle(true);
  record(
    'production SSR callsite gets the project-relative module URL',
    hasCallsite(serverBundle),
    serverBundle.slice(0, 500),
  );
  record(
    'production SSR lazy target exports $$moduleUrl',
    serverBundle.includes(PAGE_MODULE_URL),
    serverBundle.includes('$$moduleUrl') ? 'export shape differed' : '$$moduleUrl missing',
  );
}
{
  const clientBundle = await bundle(false);
  record(
    'production client callsite gets the project-relative module URL',
    hasCallsite(clientBundle),
    clientBundle.slice(0, 500),
  );
  record(
    'production client has no $$moduleUrl',
    !clientBundle.includes('$$moduleUrl'),
    clientBundle.includes('$$moduleUrl') ? 'stamped a client module' : '',
  );
}

const failures = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failures.length}/${results.length} ts module-url assertions passed`,
);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f.name} — ${f.detail}`);
}
process.exit(failures.length ? 1 : 0);
