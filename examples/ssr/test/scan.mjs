// Dependency-scan test for non-client environments (#387). Vite seeds only
// the `client` environment from the top-level `optimizeDeps`, so the scanner
// JSX setting the plugin returns from `config` never reached `ssr`: with
// discovery turned back on (as @cloudflare/vite-plugin does for workerd
// SSR), Rolldown scanned Solid TSX with React's automatic runtime and the
// scan failed on an unresolvable `react/jsx-dev-runtime`, skipping
// pre-bundling for that environment. Asserts, in one process:
//   - config: the ssr environment resolves the classic scanner JSX runtime,
//     the `.tsrx` extension and the tsrx scan plugin; a per-environment
//     `transform.jsx` set by the app is left alone,
//   - scan: a cold dev server with ssr discovery on (entries
//     src/entry-server.tsx, whose graph includes JSX and import.meta.glob)
//     completes both the client and the ssr scans without a failure banner.
//
// Requires the plugin built (pnpm build at the repo root). No browser.
// Usage: node test/scan.mjs

import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, resolveConfig } from 'vite';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [scan] ${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

const ssrDiscovery = { noDiscovery: false, entries: ['src/entry-server.tsx'] };

// ---- Resolved config -------------------------------------------------------
{
  const config = await resolveConfig(
    { root: exampleDir, logLevel: 'silent', environments: { ssr: { optimizeDeps: ssrDiscovery } } },
    'serve',
  );
  const ssr = config.environments.ssr.optimizeDeps;
  record(
    'ssr scanner uses the classic JSX runtime',
    ssr.rolldownOptions?.transform?.jsx?.runtime === 'classic',
    JSON.stringify(ssr.rolldownOptions?.transform),
  );
  record('ssr scanner crawls .tsrx', !!ssr.extensions?.includes('.tsrx'), JSON.stringify(ssr.extensions));
  const plugins = [ssr.rolldownOptions?.plugins].flat(Infinity);
  record(
    'ssr scanner registers the tsrx scan plugin',
    plugins.some((p) => p?.name === 'solid:tsrx-dep-scan'),
  );
  record(
    'client scanner keeps the classic JSX runtime',
    config.environments.client.optimizeDeps.rolldownOptions?.transform?.jsx?.runtime === 'classic',
  );
}
{
  const config = await resolveConfig(
    {
      root: exampleDir,
      logLevel: 'silent',
      environments: {
        ssr: { optimizeDeps: { rolldownOptions: { transform: { jsx: { runtime: 'automatic' } } } } },
      },
    },
    'serve',
  );
  record(
    'an app-set per-environment scanner JSX option wins',
    config.environments.ssr.optimizeDeps.rolldownOptions?.transform?.jsx?.runtime === 'automatic',
  );
}

// ---- Cold scans ------------------------------------------------------------
{
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'solid-ssr-scan-'));
  const failed = {};
  const server = await createServer({
    root: exampleDir,
    cacheDir,
    logLevel: 'silent',
    server: { port: 0 },
    environments: { ssr: { optimizeDeps: ssrDiscovery } },
  });
  try {
    for (const [name, env] of Object.entries(server.environments)) {
      const error = env.logger.error;
      env.logger = {
        ...env.logger,
        error(msg, opts) {
          if (String(msg).includes('Failed to run dependency scan')) failed[name] = String(msg);
          return error.call(this, msg, opts);
        },
      };
    }
    await server.listen();
    for (const name of ['client', 'ssr']) {
      const optimizer = server.environments[name]?.depsOptimizer;
      if (!optimizer || optimizer.options.noDiscovery) {
        record(`${name} scan ran`, false, 'discovery is off');
        continue;
      }
      for (let i = 0; i < 100 && !optimizer.scanProcessing; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await optimizer.scanProcessing;
      record(`${name} scan completed (no failure banner)`, !failed[name], failed[name]?.slice(0, 300));
    }
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

const failures = results.filter((r) => !r.ok);
console.log(`\n${results.length - failures.length}/${results.length} scan assertions passed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f.name} — ${f.detail}`);
}
process.exit(failures.length ? 1 : 0);
