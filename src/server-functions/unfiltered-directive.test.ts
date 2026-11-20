import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createLogger, createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverFunctions } from './index.js';

const SECRET = '"use server";\nexport async function readSecret() {\n  return process.env.DB_PASSWORD;\n}\n';
const COMMENT_ONLY = '// a "use server" note in a comment\nexport const x = 1;\n';

async function makeRoot() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-unfiltered-')));
  await symlink(
    fileURLToPath(new URL('../../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'server'));
  await writeFile(path.join(root, 'server/secret.ts'), SECRET);
  await writeFile(path.join(root, 'server/note.ts'), COMMENT_ONLY);
  await writeFile(path.join(root, 'src/secret.ts'), SECRET);
  return root;
}

describe('"use server" outside serverFunctions.filter', () => {
  let root: string;
  let server: ViteDevServer;
  const warnings: string[] = [];

  beforeAll(async () => {
    root = await makeRoot();
    const logger = createLogger('silent');
    logger.warn = (msg) => void warnings.push(msg);
    server = await createServer({
      root,
      configFile: false,
      cacheDir: path.join(root, '.vite'),
      appType: 'custom',
      customLogger: logger,
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [serverFunctions()],
    });
  });

  afterAll(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('warns in dev when a client module with the directive is not compiled', async () => {
    await server.environments.client.transformRequest('/server/secret.ts');
    expect(warnings.join('\n')).toContain('server/secret.ts contains "use server"');
  });

  it('warns once per module', async () => {
    await server.environments.client.transformRequest('/server/secret.ts?t=1');
    expect(warnings.filter((w) => w.includes('server/secret.ts')).length).toBe(1);
  });

  it('stays quiet for the directive text outside a directive and for compiled modules', async () => {
    await server.environments.client.transformRequest('/server/note.ts');
    await server.environments.client.transformRequest('/src/secret.ts');
    expect(warnings.join('\n')).not.toContain('note.ts');
    expect(warnings.join('\n')).not.toContain('src/secret.ts');
  });

  it('stays quiet in a server environment, where the function runs on the server', async () => {
    await server.environments.ssr.transformRequest('/server/secret.ts?ssr-check');
    expect(warnings.filter((w) => w.includes('server/secret.ts')).length).toBe(1);
  });
});

describe('"use server" outside serverFunctions.filter in a client build', () => {
  let root: string;

  beforeAll(async () => {
    root = await makeRoot();
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('fails the build instead of bundling the server code', async () => {
    await expect(
      build({
        root,
        configFile: false,
        logLevel: 'silent',
        build: { write: false, rollupOptions: { input: path.join(root, 'server/secret.ts') } },
        plugins: [serverFunctions()],
      }),
    ).rejects.toThrow(/server\/secret\.ts contains "use server" but is outside/);
  });

  it('builds when the file is added to filter.include', async () => {
    await expect(
      build({
        root,
        configFile: false,
        logLevel: 'silent',
        build: { write: false, rollupOptions: { input: path.join(root, 'server/secret.ts') } },
        plugins: [serverFunctions({ filter: { include: ['src/**/*.ts', 'server/**/*.ts'] } })],
      }),
    ).resolves.toBeDefined();
  });
});
