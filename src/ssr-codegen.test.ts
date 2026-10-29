import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type InlineConfig } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solidPlugin, { type Options } from './index.js';

// https://github.com/solidjs/solid-vite-plugin/issues/64
describe('JSX codegen per transform', () => {
  let root: string;

  async function transform(options: Partial<Options>, config: InlineConfig = {}) {
    const server = await createServer({
      root,
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [solidPlugin(options)],
      ...config,
    });
    try {
      const client = await server.environments.client.transformRequest('/src/Page.tsx');
      const ssr = await server.environments.ssr.transformRequest('/src/Page.tsx');
      return { server, client: client!.code, ssr: ssr!.code };
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  async function render(server: Awaited<ReturnType<typeof transform>>['server']) {
    try {
      const { renderToString } = await server.ssrLoadModule('solid-js/web');
      const { default: Page } = await server.ssrLoadModule('/src/Page.tsx');
      return renderToString(() => Page({ name: 'x' })) as string;
    } finally {
      await server.close();
    }
  }

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'vite-plugin-solid-ssr-codegen-')));
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      path.join(root, 'node_modules'),
      'dir',
    );
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'ssr-codegen-fixture', private: true, type: 'module' }),
    );
    await mkdir(path.join(root, 'src'));
    await writeFile(
      path.join(root, 'src/Page.tsx'),
      'export default (props: { name: string }) => <div class="page">Hello {props.name}</div>;\n',
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('compiles server transforms with the SSR generate when `ssr` is off', async () => {
    const { server, client, ssr } = await transform({ hot: false });
    expect(client).toContain('template');
    expect(ssr).not.toContain('template');
    expect(await render(server)).toBe('<div class="page">Hello x</div>');
  });

  it('keeps hydration keys in server output when `ssr` is on', async () => {
    const { server, client, ssr } = await transform({ hot: false, ssr: true });
    expect(client).toContain('template');
    expect(ssr).not.toContain('template');
    expect(await render(server)).toMatch(/data-hk=/);
  });

  it('keeps DOM output for server transforms in test mode', async () => {
    const { server, ssr } = await transform({ hot: false }, { mode: 'test' });
    await server.close();
    expect(ssr).toContain('template');
  });
});
