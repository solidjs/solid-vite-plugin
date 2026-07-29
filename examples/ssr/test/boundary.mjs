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
import { build } from 'vite';
import solidPlugin from 'vite-plugin-solid';

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
      client.message.includes('[vite-plugin-solid]') &&
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
      server.message.includes('[vite-plugin-solid]') &&
      server.message.includes("'client-only'") &&
      server.message.includes('client-only-import.ts'),
    server.message,
  );
  const client = await runBuild({ entry: fixture('client-only-import.ts'), ssr: false });
  record("client import of 'client-only' builds cleanly", client.ok, client.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} boundary assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name} — ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
