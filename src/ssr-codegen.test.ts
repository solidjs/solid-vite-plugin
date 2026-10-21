import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

// https://github.com/solidjs/solid-vite-plugin/issues/64
describe('JSX codegen per transform', () => {
  let root: string;

  async function serve(options: Parameters<typeof solidPlugin>[0]): Promise<ViteDevServer> {
    return createServer({
      root,
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [solidPlugin(options)],
    });
  }

  async function transform(options: Parameters<typeof solidPlugin>[0]) {
    const server = await serve(options);
    try {
      const client = await server.environments.client.transformRequest('/src/Page.tsx');
      const ssr = await server.environments.ssr.transformRequest('/src/Page.tsx');
      const { renderToString } = await server.ssrLoadModule('@solidjs/web');
      const { default: Page } = await server.ssrLoadModule('/src/Page.tsx');
      const html = renderToString(() => Page({ name: 'x' })) as string;
      return { client: client!.code, ssr: ssr!.code, html };
    } finally {
      await server.close();
    }
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-ssr-codegen-'));
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      path.join(root, 'node_modules'),
      'dir',
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
    const { client, ssr, html } = await transform({ hot: false });
    expect(client).toContain('template');
    expect(ssr).not.toContain('template');
    expect(html).toBe('<div class="page">Hello x</div>');
  });

  it('keeps hydration keys in server output when `ssr` is on', async () => {
    const { client, ssr, html } = await transform({ hot: false, ssr: true });
    expect(client).toContain('template');
    expect(ssr).not.toContain('template');
    expect(html).toMatch(/_hk=/);
  });
});
