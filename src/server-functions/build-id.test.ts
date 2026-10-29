import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
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
