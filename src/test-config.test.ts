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
