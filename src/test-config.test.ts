import { describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

async function resolveTestConfig(userTest: Record<string, unknown>) {
  const plugin = solidPlugin();
  const config = plugin.config as (...args: any[]) => Promise<any>;
  const result = await config.call(
    {},
    { root: process.cwd(), mode: 'test', test: userTest },
    { command: 'serve', mode: 'test' },
  );
  return result.test;
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
