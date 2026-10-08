// `__SOLID_SERVER_COMPONENTS__` is defined for every build so libraries can
// drop server-component-only client code (#396). Asserts, in one process:
//   - resolved config: the flag is `"true"` or `"false"` (never absent) on
//     Vite's `define` and on every environment's dep-scan transform, `"true"`
//     when `serverFunctions.components` is set including `'external'`, and a
//     user-provided value wins on both the top-level define and a single
//     environment's optimizer,
//   - build: the unused branch of `if (__SOLID_SERVER_COMPONENTS__)` is gone
//     from the bundle, off and on.
//
// Requires the plugin built (pnpm build at the repo root). No browser.
// Usage: node test/server-components-define.mjs

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build, resolveConfig } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

const KEY = '__SOLID_SERVER_COMPONENTS__';
const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(exampleDir, 'test/fixtures/sc-define.ts');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [define] ${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

function flags(config) {
  const read = (define) => define?.[KEY];
  return {
    client: read(config.environments.client.define),
    ssr: read(config.environments.ssr.define),
    clientOpt: read(config.environments.client.optimizeDeps?.rolldownOptions?.transform?.define),
    ssrOpt: read(config.environments.ssr.optimizeDeps?.rolldownOptions?.transform?.define),
  };
}

async function resolved(inline) {
  return resolveConfig(
    { root: exampleDir, configFile: false, logLevel: 'silent', ...inline },
    'serve',
  );
}

function expectFlags(name, actual, expected) {
  const mismatches = Object.entries(expected).filter(([key, value]) => actual[key] !== value);
  record(
    name,
    mismatches.length === 0,
    mismatches.map(([key]) => `${key}=${JSON.stringify(actual[key])}`).join(', ') ||
      JSON.stringify(actual),
  );
}

{
  const config = await resolved({ plugins: [solidPlugin()] });
  expectFlags('off by default, on define and both optimizers', flags(config), {
    client: 'false',
    ssr: 'false',
    clientOpt: 'false',
    ssrOpt: 'false',
  });
  record(
    'client scanner jsx stays classic',
    config.environments.client.optimizeDeps.rolldownOptions?.transform?.jsx?.runtime === 'classic',
  );
}
{
  const config = await resolved({
    plugins: [solidPlugin({ serverFunctions: { components: true } })],
  });
  expectFlags('components: true defines the flag true', flags(config), {
    client: 'true',
    ssr: 'true',
    clientOpt: 'true',
    ssrOpt: 'true',
  });
}
{
  const config = await resolved({
    plugins: [solidPlugin({ serverFunctions: { components: 'external' } })],
  });
  expectFlags("components: 'external' defines the flag true", flags(config), {
    client: 'true',
    ssr: 'true',
    clientOpt: 'true',
    ssrOpt: 'true',
  });
}
{
  const config = await resolved({
    define: { [KEY]: 'true' },
    plugins: [solidPlugin()],
  });
  expectFlags('a user define wins, including the optimizers', flags(config), {
    client: 'true',
    ssr: 'true',
    clientOpt: 'true',
    ssrOpt: 'true',
  });
}
{
  const config = await resolved({
    plugins: [solidPlugin()],
    environments: {
      ssr: {
        optimizeDeps: { rolldownOptions: { transform: { define: { [KEY]: 'true' } } } },
      },
    },
  });
  expectFlags('a per-environment optimizer define wins only there', flags(config), {
    client: 'false',
    ssr: 'false',
    clientOpt: 'false',
    ssrOpt: 'true',
  });
}

async function builtMarker(plugins) {
  const result = await build({
    root: exampleDir,
    configFile: false,
    logLevel: 'silent',
    plugins,
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: fixture },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  return outputs
    .flatMap((output) => ('output' in output ? output.output : []))
    .map((chunk) => (chunk.type === 'chunk' ? chunk.code : ''))
    .join('\n');
}

{
  const off = await builtMarker([solidPlugin()]);
  record(
    'a false define drops the server-component branch',
    off.includes('SC_DEFINE_OFF') && !off.includes('SC_DEFINE_ON'),
    off.includes('SC_DEFINE_ON') ? 'both markers survived' : 'off marker missing',
  );
  const on = await builtMarker([solidPlugin({ serverFunctions: { components: true } })]);
  record(
    'a true define drops the fallback branch',
    on.includes('SC_DEFINE_ON') && !on.includes('SC_DEFINE_OFF'),
    on.includes('SC_DEFINE_OFF') ? 'both markers survived' : 'on marker missing',
  );
}

const failures = results.filter((r) => !r.ok);
console.log(`\n${results.length - failures.length}/${results.length} define assertions passed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f.name} — ${f.detail}`);
}
process.exit(failures.length ? 1 : 0);
