import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer, type Plugin, type Rollup } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

let root: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-alias-')));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
  await writeFile(path.join(root, 'entry.js'), "export { join } from 'path/posix';\n");
  await writeFile(path.join(root, 'user-posix.js'), 'export const join = "user alias";\n');
  // The `path` polyfill has no `posix` subpath, like path-browserify.
  await mkdir(path.join(root, 'polyfill'));
  await writeFile(path.join(root, 'polyfill/index.js'), 'export const join = "polyfill";\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolve.alias', () => {
  // #130: the plugin turned the user's alias object into an array. Vite then
  // put aliases from later plugins first, so `path` matched `path/posix`.
  it('keeps user object aliases ahead of aliases added by later plugins', async () => {
    const polyfills: Plugin = {
      name: 'test-polyfills',
      config: () => ({ resolve: { alias: { path: path.join(root, 'polyfill') } } }),
    };
    const result = (await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [solidPlugin(), polyfills],
      resolve: { alias: { 'path/posix': path.join(root, 'user-posix.js') } },
      build: {
        write: false,
        minify: false,
        rollupOptions: { input: path.join(root, 'entry.js'), preserveEntrySignatures: 'strict' },
      },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    const output = Array.isArray(result) ? result[0] : result;
    const code = output.output
      .filter((chunk): chunk is Rollup.OutputChunk => chunk.type === 'chunk')
      .map((chunk) => chunk.code)
      .join('\n');
    expect(code).toContain('"user alias"');
  });

  it('still serves the HMR runtime for the solid-refresh import', async () => {
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      path.join(root, 'node_modules'),
      'dir',
    );
    await writeFile(path.join(root, 'App.tsx'), 'export const App = () => <div>app</div>;\n');
    const server = await createServer({
      root,
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true, ws: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [solidPlugin()],
    });
    try {
      const app = await server.transformRequest('/App.tsx');
      expect(app?.code).toMatch(/from ["']\/@solid-refresh["']/);
      const runtime = await server.transformRequest('/@solid-refresh');
      expect(runtime?.code).toContain('$$registry');
    } finally {
      await server.close();
    }
  });
});
