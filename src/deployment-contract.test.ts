// The deployment contract (README, "Deployment contract"), as a stand-in
// provider relies on it: it moves both outputs, builds the server first
// from a `post` buildApp hook, and serves the `ssr` environment's `index`
// entry from a separate Node process, as a host would. The dev half (point
// 6) runs in examples/start-ssr's `external` and `detect` modes.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBuilder, type InlineConfig, type Plugin } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

let root: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-deployment-contract-')));
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'src/App.tsx'),
    [
      "import { getRequestEvent } from '@solidjs/web';",
      'export default function App() {',
      '  const event = getRequestEvent() as { nativeEvent?: { marker?: string } } | undefined;',
      "  return <h1>native event: {event?.nativeEvent?.marker ?? 'none'}</h1>;",
      '}',
    ].join('\n'),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function provider(output: string): Plugin {
  return {
    name: 'stand-in-provider',
    configEnvironment(name) {
      if (name === 'client') return { build: { outDir: `${output}/public` } };
      if (name === 'ssr') return { build: { outDir: `${output}/server` } };
    },
    buildApp: {
      order: 'post',
      async handler(builder) {
        // Server first, as orchestrators that build their workers first do.
        for (const name of ['ssr', 'client']) {
          const environment = builder.environments[name];
          if (environment && !environment.isBuilt) await builder.build(environment);
        }
      },
    },
  };
}

async function buildApp(
  output: string,
  options: Parameters<typeof solidPlugin>[0],
  config: InlineConfig = {},
) {
  const builder = await createBuilder({
    root,
    configFile: false,
    // Own optimizer cache: node_modules is a symlink to the repo's.
    cacheDir: path.join(root, '.vite'),
    logLevel: 'silent',
    plugins: [solidPlugin(options), provider(output)],
    ...config,
  });
  await builder.buildApp();
}

// The client entry a page loads, which must exist in the client output.
function clientEntry(html: string, publicDir: string) {
  const src = html.match(/<script[^>]*type="?module"?[^>]*src="([^"]+)"/)?.[1];
  return { src, exists: !!src && existsSync(path.join(publicDir, src)) };
}

describe('deployment contract', () => {
  it('serves an SSR app through the index entry a provider builds', async () => {
    await buildApp('.ssr-output', { start: true, ssr: true });
    const publicDir = path.join(root, '.ssr-output/public');
    // The server read the manifest from memory: nothing under .vite/ is left to publish.
    expect(existsSync(path.join(publicDir, '.vite'))).toBe(false);
    const serverEntry = path.join(root, '.ssr-output/server/server.js');
    expect(existsSync(serverEntry)).toBe(true);

    const script = `
      const app = await import(${JSON.stringify(pathToFileURL(serverEntry).href)});
      const request = () => new Request('http://localhost/', { headers: { accept: 'text/html' } });
      const page = await app.default.fetch(request());
      const hosted = await app.handleRequest(request(), {
        event: { nativeEvent: { marker: 'from-host' } },
      });
      console.log(JSON.stringify({
        status: page.status,
        type: page.headers.get('content-type'),
        page: await page.text(),
        hosted: await hosted.text(),
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    const served = JSON.parse(result.stdout.trim().split('\n').pop()!);
    expect(served.status).toBe(200);
    expect(served.type).toMatch(/^text\/html/);
    expect(served.page).toMatch(/native event: (<!--[^>]*-->)*none/);
    expect(served.hosted).toMatch(/native event: (<!--[^>]*-->)*from-host/);
    // Built client-first, whatever order the provider asks for.
    expect(clientEntry(served.page, publicDir)).toEqual({ src: expect.any(String), exists: true });
  }, 120_000);

  it('builds a client-mode app to a static site, keeping the service for the host', async () => {
    await buildApp('.client-output', { start: true });
    const publicDir = path.join(root, '.client-output/public');
    const html = readFileSync(path.join(publicDir, 'index.html'), 'utf-8');
    expect(clientEntry(html, publicDir)).toEqual({ src: expect.any(String), exists: true });
    expect(existsSync(path.join(root, '.client-output/server/server.js'))).toBe(true);
    expect(existsSync(path.join(publicDir, '.vite'))).toBe(false);
  }, 120_000);

  it("keeps Vite's manifest in the client output when the app asks for it", async () => {
    await buildApp('.manifest-output', { start: true, ssr: true }, { build: { manifest: true } });
    expect(existsSync(path.join(root, '.manifest-output/public/.vite/manifest.json'))).toBe(true);
  }, 120_000);

  // #525: a config file gives each environment its own instance; Cloudflare rebuilds the client.
  it('links the built assets of a lazy page when each environment has its own plugin instance', async () => {
    await writeFile(
      path.join(root, 'src/LazyApp.tsx'),
      [
        "import { lazy } from 'solid-js';",
        "const Page = lazy(() => import('./Page'));",
        'export default function LazyApp() {',
        '  return <Page />;',
        '}',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'src/Page.tsx'),
      'import \'./page.css\';\nexport default function Page() {\n  return <h1 class="page">page</h1>;\n}\n',
    );
    await writeFile(path.join(root, 'src/page.css'), '.page { color: rgb(1, 2, 3); }\n');
    const rebuildingProvider: Plugin = {
      name: 'rebuilding-provider',
      configEnvironment(name) {
        if (name === 'client') return { build: { outDir: '.rebuild-output/public' } };
        if (name === 'ssr') return { build: { outDir: '.rebuild-output/server' } };
      },
      buildApp: {
        order: 'post',
        async handler(builder) {
          await builder.build(builder.environments.ssr!);
          await builder.build(builder.environments.client!);
        },
      },
    };
    const config: InlineConfig = {
      root,
      configFile: false,
      cacheDir: path.join(root, '.vite'),
      logLevel: 'silent',
    };
    // Fresh instances on every resolve, as reloading a config file gives.
    let instances = 0;
    Object.defineProperty(config, 'plugins', {
      enumerable: true,
      get: () => {
        instances++;
        return [solidPlugin({ ssr: true, start: { app: 'src/LazyApp.tsx' } }), rebuildingProvider];
      },
    });
    const builder = await createBuilder(config);
    await builder.buildApp();
    expect(instances).toBeGreaterThan(1);

    const serverEntry = path.join(root, '.rebuild-output/server/server.js');
    const script = `
      const app = await import(${JSON.stringify(pathToFileURL(serverEntry).href)});
      const page = await app.default.fetch(new Request('http://localhost/', { headers: { accept: 'text/html' } }));
      console.log(JSON.stringify(await page.text()));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    const html: string = JSON.parse(result.stdout.trim().split('\n').pop()!);
    const publicDir = path.join(root, '.rebuild-output/public');
    const stylesheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(
      (m) => m[1],
    );
    const preloads = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(stylesheets.length).toBeGreaterThan(0);
    expect(preloads.length).toBeGreaterThan(0);
    // Every URL points at a file the final client build wrote, not a source path.
    for (const url of [...stylesheets, ...preloads]) {
      expect(url).toMatch(/^\/assets\//);
      expect(existsSync(path.join(publicDir, url))).toBe(true);
    }
    expect(readFileSync(path.join(publicDir, stylesheets[0]), 'utf-8')).toContain('.page');
    expect(clientEntry(html, publicDir)).toEqual({ src: expect.any(String), exists: true });
    // The rebuild wrote the same files instead of a second copy of the app.
    const entries = readdirSync(path.join(publicDir, 'assets')).filter((file) =>
      file.startsWith('virtual_solid-ssr-entry-client-'),
    );
    expect(entries).toHaveLength(1);
  }, 120_000);
});
