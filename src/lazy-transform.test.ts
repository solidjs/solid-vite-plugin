import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

let root: string;
let server: ViteDevServer;

// Legal CommonJS (a top-level return), but not a parseable ES module.
const cjsSource = 'var lazyValue = 1;\nif (lazyValue) return;\nmodule.exports = lazyValue;\n';

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'solid-lazy-transform-'));
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/Page.tsx'), 'export default () => <main />;\n');
  await writeFile(
    path.join(root, 'src/routes.ts'),
    "import { lazy } from 'solid-js';\nexport const Page = lazy(() => import('./Page'));\n",
  );
  await mkdir(path.join(root, 'vendor/node_modules/cjslib'), { recursive: true });
  await writeFile(path.join(root, 'vendor/node_modules/cjslib/index.js'), cjsSource);
  server = await createServer({
    root,
    configFile: false,
    // Own optimizer cache: node_modules is a symlink to the repo's.
    cacheDir: path.join(root, '.vite'),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [solidPlugin()],
  });
});

afterAll(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

describe('lazy module URLs in non-JSX modules', () => {
  it('leaves CommonJS that mentions lazy without importing it alone', async () => {
    const result = await server.environments.client.transformRequest(
      '/vendor/node_modules/cjslib/index.js',
    );
    expect(result?.code).toContain('if (lazyValue) return;');
  });

  it('still adds the module URL to lazy imported from solid-js', async () => {
    const result = await server.environments.client.transformRequest('/src/routes.ts');
    expect(result?.code).toContain('"src/Page.tsx"');
  });
});
