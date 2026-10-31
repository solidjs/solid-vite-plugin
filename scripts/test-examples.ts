// Builds each example, failing on Vite future deprecations in the build
// output, then runs the Playwright suite in e2e/ against its `vite preview`
// (see playwright.config.ts).
import { spawnSync } from 'node:child_process';

const examples = ['vite-8'];
const futureDeprecations = [
  "Plugin hook `options.ssr` is replaced with `this.environment.config.consumer === 'server'`.",
  'Plugin hook `handleHotUpdate()` is replaced with `hotUpdate()`.',
  'The `server.ssrLoadModule` is replaced with Environment Runner.',
];

let failed = false;
for (const example of examples) {
  console.log(`Testing ${example}...`);
  const build = spawnSync('pnpm', ['run', 'build'], {
    cwd: `examples/${example}`,
    encoding: 'utf-8',
  });
  const output = `${build.stdout}\n${build.stderr}`;
  const deprecation = futureDeprecations.find((message) => output.includes(message));
  if (build.status !== 0 || deprecation) {
    console.error(output);
    console.error(
      deprecation
        ? `Vite future deprecation in ${example}: ${deprecation}`
        : `Build failed for ${example}`,
    );
    failed = true;
    continue;
  }
  const test = spawnSync('pnpm', ['exec', 'playwright', 'test'], {
    stdio: 'inherit',
    env: { ...process.env, EXAMPLE: example },
  });
  if (test.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
