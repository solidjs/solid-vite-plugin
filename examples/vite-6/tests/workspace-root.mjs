// A package with a `solid` export condition that only the workspace root's
// package.json declares must still be inlined for a project in that
// workspace (#157). The crawl used to read only the project's own
// package.json, so Vitest left the package external and Node failed on its
// `.jsx` files with `Unknown file extension ".jsx"`.
//
// The fixture is a workspace in a temp directory. The root declares
// `fake-solid-lib`, and the project `packages/app` declares nothing.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from 'vite';
import solid from 'vite-plugin-solid';

const workspaceDir = path.join(os.tmpdir(), `vite-plugin-solid-workspace-${process.pid}`);
const appDir = path.join(workspaceDir, 'packages', 'app');
const libDir = path.join(workspaceDir, 'node_modules', 'fake-solid-lib');

let noExternal;
try {
  rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  writeFileSync(
    path.join(workspaceDir, 'package.json'),
    JSON.stringify({
      name: 'workspace',
      private: true,
      workspaces: ['packages/*'],
      dependencies: { 'fake-solid-lib': '1.0.0' },
    }),
  );
  writeFileSync(path.join(appDir, 'package.json'), '{ "name": "app", "private": true }\n');
  writeFileSync(
    path.join(libDir, 'package.json'),
    JSON.stringify({
      name: 'fake-solid-lib',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { solid: './index.jsx', default: './index.js' } },
    }),
  );
  writeFileSync(path.join(libDir, 'index.jsx'), 'export const Lib = () => <p>lib</p>;\n');
  writeFileSync(path.join(libDir, 'index.js'), 'export const Lib = () => null;\n');

  const resolved = await resolveConfig(
    { root: appDir, mode: 'test', configFile: false, logLevel: 'silent', plugins: [solid()] },
    'serve',
  );
  noExternal = resolved.environments.ssr.resolve.noExternal;
} finally {
  rmSync(workspaceDir, { recursive: true, force: true });
}

if (!Array.isArray(noExternal) || !noExternal.includes('fake-solid-lib')) {
  console.error(
    `FAIL: fake-solid-lib is not in ssr.resolve.noExternal: ${JSON.stringify(noExternal)}`,
  );
  process.exit(1);
}
console.log('PASS: framework packages declared only in the workspace root are inlined');
