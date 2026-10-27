// Config-level test for `serverFunctions.components: 'external'` (the host
// acknowledgement value) and the without-SSR-app-mode warning:
//   - `components: true` without SSR app mode warns, and the text names
//     the current app-side pieces (render plugin + installServerComponents())
//     and points hosts at `components: 'external'` — it must NOT mention the
//     bootstrap script (head bootstrap injection was removed; serialized
//     references self-bootstrap the registry),
//   - `components: 'external'` in the same config is silent — that's the
//     whole point of the value: composing hosts (Astro adapter, TanStack
//     Start Solid) own the document wiring and shouldn't ship a scary log,
//   - `'external'` still behaves as enabled: the serve-time optimizeDeps
//     pre-bundle of the server-components client runtime (gated on the
//     derived serverComponents flag) matches `true` exactly, and stays off
//     when the option is off,
//   - under full SSR app mode `'external'` is redundant but harmless:
//     silent, exactly like `true`,
//   - independent of server components: `serverFunctions` alone (with or
//     without `ssr`) pre-bundles the server-function client runtime under
//     `serve` (the dependency scan never runs the transform that adds its
//     import), listed once when components also ask for it; not without
//     `serverFunctions`, not in build, and a custom `runtime.client` only as
//     a package specifier, beside the components entries when both are on.
//
// Pure resolveConfig — no dev server, no browser. Requires the plugin built
// (pnpm build at the repo root). Usage: node test/components-warning.mjs

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveConfig, createLogger } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

async function resolveWith(solidOptions) {
  const warnings = [];
  const logger = createLogger('info', { allowClearScreen: false });
  const originalWarn = logger.warn;
  logger.warn = (msg, opts) => {
    warnings.push(String(msg));
    originalWarn(msg, opts);
  };
  const config = await resolveConfig(
    {
      root: exampleDir,
      configFile: false,
      customLogger: logger,
      plugins: [solidPlugin(solidOptions)],
    },
    'serve',
  );
  const componentsWarnings = warnings.filter((w) =>
    w.includes('serverFunctions.components is set without SSR app mode'),
  );
  return { config, componentsWarnings };
}

// ---- `true` without SSR app mode: warns, with the updated text ---------
{
  const { config, componentsWarnings } = await resolveWith({
    ssr: true,
    serverFunctions: { components: true },
  });
  record('components: true without app mode warns', componentsWarnings.length === 1);
  const text = componentsWarnings[0] ?? '';
  record(
    'warning names the render plugin and installServerComponents()',
    text.includes('render plugin') && text.includes('installServerComponents()'),
  );
  record(
    'warning no longer mentions the bootstrap script',
    !text.toLowerCase().includes('bootstrap'),
    text,
  );
  record(
    "warning points hosts at components: 'external'",
    text.includes("components: 'external'"),
    text,
  );
  record(
    'enabled: server-components client runtime pre-bundled (true)',
    config.optimizeDeps.include.includes('@solidjs/web/frames') &&
      config.optimizeDeps.include.includes('@solidjs/web/server-functions'),
  );
  const runtimeEntries = config.optimizeDeps.include.filter(
    (dep) => dep === '@solidjs/web/server-functions',
  );
  record(
    'enabled: server-function client runtime listed once',
    runtimeEntries.length === 1,
    config.optimizeDeps.include.join(', '),
  );
}

// ---- `'external'` in the identical config: silent, still enabled ---------
{
  const { config, componentsWarnings } = await resolveWith({
    ssr: true,
    serverFunctions: { components: 'external' },
  });
  record(
    "components: 'external' without app mode does not warn",
    componentsWarnings.length === 0,
    componentsWarnings[0],
  );
  record(
    "enabled: server-components client runtime pre-bundled ('external' = true)",
    config.optimizeDeps.include.includes('@solidjs/web/frames') &&
      config.optimizeDeps.include.includes('@solidjs/web/server-functions'),
  );
}

// ---- option off: the pre-bundle stays off (probe is meaningful) ----------
{
  const { config, componentsWarnings } = await resolveWith({
    ssr: true,
    serverFunctions: true,
  });
  record(
    'off: no warning and no server-components pre-bundle',
    componentsWarnings.length === 0 &&
      !config.optimizeDeps.include.includes('@solidjs/web/frames'),
  );
  // Independent of server components: the attribution engine and the
  // performance-tracks recorder are pre-bundled in the first optimizer pass
  // under `serve`, so a consumer the scanner never crawls (a linked package,
  // a `solid`-condition package vitefu excluded) importing one mid-session
  // can't re-optimize a second @solidjs/signals core into the page.
  record(
    'serve: solid-js/attribution and @solidjs/web/performance-tracks pre-bundled',
    config.optimizeDeps.include.includes('solid-js/attribution') &&
      config.optimizeDeps.include.includes('@solidjs/web/performance-tracks'),
    config.optimizeDeps.include.join(', '),
  );
  // Compiled server-function references import the client runtime, but the
  // dependency scanner never runs the transform that adds that import.
  // Without the entry, the first "use server" module the browser loads
  // discovers it late: re-optimize and full reload.
  record(
    'serverFunctions without components: server-function client runtime pre-bundled',
    config.optimizeDeps.include.includes('@solidjs/web/server-functions'),
    config.optimizeDeps.include.join(', '),
  );
}

// ---- serverFunctions without ssr: same entry -----------------------------
{
  const { config } = await resolveWith({ serverFunctions: true });
  record(
    'serverFunctions without ssr: server-function client runtime pre-bundled',
    config.optimizeDeps.include.includes('@solidjs/web/server-functions'),
    config.optimizeDeps.include.join(', '),
  );
}

// ---- serverFunctions off: no server-function runtime pre-bundle -----------
{
  const { config } = await resolveWith({ ssr: true });
  record(
    'serverFunctions off: server-function client runtime not pre-bundled',
    !config.optimizeDeps.include.includes('@solidjs/web/server-functions'),
    config.optimizeDeps.include.join(', '),
  );
}

// ---- custom runtime: only a package specifier is pre-bundled --------------
{
  const client = '@acme/server-runtime/client';
  const { config } = await resolveWith({
    ssr: true,
    serverFunctions: { runtime: { server: '@acme/server-runtime/server', client } },
  });
  record(
    'custom runtime (package): runtime.client pre-bundled instead of the default',
    config.optimizeDeps.include.includes(client) &&
      !config.optimizeDeps.include.includes('@solidjs/web/server-functions'),
    config.optimizeDeps.include.join(', '),
  );
}
{
  const client = '@acme/server-runtime/client';
  const { config } = await resolveWith({
    ssr: true,
    serverFunctions: {
      components: true,
      runtime: { server: '@acme/server-runtime/server', client },
    },
  });
  record(
    'components + custom runtime (package): runtime.client beside the components entries',
    config.optimizeDeps.include.includes(client) &&
      config.optimizeDeps.include.includes('@solidjs/web/server-functions'),
    config.optimizeDeps.include.join(', '),
  );
}
for (const client of [
  './src/sf-client.ts',
  '/src/sf-client.ts',
  'virtual:sf-client',
  '@/sf-client',
  '~/sf-client',
]) {
  const { config } = await resolveWith({
    ssr: true,
    serverFunctions: { runtime: { server: client, client } },
  });
  record(
    `custom runtime (${client}): neither it nor the default pre-bundled`,
    !config.optimizeDeps.include.includes(client) &&
      !config.optimizeDeps.include.includes('@solidjs/web/server-functions'),
    config.optimizeDeps.include.join(', '),
  );
}

// ---- build: optimizeDeps is serve-only, the entries stay out --------------
{
  const config = await resolveConfig(
    { root: exampleDir, configFile: false, plugins: [solidPlugin({ ssr: true })] },
    'build',
  );
  record(
    'build: attribution / performance-tracks not in optimizeDeps.include',
    !config.optimizeDeps.include.includes('solid-js/attribution') &&
      !config.optimizeDeps.include.includes('@solidjs/web/performance-tracks'),
    config.optimizeDeps.include.join(', '),
  );
}
{
  const config = await resolveConfig(
    {
      root: exampleDir,
      configFile: false,
      plugins: [solidPlugin({ ssr: true, serverFunctions: true })],
    },
    'build',
  );
  record(
    'build: server-function client runtime not in optimizeDeps.include',
    !config.optimizeDeps.include.includes('@solidjs/web/server-functions'),
    config.optimizeDeps.include.join(', '),
  );
}

// ---- full SSR app mode: `'external'` is redundant but harmless ---------
{
  const { componentsWarnings } = await resolveWith({
    ssr: true,
    app: { root: 'src/frames/FramesApp.tsx' },
    serverFunctions: { components: 'external' },
  });
  record(
    "components: 'external' under SSR app mode is silent (like true)",
    componentsWarnings.length === 0,
    componentsWarnings[0],
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name} — ${f.detail}`);
  process.exit(1);
}
