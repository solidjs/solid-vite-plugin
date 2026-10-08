import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createBuilder } from 'vite';
import solid from '@solidjs/vite-plugin';

const preservedWarning = (target) =>
  '[@solidjs/vite-plugin] Preserving SSR output at ' +
  target +
  ': automatic cleanup requires a directory inside the project root that does not contain client output.';

async function run(failure) {
  const sandbox = realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'solid-cleanup-target-')));
  const originalRemove = fs.rmSync;
  let primaryError;
  try {
    const root = path.join(sandbox, 'project');
    const clientDir = path.join(root, 'dist/client');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(
      path.join(root, 'src/App.tsx'),
      'export default function App() { return null; }',
    );
    const sentinel = path.join(clientDir, 'asset.js');
    fs.writeFileSync(sentinel, 'client asset');

    if (failure === 'setup') throw new Error('Injected setup failure');

    // Exercise the real prerender hook with completed environment builds. Its
    // removal is observed without executing it, even for project-root targets.
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [solid({ start: true })],
    });
    const serving = builder.config.plugins.find((plugin) => plugin.name === 'solid:ssr/setup');
    const prerender = builder.config.plugins.find(
      (plugin) => plugin.name === 'solid:start/prerender',
    );
    assert.ok(serving && prerender);
    const warnings = [];
    builder.config.logger.warn = (message) => warnings.push(message);
    const removals = [];
    fs.rmSync = (directory) => removals.push(directory);
    syncBuiltinESMExports();
    for (const [name, target, removable] of [
      ['project root', root, false],
      ['project ancestor', sandbox, false],
      ['outside root', path.join(sandbox, 'outside'), false],
      ['root prefix sibling', root + '-sibling', false],
      ['client directory', clientDir, false],
      ['client ancestor', path.dirname(clientDir), false],
      ['standalone server', path.join(root, 'dist/server'), true],
    ]) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(
        path.join(target, 'server.js'),
        failure === 'build'
          ? 'export function handleRequest() { throw new Error("Injected build failure"); }'
          : 'export function handleRequest() { return new Response("<!DOCTYPE html><html></html>"); }',
      );
      serving.generateBundle.handler.call(
        { environment: builder.environments.client },
        { dir: clientDir },
        {},
      );
      serving.generateBundle.handler.call(
        { environment: builder.environments.ssr },
        { dir: target },
        {},
      );
      removals.length = 0;
      warnings.length = 0;
      await prerender.buildApp.handler({
        config: builder.config,
        environments: { client: { isBuilt: true }, ssr: { isBuilt: true } },
      });
      if (failure === 'assertion') assert.fail('Injected assertion failure');
      assert.deepEqual(removals, removable ? [target] : [], `cleanup eligibility: ${name}`);
      assert.deepEqual(
        warnings,
        removable ? [] : [preservedWarning(target)],
        'warning eligibility: ' + name,
      );
      const host = { name: 'fixture:host', buildApp() {} };
      builder.config.plugins.push(host);
      warnings.length = 0;
      removals.length = 0;
      await prerender.buildApp.handler({
        config: builder.config,
        environments: { client: { isBuilt: true }, ssr: { isBuilt: true } },
      });
      assert.deepEqual(warnings, [], 'host never warns: ' + name);
      assert.deepEqual(removals, [], 'host output retained: ' + name);
      builder.config.plugins.pop();
      const functionsBuilder = await createBuilder({
        root,
        configFile: false,
        customLogger: { ...builder.config.logger, warn: (message) => warnings.push(message) },
        plugins: [solid({ start: true, serverFunctions: true })],
      });
      const functionsServing = functionsBuilder.config.plugins.find(
        (plugin) => plugin.name === 'solid:ssr/setup',
      );
      functionsServing.generateBundle.handler.call(
        { environment: functionsBuilder.environments.client },
        { dir: clientDir },
        {},
      );
      functionsServing.generateBundle.handler.call(
        { environment: functionsBuilder.environments.ssr },
        { dir: target },
        {},
      );
      await functionsBuilder.config.plugins
        .find((plugin) => plugin.name === 'solid:start/prerender')
        .buildApp.handler({
          config: functionsBuilder.config,
          environments: { client: { isBuilt: true }, ssr: { isBuilt: true } },
        });
      assert.deepEqual(warnings, [], 'function output never warns: ' + name);
      assert.deepEqual(removals, [], 'function output retained: ' + name);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'client asset');
      console.log(`PASS cleanup target: ${name}`);
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
      assert.equal(fs.existsSync(sandbox), false, 'cleanup-target sandbox cleaned');
    } catch (error) {
      if (primaryError) {
        throw new AggregateError([primaryError, error], 'Failed to clean cleanup-target sandbox');
      }
      throw error;
    }
  }
}
await run();
for (const failure of ['setup', 'build', 'assertion']) {
  await assert.rejects(run(failure), new RegExp('Injected ' + failure + ' failure'));
  console.log('PASS cleanup-target failure cleanup: ' + failure);
}
