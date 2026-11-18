import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

async function resolveConfig(userConfig: Record<string, unknown>, root = process.cwd()) {
  const plugin = solidPlugin();
  const config = plugin.config as (...args: any[]) => Promise<any>;
  return config.call({}, { root, mode: 'test', ...userConfig }, { command: 'serve', mode: 'test' });
}

async function resolveTestConfig(userTest: Record<string, unknown>) {
  return (await resolveConfig({ test: userTest })).test;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writePkg(dir: string, pkg: Record<string, unknown>) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
}

describe('test config', () => {
  it('sets the jsdom environment', async () => {
    const test = await resolveTestConfig({});
    expect(test?.environment).toBe('jsdom');
  });

  it('sets the jsdom environment when solid-js is already external', async () => {
    const test = await resolveTestConfig({ server: { deps: { external: [/solid-js/] } } });
    expect(test?.environment).toBe('jsdom');
    expect(test?.server).toBeUndefined();
  });

  // #543: solid-transition-group's own dependencies stayed external and
  // loaded a second solid-js.
  it('inlines runtime consumers reached through another consumer', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-test-inline-')));
    roots.push(root);
    const modules = path.join(root, 'node_modules');
    await writePkg(root, { name: 'app', dependencies: { 'solid-js': '*', a: '*' } });
    await writePkg(path.join(modules, 'solid-js'), { name: 'solid-js' });
    await writePkg(path.join(modules, 'a'), {
      name: 'a',
      dependencies: { b: '*' },
      peerDependencies: { 'solid-js': '*' },
    });
    await writePkg(path.join(modules, 'b'), {
      name: 'b',
      dependencies: { 'solid-js': '*', c: '*' },
    });
    await writePkg(path.join(modules, 'c'), { name: 'c' });

    const config = await resolveConfig({ ssr: { external: ['b'] } }, root);
    const inline = config.test.server.deps.inline;
    expect(inline).toContain('a');
    expect(inline).toContain('b');
    expect(inline).not.toContain('c');
    expect(config.optimizeDeps.exclude).not.toContain('a');
    expect(config.optimizeDeps.exclude).not.toContain('b');
  });
});

describe('test conditions', () => {
  async function conditions(test: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const { resolveConfig } = await import('vite');
    const resolved = await resolveConfig(
      {
        mode: 'test',
        configFile: false,
        logLevel: 'silent',
        plugins: [solidPlugin()],
        test,
        ...extra,
      } as any,
      'serve',
    );
    return {
      ssr: resolved.environments.ssr.resolve.conditions,
      node: resolved.ssr.resolve!.conditions!,
    };
  }

  it('keeps browser on the ssr environment but not in the Node conditions for DOM tests', async () => {
    const { ssr, node } = await conditions({ environment: 'happy-dom' });
    expect(ssr).toContain('browser');
    expect(node).not.toContain('browser');
  });

  it('keeps a browser condition the user set on the ssr environment', async () => {
    const { node } = await conditions(
      { environment: 'jsdom' },
      { environments: { ssr: { resolve: { conditions: ['browser', 'node', 'import'] } } } },
    );
    expect(node).toContain('browser');
  });

  it('keeps browser in the Node conditions for the node environment', async () => {
    const { ssr, node } = await conditions({ environment: 'node' });
    expect(ssr).toContain('browser');
    expect(node).toContain('browser');
  });
});
