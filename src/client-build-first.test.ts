// `ssr: true` builds the client environment ahead of server-first
// orchestrators, so server builds can read its manifest. A host that sets the
// client's real input only after its own server builds (Astro) leaves the
// top-level `build` input in place until then; the client sees that shared
// server input and must not be built from it.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuilder, type Plugin } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

let root: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-client-build-first-')));
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'src/Island.tsx'),
    'export default function Island() {\n  return <p>island</p>;\n}\n',
  );
  await writeFile(
    path.join(root, 'src/client.tsx'),
    "import { render } from '@solidjs/web';\nimport Island from './Island';\nrender(() => <Island />, document.body);\n",
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const SERVER_ENTRY = 'virtual:host-server-entry';

// A server entry that only server environments can resolve, like Astro's.
function serverEntry(): Plugin {
  return {
    name: 'host-server-entry',
    resolveId(id) {
      if (id === SERVER_ENTRY && this.environment.config.consumer === 'server') return '\0' + id;
    },
    load(id) {
      if (id === '\0' + SERVER_ENTRY) return 'export default "server";';
    },
  };
}

async function build(sharedInput: boolean) {
  const order: string[] = [];
  const builder = await createBuilder({
    root,
    configFile: false,
    cacheDir: path.join(root, '.vite'),
    logLevel: 'silent',
    build: sharedInput ? { rollupOptions: { input: SERVER_ENTRY } } : {},
    environments: {
      client: {
        build: {
          outDir: 'dist/client',
          manifest: true,
          ...(sharedInput ? {} : { rollupOptions: { input: 'src/client.tsx' } }),
        },
      },
      ssr: {
        build: { outDir: 'dist/server', rollupOptions: { input: SERVER_ENTRY } },
      },
    },
    plugins: [
      solidPlugin({ ssr: true }),
      serverEntry(),
      {
        name: 'record-order',
        buildStart() {
          order.push(this.environment.name);
        },
      },
    ],
    // A config-level orchestrator: servers first, then the client with the
    // input it found while building them.
    builder: {
      async buildApp(builder) {
        await builder.build(builder.environments.ssr);
        const client = builder.environments.client;
        if (client.isBuilt) return;
        client.config.build.rollupOptions.input = path.join(root, 'src/client.tsx');
        await builder.build(client);
      },
    },
  });
  await builder.buildApp();
  return order;
}

describe('client-build-first', () => {
  it('leaves the order to the host when the client only has the shared server input', async () => {
    expect(await build(true)).toEqual(['ssr', 'client']);
  }, 60_000);

  it('still builds a client with its own input first', async () => {
    expect(await build(false)).toEqual(['client', 'ssr']);
  }, 60_000);
});
