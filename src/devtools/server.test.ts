import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { configureServerErrors, reportRequestFailure } from '@solidjs/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { devtoolsConnectCode, devtoolsMountModuleCode } from './index.js';
import {
  detectDevtoolsPackage,
  listenToServerErrors,
  readPackageVersion,
  resolveEditorLocation,
  serverErrorMessage,
} from './server.js';

const temporary: string[] = [];

function makeDirectory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'solid-devtools-'));
  temporary.push(dir);
  return dir;
}

function writeFile(file: string, content = ''): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveEditorLocation', () => {
  it('resolves a location against the root and keeps its line and column', () => {
    const root = makeDirectory();
    writeFile(path.join(root, 'src/App.tsx'));
    expect(resolveEditorLocation(root, 'src/App.tsx:12:5')).toBe(
      path.join(root, 'src/App.tsx') + ':12:5',
    );
  });

  it('drops leading folders the root already includes', () => {
    const root = makeDirectory();
    writeFile(path.join(root, 'src/App.tsx'));
    expect(resolveEditorLocation(root, 'examples/app/src/App.tsx:3')).toBe(
      path.join(root, 'src/App.tsx') + ':3',
    );
  });

  it('takes an absolute path that exists', () => {
    const root = makeDirectory();
    const file = path.join(makeDirectory(), 'server.ts');
    writeFile(file);
    expect(resolveEditorLocation(root, `${file}:1:1`)).toBe(`${file}:1:1`);
  });

  it('gives nothing for a file that does not exist', () => {
    expect(resolveEditorLocation(makeDirectory(), 'src/Missing.tsx:1:1')).toBeUndefined();
  });
});

describe('readPackageVersion', () => {
  it('finds a package installed above the root', () => {
    const workspace = makeDirectory();
    writeFile(
      path.join(workspace, 'node_modules/solid-js/package.json'),
      JSON.stringify({ version: '2.0.0' }),
    );
    const root = path.join(workspace, 'apps/site');
    mkdirSync(root, { recursive: true });
    expect(readPackageVersion(root, 'solid-js')).toBe('2.0.0');
    expect(readPackageVersion(root, 'vite')).toBeUndefined();
  });
});

describe('detectDevtoolsPackage', () => {
  it('finds the package declared by the app or installed above it', () => {
    const declared = makeDirectory();
    writeFile(
      path.join(declared, 'package.json'),
      JSON.stringify({ devDependencies: { '@solidjs/start-devtools': '^1.0.0' } }),
    );
    expect(detectDevtoolsPackage(path.join(declared, 'src'))).toBe(true);

    const itself = makeDirectory();
    writeFile(
      path.join(itself, 'package.json'),
      JSON.stringify({ name: '@solidjs/start-devtools' }),
    );
    expect(detectDevtoolsPackage(path.join(itself, 'examples/demo'))).toBe(true);

    const without = makeDirectory();
    writeFile(path.join(without, 'package.json'), JSON.stringify({ name: 'app' }));
    expect(detectDevtoolsPackage(without)).toBe(false);
  });
});

describe('serverErrorMessage', () => {
  it('carries the error and where the runtime met it', () => {
    const error = new TypeError('boom');
    const message = serverErrorMessage(3, error, {
      kind: 'server-function',
      handling: 'thrown',
      functionId: 'abc',
      event: { request: new Request('http://localhost/_server', { method: 'POST' }) },
    });
    expect(message).toMatchObject({
      id: 3,
      name: 'TypeError',
      message: 'boom',
      kind: 'server-function',
      handling: 'thrown',
      functionId: 'abc',
      method: 'POST',
      url: 'http://localhost/_server',
    });
    expect(message.stack).toContain('boom');
  });

  it('describes a thrown value that is not an error', () => {
    expect(serverErrorMessage(1, 'nope', { kind: 'request', handling: 'failed' })).toMatchObject({
      name: 'Error',
      message: 'nope',
    });
  });
});

describe('listenToServerErrors', () => {
  it('hears a failure and still calls the hook the app registers', () => {
    const heard: string[] = [];
    const stop = listenToServerErrors((error) => heard.push((error as Error).message));
    const appHook = vi.fn();
    configureServerErrors({ onError: appHook });

    const event = { request: new Request('http://localhost/page') } as never;
    reportRequestFailure(new Error('middleware failed'), event);

    expect(heard).toEqual(['middleware failed']);
    expect(appHook).toHaveBeenCalledTimes(1);
    expect(appHook.mock.calls[0]![1]).toMatchObject({ kind: 'request', handling: 'failed' });

    stop();
    configureServerErrors({});
  });

  it('prints a failed request when the app registers no hook', () => {
    const stop = listenToServerErrors(() => {});
    const print = vi.spyOn(console, 'error').mockImplementation(() => {});

    const failure = new Error('no hook');
    reportRequestFailure(failure, { request: new Request('http://localhost/') } as never);

    expect(print).toHaveBeenCalledWith(failure);
    print.mockRestore();
    stop();
  });

  it('puts the app hook back when it stops', () => {
    const appHook = vi.fn();
    const stop = listenToServerErrors(() => {});
    configureServerErrors({ onError: appHook });
    stop();
    const heard = vi.fn();
    listenToServerErrors(heard)();

    reportRequestFailure(new Error('after'), {
      request: new Request('http://localhost/'),
    } as never);

    expect(appHook).toHaveBeenCalledTimes(1);
    expect(heard).not.toHaveBeenCalled();
    configureServerErrors({});
  });
});

describe('devtoolsConnectCode', () => {
  it('connects only when the devtools release has connectDevServer', () => {
    const code = devtoolsConnectCode().join('\n');
    expect(code).toContain(`import * as __solidDevtools from '@solidjs/start-devtools';`);
    expect(code).toContain(`typeof __solidDevtools.connectDevServer === 'function'`);
    expect(code).toContain('__solidDevtools.connectDevServer(import.meta.hot)');
  });

  it('connects before the mount module mounts the toolbar', () => {
    const code = devtoolsMountModuleCode();
    expect(code.indexOf('connectDevServer(')).toBeLessThan(code.indexOf('mountDevToolbar()'));
  });
});
