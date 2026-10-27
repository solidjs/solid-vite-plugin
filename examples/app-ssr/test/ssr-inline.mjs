// Config-level test for the dev SSR inline list (`environments.ssr.resolve.noExternal`):
//   - under `serve`, `solid-js`, `@solidjs/web`, `seroval` and
//     `seroval-plugins` are inlined. Each ships a `dist/dev` build behind
//     the `development` condition; left external, Node resolves their own
//     imports without it and a second (prod) copy loads beside the runner's
//     dev copy. For seroval that breaks `instanceof Stream`, so a server
//     component's `sc:live` ReadableStream fails to serialize
//     ("cannot be parsed/serialized") when it lands after the shell flush,
//   - host entries are kept alongside,
//   - a host that set `noExternal: true` is left alone,
//   - under `build` none of them are added (dev-only fix; the build bundles
//     one copy of everything).
//
// Pure resolveConfig — no dev server, no browser. Requires the plugin built
// (pnpm build at the repo root). Usage: node test/ssr-inline.mjs

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveConfig } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INLINED = ['solid-js', '@solidjs/web', 'seroval', 'seroval-plugins'];

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

async function ssrNoExternal(command, ssrResolve) {
  const config = await resolveConfig(
    {
      root: exampleDir,
      configFile: false,
      logLevel: 'error',
      ...(ssrResolve ? { environments: { ssr: { resolve: ssrResolve } } } : {}),
      plugins: [solidPlugin({ ssr: true })],
    },
    command,
  );
  // A bare `build` resolve may carry no ssr environment at all.
  return config.environments.ssr?.resolve.noExternal;
}

const show = (v) => (Array.isArray(v) ? v.map(String).join(', ') : String(v));

{
  const noExternal = await ssrNoExternal('serve');
  record(
    'serve: solid-js, @solidjs/web, seroval and seroval-plugins inlined in ssr',
    Array.isArray(noExternal) && INLINED.every((pkg) => noExternal.includes(pkg)),
    show(noExternal),
  );
}

{
  const noExternal = await ssrNoExternal('serve', { noExternal: ['host-pkg'] });
  record(
    'serve: host noExternal entries kept alongside',
    Array.isArray(noExternal) &&
      noExternal.includes('host-pkg') &&
      INLINED.every((pkg) => noExternal.includes(pkg)),
    show(noExternal),
  );
}

{
  const noExternal = await ssrNoExternal('serve', { noExternal: true });
  record('serve: host noExternal: true left alone', noExternal === true, show(noExternal));
}

{
  const noExternal = await ssrNoExternal('build');
  record(
    'build: seroval and seroval-plugins not added (dev-only fix)',
    !Array.isArray(noExternal) ||
      (!noExternal.includes('seroval') && !noExternal.includes('seroval-plugins')),
    show(noExternal),
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name} — ${f.detail}`);
  process.exit(1);
}
