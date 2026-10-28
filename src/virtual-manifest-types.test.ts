import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

// Type-checks a consumer of `virtual:solid-manifest` against the shipped
// ambient declaration and the plugin's own types.
function diagnostics(source: string): string[] {
  const file = path.join(root, 'src/__virtual-manifest-consumer.ts');
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['node'],
    baseUrl: root,
    paths: { '@solidjs/vite-plugin': ['./src/index.ts'] },
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => (path.resolve(name) === file ? source : readFile(name));
  host.fileExists = (
    (exists) => (name: string) =>
      path.resolve(name) === file || exists(name)
  )(host.fileExists.bind(host));
  const program = ts.createProgram(
    [file, path.join(root, 'virtual-solid-manifest.d.ts')],
    options,
    host,
  );
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(file))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

it('types virtual:solid-manifest as the build manifest or the dev resolver', () => {
  expect(
    diagnostics(`
      import manifest from 'virtual:solid-manifest';
      import type { DevAssetResolver, ViteManifest } from '@solidjs/vite-plugin';
      import type { renderToStream } from '@solidjs/web';

      const options: NonNullable<Parameters<typeof renderToStream>[1]> = { manifest };
      if (manifest.resolve) {
        const resolver: DevAssetResolver = manifest;
        resolver.resolveSync('src/App.tsx').js;
      } else {
        const built: ViteManifest = manifest;
        const base: string | undefined = built._base;
        built['src/App.tsx']?.file;
      }
      export { options };
    `),
  ).toEqual([]);
});

it('does not let the union pass as a build manifest without narrowing', () => {
  const errors = diagnostics(`
    import manifest from 'virtual:solid-manifest';
    import type { ViteManifest } from '@solidjs/vite-plugin';
    export const built: ViteManifest = manifest;
  `);
  expect(errors.join('\n')).toContain("is not assignable to type 'ViteManifest'");
});
