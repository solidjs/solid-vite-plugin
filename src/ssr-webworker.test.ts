import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, type Rollup } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'solid-ssr-worker-'));
  // Mirrors the export map of solid-js: `worker` selects the server build.
  const solid = path.join(root, 'node_modules/solid-js');
  await mkdir(solid, { recursive: true });
  await writeFile(
    path.join(solid, 'package.json'),
    JSON.stringify({
      name: 'solid-js',
      version: '1.9.0',
      type: 'module',
      exports: {
        '.': {
          worker: './server.js',
          browser: './browser.js',
          node: './server.js',
          default: './browser.js',
        },
      },
    }),
  );
  await writeFile(path.join(solid, 'server.js'), 'export const build = "server";\n');
  await writeFile(path.join(solid, 'browser.js'), 'export const build = "browser";\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
  await writeFile(path.join(root, 'entry.js'), "export { build } from 'solid-js';\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function buildSsr(ssr: Record<string, unknown>) {
  const result = (await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [solidPlugin({ ssr: true })],
    ssr: { noExternal: true, ...ssr },
    build: {
      ssr: path.join(root, 'entry.js'),
      write: false,
      minify: false,
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const output = Array.isArray(result) ? result[0] : result;
  return output.output
    .filter((chunk): chunk is Rollup.OutputChunk => chunk.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n');
}

describe('ssr.target webworker', () => {
  // #153: the webworker SSR build resolved the browser build of solid-js.
  it('resolves the server build through the worker condition', async () => {
    const code = await buildSsr({ target: 'webworker' });
    expect(code).toContain('"server"');
    expect(code).not.toContain('"browser"');
  });

  it('still resolves the server build for the node target', async () => {
    const code = await buildSsr({});
    expect(code).toContain('"server"');
  });
});
