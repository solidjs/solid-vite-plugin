import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

it('hot names its replacement', () => {
  expect(() => solidPlugin({ hot: false } as never)).toThrow(
    '`hot` has been removed. HMR is on by default; disable it with `refresh: false`.',
  );
});

it('refresh.disabled names its replacement', () => {
  expect(() => solidPlugin({ refresh: { disabled: true } as never })).toThrow(
    '`refresh.disabled` has been replaced by `refresh: false`.',
  );
});

describe('refresh transform in dev', () => {
  let root: string;

  async function clientCode(options: Parameters<typeof solidPlugin>[0]): Promise<string> {
    const server = await createServer({
      root,
      configFile: false,
      // Own optimizer cache: node_modules is a symlink to the repo's.
      cacheDir: path.join(root, '.vite'),
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [solidPlugin(options)],
    });
    try {
      return (await server.environments.client.transformRequest('/src/Page.tsx'))!.code;
    } finally {
      await server.close();
    }
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-refresh-'));
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      path.join(root, 'node_modules'),
      'dir',
    );
    await mkdir(path.join(root, 'src'));
    await writeFile(
      path.join(root, 'src/Page.tsx'),
      'export default function Page(props: { name: string }) {\n  return <div>Hello {props.name}</div>;\n}\n',
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('is on by default and with `true` or an object', async () => {
    for (const refresh of [undefined, true, { granular: false }]) {
      expect(await clientCode({ refresh })).toContain('$$registry');
    }
  });

  it('is off with `refresh: false`', async () => {
    expect(await clientCode({ refresh: false })).not.toContain('$$registry');
  });
});
