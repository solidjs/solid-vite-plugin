import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformAsync, transformDirectives } from '@solidjs/compiler';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solidPlugin, { type Frontend, type FrontendContext } from './index.js';

let root: string;

function directivesTakeAnyExtension() {
  try {
    transformDirectives('export async function f() { "use server"; }', {
      filename: '/p/a.fe',
      root: '/p',
      mode: 'server',
    });
    return true;
  } catch {
    return false;
  }
}
let server: ViteDevServer;
const calls: FrontendContext[] = [];

// A front end whose language is JSX under another extension: it lowers
// through Solid's compiler with the options the plugin hands it, and returns
// a stylesheet — what a real one (ReactiveScript's `.rx`) returns.
const fe: Frontend = {
  async compile(source, context) {
    calls.push(context);
    context.addWatchFile(path.join(root, 'src/shared.d.fe'));
    const result = await transformAsync(source, {
      ...context.solid,
      filename: context.id + '.jsx',
      sourceMap: true,
    });
    // the map names the module, as a front end's own map would
    const map = { ...JSON.parse(result.map!), sources: [context.id] };
    return { code: result.code, map, css: '.fe { color: red; }' };
  },
};

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-frontends-')));
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'src/App.fe'),
    'export default function App() { return <p class="fe">hi</p>; }\n',
  );
  await writeFile(path.join(root, 'src/shared.d.fe'), '// declarations the front end reads\n');
  await writeFile(
    path.join(root, 'src/actions.fe'),
    'export async function save(x) { "use server"; return x; }\nexport const View = () => <button onClick={() => save(1)}>save</button>;\n',
  );
  server = await createServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    environments: { client: {}, ssr: { consumer: 'server' } },
    plugins: [solidPlugin({ ssr: true, serverFunctions: true, frontends: { '.fe': fe } })],
  });
});

afterAll(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

describe('frontends', () => {
  it('compiles a module of its extension with the client options', async () => {
    const result = await server.environments.client.transformRequest('/src/App.fe');
    expect(result?.code).toContain('_$template(');
    const context = calls.find((c) => c.id.endsWith('App.fe') && !c.ssr);
    expect(context?.solid.generate).toBe('dom');
    expect(context?.solid.hydratable).toBe(true);
  });

  it('compiles it for the server in a server environment', async () => {
    const result = await server.environments.ssr.transformRequest('/src/App.fe');
    expect(result?.code).toContain('ssrHydrationKey');
    expect(calls.find((c) => c.id.endsWith('App.fe') && c.ssr)?.solid.generate).toBe('ssr');
  });

  it('serves its stylesheet as a CSS module the module imports', async () => {
    const result = await server.environments.client.transformRequest('/src/App.fe');
    const css = result?.code.match(/import "([^"]*solid-tsrx-css[^"]*)"/)?.[1];
    expect(css).toBeTruthy();
    const loaded = await server.environments.client.transformRequest(css!);
    expect(loaded?.code).toContain('.fe { color: red; }');
  });

  it('keeps a source map back to the module', async () => {
    const result = await server.environments.client.transformRequest('/src/App.fe');
    const map = result?.map as { sources?: string[] } | null;
    expect(map?.sources?.some((s) => s.endsWith('App.fe'))).toBe(true);
  });

  // Needs @solidjs/compiler's secondary passes to take another front end's
  // filename (solidjs/solid, secondary passes parse unknown extensions as TSX).
  it.skipIf(!directivesTakeAnyExtension())(
    'extracts server functions from its output',
    async () => {
      const client = await server.environments.client.transformRequest('/src/actions.fe');
      expect(client?.code).toContain('createServerReference');
      expect(client?.code).not.toContain('return x');
    },
  );

  it('hands over the queried module id beside the file path', async () => {
    const result = await server.environments.client.transformRequest('/src/App.fe?dep');
    expect(result?.code).toContain('_$template(');
    const context = calls.find((c) => c.moduleId.endsWith('App.fe?dep'));
    expect(context?.id).toBe(path.join(root, 'src/App.fe'));
  });

  it('watches the files the front end read', async () => {
    await server.environments.client.transformRequest('/src/App.fe');
    const node = await server.environments.client.moduleGraph.getModuleByUrl('/src/App.fe');
    expect([...(node?.importedModules ?? [])].some((m) => m.file?.endsWith('shared.d.fe'))).toBe(
      true,
    );
  });

  it("refuses an extension Solid's compiler already owns", () => {
    expect(() => solidPlugin({ frontends: { '.tsx': fe } })).toThrow(/frontends/);
  });
});

// `.rx` is built in: its front end is `@reactivescript/compiler/vite`, resolved from the
// project the first time an `.rx` module is compiled.
describe('built-in .rx', () => {
  let rxRoot: string;
  let rxServer: ViteDevServer;
  const start = (dir: string) =>
    createServer({
      root: dir,
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [solidPlugin()],
    });

  beforeAll(async () => {
    rxRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-rx-')));
    const pkg = path.join(rxRoot, 'node_modules/@reactivescript/compiler');
    await mkdir(pkg, { recursive: true });
    await writeFile(
      path.join(pkg, 'package.json'),
      JSON.stringify({
        name: '@reactivescript/compiler',
        type: 'module',
        exports: { './vite': './vite.js' },
      }),
    );
    await writeFile(
      path.join(pkg, 'vite.js'),
      'export default () => ({ compile: (source, { id, moduleId }) => ({ code: `export default ${JSON.stringify(moduleId)};` }) });\n',
    );
    await mkdir(path.join(rxRoot, 'src'));
    await writeFile(path.join(rxRoot, 'src/main.rx'), 'export default component App() {}\n');
    rxServer = await start(rxRoot);
  });

  afterAll(async () => {
    await rxServer?.close();
    await rm(rxRoot, { recursive: true, force: true });
  });

  it('compiles .rx with the @reactivescript/compiler package the project installed', async () => {
    const result = await rxServer.environments.client.transformRequest('/src/main.rx');
    expect(result?.code).toContain('main.rx');
  });

  it('asks for the package when the project has none', async () => {
    const bare = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-rx-bare-')));
    await mkdir(path.join(bare, 'src'));
    await writeFile(path.join(bare, 'src/main.rx'), 'export default component App() {}\n');
    const server = await start(bare);
    try {
      await expect(server.environments.client.transformRequest('/src/main.rx')).rejects.toThrow(
        /needs the `@reactivescript\/compiler` package/,
      );
    } finally {
      await server.close();
      await rm(bare, { recursive: true, force: true });
    }
  });
});
