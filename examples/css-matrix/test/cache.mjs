import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import solid from '@solidjs/vite-plugin';
import {
  createServer,
  createServerHotChannel,
  createServerModuleRunner,
  DevEnvironment,
} from 'vite';

const EVENT = 'solid:dev-manifest-invalidate';
const KEY = 'page.ts';

async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Manifest invalidation did not arrive')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(context, plugins = []) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-bridge-cache-')));
  await writeFile(path.join(root, KEY), "import './page.css'");
  const css = path.join(root, 'page.css');
  await writeFile(css, '.probe { width: 18px; }');
  let fetchAssets = fetch;
  let runner;
  let server;
  context.after(async () => {
    await runner?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0 },
    environments: {
      ssr: {
        dev: {
          createEnvironment(name, config) {
            const transport = createServerHotChannel();
            const send = transport.send.bind(transport);
            transport.send = (payload) => {
              // Nitro consumes full-reload itself; the manifest can retain its evaluation.
              if (payload.type !== 'full-reload') send(payload);
            };
            return new DevEnvironment(name, config, { hot: true, transport });
          },
        },
      },
    },
    plugins: [
      solid({ ssr: true }),
      {
        name: 'bridge-cache:probe',
        resolveId(id) {
          if (id === 'virtual:bridge-cache-probe') return '\0' + id;
        },
        load(id) {
          if (id !== '\0virtual:bridge-cache-probe') return;
          return `let complete;
            import.meta.hot.on(${JSON.stringify(EVENT)}, () => {
              complete?.();
              complete = undefined;
            });
            export const next = () => new Promise(resolve => { complete = resolve; });`;
        },
      },
      ...plugins,
    ],
  });
  await server.listen();
  runner = createServerModuleRunner(server.environments.ssr, {
    sourcemapInterceptor: false,
    hmr: { logger: false },
    evaluator: {
      async runInlinedModule(moduleContext, code) {
        await runInNewContext(`(async () => { ${code}\n })()`, {
          ...moduleContext,
          fetch: (...args) => fetchAssets(...args),
          URL,
          console,
        });
      },
      runExternalModule: (file) => import(file),
    },
  });
  const manifest = (await runner.import('virtual:solid-manifest')).default;
  const probe = await runner.import('virtual:bridge-cache-probe');
  return {
    manifest,
    css,
    nextInvalidation: () => within(probe.next()),
    async invalidate() {
      const received = within(probe.next());
      server.environments.ssr.hot.send({ type: 'custom', event: EVENT });
      await received;
    },
    setFetch: (value) => {
      fetchAssets = value;
    },
    async reimport() {
      const module = server.environments.ssr.moduleGraph.getModuleById('\0virtual:solid-manifest');
      server.environments.ssr.moduleGraph.invalidateModule(module);
      return (await runner.import('virtual:solid-manifest')).default;
    },
  };
}

function response(value) {
  return Response.json({ js: ['/' + KEY], css: [{ content: value }] });
}

test(
  'CSS edits invalidate the same isolated manifest instance',
  { timeout: 15000 },
  async (context) => {
    const { manifest, css, nextInvalidation } = await fixture(context);
    const pending = manifest.resolve(KEY);
    assert.equal(manifest.resolve(KEY), pending);
    const before = await pending;
    assert.match(JSON.stringify(before.css), /18px/);
    assert.equal(manifest.resolve(KEY), before);

    const invalidated = nextInvalidation();
    await writeFile(css, '.probe { width: 36px; }');
    await invalidated;
    const after = await manifest.resolve(KEY);
    assert.match(JSON.stringify(after.css), /36px/);
    assert.doesNotMatch(JSON.stringify(after.css), /18px/);
    assert.equal(manifest.resolve(KEY), after);
    assert.equal(manifest.resolveSync(KEY), after);
  },
);

test(
  'an asynchronous watchChange cannot leave stale CSS cached',
  { timeout: 15000 },
  async (context) => {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const processed = Promise.withResolvers();
    context.after(() => release.resolve());
    const { manifest, css, nextInvalidation } = await fixture(context, [
      {
        name: 'bridge-cache:slow-watch-change',
        async watchChange(file) {
          if (!file.endsWith('/page.css')) return;
          started.resolve();
          await release.promise;
        },
        hotUpdate({ file }) {
          if (file.endsWith('/page.css') && this.environment.name === 'ssr') processed.resolve();
        },
      },
    ]);
    await manifest.resolve(KEY);
    const invalidated = nextInvalidation();
    await writeFile(css, '.probe { width: 36px; }');
    await within(started.promise);
    const during = await manifest.resolve(KEY);
    assert.match(JSON.stringify(during.css), /18px/);
    release.resolve();
    await within(processed.promise);
    await invalidated;
    const after = await manifest.resolve(KEY);
    assert.match(JSON.stringify(after.css), /36px/);
    assert.doesNotMatch(JSON.stringify(after.css), /18px/);
    assert.equal(manifest.resolve(KEY), after);
  },
);

for (const order of ['old-first', 'new-first', 'old-rejects']) {
  test(`in-flight invalidation: ${order}`, { timeout: 15000 }, async (context) => {
    const fixtureState = await fixture(context);
    const { manifest } = fixtureState;
    const oldFetch = Promise.withResolvers();
    const newFetch = Promise.withResolvers();
    let calls = 0;
    fixtureState.setFetch(() => (++calls === 1 ? oldFetch.promise : newFetch.promise));
    const old = manifest.resolve(KEY);
    const oldResult = old.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    assert.equal(manifest.resolve(KEY), old);

    await fixtureState.invalidate();
    const current = manifest.resolve(KEY);
    assert.notEqual(current, old);
    assert.equal(calls, 2);

    if (order === 'new-first') {
      newFetch.resolve(response('36px'));
      const fresh = await current;
      oldFetch.resolve(response('18px'));
      await oldResult;
      assert.equal(manifest.resolve(KEY), fresh);
    } else {
      oldFetch.resolve(order === 'old-rejects' ? new Response('invalid JSON') : response('18px'));
      const previous = await oldResult;
      assert.equal(Boolean(previous.error), order === 'old-rejects');
      assert.equal(manifest.resolve(KEY), current);
      assert.equal(manifest.resolveSync(KEY).css.length, 0);
      newFetch.resolve(response('36px'));
      await current;
    }
    assert.equal(calls, 2);
    assert.match(JSON.stringify(manifest.resolve(KEY).css), /36px/);
    assert.doesNotMatch(JSON.stringify(manifest.resolve(KEY).css), /18px/);
  });
}

test(
  'a bridge failure remains retryable after invalidation',
  { timeout: 15000 },
  async (context) => {
    const state = await fixture(context);
    state.setFetch(() => Promise.resolve(Response.json(null)));
    assert.equal(await state.manifest.resolve(KEY), null);
    state.setFetch(() => Promise.resolve(response('18px')));
    const before = await state.manifest.resolve(KEY);
    assert.equal(state.manifest.resolve(KEY), before);
    await state.invalidate();
    state.setFetch(() => Promise.resolve(response('36px')));
    const after = await state.manifest.resolve(KEY);
    assert.match(JSON.stringify(after.css), /36px/);
    assert.equal(state.manifest.resolve(KEY), after);
  },
);

test(
  're-evaluation leaves only the current manifest subscribed',
  { timeout: 15000 },
  async (context) => {
    const state = await fixture(context);
    const before = await state.manifest.resolve(KEY);
    const next = await state.reimport();
    assert.notEqual(next, state.manifest);
    await next.resolve(KEY);
    await state.invalidate();
    assert.equal(state.manifest.resolve(KEY), before);
    assert.equal(next.resolveSync(KEY).css.length, 0);
    const after = await next.resolve(KEY);
    assert.equal(next.resolve(KEY), after);
  },
);
