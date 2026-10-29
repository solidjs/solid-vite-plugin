// Headless checks of the built plugin against the Vite version installed in
// this repository. vite-ecosystem-ci runs this script (`pnpm test:ecosystem`)
// after it replaces Vite with the build under test. It needs no browser and
// no network, so it only depends on Vite and the plugin.
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createLogger, createServer, version } from 'vite';
import solid from '../dist/esm/index.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const failures = [];
const warnings = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
}

function logger() {
  const base = createLogger('warn', { allowClearScreen: false });
  return {
    ...base,
    warn(message, options) {
      warnings.push(message);
      base.warn(message, options);
    },
    warnOnce(message, options) {
      warnings.push(message);
      base.warnOnce(message, options);
    },
  };
}

async function write(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function createFixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'vite-plugin-solid-ecosystem-')));
  await write(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'ecosystem-fixture',
      private: true,
      type: 'module',
      dependencies: { 'solid-js': '*', 'fixture-solid-lib': '*' },
    }),
  );
  await mkdir(path.join(root, 'node_modules'));
  await symlink(
    path.join(repoRoot, 'node_modules/solid-js'),
    path.join(root, 'node_modules/solid-js'),
    'dir',
  );
  // A library that ships JSX source under the `solid` export condition.
  const lib = path.join(root, 'node_modules/fixture-solid-lib');
  await write(
    path.join(lib, 'package.json'),
    JSON.stringify({
      name: 'fixture-solid-lib',
      type: 'module',
      exports: { '.': { solid: './index.jsx', default: './index.js' } },
      peerDependencies: { 'solid-js': '*' },
    }),
  );
  await write(path.join(lib, 'index.jsx'), 'export const Badge = (props) => <b class="badge">{props.children}</b>;\n');
  await write(path.join(lib, 'index.js'), 'throw new Error("the solid condition was not used");\n');

  await write(
    path.join(root, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/entry-client.tsx"></script></body></html>\n',
  );
  await write(
    path.join(root, 'src/App.tsx'),
    [
      "import { createSignal } from 'solid-js';",
      "import { Badge } from 'fixture-solid-lib';",
      'export default function App() {',
      '  const [count, setCount] = createSignal(0);',
      '  return <main><button onClick={() => setCount(count() + 1)}>{count()}</button><Badge>lib</Badge></main>;',
      '}',
      '',
    ].join('\n'),
  );
  await write(
    path.join(root, 'src/entry-client.tsx'),
    "import { hydrate } from 'solid-js/web';\nimport App from './App';\nhydrate(() => <App />, document.getElementById('root')!);\n",
  );
  await write(
    path.join(root, 'src/entry-server.tsx'),
    "import { renderToString } from 'solid-js/web';\nimport App from './App';\nexport const render = () => renderToString(() => <App />);\n",
  );
  return root;
}

// Hydratable HTML with the app and the library component rendered on the server.
const isExpectedHtml = (html) =>
  typeof html === 'string' &&
  /^<main data-hk=/.test(html) &&
  html.includes('<button>0</button>') &&
  /<b data-hk=\S+ class="badge">lib<\/b>/.test(html);

async function main() {
  console.log(`vite ${version}`);
  const root = await createFixture();
  const base = { root, configFile: false, customLogger: logger() };
  try {
    // Dev server: client and SSR transforms, HMR runtime, SSR rendering.
    const server = await createServer({
      ...base,
      appType: 'custom',
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [solid({ ssr: true })],
    });
    try {
      const client = await server.transformRequest('/src/App.tsx');
      check('dev: client transform compiles JSX to DOM templates', /template/.test(client?.code ?? ''));
      check('dev: client transform includes the HMR runtime', /solid-refresh/.test(client?.code ?? ''));
      const { render } = await server.ssrLoadModule('/src/entry-server.tsx');
      const html = render();
      check('dev: SSR renders hydratable HTML', isExpectedHtml(html), html);
    } finally {
      await server.close();
    }

    // Client build.
    await build({
      ...base,
      plugins: [solid({ ssr: true })],
      build: { outDir: 'dist/client', minify: false },
    });
    const assets = path.join(root, 'dist/client/assets');
    const js = (await readdir(assets)).filter((file) => file.endsWith('.js'));
    const code = (await Promise.all(js.map((file) => readFile(path.join(assets, file), 'utf8')))).join('\n');
    check('build: client bundle contains the app and the library', code.includes('badge') && code.includes('hydrate'));
    check('build: client bundle has no HMR runtime', !code.includes('solid-refresh'));

    // SSR build.
    await build({
      ...base,
      plugins: [solid({ ssr: true })],
      build: { ssr: 'src/entry-server.tsx', outDir: 'dist/server', minify: false },
    });
    const { render } = await import(pathToFileURL(path.join(root, 'dist/server/entry-server.js')).href);
    const html = render();
    check('build: SSR bundle renders hydratable HTML', isExpectedHtml(html), html);

    const deprecations = warnings.filter((message) => /deprecat/i.test(message));
    check('no deprecation warnings', deprecations.length === 0, deprecations.join('\n'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  failures.push('unexpected error');
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
