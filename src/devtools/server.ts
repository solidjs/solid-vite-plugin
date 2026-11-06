/**
 * The dev server side of the devtools toolbar (dev serve only).
 *
 * The toolbar runs in the page and cannot see what happens in the server
 * process or on disk. This plugin sends it:
 * - the errors the server runtime reports through `configureServerErrors`,
 *   over Vite's WebSocket;
 * - the versions of the packages the app resolves;
 * - an open-in-editor endpoint that resolves paths against the Vite root.
 *
 * The toolbar connects from the client entry this plugin generates, which
 * calls `connectDevServer(import.meta.hot)` (see `devtoolsConnectCode`).
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { Plugin } from 'vite';
import { DEVTOOLS_PACKAGE } from './index.js';
import {
  DEVTOOLS_HELLO_EVENT,
  DEVTOOLS_INFO_EVENT,
  DEVTOOLS_SERVER_ERROR_EVENT,
  OPEN_IN_EDITOR_PATH,
  type DevServerHello,
  type DevServerInfo,
  type DevServerVersions,
  type ServerErrorMessage,
} from './protocol.js';

/** The registered symbol `@solidjs/web` keeps the ambient server error hook under. */
const SERVER_ERRORS = Symbol.for('solid-js/server/errors');

/** Errors kept for a page that connects after the render that served it. */
const KEPT_ERRORS = 50;

const VERSIONED_PACKAGES = ['solid-js', '@solidjs/web', '@solidjs/vite-plugin', 'vite'] as const;

type ServerErrorHook = (error: unknown, context: ServerErrorContext) => unknown;

interface ServerErrorContext {
  kind: ServerErrorMessage['kind'];
  handling: string;
  functionId?: string;
  ownerPath?: string[];
  event?: { request?: Request };
}

/** The `version` of a package installed at or above `root`, or nothing when it is not found. */
export function readPackageVersion(root: string, name: string): string | undefined {
  let dir = path.resolve(root);
  while (true) {
    const manifest = path.join(dir, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) {
      try {
        const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown })
          .version;
        return typeof version === 'string' ? version : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Whether the app uses `@solidjs/start-devtools`: the nearest package.json
 * declares it or is the package itself, or it is installed at or above the
 * root. Declared or installed, the toolbar can resolve it.
 */
export function detectDevtoolsPackage(root: string): boolean {
  let dir = path.resolve(root);
  while (true) {
    const manifestPath = path.join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          name?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        if (
          manifest.name === DEVTOOLS_PACKAGE ||
          manifest.dependencies?.[DEVTOOLS_PACKAGE] ||
          manifest.devDependencies?.[DEVTOOLS_PACKAGE]
        ) {
          return true;
        }
      } catch {
        // An unreadable manifest declares nothing.
      }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return readPackageVersion(root, DEVTOOLS_PACKAGE) !== undefined;
}

export function readVersions(root: string): DevServerVersions {
  const versions: DevServerVersions = {};
  for (const name of VERSIONED_PACKAGES) {
    const version = readPackageVersion(root, name);
    if (version) versions[name] = version;
  }
  return versions;
}

/**
 * The file an editor location points at, keeping its `:line:col`.
 *
 * Locations the compiler emits are relative to the Vite root. A location
 * written from a parent folder, such as `examples/app/src/App.tsx` when the
 * root is `examples/app`, still resolves: leading folders are dropped until
 * the file exists. Nothing when no candidate exists.
 */
export function resolveEditorLocation(root: string, location: string): string | undefined {
  const match = /^(.*?)((?::\d+){0,2})$/.exec(location);
  const file = match?.[1] ?? location;
  const position = match?.[2] ?? '';
  if (!file) return undefined;
  if (path.isAbsolute(file) && existsSync(file)) return file + position;

  const parts = file.split(/[/\\]/);
  for (let index = 0; index < parts.length; index++) {
    const candidate = path.resolve(root, ...parts.slice(index));
    if (existsSync(candidate)) return candidate + position;
  }
  return undefined;
}

/** The message the toolbar gets for one reported failure. */
export function serverErrorMessage(
  id: number,
  error: unknown,
  context: ServerErrorContext,
): ServerErrorMessage {
  const isError = error instanceof Error;
  const message: ServerErrorMessage = {
    id,
    at: Date.now(),
    name: isError ? error.name : 'Error',
    message: isError ? error.message : String(error),
    kind: context.kind,
    handling: context.handling,
  };
  if (isError && error.stack) message.stack = error.stack;
  if (context.functionId) message.functionId = context.functionId;
  if (context.ownerPath) message.ownerPath = [...context.ownerPath];
  const request = context.event?.request;
  if (request) {
    message.method = request.method;
    message.url = request.url;
  }
  return message;
}

/**
 * Hears every failure the server runtime reports, beside the app's own hook.
 *
 * `configureServerErrors` keeps one hook on `globalThis`, so registering a
 * second one would replace the app's. Instead the slot's `hook` becomes an
 * accessor: the app's `configureServerErrors` call sets the app hook, and
 * the runtime reads a hook that reports the failure, then calls the app's.
 * The server modules run in this process under Vite's module runner, so they
 * share this `globalThis`. A server environment in a worker or another process
 * is not heard.
 */
export function listenToServerErrors(
  report: (error: unknown, context: ServerErrorContext) => void,
): () => void {
  const scope = globalThis as Record<symbol, { hook?: ServerErrorHook } | undefined>;
  const slot = (scope[SERVER_ERRORS] ??= {});
  let appHook = slot.hook;

  function forward(error: unknown, context: ServerErrorContext): unknown {
    try {
      report(error, context);
    } catch {
      // The toolbar's copy must never change how the app handles the failure.
    }
    if (appHook) return appHook(error, context);
    // With no hook registered the runtime prints a failure that fails the
    // request. A hook is now always registered, so it prints it here instead.
    if (context.handling === 'failed') console.error(error);
    return undefined;
  }

  Object.defineProperty(slot, 'hook', {
    configurable: true,
    enumerable: true,
    get: () => forward,
    set(value: ServerErrorHook | undefined) {
      appHook = value;
    },
  });

  return () => {
    Object.defineProperty(slot, 'hook', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: appHook,
    });
  };
}

export function solidDevtoolsServer(): Plugin {
  let root = process.cwd();
  let versions: DevServerVersions = {};
  let enabled = false;

  return {
    name: 'solid:devtools/server',
    // Like the diagnostics surface: the toolbar exists in dev serve only, and
    // test runs (Vitest serves too) never render it.
    apply(_config, env) {
      return env.command === 'serve' && !env.isPreview && env.mode !== 'test';
    },

    configResolved(config) {
      root = config.root;
      enabled = detectDevtoolsPackage(root);
      if (enabled) versions = readVersions(root);
    },

    configureServer(server) {
      if (!enabled) return;

      // Kept so a page that loads after an error still gets it: the render
      // that serves a page fails before the page can connect.
      const kept: ServerErrorMessage[] = [];
      let nextId = 1;

      const stopListening = listenToServerErrors((error, context) => {
        const message = serverErrorMessage(nextId++, error, context);
        kept.push(message);
        if (kept.length > KEPT_ERRORS) kept.shift();
        server.ws.send(DEVTOOLS_SERVER_ERROR_EVENT, message);
      });
      server.httpServer?.once('close', stopListening);

      server.ws.on(DEVTOOLS_HELLO_EVENT, (hello: DevServerHello, client) => {
        const since = typeof hello?.since === 'number' ? hello.since : 0;
        const errors: ServerErrorMessage[] = [];
        for (const message of kept) {
          if (message.at >= since) errors.push(message);
        }
        const info: DevServerInfo = { versions, errors };
        client.send(DEVTOOLS_INFO_EVENT, info);
      });

      // Hands the resolved path to Vite's own `/__open-in-editor`, which
      // launches the editor. Mounted without a path, so connect does not put
      // the original URL back before Vite's middleware reads it.
      server.middlewares.use((req, res, next) => {
        const url = req.url;
        if (!url || !url.startsWith(OPEN_IN_EDITOR_PATH + '?')) return next();
        const file = new URL(url, 'http://localhost').searchParams.get('file');
        const resolved = file ? resolveEditorLocation(root, file) : undefined;
        if (!resolved) {
          res.statusCode = 404;
          res.end(`No file found for ${JSON.stringify(file)}`);
          return;
        }
        req.url = `/__open-in-editor?file=${encodeURIComponent(resolved)}`;
        next();
      });
    },
  };
}
