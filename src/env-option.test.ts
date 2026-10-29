import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, createServer, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

const names = (options: Parameters<typeof solidPlugin>[0]) =>
  solidPlugin(options).map((plugin) => plugin.name);

describe('env option gating', () => {
  it('is probed under start mode and opt-in without it', () => {
    expect(names({ start: true })).toContain('solid:env');
    expect(names({})).not.toContain('solid:env');
    expect(names({ ssr: true })).not.toContain('solid:env');
    expect(names({ env: true })).toContain('solid:env');
    expect(names({ ssr: true, env: './env.ts' })).toContain('solid:env');
  });

  it('is removed entirely by env: false', () => {
    expect(names({ start: true, env: false })).not.toContain('solid:env');
  });

  it('start.env names the top-level replacement', () => {
    expect(() => solidPlugin({ start: { env: true } as never })).toThrow(
      '`start.env` has moved to the top-level `env` option',
    );
  });
});

// A manual `ssr: true` setup without start mode: the integrator path that
// `env: true` now supports.
describe('env without start', () => {
  const SECRET = 'fixture-session-secret-0123456789';
  let root: string;
  const touched = ['SESSION_SECRET', 'VITE_APP_NAME'];

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'solid-env-'));
    // A hand-rolled Standard Schema validator keeps the fixture free of
    // schema-library dependencies.
    await writeFile(
      path.join(root, 'env.ts'),
      `const required = { '~standard': { version: 1, vendor: 'fixture', validate: (value) =>
  typeof value === 'string' && value.length > 0 ? { value } : { issues: [{ message: 'required' }] } } };
export default { server: { SESSION_SECRET: required }, client: { VITE_APP_NAME: required } };
`,
    );
    await writeFile(
      path.join(root, '.env'),
      `SESSION_SECRET=${SECRET}\nVITE_APP_NAME=FixtureApp\n`,
    );
    await writeFile(
      path.join(root, 'server.ts'),
      `import { env } from 'virtual:solid-env/server';\nexport const secretLength = env.SESSION_SECRET.length;\n`,
    );
    await writeFile(
      path.join(root, 'client.ts'),
      `import { env } from 'virtual:solid-env/client';\nexport const appName = env.VITE_APP_NAME;\n`,
    );
    await writeFile(
      path.join(root, 'old-id.ts'),
      `import { env } from 'virtual:env/server';\nexport const secretLength = env.SESSION_SECRET.length;\n`,
    );
    await writeFile(
      path.join(root, 'leak.ts'),
      `import { env } from 'virtual:solid-env/server';\nexport const leaked = env.SESSION_SECRET;\n`,
    );
  });

  afterAll(async () => {
    // The plugin folds .env into process.env; keep it from leaking into
    // other test files.
    for (const key of touched) delete process.env[key];
    await rm(root, { recursive: true, force: true });
  });

  const config = (options: Parameters<typeof solidPlugin>[0]) => ({
    root,
    configFile: false as const,
    logLevel: 'silent' as const,
    plugins: [solidPlugin(options)],
  });

  it('serves validated values to the server graph in dev', async () => {
    const server = await createServer({
      ...config({ ssr: true, env: true }),
      appType: 'custom',
      server: { middlewareMode: true, ws: false },
    });
    try {
      const mod = await server.ssrLoadModule('/server.ts');
      expect(mod.secretLength).toBe(SECRET.length);
      await expect(server.environments.client.transformRequest('/leak.ts')).rejects.toThrow(
        'virtual:solid-env/server is server-only',
      );
    } finally {
      await server.close();
    }
  });

  it('names the new id when code imports a pre-rename one', async () => {
    const server = await createServer({
      ...config({ ssr: true, env: true }),
      appType: 'custom',
      server: { middlewareMode: true, ws: false },
    });
    try {
      await expect(server.ssrLoadModule('/old-id.ts')).rejects.toThrow(
        '`virtual:env/server` has been renamed to `virtual:solid-env/server`.',
      );
    } finally {
      await server.close();
    }
  });

  it('bakes client values and keeps server values out of the builds', async () => {
    const code = (output: unknown) =>
      (Array.isArray(output) ? output : [output])
        .flatMap((result) => (result as Rolldown.RolldownOutput).output)
        .map((chunk) => ('code' in chunk ? chunk.code : ''))
        .join('\n');

    const client = code(
      await build({
        ...config({ ssr: true, env: true }),
        build: { write: false, rollupOptions: { input: path.join(root, 'client.ts') } },
      }),
    );
    expect(client).toContain('FixtureApp');
    expect(client).not.toContain(SECRET);

    const server = code(
      await build({
        ...config({ ssr: true, env: true }),
        build: { write: false, ssr: path.join(root, 'server.ts') },
      }),
    );
    expect(server).not.toContain(SECRET);
    expect(server).toContain('process.env');
  });
});
