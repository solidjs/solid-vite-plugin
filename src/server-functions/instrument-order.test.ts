import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import solidPlugin from '../index.js';

declare global {
  // eslint-disable-next-line no-var
  var __instrumentOrder: string[] | undefined;
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-instrument-order-'));
  await symlink(
    fileURLToPath(new URL('../../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'src/App.tsx'),
    'export default function App() {\n  return <main>app</main>;\n}\n',
  );
  await writeFile(
    path.join(root, 'src/instrument.ts'),
    "(globalThis.__instrumentOrder ??= []).push('instrument');\n",
  );
  await writeFile(
    path.join(root, 'src/functions.ts'),
    "(globalThis.__instrumentOrder ??= []).push('functions');\n\n" +
      "export async function ping() {\n  'use server';\n  return 'pong';\n}\n",
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  delete globalThis.__instrumentOrder;
});

// A server-function call can be the first request the dev server's SSR
// runner sees (no page has loaded the handler yet). The function's module
// must still load after the instrument module, like everything else in the
// server graph.
it('loads the instrument module before the function module on a first server-function request', async () => {
  const server = await createServer({
    root,
    configFile: false,
    cacheDir: path.join(root, '.vite'),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      solidPlugin({
        start: { instrument: './src/instrument.ts' },
        ssr: true,
        serverFunctions: true,
      }),
    ],
  });
  const http = createHttpServer(server.middlewares);
  try {
    // What the browser fetching the module does: the client transform
    // registers it with the dev manifest, without loading the server handler.
    const client = await server.environments.client.transformRequest('/src/functions.ts');
    const id = client?.code.match(/["'](ping-[0-9a-f]+(?:-\d+)?)["']/)?.[1];
    expect(id).toBeDefined();

    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as AddressInfo;
    await fetch(`http://127.0.0.1:${port}/_server/${id}`, { method: 'POST' });

    expect(globalThis.__instrumentOrder).toEqual(['instrument', 'functions']);
  } finally {
    http.close();
    await server.close();
  }
});
