import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevAssetResolver, devModuleUrl } from './dev-manifest.js';

describe('devModuleUrl', () => {
  const graph = (entries: Record<string, number>) => ({
    urlToModuleMap: new Map(
      Object.entries(entries).map(([url, lastHMRTimestamp]) => [url, { lastHMRTimestamp }] as any),
    ),
  });

  it('adds the client HMR timestamp like Vite import analysis', () => {
    const clientGraph = graph({ '/src/Page.tsx': 1794695609762, '/src/Fresh.tsx': 0 });
    expect(devModuleUrl('/root', '/', 'src/Page.tsx', clientGraph)).toBe(
      '/src/Page.tsx?t=1794695609762',
    );
    expect(devModuleUrl('/root', '/app/', '/src/Page.tsx', clientGraph)).toBe(
      '/app/src/Page.tsx?t=1794695609762',
    );
    expect(devModuleUrl('/root', '/', 'src/Fresh.tsx', clientGraph)).toBe('/src/Fresh.tsx');
    expect(devModuleUrl('/root', '/', 'src/Page.tsx')).toBe('/src/Page.tsx');
  });

  it('puts the timestamp first in an existing query', () => {
    const clientGraph = graph({ '/src/Page.tsx?raw-ish': 1794695609762 });
    expect(devModuleUrl('/root', '/', 'src/Page.tsx?raw-ish', clientGraph)).toBe(
      '/src/Page.tsx?t=1794695609762&raw-ish',
    );
  });

  it('looks up root-external keys by their /@fs/ URL', () => {
    const clientGraph = graph({ '/@fs/pkg/src/Page.tsx': 1794695609762 });
    expect(devModuleUrl('/root/app', '/', '../../pkg/src/Page.tsx', clientGraph)).toBe(
      '/@fs/pkg/src/Page.tsx?t=1794695609762',
    );
  });
});

describe('createDevAssetResolver', () => {
  let root: string;
  let server: ViteDevServer;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-dev-manifest-')));
    await mkdir(path.join(root, 'src'));
    await writeFile(
      path.join(root, 'src/App.js'),
      'export const load = () => import("./Page.js");\n',
    );
    await writeFile(path.join(root, 'src/Page.js'), 'export default 1;\n');
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true, ws: false },
    });
  });

  afterAll(async () => {
    await server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('matches the URL the client import graph uses after an HMR invalidation (#540)', async () => {
    const resolver = createDevAssetResolver(server);
    const client = server.environments.client;
    await client.transformRequest('/src/App.js');
    const page = await client.moduleGraph.getModuleByUrl('/src/Page.js');
    expect(page).toBeTruthy();
    expect((await resolver.resolve('src/Page.js'))!.js).toEqual(['/src/Page.js']);

    const timestamp = Date.now();
    client.moduleGraph.invalidateModule(page!, new Set(), timestamp, true);
    client.moduleGraph.invalidateModule(
      client.moduleGraph.getModuleById(path.join(root, 'src/App.js'))!,
    );
    const app = await client.transformRequest('/src/App.js');
    expect(app!.code).toContain(`"/src/Page.js?t=${timestamp}"`);

    // The cached entry from before the invalidation must not keep the stale URL.
    expect((await resolver.resolve('src/Page.js'))!.js).toEqual([`/src/Page.js?t=${timestamp}`]);
    expect(resolver.resolveSync('src/Page.js').js).toEqual([`/src/Page.js?t=${timestamp}`]);
  });
});
