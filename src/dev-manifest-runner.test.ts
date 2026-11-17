import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createServer,
  createServerModuleRunner,
  type EnvironmentModuleNode,
  type ViteDevServer,
} from 'vite';
import type { ModuleRunner } from 'vite/module-runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDevAssetResolver } from './dev-manifest.js';

declare global {
  var __evals: Record<string, number>;
}

let root: string;
let server: ViteDevServer;
let runner: ModuleRunner;
let resolver: ReturnType<typeof createDevAssetResolver>;

const track = (name: string) =>
  `globalThis.__evals[${JSON.stringify(name)}] = (globalThis.__evals[${JSON.stringify(name)}] ?? 0) + 1;\n`;

async function edit(file: string, code: string) {
  await writeFile(path.join(root, file), code);
  // Vite's watcher path: onFileChange, then the HMR invalidation of the module and its importers.
  const env = server.environments.ssr;
  const changedFile = path.join(root, file);
  env.moduleGraph.onFileChange(changedFile);
  const seen = new Set<EnvironmentModuleNode>();
  for (const mod of env.moduleGraph.getModulesByFile(changedFile)!) {
    env.moduleGraph.invalidateModule(mod, seen, Date.now(), true);
  }
  resolver.invalidate();
}

beforeEach(async () => {
  globalThis.__evals = {};
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-dev-manifest-')));
  await writeFile(path.join(root, 'page.css'), '.page { color: red }\n');
  await writeFile(
    path.join(root, 'ctx.js'),
    track('ctx') + 'export const ctx = { id: Math.random() };\n',
  );
  await writeFile(path.join(root, 'child.js'), track('child') + "export const v = 'v0';\n");
  await writeFile(
    path.join(root, 'page.js'),
    track('page') +
      "import './page.css';\nimport { ctx } from './ctx.js';\nexport { v } from './child.js';\nexport { ctx };\n",
  );
  await writeFile(
    path.join(root, 'layout.js'),
    track('layout') + "export { ctx } from './ctx.js';\n",
  );
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false, watch: null },
    plugins: [
      {
        // A slow transform widens the window in which the walk and the runner request the same module.
        name: 'slow-ctx',
        async transform(_code, id) {
          if (id.endsWith('/ctx.js')) await new Promise((r) => setTimeout(r, 50));
        },
      },
    ],
  });
  resolver = createDevAssetResolver(server);
  // Without HMR the runner relies on fetchModule's `cached` handshake alone, like workerd's.
  runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
});

afterEach(async () => {
  await runner.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe('dev asset resolver style walk (#537)', () => {
  it('inlines the CSS a lazy module imports', async () => {
    const assets = await resolver.resolve('page.js');
    expect(assets?.css.map((css) => typeof css === 'object' && css.id)).toEqual([
      path.join(root, 'page.css'),
    ]);
  });

  it('does not leave the runner on stale code after an edit', async () => {
    expect((await runner.import('/page.js')).v).toBe('v0');
    await edit('child.js', track('child') + "export const v = 'v1';\n");
    await resolver.resolve('page.js');
    expect((await runner.import('/page.js')).v).toBe('v1');
    expect(globalThis.__evals).toEqual({ ctx: 1, child: 2, page: 2 });
  });

  it('evaluates each module once when the walk races the first render', async () => {
    const [, layout, page] = await Promise.all([
      resolver.resolve('page.js'),
      runner.import('/layout.js'),
      runner.import('/page.js'),
    ]);
    expect(page.ctx).toBe(layout.ctx);
    expect((await runner.import('/page.js')).ctx).toBe(layout.ctx);
    expect(globalThis.__evals).toEqual({ ctx: 1, child: 1, page: 1, layout: 1 });
  });

  it('evaluates each module once when the walk races a render after an edit', async () => {
    const before = (await runner.import('/layout.js')).ctx;
    await runner.import('/page.js');
    await edit('child.js', track('child') + "export const v = 'v1';\n");
    const [, page] = await Promise.all([resolver.resolve('page.js'), runner.import('/page.js')]);
    expect(page.v).toBe('v1');
    expect(page.ctx).toBe(before);
    expect((await runner.import('/page.js')).v).toBe('v1');
    expect(globalThis.__evals).toEqual({ ctx: 1, child: 2, page: 2, layout: 1 });
  });
});
