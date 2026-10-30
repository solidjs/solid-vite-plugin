import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverFunctions } from './index.js';

const MANIFEST_ID = 'virtual:solid-server-function-manifest';

// A host can own the server side under its own environment name (Void's
// `void_worker`, a Cloudflare worker) and import the manifest there. A server
// function the client reaches first has to show up in that environment's
// manifest too.
describe('server function manifest in a host-named server environment', () => {
  let root: string;
  let server: ViteDevServer;

  async function loadManifest() {
    const result = await server.environments.worker!.transformRequest(MANIFEST_ID);
    return result?.code ?? '';
  }

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-env-')));
    await symlink(
      fileURLToPath(new URL('../../node_modules', import.meta.url)),
      path.join(root, 'node_modules'),
      'dir',
    );
    await mkdir(path.join(root, 'src'));
    await writeFile(
      path.join(root, 'src/greet.ts'),
      '"use server";\nexport async function greet(name: string) {\n  return `hello ${name}`;\n}\n',
    );
    server = await createServer({
      root,
      configFile: false,
      // Own optimizer cache: node_modules is a symlink to the repo's.
      cacheDir: path.join(root, '.vite'),
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      environments: {
        client: {},
        worker: { consumer: 'server' },
      },
      plugins: [serverFunctions()],
    });
  });

  afterAll(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('invalidates the manifest in that environment when the client finds a new module', async () => {
    expect(await loadManifest()).not.toContain('/src/greet.ts');

    await server.environments.client.transformRequest('/src/greet.ts');

    expect(await loadManifest()).toContain('"/src/greet.ts"');
  });
});
