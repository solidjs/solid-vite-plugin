import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

describe('optimizeDeps.include under vite dev', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-optimize-deps-'));
    // Resolve solid-js / @solidjs/web from this repo's install.
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      path.join(root, 'node_modules'),
      'dir',
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function clientInclude(
    solidOptions: Parameters<typeof solidPlugin>[0],
    command: 'serve' | 'build' = 'serve',
  ) {
    const config = await resolveConfig(
      {
        root,
        configFile: false,
        logLevel: 'silent',
        optimizeDeps: { exclude: ['@solidjs/web'] },
        plugins: [solidPlugin(solidOptions)],
      },
      command,
    );
    return config.optimizeDeps.include ?? [];
  }

  // #428: `@solidjs/web/frames` and `@solidjs/web/server-functions/rich-args`
  // import the client runtime by this subpath. With `@solidjs/web` excluded
  // it must still be pre-bundled, or they load a second copy of the
  // server-functions client.
  it('pre-bundles the server-functions client subpath with server components', async () => {
    const include = await clientInclude({ ssr: true, serverFunctions: { components: true } });
    expect(include).toEqual(
      expect.arrayContaining([
        '@solidjs/web/frames',
        '@solidjs/web/server-functions',
        '@solidjs/web/server-functions/client',
      ]),
    );
  });

  it('pre-bundles the server-functions client subpath with plain server functions', async () => {
    const include = await clientInclude({ ssr: true, serverFunctions: true });
    expect(include).toEqual(
      expect.arrayContaining([
        '@solidjs/web/server-functions',
        '@solidjs/web/server-functions/client',
      ]),
    );
    expect(include).not.toContain('@solidjs/web/frames');
  });

  it('leaves the subpath out for a custom client runtime', async () => {
    const include = await clientInclude({
      ssr: true,
      serverFunctions: { runtime: { client: 'my-runtime/client', server: 'my-runtime/server' } },
    });
    expect(include).toContain('my-runtime/client');
    expect(include).not.toContain('@solidjs/web/server-functions/client');
  });

  it('leaves the subpath out for a build', async () => {
    const include = await clientInclude(
      { ssr: true, serverFunctions: { components: true } },
      'build',
    );
    expect(include).not.toContain('@solidjs/web/server-functions/client');
  });
});
