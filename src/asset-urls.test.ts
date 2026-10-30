import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transformAssetUrls } from './asset-urls.js';
import solidPlugin from './index.js';

let root: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-asset-urls-')));
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'src/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(root, 'public/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const transform = (code: string, publicUrls: { base: string } | 'import' | null = null) =>
  transformAssetUrls(code, path.join(root, 'src/App.tsx'), true, {
    publicUrls,
    publicDir: path.join(root, 'public'),
  })?.code;

describe('asset URLs in JSX', () => {
  it('imports a relative URL once per asset', () => {
    const code = transform(
      'export const A = () => <><img src="./logo.svg" /><video poster={"./logo.svg"} /></>;',
    );
    expect(code).toContain('import __solidAsset0 from "./logo.svg";');
    expect(code).toContain('<img src={__solidAsset0} />');
    expect(code).toContain('<video poster={__solidAsset0} />');
    expect(code).not.toContain('__solidAsset1');
  });

  it('keeps a fragment and rewrites each srcset candidate', () => {
    const code = transform(
      'export const A = () => <><use href="./logo.svg#home" /><img srcset="./logo.svg 1x, /icon.svg 2x" /></>;',
      { base: '/app/' },
    );
    expect(code).toContain('<use href={`${__solidAsset0}#home`} />');
    expect(code).toContain('<img srcset={`${__solidAsset0} 1x, /app/icon.svg 2x`} />');
  });

  it('gives public-directory URLs the base, or imports them', () => {
    const source = 'export const A = () => <><img src="/icon.svg" /><img src="/api/avatar" /></>;';
    expect(transform(source)).toBeUndefined();
    expect(transform(source, { base: '/app/' })).toContain('<img src={"/app/icon.svg"} />');
    const imported = transform(source, 'import');
    expect(imported).toContain('import __solidAsset0 from "/icon.svg";');
    expect(imported).toContain('<img src="/api/avatar" />');
  });

  it('leaves other URLs, attributes and elements alone', () => {
    expect(
      transform(
        'export const A = () => <><img src="https://example.com/x.png" /><img src="data:image/png;base64,AA" /><a href="./logo.svg" /><img src={logo} /><img src="/../secret" /></>;',
        { base: '/app/' },
      ),
    ).toBeUndefined();
  });

  it('imports after the directive prologue', () => {
    const code = transform('"use server";\nexport const A = () => <img src="./logo.svg" />;');
    expect(code?.startsWith('"use server";\nimport __solidAsset0 from "./logo.svg";')).toBe(true);
  });

  it('serves the assets from a relative-base build', async () => {
    await writeFile(
      path.join(root, 'src/main.tsx'),
      // A side effect keeps App: app builds drop the entry's exports.
      'const App = () => <><img src="./logo.svg" /><img src="/icon.svg" /></>;\nglobalThis.App = App;\n',
    );
    const result = (await build({
      root,
      base: './',
      configFile: false,
      // Own optimizer cache: node_modules is a symlink to the repo's.
      cacheDir: path.join(root, '.vite'),
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        assetsInlineLimit: 0,
        rollupOptions: { input: path.join(root, 'src/main.tsx') },
      },
      plugins: [solidPlugin()],
    })) as Rollup.RollupOutput;
    const chunk = result.output.find((file) => file.type === 'chunk') as Rollup.OutputChunk;
    const logo = result.output.find((file) => file.fileName.includes('logo'));
    expect(logo?.fileName).toMatch(/^assets\/logo-.+\.svg$/);
    expect(chunk.code).toContain(`new URL("${path.basename(logo!.fileName)}", import.meta.url)`);
    expect(chunk.code).toContain('new URL("../icon.svg", import.meta.url)');
    expect(chunk.code).not.toContain('./logo.svg');
  }, 60_000);
});
