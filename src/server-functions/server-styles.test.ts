import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solid from '../index.js';

function outputs(output: Rollup.RollupOutput | Rollup.RollupOutput[] | Rollup.RollupWatcher) {
  return (Array.isArray(output) ? output : [output as Rollup.RollupOutput]).flatMap(
    (o) => o.output,
  );
}

// #554: the client build walks a server module's graph for stylesheets, but
// what it loads there is never imported by the client.
describe('server component stylesheet walk', () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-server-styles-')));
    await symlink(
      fileURLToPath(new URL('../../node_modules', import.meta.url)),
      path.join(root, 'node_modules'),
      'dir',
    );
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/panel.css'), '.panel { color: red; }\n');
    await writeFile(
      path.join(root, 'src/notes.server.ts'),
      [
        "'use server';",
        "import './panel.css';",
        "import { notes } from './database';",
        'export async function countNotes() {',
        '  return (await notes()).length;',
        '}',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'src/client.ts'),
      "import { countNotes } from './notes.server';\ncountNotes();\n",
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function buildClient(input = 'src/client.ts') {
    return outputs(
      await build({
        root,
        configFile: false,
        cacheDir: path.join(root, '.vite'),
        logLevel: 'silent',
        build: {
          write: false,
          minify: false,
          rollupOptions: { input: path.join(root, input) },
        },
        plugins: [solid({ ssr: true, serverFunctions: { components: true } })],
      }),
    );
  }

  it('lets a walked server module import server-only', async () => {
    await writeFile(
      path.join(root, 'src/database.ts'),
      "import 'server-only';\nexport async function notes() {\n  return ['a', 'b'];\n}\n",
    );
    const output = await buildClient();
    expect(output.some((file) => file.fileName.endsWith('.css'))).toBe(true);
  }, 60_000);

  it('still fails a client module that imports server-only', async () => {
    await writeFile(
      path.join(root, 'src/database.ts'),
      "import 'server-only';\nexport async function notes() {\n  return ['a', 'b'];\n}\n",
    );
    await writeFile(
      path.join(root, 'src/direct-client.ts'),
      "import './notes.server';\nimport { notes } from './database';\nnotes();\n",
    );
    await expect(buildClient('src/direct-client.ts')).rejects.toThrow(
      /Attempt to import 'server-only' in a client module: .*database\.ts/,
    );
  }, 60_000);

  it('emits no chunk for a dynamic import below a walked module', async () => {
    await writeFile(
      path.join(root, 'src/database.ts'),
      "export async function notes() {\n  const { connect } = await import('./driver');\n  return connect();\n}\n",
    );
    await writeFile(
      path.join(root, 'src/driver.ts'),
      "export function connect() {\n  return ['SERVER-DRIVER-MARKER'];\n}\n",
    );
    const output = await buildClient();
    expect(output.some((file) => file.fileName.endsWith('.css'))).toBe(true);
    const code = output.map((file) => (file.type === 'chunk' ? file.code : '')).join('\n');
    expect(code).not.toContain('SERVER-DRIVER-MARKER');
  }, 60_000);
});
