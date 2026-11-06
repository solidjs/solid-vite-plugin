import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const tscBin = path.join(
  path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin/tsc',
);
const BABEL = ['@babel/core', '@solidjs/babel-plugin'];
const JSX_ERROR =
  '`compiler: "babel"` needs `@babel/core` and `@solidjs/babel-plugin`: install them in the project, then restart the Vite process.';
const OPTION_ERROR =
  'the `babel` option needs `@babel/core`: install it in the project, then restart the Vite process.';

// Outside the repo, so the plugin's imports cannot reach the repo's node_modules.
const root = mkdtempSync(path.join(tmpdir(), 'solid-optional-babel-'));
const pluginDir = path.join(root, 'node_modules/@solidjs/vite-plugin');
afterAll(() => rmSync(root, { recursive: true, force: true }));

function link(pkg: string) {
  const target = path.join(root, 'node_modules', pkg);
  mkdirSync(path.dirname(target), { recursive: true });
  symlinkSync(realpathSync(path.join(repo, 'node_modules', pkg)), target, 'dir');
}

function unlink(pkg: string) {
  rmSync(path.join(root, 'node_modules', pkg), { force: true });
}

// A child process per scenario: one project state, one fresh module cache.
function compile(options: string) {
  writeFileSync(
    path.join(root, 'scenario.mjs'),
    `import { createServer } from 'vite';
import solid from '@solidjs/vite-plugin';
const server = await createServer({
  root: ${JSON.stringify(root)},
  configFile: false,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [solid(${options})],
});
await server.environments.client.transformRequest('/src/App.tsx').then(
  ({ code }) => console.log(code.includes('_$') ? 'compiled' : code),
  (error) => console.log(error.message),
);
await server.close();
`,
  );
  const result = spawnSync(process.execPath, ['scenario.mjs'], { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

// Through the tsc CLI: TypeScript 7 has no compiler API.
function tsc(...args: string[]) {
  return spawnSync(process.execPath, [tscBin, ...args, '--pretty', 'false'], {
    cwd: repo,
    encoding: 'utf8',
  }).stdout;
}

beforeAll(async () => {
  const bundle = await rolldown({
    input: path.join(repo, 'src/index.ts'),
    platform: 'node',
    external: (id) => !id.startsWith('.') && !path.isAbsolute(id),
  });
  await bundle.write({ format: 'esm', file: path.join(pluginDir, 'dist/esm/index.mjs') });
  await bundle.close();
  writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({ name: manifest.name, type: 'module', exports: './dist/esm/index.mjs' }),
  );

  for (const pkg of Object.keys(manifest.dependencies)) link(pkg);
  link('vite');
  link('solid-js');
  link('@solidjs/web');

  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(
    path.join(root, 'src/App.tsx'),
    'export default function App() {\n  return <div>{Math.random()}</div>;\n}\n',
  );
});

beforeEach(() => BABEL.forEach(unlink));

describe('package manifest', () => {
  it('keeps Babel out of the dependencies', () => {
    const dependencies = Object.keys(manifest.dependencies);
    expect(dependencies.filter((name) => name.includes('babel'))).toEqual([]);
  });

  it('declares the Babel packages as optional peers', () => {
    for (const pkg of BABEL) {
      expect(manifest.peerDependencies[pkg]).toBeDefined();
      expect(manifest.peerDependenciesMeta[pkg]).toEqual({ optional: true });
    }
  });
});

describe('without Babel installed', () => {
  it('compiles with the native compiler', () => {
    expect(compile('{}')).toBe('compiled');
  });

  it('names both packages for compiler: "babel"', () => {
    expect(compile('{ compiler: "babel" }')).toContain(JSX_ERROR);
  });

  it('names @babel/core for the babel option', () => {
    expect(compile('{ babel: { plugins: [] } }')).toContain(OPTION_ERROR);
  });
});

describe('with Babel installed', () => {
  it('runs the babel option on @babel/core alone', () => {
    link('@babel/core');
    expect(compile('{ babel: { plugins: [] } }')).toBe('compiled');
  });

  it('still needs the plugin for compiler: "babel"', () => {
    link('@babel/core');
    expect(compile('{ compiler: "babel" }')).toContain(JSX_ERROR);
  });

  it('compiles with compiler: "babel"', () => {
    BABEL.forEach(link);
    expect(compile('{ compiler: "babel" }')).toBe('compiled');
  });
});

describe('published types', () => {
  it('declares no import of @babel/core', () => {
    const out = path.join(root, 'types');
    tsc('-p', 'tsconfig.build.json', '--declarationDir', out);
    const declarations = readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((file) =>
      file.endsWith('.d.ts'),
    );
    expect(declarations).toContain(path.join('src', 'index.d.ts'));
    for (const file of declarations) {
      expect(readFileSync(path.join(out, file), 'utf8')).not.toMatch(/['"]@babel\/core['"]/);
    }
  });
});
