import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

describe('optimizeDeps.exclude for solid-condition packages (#560)', () => {
  let root: string;
  const pkgName = 'solid-js-entry-lib';

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-ssr-exclude-'));
    // Package whose `solid` entry is a `.js` barrel — the shape the SSR
    // optimizer would otherwise take when discovery is on (#560).
    const pkgDir = path.join(root, 'node_modules', pkgName);
    await mkdir(path.join(pkgDir, 'dist', 'source'), { recursive: true });
    await writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: pkgName,
        type: 'module',
        exports: {
          '.': {
            solid: './dist/source/index.js',
            import: './dist/index.js',
          },
        },
      }),
    );
    await writeFile(path.join(pkgDir, 'dist', 'source', 'index.js'), 'export {};\n');
    await writeFile(path.join(pkgDir, 'dist', 'index.js'), 'export {};\n');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'ssr-exclude-app',
        type: 'module',
        dependencies: { [pkgName]: '0.0.0' },
      }),
    );
    // Copy (not symlink) the packages the plugin resolves from the project
    // root — Windows often denies creating symlinks without elevation.
    const shared = fileURLToPath(new URL('../node_modules', import.meta.url));
    for (const name of ['solid-js', 'vite', 'vitefu']) {
      await cp(path.join(shared, name), path.join(root, 'node_modules', name), {
        recursive: true,
        dereference: true,
      });
    }
    await cp(path.join(shared, '@solidjs'), path.join(root, 'node_modules', '@solidjs'), {
      recursive: true,
      dereference: true,
    });
  }, 120_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('excludes the package from both client and SSR optimizeDeps', async () => {
    const config = await resolveConfig(
      {
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [solidPlugin({ ssr: true })],
        // Hosts like @cloudflare/vite-plugin turn SSR discovery back on.
        environments: {
          ssr: { optimizeDeps: { noDiscovery: false } },
        },
      },
      'serve',
    );

    expect(config.optimizeDeps.exclude ?? []).toContain(pkgName);
    expect(config.environments.ssr.optimizeDeps.exclude ?? []).toContain(pkgName);
  });
});
