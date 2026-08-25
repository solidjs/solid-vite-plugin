// Boundary-marker test: the always-on `server-only` / `client-only` modules
// claimed by the plugin. A client-bundle import of `server-only` must fail
// the build with the plugin's descriptive error (and vice versa for
// `client-only`); the correct environment resolves the marker to an empty
// module and builds cleanly. Runs four in-memory builds over the fixtures
// in test/boundary-fixtures/.
//
// Requires the plugin built (pnpm build at the repo root). No browser.
// Usage: node test/boundary.mjs

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build, createServer } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = (name) => path.join(exampleDir, 'test/boundary-fixtures', name);

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [boundary] ${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

async function runBuild({ entry, ssr }) {
  try {
    await build({
      root: exampleDir,
      configFile: false,
      logLevel: 'silent',
      plugins: [solidPlugin({ ssr: true })],
      build: {
        write: false,
        ssr: ssr ? entry : false,
        rollupOptions: ssr ? {} : { input: entry },
      },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String((error && error.message) || error) };
  }
}

// server-only: client build fails with our error, server build passes.
{
  const client = await runBuild({ entry: fixture('server-only-import.ts'), ssr: false });
  record(
    "client import of 'server-only' fails the build",
    !client.ok,
    'build unexpectedly succeeded',
  );
  record(
    'failure is the plugin error naming the importer',
    !client.ok &&
      client.message.includes('[@solidjs/vite-plugin]') &&
      client.message.includes("'server-only'") &&
      client.message.includes('server-only-import.ts'),
    client.message,
  );
  const server = await runBuild({ entry: fixture('server-only-import.ts'), ssr: true });
  record("server import of 'server-only' builds cleanly", server.ok, server.message);
}

// client-only: server build fails with our error, client build passes.
{
  const server = await runBuild({ entry: fixture('client-only-import.ts'), ssr: true });
  record(
    "server import of 'client-only' fails the build",
    !server.ok,
    'build unexpectedly succeeded',
  );
  record(
    'failure is the plugin error naming the importer',
    !server.ok &&
      server.message.includes('[@solidjs/vite-plugin]') &&
      server.message.includes("'client-only'") &&
      server.message.includes('client-only-import.ts'),
    server.message,
  );
  const client = await runBuild({ entry: fixture('client-only-import.ts'), ssr: false });
  record("client import of 'client-only' builds cleanly", client.ok, client.message);
}

// Dev graph vs dep-scan pass: the guard fires on a real client-graph
// resolve of 'server-only' (a dev transform of the importing module rejects
// with our error), but NOT on the dependency scanner's pass — the scanner
// crawls the raw, untransformed graph straight through 'use server' modules
// into server-only code, a legal graph once transforms split it. Vite marks
// scanner resolves with `scan: true` on the plugin-container options (both
// the esbuild scanner in v6/7 and the rolldown one in v8); resolving there
// must succeed quietly (still claiming the specifier, so the scanner does
// not chase it as a missing bare dependency, which would abort the scan all
// the same). Regression: cold-start "Failed to run dependency scan" banners
// on apps whose 'use server' modules reach server-only code (the app-ssr
// suite's dev mode covers the end-to-end cold start).
{
  const server = await createServer({
    root: exampleDir,
    configFile: false,
    logLevel: 'silent',
    plugins: [solidPlugin({ ssr: true })],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const importer = fixture('server-only-import.ts');

    let devError = null;
    try {
      await server.environments.client.transformRequest(
        '/test/boundary-fixtures/server-only-import.ts',
      );
    } catch (error) {
      devError = error;
    }
    record(
      "dev client transform of a 'server-only' importer errors",
      !!devError &&
        String(devError.message).includes('[@solidjs/vite-plugin]') &&
        String(devError.message).includes("'server-only'"),
      devError ? String(devError.message) : 'transform unexpectedly succeeded',
    );

    let scanError = null;
    let scanResolved = null;
    try {
      scanResolved = await server.environments.client.pluginContainer.resolveId(
        'server-only',
        importer,
        { scan: true },
      );
    } catch (error) {
      scanError = error;
    }
    record(
      "dep-scan resolve of 'server-only' passes quietly (scan flag)",
      !scanError && !!scanResolved,
      scanError ? String(scanError.message) : 'resolved to nothing',
    );
  } finally {
    await server.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} boundary assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name} — ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
