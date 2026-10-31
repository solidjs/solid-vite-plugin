import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
// Inside node_modules, so the consumer resolves the repo's packages.
const dir = path.join(root, 'node_modules/.cache/virtual-modules-types');
const tsc = path.join(
  path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin/tsc',
);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Type-checks a consumer of the plugin's virtual modules against the shipped
// ambient declaration and the plugin's own types. Through the `tsc` CLI:
// TypeScript 7 has no compiler API.
function diagnostics(source: string): string[] {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'consumer.ts'), source);
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: 'esnext',
        module: 'esnext',
        moduleResolution: 'bundler',
        types: ['node'],
        paths: { '@solidjs/vite-plugin': [path.join(root, 'src/index.ts')] },
      },
      files: ['consumer.ts', path.join(root, 'virtual-modules.d.ts')],
    }),
  );
  const { stdout } = spawnSync(process.execPath, [tsc, '-p', '.', '--pretty', 'false'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  // `file(line,col): error TSn: message`, continued on indented lines. Only
  // the consumer's own errors count.
  return stdout
    .split(/\n(?=\S)/)
    .filter((diagnostic) => diagnostic.startsWith('consumer.ts('))
    .map((diagnostic) => diagnostic.replace(/^[^:]+: error TS\d+: /, '').trim());
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

it('types the server-function handler options, so a typo fails', () => {
  expect(
    diagnostics(`
      import { handleServerFunctionRequest } from 'virtual:solid-server-function-handler';
      import { handleRequest } from 'virtual:solid-ssr-handler';
      const request = new Request('http://localhost/_server');
      handleServerFunctionRequest(request, { event: { nativeEvent: {} }, onError: () => {} });
      handleRequest(request, { serverFunctions: { event: { nativeEvent: {} } } });
    `),
  ).toEqual([]);
  const errors = diagnostics(`
    import { handleServerFunctionRequest } from 'virtual:solid-server-function-handler';
    handleServerFunctionRequest(new Request('http://localhost/_server'), { evnet: {} });
  `);
  expect(errors.join('\n')).toContain("'evnet' does not exist");
});
