// Config-level test for `serverFunctions.components: 'external'` (the host
// acknowledgement value) and the without-SSR-start-mode warning:
//   - `components: true` without SSR start mode warns, and the text names
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
//   - under full SSR start mode `'external'` is redundant but harmless:
//     silent, exactly like `true`.
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
    w.includes('serverFunctions.components is set without SSR start mode'),
  );
  return { config, componentsWarnings };
}

// ---- `true` without SSR start mode: warns, with the updated text ---------
{
  const { config, componentsWarnings } = await resolveWith({
    ssr: true,
    serverFunctions: { components: true },
  });
  record('components: true without start mode warns', componentsWarnings.length === 1);
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
}

// ---- `'external'` in the identical config: silent, still enabled ---------
{
  const { config, componentsWarnings } = await resolveWith({
    ssr: true,
    serverFunctions: { components: 'external' },
  });
  record(
    "components: 'external' without start mode does not warn",
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
}

// ---- full SSR start mode: `'external'` is redundant but harmless ---------
{
  const { componentsWarnings } = await resolveWith({
    ssr: true,
    start: { app: 'src/frames/FramesApp.tsx' },
    serverFunctions: { components: 'external' },
  });
  record(
    "components: 'external' under SSR start mode is silent (like true)",
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
