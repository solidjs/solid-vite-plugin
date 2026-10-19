import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConfigEnv, UserConfig } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

const roots: string[] = [];

// A project root whose installed vitest has the given version.
async function projectWithVitest(version: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-jest-dom-')));
  roots.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
  await mkdir(path.join(root, 'node_modules/vitest'), { recursive: true });
  await writeFile(
    path.join(root, 'node_modules/vitest/package.json'),
    JSON.stringify({ name: 'vitest', version }),
  );
  return root;
}

async function setupFilesFor(root: string): Promise<string[]> {
  const plugin = solidPlugin();
  const userConfig: UserConfig = { root, mode: 'test' };
  const env: ConfigEnv = { command: 'serve', mode: 'test' };
  const config = await (plugin.config as Function).call({}, userConfig, env);
  return config.test?.setupFiles;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('jest-dom setup file', () => {
  // #141: vitest < 1 loaded jest-dom's CommonJS entry, which threw
  // "Cannot read properties of undefined (reading 'extend')".
  it('injects the ESM entry path for vitest before 1.0', async () => {
    const [setupFile] = await setupFilesFor(await projectWithVitest('0.34.6'));
    expect(setupFile).toMatch(/@testing-library[\\/]jest-dom[\\/]dist[\\/]vitest\.mjs$/);
    expect(path.isAbsolute(setupFile)).toBe(true);
    expect(existsSync(setupFile)).toBe(true);
  });

  it('keeps the bare specifier for vitest 1.0 and later', async () => {
    const setupFiles = await setupFilesFor(await projectWithVitest('1.0.0'));
    expect(setupFiles).toEqual(['@testing-library/jest-dom/vitest']);
  });
});
