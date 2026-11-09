// Vitest passes the resolved `ssr.resolve.conditions` to Node as
// `--conditions` for the packages it leaves external. In a jsdom test run the
// plugin used to add `browser` there, so Node-only packages failed to load.
// For example, `msw/node` imports `@mswjs/interceptors/ClientRequest`, whose
// `browser` export is `null` (#125). Files with `// @vitest-environment node`
// run in the `ssr` environment, so it keeps `browser` for Vite's own
// resolution of the inlined solid-js (#534).
//
// Checks:
// - jsdom: `client` and `ssr` keep `browser`, Node's conditions do not.
// - jsdom with `browser` set by the user on `ssr`: Node keeps it.
// - node environment: `ssr` and Node keep `browser`.
import { resolveConfig } from 'vite';
import solid from 'vite-plugin-solid';

async function conditions(test, extra = {}) {
  const resolved = await resolveConfig(
    { mode: 'test', configFile: false, logLevel: 'silent', plugins: [solid()], test, ...extra },
    'serve',
  );
  return {
    client: resolved.environments.client.resolve.conditions,
    ssr: resolved.environments.ssr.resolve.conditions,
    node: resolved.ssr.resolve.conditions,
  };
}

const failures = [];
function expectBrowser(label, list, expected) {
  if (list.includes('browser') !== expected) {
    failures.push(`${label} ${expected ? 'lacks' : 'includes'} browser: ${JSON.stringify(list)}`);
  }
}

const jsdom = await conditions({ environment: 'jsdom' });
expectBrowser('jsdom: client conditions', jsdom.client, true);
expectBrowser('jsdom: ssr environment conditions', jsdom.ssr, true);
expectBrowser('jsdom: Node conditions', jsdom.node, false);

const userSsr = await conditions(
  { environment: 'jsdom' },
  { environments: { ssr: { resolve: { conditions: ['browser', 'node', 'import'] } } } },
);
expectBrowser('jsdom + user ssr browser: Node conditions', userSsr.node, true);

const node = await conditions({ environment: 'node' });
expectBrowser('node: ssr environment conditions', node.ssr, true);
expectBrowser('node: Node conditions', node.node, true);

if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log('PASS: jsdom tests keep browser out of the Node conditions only');
