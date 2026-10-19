// Vitest passes the `ssr` environment's conditions to Node as `--conditions`
// for the packages it leaves external. In a jsdom test run the plugin used to
// add `browser` there, so Node-only packages failed to load. For example,
// `msw/node` imports `@mswjs/interceptors/ClientRequest`, whose `browser`
// export is `null` (#125).
//
// Checks:
// - jsdom: `client` keeps `browser`, `ssr` does not.
// - node environment: `ssr` keeps `browser`, since its tests run there.
import { resolveConfig } from 'vite';
import solid from 'vite-plugin-solid';

async function conditions(test) {
  const resolved = await resolveConfig(
    { mode: 'test', configFile: false, logLevel: 'silent', plugins: [solid()], test },
    'serve',
  );
  return {
    client: resolved.environments.client.resolve.conditions,
    ssr: resolved.environments.ssr.resolve.conditions,
  };
}

const failures = [];
const jsdom = await conditions({ environment: 'jsdom' });
if (!jsdom.client.includes('browser')) {
  failures.push(`jsdom: client conditions lack browser: ${JSON.stringify(jsdom.client)}`);
}
if (jsdom.ssr.includes('browser')) {
  failures.push(`jsdom: ssr conditions include browser: ${JSON.stringify(jsdom.ssr)}`);
}
const node = await conditions({ environment: 'node' });
if (!node.ssr.includes('browser')) {
  failures.push(`node: ssr conditions lack browser: ${JSON.stringify(node.ssr)}`);
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log('PASS: jsdom tests keep browser out of the ssr conditions');
