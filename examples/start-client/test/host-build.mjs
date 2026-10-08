// Production proof for relocated environments. An optional Nitro module runs
// the same assertions against nitro/vite without adding a fixture dependency:
// NITRO_VITE_MODULE=/absolute/path/to/nitro/dist/vite.mjs node test/host-build.mjs
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  cpSync,
  symlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { createBuilder, preview } from 'vite';
import solid from '@solidjs/vite-plugin';

const fixture = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2];
if (!mode) {
  const modes = process.env.NITRO_VITE_MODULE
    ? ['functions', 'static', 'ssr']
    : ['functions', 'static', 'config-host', 'ssr', 'configured-functions', 'configured-ssr'];
  for (const test of modes) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), test], {
      stdio: 'inherit',
      env: process.env,
    });
    assert.equal(result.status, 0, `${test} production proof failed`);
  }
  if (!process.env.NITRO_VITE_MODULE) {
    for (const failure of ['setup', 'build', 'assertion']) {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'static'], {
        encoding: 'utf8',
        env: { ...process.env, HOST_TEST_FAILURE: failure },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, new RegExp('Injected ' + failure + ' failure'));
      const sandbox = /PASS owned fixture cleaned: (.+)/.exec(result.stdout)?.[1];
      assert.ok(sandbox, failure + ' cleanup completed');
      assert.equal(existsSync(sandbox), false, failure + ' artifacts cleaned');
      if (failure === 'assertion') assert.match(result.stdout, /PASS preview closed/);
      console.log('PASS failure cleanup: ' + failure);
    }
    await import('./cleanup-target.mjs');
  }
} else {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'solid-host-build-')));
  let server;
  let primaryError;
  try {
    cpSync(path.join(fixture, 'src'), path.join(root, 'src'), { recursive: true });
    cpSync(path.join(fixture, 'package.json'), path.join(root, 'package.json'));
    symlinkSync(path.join(fixture, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    if (process.env.HOST_TEST_FAILURE === 'setup') throw new Error('Injected setup failure');
    const configured = mode.startsWith('configured-');
    const serverFunctions = mode === 'functions' || configured;
    const ssr = mode === 'ssr' || mode === 'configured-ssr';
    let applicationModuleChecked = false;
    const output = path.join(root, 'dist', 'host');
    const clientDir = path.join(output, 'public');
    // Configured modes relocate through a later configEnvironment, which is
    // what actually overrides the plugin's dist/client and dist/server
    // defaults. A hardcoded prerender or preview path fails these modes.
    const serverDir = path.join(output, configured ? 'user-server' : 'service');
    let consumed = false;
    const buildService = async (builder) => {
      for (const environment of Object.values(builder.environments)) {
        if (!environment.isBuilt) await builder.build(environment);
      }
      if (process.env.HOST_TEST_FAILURE === 'build') throw new Error('Injected build failure');
      assert.ok(existsSync(path.join(serverDir, 'server.js')), 'host service retained');
      consumed = true;
    };
    const miniatureHost = {
      name: 'fixture:host',
      config() {
        return {
          ...(mode === 'config-host' ? { builder: { buildApp: buildService } } : {}),
        };
      },
      configEnvironment(name, config) {
        if (name === 'client') config.build.outDir = clientDir;
        if (name === 'ssr') config.build.outDir = serverDir;
      },
      buildApp:
        mode === 'config-host'
          ? undefined
          : {
              order: 'post',
              async handler(builder) {
                await buildService(builder);
                if (!ssr) {
                  assert.ok(existsSync(path.join(clientDir, 'index.html')), 'shell ready for host');
                }
              },
            },
    };
    // No buildApp here: relocation has to win as a configEnvironment override
    // of the plugin defaults, including for preview's resolved directories.
    const relocate = {
      name: 'fixture:relocate',
      configEnvironment(name, config) {
        if (name === 'client') config.build.outDir = clientDir;
        if (name === 'ssr') config.build.outDir = serverDir;
      },
    };
    const makeHost = async () => {
      if (!process.env.NITRO_VITE_MODULE) return miniatureHost;
      const { nitro } = await import(pathToFileURL(process.env.NITRO_VITE_MODULE).href);
      return nitro({
        preset: 'node-server',
        output: { dir: output, publicDir: clientDir, serverDir: path.join(output, 'server') },
        buildDir: path.join(output, 'nitro'),
      });
    };
    // Nitro treats port 0 as its default port. Reserve an available port before
    // starting preview so the proof never shares a user's running service.
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const config = async () => ({
      root,
      cacheDir: path.join(root, '.vite-cache'),
      configFile: false,
      plugins: [
        solid({ start: true, ssr, serverFunctions }),
        ...(configured ? [relocate] : [await makeHost()]),
        {
          name: 'fixture:application-pipeline',
          enforce: 'post',
          transform(code, id) {
            if (
              ssr &&
              this.environment.name === 'ssr' &&
              id.split('?')[0] === path.join(root, 'src/LazySection.tsx')
            ) {
              assert.match(code, /\$\$moduleUrl\s*=/, 'application SSR module metadata');
              applicationModuleChecked = true;
            }
          },
        },
      ],
      preview: { host: '127.0.0.1', port, strictPort: true },
    });
    const builder = await createBuilder(await config());
    await builder.buildApp();
    if (ssr) {
      assert.ok(applicationModuleChecked, 'application SSR transform exercised');
      console.log('PASS application SSR module metadata');
    }
    const builtClientDir = clientDir;
    const builtServerDir = path.resolve(root, builder.environments.ssr.config.build.outDir);
    if (!process.env.NITRO_VITE_MODULE) {
      assert.equal(builtServerDir, path.resolve(serverDir), 'SSR output follows configEnvironment');
      assert.equal(
        path.resolve(root, builder.environments.client.config.build.outDir),
        path.resolve(clientDir),
        'client output follows configEnvironment',
      );
      assert.ok(
        existsSync(path.join(serverDir, 'server.js')),
        'server.js emitted to relocated dir',
      );
      assert.ok(
        !existsSync(path.join(root, 'dist/server/server.js')),
        'hardcoded dist/server was not the emit directory',
      );
    }
    if (!configured && !process.env.NITRO_VITE_MODULE) {
      assert.ok(consumed, 'host orchestrator ran');
      assert.ok(existsSync(path.join(serverDir, 'server.js')), 'host service survives prerender');
    }
    if (!ssr) {
      const shell = readFileSync(path.join(builtClientDir, 'index.html'), 'utf8');
      assert.ok(shell.startsWith('<!DOCTYPE html><html'), 'complete generated shell');
      assert.ok(!shell.includes('CLIENT-RENDERED-APP'), 'app remains client-rendered');
      assert.ok(!shell.includes('_$HY'), 'no hydration script in client shell');
      for (const [, url] of shell.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
        assert.ok(existsSync(path.join(builtClientDir, url)), `shell asset exists: ${url}`);
      }
      assert.match(shell, /<script[^>]+src="\/assets\//, 'hashed client entry');
      assert.match(shell, /<link[^>]+href="\/assets\//, 'entry CSS in shell');
      assert.ok(
        !existsSync(path.join(root, 'dist/client/index.html')),
        'shell was not written to hardcoded dist/client',
      );
    }
    server = await preview(await config());
    if (process.env.HOST_TEST_FAILURE === 'assertion') assert.fail('Injected assertion failure');
    if (!process.env.NITRO_VITE_MODULE) {
      assert.equal(
        path.resolve(root, server.config.environments.ssr.build.outDir),
        path.resolve(serverDir),
        'preview SSR directory follows configEnvironment',
      );
      assert.equal(
        path.resolve(root, server.config.environments.client.build.outDir),
        path.resolve(clientDir),
        'preview client directory follows configEnvironment',
      );
    }
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const response = await fetch(origin + '/', { headers: { accept: 'text/html' } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>Start Client<\/title>/);
    assert.equal(html.includes('CLIENT-RENDERED-APP'), ssr);
    for (const [, url] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      assert.equal((await fetch(origin + url)).status, 200, `HTTP asset: ${url}`);
    }
    if (serverFunctions) {
      const assets = readdirSync(path.join(builtClientDir, 'assets'))
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFileSync(path.join(builtClientDir, 'assets', file), 'utf8'))
        .join('\n');
      const id = /ping-[a-zA-Z0-9_-]+/.exec(assets)?.[0];
      assert.ok(id, 'compiled server function id');
      const endpoint = await fetch(
        `${origin}/_server/${id}?args=${encodeURIComponent('["host"]')}`,
        {
          method: 'POST',
          headers: { 'Sec-Fetch-Site': 'same-origin' },
        },
      );
      assert.equal(endpoint.status, 200);
      assert.equal(await endpoint.text(), 'pong:host');
    }
    console.log(
      `PASS ${process.env.NITRO_VITE_MODULE ? 'nitro' : 'miniature host'} ${mode}: production shell, assets and HTTP dispatch`,
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try {
      if (server) {
        await new Promise((resolve, reject) =>
          server.httpServer.close((error) => (error ? reject(error) : resolve())),
        );
        assert.equal(server.httpServer.listening, false);
        console.log('PASS preview closed');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false, 'owned fixture cleaned');
      console.log('PASS owned fixture cleaned: ' + root);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        [...(primaryError ? [primaryError] : []), ...cleanupErrors],
        'Failed to clean host build fixture',
      );
    }
  }
}
