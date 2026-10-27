import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

let root: string;
let server: ViteDevServer;

// Resolves ids the way unplugin-icons does: the extension is appended after
// the query, giving `~icons/mdi/folder?width=2em.tsx`.
const iconsPlugin: Plugin = {
  name: 'test-icons',
  enforce: 'pre',
  resolveId(id) {
    if (!id.startsWith('~icons/')) return null;
    return id.endsWith('.tsx') ? id : `${id}.tsx`;
  },
  load(id) {
    if (id.startsWith('~icons/')) {
      return 'export default (props = {}) => <svg viewBox="0 0 24 24" {...props} />;';
    }
  },
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'solid-transform-ids-'));
  // The modules import @solidjs/web from this repo's install.
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/Comp.custom'), 'export const Comp = () => <div>custom</div>;\n');
  server = await createServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [solidPlugin({ extensions: ['.custom'] }), iconsPlugin],
  });
});

afterAll(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

describe('transform ids with queries', () => {
  // #206: since queries were stripped first, this id lost its extension and
  // Vite compiled the JSX for React instead.
  it('compiles JSX when the extension follows the query', async () => {
    const result = await server.environments.client.transformRequest('~icons/mdi/folder?width=2em');
    expect(result?.code).toContain('_$template(');
    expect(result?.code).not.toMatch(/react/i);
  });

  it('reads a custom extension from the path, not from a dot in the query', async () => {
    const result = await server.environments.client.transformRequest('/src/Comp.custom?x=1.5');
    expect(result?.code).toContain('_$template(');
    expect(result?.code).not.toContain('<div>custom</div>');
  });
});
