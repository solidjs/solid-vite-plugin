// Config-level test for the `resolve.dedupe` list:
//   - `solid-js`, `@solidjs/web` and `@solidjs/signals` are each deduped only
//     when the app root can reach a copy (`<root>/node_modules/<name>`,
//     walking up). Dedupe resolves
//     the listed package from the root and Vite's Node-side resolver
//     (`fetchModule`, the externalize decision) has no importer fallback,
//     so under pnpm's isolated layout — signals present only as `solid-js`'s
//     transitive dependency, which is this example's own layout — the entry
//     would turn `import "@solidjs/signals"` from the inlined `solid-js` into
//     ERR_MODULE_NOT_FOUND once anything externalizes signals,
//   - `@solidjs/signals` rides into `optimizeDeps.include` only when it
//     resolves from the root (an include entry that doesn't resolve from the
//     root warns on every start),
//   - `build` gets the same list as `serve` (#112: a nested `solid-js` copy
//     must not land in the production bundle).
//
// Pure resolveConfig — no dev server, no browser. Requires the plugin built
// (pnpm build at the repo root). Usage: node test/dedupe.mjs

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { resolveConfig } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

function findUp(root, name) {
  let dir = root;
  while (true) {
    if (fs.existsSync(path.join(dir, 'node_modules', name, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function resolveWith(root, command) {
  return resolveConfig(
    { root, configFile: false, logLevel: 'error', plugins: [solidPlugin({ ssr: true })] },
    command,
  );
}

// ---- this example: pnpm isolated layout, signals is transitive only -------
{
  const reachable = findUp(exampleDir, '@solidjs/signals');
  record(
    'precondition: @solidjs/signals is not reachable from the example root',
    reachable === undefined,
    `found under ${reachable}`,
  );
  const config = await resolveWith(exampleDir, 'serve');
  record(
    'serve: solid-js and @solidjs/web deduped',
    config.resolve.dedupe.includes('solid-js') && config.resolve.dedupe.includes('@solidjs/web'),
    config.resolve.dedupe.join(', '),
  );
  record(
    'serve, no root copy: @solidjs/signals NOT in resolve.dedupe',
    !config.resolve.dedupe.includes('@solidjs/signals'),
    config.resolve.dedupe.join(', '),
  );
  record(
    'serve: @solidjs/signals not in optimizeDeps.include',
    !config.optimizeDeps.include.includes('@solidjs/signals'),
    config.optimizeDeps.include.join(', '),
  );
}

// ---- a root that CAN reach a copy (npm-style hoist / direct dependency) ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-dedupe-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'dedupe-probe', private: true, type: 'module' }),
    );
    for (const name of ['solid-js', '@solidjs/web', '@solidjs/signals']) {
      const stub = path.join(root, 'node_modules', name);
      fs.mkdirSync(stub, { recursive: true });
      fs.writeFileSync(
        path.join(stub, 'package.json'),
        JSON.stringify({ name, version: '0.0.0-stub' }),
      );
    }

    const serve = await resolveWith(root, 'serve');
    record(
      'serve, root copy present: @solidjs/signals in resolve.dedupe',
      serve.resolve.dedupe.includes('@solidjs/signals'),
      serve.resolve.dedupe.join(', '),
    );
    record(
      'serve, root copy present: solid-js and @solidjs/web still deduped',
      serve.resolve.dedupe.includes('solid-js') && serve.resolve.dedupe.includes('@solidjs/web'),
      serve.resolve.dedupe.join(', '),
    );
    record(
      'serve, root copy present: @solidjs/signals in optimizeDeps.include',
      serve.optimizeDeps.include.includes('@solidjs/signals'),
      serve.optimizeDeps.include.join(', '),
    );

    const build = await resolveWith(root, 'build');
    record(
      'build: solid-js, @solidjs/web and @solidjs/signals deduped (#112)',
      ['solid-js', '@solidjs/web', '@solidjs/signals'].every((name) =>
        build.resolve.dedupe.includes(name),
      ),
      build.resolve.dedupe.join(', '),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name} — ${f.detail}`);
  process.exit(1);
}
