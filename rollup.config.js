import cjs from '@rollup/plugin-commonjs';
import cleaner from 'rollup-plugin-cleaner';
import { babel } from '@rollup/plugin-babel';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { readFileSync } from 'node:fs';

const extensions = ['.js', '.ts', '.json', '.tsx', '.jsx'];

const external = [
  '@babel/core',
  '@dom-expressions/compiler',
  '@ampproject/remapping',
  '@babel/preset-typescript',
  'babel-preset-solid',
  'merge-anything',
  'vitefu',
  'vite',
];

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
  input: 'src/index.ts',
  output: [
    {
      format: 'esm',
      file: 'dist/esm/index.mjs',
      sourcemap: true,
    },
    {
      format: 'cjs',
      file: 'dist/cjs/index.cjs',
      sourcemap: true,
      exports: 'named',
    },
  ],
  external,
  plugins: [
    cleaner({ targets: ['./dist/'] }),
    babel({
      extensions,
      babelHelpers: 'bundled',
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        '@babel/preset-typescript',
      ],
    }),
    nodeResolve({ extensions, preferBuiltins: true, browser: false }),
    cjs({ extensions }),
  ],
};

function css() {
  return {
    name: 'devtools-css',
    transform(code, id) {
      if (!id.endsWith('.css')) return null;
      return {
        code: `const style = document.createElement('style');\nstyle.textContent = ${JSON.stringify(code)};\ndocument.head.append(style);`,
        map: null,
      };
    },
  };
}

function assetUrl() {
  return {
    name: 'devtools-asset-url',
    async resolveId(source, importer) {
      if (!source.endsWith('?url')) return null;
      const resolved = await this.resolve(source.slice(0, -4), importer, { skipSelf: true });
      return resolved ? `${resolved.id}?url` : null;
    },
    load(id) {
      if (!id.endsWith('?url')) return null;
      const referenceId = this.emitFile({
        type: 'asset',
        name: 'onig.wasm',
        source: readFileSync(id.slice(0, -4)),
      });
      return `export default import.meta.ROLLUP_FILE_URL_${referenceId};`;
    },
  };
}

function packageVersion() {
  const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;
  return {
    name: 'devtools-version',
    load(id) {
      if (!id.endsWith('/src/devtools/client/version.ts')) return null;
      return `export default ${JSON.stringify(version)};`;
    },
  };
}

/** @type {import('rollup').RollupOptions} */
const devtoolsConfig = {
  input: 'src/devtools/client/index.tsx',
  output: {
    format: 'esm',
    dir: 'dist/devtools',
    entryFileNames: 'client.js',
    chunkFileNames: '[name]-[hash].js',
    assetFileNames: '[name]-[hash][extname]',
    sourcemap: true,
  },
  external(id) {
    return (
      id === 'solid-js' ||
      id.startsWith('solid-js/') ||
      id === '@solidjs/web' ||
      id.startsWith('@solidjs/web/')
    );
  },
  plugins: [
    css(),
    assetUrl(),
    packageVersion(),
    babel({
      extensions,
      babelHelpers: 'bundled',
      presets: [
        ['@babel/preset-env', { targets: { esmodules: true } }],
        '@babel/preset-typescript',
        ['babel-preset-solid', { moduleName: '@solidjs/web', generate: 'dom' }],
      ],
    }),
    nodeResolve({ extensions, browser: true }),
    cjs({ extensions }),
  ],
};

export default [config, devtoolsConfig];
