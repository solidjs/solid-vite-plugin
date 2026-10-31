import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createBuilder, type Rollup } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverFunctions } from './index.js';

const HANDLER_ID = 'virtual:solid-server-function-handler';

function chunkCode(output: Rollup.RollupOutput | Rollup.RollupOutput[] | Rollup.RollupWatcher) {
  const outputs = Array.isArray(output) ? output : [output as Rollup.RollupOutput];
  return outputs
    .flatMap((o) => o.output)
    .map((chunk) => (chunk.type === 'chunk' ? chunk.code : ''))
    .join('\n');
}

// solidjs/solid#4215: the client build stamps its calls with a build id, and
// the server build is configured with the same id (read back from the
// persisted manifest, as the classic two-invocation build has to).
describe('server function build id', () => {
  let root: string;
  let client: string;
  let server: string;
  let buildId: string | undefined;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-build-id-')));
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
      path.join(root, 'src/client.ts'),
      [
        "import { configureServerFunctionsClient } from '@solidjs/web/server-functions';",
        "import { greet } from './greet';",
        'configureServerFunctionsClient({',
        '  prepareRequest(init) {',
        "    init.headers['X-App'] = 'app-hook';",
        '    return init;',
        '  },',
        '});',
        "greet('a');",
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'src/server.ts'),
      `export { handleServerFunctionRequest } from ${JSON.stringify(HANDLER_ID)};\n`,
    );
    const shared = {
      root,
      configFile: false as const,
      // Own optimizer cache: node_modules is a symlink to the repo's.
      cacheDir: path.join(root, '.vite'),
      logLevel: 'silent' as const,
      plugins: [serverFunctions()],
    };
    client = chunkCode(
      await build({
        ...shared,
        build: {
          outDir: 'dist/client',
          minify: false,
          rollupOptions: { input: path.join(root, 'src/client.ts') },
        },
      }),
    );
    const persisted = JSON.parse(
      await readFile(path.join(root, 'dist/client/.vite/solid-server-functions.json'), 'utf-8'),
    );
    buildId = persisted.buildId;
    server = chunkCode(
      await build({
        ...shared,
        build: { outDir: 'dist/server', minify: false, ssr: path.join(root, 'src/server.ts') },
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists a build id from the client build', () => {
    expect(buildId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stamps client calls with the id, ahead of the app hook', () => {
    expect(client).toContain('X-Server-Function-Build');
    expect(client).toContain(JSON.stringify(buildId));
    expect(client).toContain('app-hook');
  });

  it('configures the server with the client build id', () => {
    expect(server).toContain(`buildId: ${JSON.stringify(buildId)}`);
  });
});

describe('server function build id outside the defaults', () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-build-id-out-')));
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
      path.join(root, 'src/client.ts'),
      "import { greet } from './greet';\ngreet('a');\n",
    );
    await writeFile(
      path.join(root, 'src/server.ts'),
      `export { handleServerFunctionRequest } from ${JSON.stringify(HANDLER_ID)};\n`,
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Builds the client into `clientOutDir`, then the server, and returns the
  // id the client build persisted with both outputs.
  async function buildPair(
    clientOutDir: string,
    plugins: () => ReturnType<typeof serverFunctions>,
    serverConfig: Record<string, unknown> = {},
  ) {
    const shared = {
      root,
      configFile: false as const,
      cacheDir: path.join(root, '.vite'),
      logLevel: 'silent' as const,
    };
    await rm(path.join(root, 'out'), { recursive: true, force: true });
    const client = chunkCode(
      await build({
        ...shared,
        plugins: plugins(),
        build: {
          outDir: clientOutDir,
          minify: false,
          rollupOptions: { input: path.join(root, 'src/client.ts') },
        },
      }),
    );
    const persisted = JSON.parse(
      await readFile(path.join(root, clientOutDir, '.vite/solid-server-functions.json'), 'utf-8'),
    );
    const server = chunkCode(
      await build({
        ...shared,
        ...serverConfig,
        plugins: plugins(),
        build: { outDir: 'out/server', minify: false, ssr: path.join(root, 'src/server.ts') },
      }),
    );
    return { buildId: persisted.buildId as string, client, server };
  }

  it('reads the id back from a custom client outDir in one process', async () => {
    const instance = serverFunctions();
    const { buildId, server } = await buildPair('out/public', () => instance);
    expect(server).toContain(`buildId: ${JSON.stringify(buildId)}`);
  }, 60_000);

  it("reads the id back from the client environment's configured outDir", async () => {
    const { buildId, server } = await buildPair('out/public', () => serverFunctions(), {
      environments: { client: { build: { outDir: 'out/public' } } },
    });
    expect(server).toContain(`buildId: ${JSON.stringify(buildId)}`);
  }, 60_000);

  it('still stamps when runtime spells out the default', async () => {
    const runtime = {
      server: '@solidjs/web/server-functions',
      client: '@solidjs/web/server-functions',
    };
    const instance = serverFunctions({ runtime });
    const { buildId, client, server } = await buildPair('out/public', () => instance);
    expect(client).toContain('X-Server-Function-Build');
    expect(server).toContain(`buildId: ${JSON.stringify(buildId)}`);
  }, 60_000);
});

// #511: nitro builds the app in builder mode with a shared config and moves
// the client's output away from dist/client in configEnvironment.
describe('server function build id in a shared-config app build', () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-build-id-app-')));
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
      path.join(root, 'src/client.ts'),
      "import { greet } from './greet';\ngreet('a');\n",
    );
    await writeFile(
      path.join(root, 'src/server.ts'),
      `export { handleServerFunctionRequest } from ${JSON.stringify(HANDLER_ID)};\n`,
    );
    // A stale manifest from an earlier build, where the server used to look.
    await mkdir(path.join(root, 'dist/client/.vite'), { recursive: true });
    await writeFile(
      path.join(root, 'dist/client/.vite/solid-server-functions.json'),
      JSON.stringify({ modules: [], functions: [], buildId: '5ta1e5ta1e5ta1e0' }),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('configures the server with the id the client build stamps', async () => {
    const builder = await createBuilder({
      root,
      configFile: false,
      cacheDir: path.join(root, '.vite'),
      logLevel: 'silent',
      builder: { sharedConfigBuild: true },
      environments: {
        client: {
          build: {
            outDir: 'out/public',
            minify: false,
            rollupOptions: { input: path.join(root, 'src/client.ts') },
          },
        },
        ssr: {
          build: {
            outDir: 'out/server',
            minify: false,
            rollupOptions: { input: path.join(root, 'src/server.ts') },
          },
        },
      },
      plugins: [serverFunctions()],
    });
    const client = chunkCode(await builder.build(builder.environments.client));
    // A host may move or clean the client output before the server builds:
    // the id comes from this build's memory, not from a file.
    await rm(path.join(root, 'out/public/.vite/solid-server-functions.json'));
    const server = chunkCode(await builder.build(builder.environments.ssr));
    const stamped = client.match(/"X-Server-Function-Build"\]\s*=\s*"([0-9a-f]{16})"/)?.[1];
    expect(stamped).toMatch(/^[0-9a-f]{16}$/);
    expect(server).toContain(`buildId: ${JSON.stringify(stamped)}`);
    // The file moves beside the server bundle, out of the client output.
    expect(existsSync(path.join(root, 'out/public/.vite'))).toBe(false);
    const moved = JSON.parse(
      await readFile(path.join(root, 'out/server/.vite/solid-server-functions.json'), 'utf-8'),
    );
    expect(moved.buildId).toBe(stamped);
  }, 60_000);

  // The README configures the client through the `/client` subpath.
  it('stamps calls when the app configures the client through /client', async () => {
    await writeFile(
      path.join(root, 'src/subpath-client.ts'),
      [
        "import { configureServerFunctionsClient } from '@solidjs/web/server-functions/client';",
        "import { greet } from './greet';",
        'configureServerFunctionsClient({',
        '  fetch: async (_url: string, init: any) => {',
        '    (globalThis as any).__headers = init.headers;',
        "    throw new Error('captured');",
        '  },',
        '  prepareRequest(init: any) {',
        "    init.headers['X-App'] = 'app-hook';",
        '    return init;',
        '  },',
        '});',
        "(globalThis as any).__call = () => greet('a');",
      ].join('\n'),
    );
    const client = chunkCode(
      await build({
        root,
        configFile: false,
        cacheDir: path.join(root, '.vite'),
        logLevel: 'silent',
        build: {
          write: false,
          minify: false,
          rollupOptions: { input: path.join(root, 'src/subpath-client.ts') },
        },
        plugins: [serverFunctions()],
      }),
    );
    await import('data:text/javascript;base64,' + Buffer.from(client).toString('base64'));
    await (globalThis as any).__call().catch(() => {});
    const headers = (globalThis as any).__headers;
    expect(headers['X-App']).toBe('app-hook');
    expect(headers['X-Server-Function-Build']).toMatch(/^[0-9a-f]{16}$/);
  }, 60_000);
});
