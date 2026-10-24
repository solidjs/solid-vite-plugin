import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeResponse } from '@solidjs/web/server-functions/client';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverFunctions } from './index.js';

const HANDLER_ID = 'virtual:solid-server-function-handler';

const MONEY_SOURCE = `export class Money {
  constructor(cents) {
    this.cents = cents;
  }
}
`;

const PLUGIN_SOURCE = `import { createPlugin } from '@solidjs/web/serialization';
import { Money } from './money.js';

export const MoneyPlugin = createPlugin({
  tag: 'test/Money',
  test: (value) => value instanceof Money,
  parse: {
    sync: (value, ctx) => ({ cents: ctx.parse(value.cents) }),
    async: async (value, ctx) => ({ cents: await ctx.parse(value.cents) }),
    stream: (value, ctx) => ({ cents: ctx.parse(value.cents) }),
  },
  serialize: () => {
    throw new Error('unused by the JSON codec');
  },
  deserialize: (node, ctx) => new Money(ctx.deserialize(node.cents)),
});
`;

const API_SOURCE = `"use server";
import { Money } from './money.js';

export async function price() {
  return new Money(500);
}
`;

// Each case is a project whose `serialization` module default-exports the
// codec in one of the accepted shapes (or no option at all).
const cases = {
  object: `export { MoneyPlugin } from './money-plugin.js';
import { MoneyPlugin } from './money-plugin.js';
export default { plugins: [MoneyPlugin] };
`,
  array: `import { MoneyPlugin } from './money-plugin.js';
export default [MoneyPlugin];
`,
  none: null,
} as const;

async function createProject(serialization: string | null) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-codec-')));
  await symlink(
    fileURLToPath(new URL('../../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/money.js'), MONEY_SOURCE);
  await writeFile(path.join(root, 'src/money-plugin.js'), PLUGIN_SOURCE);
  await writeFile(path.join(root, 'src/api.js'), API_SOURCE);
  if (serialization) await writeFile(path.join(root, 'src/serialization.js'), serialization);
  const server = await createServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [serverFunctions(serialization ? { serialization: './src/serialization.js' } : {})],
  });
  return { root, server };
}

// Calls `price` over the generated handler, the way the dev middleware and
// the production handler dispatch, and returns the raw response.
async function callPrice(server: ViteDevServer) {
  const client = await server.environments.client.transformRequest('/src/api.js');
  const id = /createServerReference\w*\("(price-[^"]*)"/.exec(client?.code ?? '')?.[1];
  expect(id).toBeTruthy();
  const runner = server.environments.ssr.runner;
  await runner.import('/src/api.js');
  const handler = await runner.import(HANDLER_ID);
  const request = new Request(
    `http://localhost/_server/${encodeURIComponent(id!)}?args=${encodeURIComponent('[]')}`,
    // Same-origin, so the runtime's CSRF gate lets the call through.
    { method: 'POST', headers: { origin: 'http://localhost' } },
  );
  return {
    client: client!.code,
    response: (await handler.handleServerFunctionRequest(request)) as Response,
  };
}

describe('serverFunctions.serialization', () => {
  const projects: Record<string, { root: string; server: ViteDevServer }> = {};

  beforeAll(async () => {
    for (const [name, source] of Object.entries(cases)) {
      projects[name] = await createProject(source);
    }
  });

  afterAll(async () => {
    for (const { root, server } of Object.values(projects)) {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['object', 'array'])('configures the codec on both sides (%s export)', async (name) => {
    const { server } = projects[name]!;

    // Vite rewrites the absolute import to the module's dev URL.
    const { client, response } = await callPrice(server);
    expect(client).toContain('import $$serialization from "/src/serialization.js";');
    expect(client).toMatch(/configureServerFunctionsClient as \$\$configureServerFunctions/);
    expect(client).toContain('codec: Array.isArray($$serialization)');

    const ssr = await server.environments.ssr.transformRequest('/src/api.js');
    expect(ssr?.code).toContain('"/src/serialization.js"');
    expect(ssr?.code).toContain('configureServerFunctionsServer');

    // The server encoded the result through the plugin: its tag is on the
    // wire, and a client using the same plugin decodes a real Money.
    expect(response.status).toBe(200);
    const body = await response.clone().text();
    expect(body).toContain('test/Money');
    const { MoneyPlugin } = await server.environments.ssr.runner.import('/src/money-plugin.js');
    const value = await decodeResponse<{ cents: number }>(response, { plugins: [MoneyPlugin] });
    expect(value.constructor.name).toBe('Money');
    expect(value.cents).toBe(500);
  });

  it('leaves compiled output and the codec alone without the option', async () => {
    const { server } = projects.none!;
    const { client, response } = await callPrice(server);
    expect(client).not.toContain('$$serialization');
    expect(client).not.toContain('$$configureServerFunctions');
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('test/Money');
  });

  it('rejects a module path that does not exist', async () => {
    await expect(
      createServer({
        configFile: false,
        logLevel: 'silent',
        server: { middlewareMode: true, hmr: false, watch: null },
        plugins: [serverFunctions({ serialization: './src/missing.ts' })],
      }),
    ).rejects.toThrow('serverFunctions.serialization does not exist: ./src/missing.ts');
  });
});
