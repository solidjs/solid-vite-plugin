import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverFunctions } from './index.js';

const MANIFEST_ID = 'virtual:solid-server-function-manifest';

// solidjs/vite-plugin-solid#427: a host that owns the SSR environment
// imports the manifest in dev. Its load must not wait the build debounce.
describe('server function manifest under vite dev', () => {
  let root: string;
  let server: ViteDevServer;

  async function loadManifest() {
    const started = performance.now();
    const result = await server.environments.ssr.transformRequest(MANIFEST_ID);
    return { code: result?.code ?? '', elapsed: performance.now() - started };
  }

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-manifest-')));
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
    await writeFile(
      path.join(root, 'src/shout.ts'),
      '"use server";\nexport async function shout(name: string) {\n  return name.toUpperCase();\n}\n',
    );
    server = await createServer({
      root,
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [serverFunctions()],
    });
  });

  afterAll(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('loads the current list without waiting, and picks up new modules', async () => {
    const empty = await loadManifest();
    expect(empty.code).not.toContain('/src/greet.ts');
    expect(empty.elapsed).toBeLessThan(500);

    await server.environments.client.transformRequest('/src/greet.ts');
    const first = await loadManifest();
    expect(first.code).toContain('"/src/greet.ts"');
    expect(first.elapsed).toBeLessThan(500);

    await server.environments.client.transformRequest('/src/shout.ts');
    const second = await loadManifest();
    expect(second.code).toContain('"/src/greet.ts"');
    expect(second.code).toContain('"/src/shout.ts"');
    expect(second.elapsed).toBeLessThan(500);
  });

  it('drops a deleted module', async () => {
    const file = path.join(root, 'src/shout.ts');
    await unlink(file);
    // What Vite's watcher does on unlink.
    await Promise.all(
      Object.values(server.environments).map((environment) =>
        environment.pluginContainer.watchChange(file, { event: 'delete' }),
      ),
    );
    const { code } = await loadManifest();
    expect(code).toContain('"/src/greet.ts"');
    expect(code).not.toContain('/src/shout.ts');
  });

  it('drops a module that no longer declares server functions', async () => {
    await writeFile(
      path.join(root, 'src/greet.ts'),
      'export const greet = (name: string) => name;\n',
    );
    const module = server.environments.client.moduleGraph.getModuleById(
      path.join(root, 'src/greet.ts'),
    );
    if (module) server.environments.client.moduleGraph.invalidateModule(module);
    await server.environments.client.transformRequest('/src/greet.ts');
    const { code } = await loadManifest();
    expect(code).not.toContain('/src/greet.ts');
  });
});
