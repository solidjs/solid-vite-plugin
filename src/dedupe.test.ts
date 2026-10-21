import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

let root: string;

async function writePackage(dir: string, pkg: Record<string, unknown>, files: Record<string, string>) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [name, code] of Object.entries(files)) {
    await writeFile(path.join(dir, name), code);
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'solid-dedupe-'));
  const fakeSolid = (copy: string) => [
    { name: 'solid-js', version: '2.0.0', type: 'module', exports: { '.': './index.js' } },
    { 'index.js': `export const copy = ${JSON.stringify(copy)};\n` },
  ] as const;
  await writePackage(path.join(root, 'node_modules/solid-js'), ...fakeSolid('root'));
  // A dependency that ships its own nested copy of solid-js.
  const lib = path.join(root, 'node_modules/lib');
  await writePackage(
    lib,
    { name: 'lib', version: '1.0.0', type: 'module', exports: { '.': './index.js' } },
    { 'index.js': "export { copy as libCopy } from 'solid-js';\n" },
  );
  await writePackage(path.join(lib, 'node_modules/solid-js'), ...fakeSolid('nested'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
  await writeFile(
    path.join(root, 'entry.js'),
    "import { copy } from 'solid-js';\nimport { libCopy } from 'lib';\nexport const copies = [copy, libCopy];\n",
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolve.dedupe', () => {
  // #112: dev deduped solid-js, but production builds bundled the nested copy too.
  it('bundles a single solid-js copy in production builds', async () => {
    const result = (await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [solidPlugin()],
      build: {
        write: false,
        minify: false,
        rolldownOptions: { input: path.join(root, 'entry.js'), preserveEntrySignatures: 'strict' },
      },
    })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
    const output = Array.isArray(result) ? result[0] : result;
    const code = output.output
      .filter((chunk): chunk is Rolldown.OutputChunk => chunk.type === 'chunk')
      .map((chunk) => chunk.code)
      .join('\n');
    expect(code).toContain('"root"');
    expect(code).not.toContain('"nested"');
  });
});
