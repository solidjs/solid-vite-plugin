/**
 * The messages and endpoints the dev server and the devtools toolbar share.
 *
 * `@solidjs/start-devtools/protocol` defines them (solidjs/solid-start-devtools#48).
 * They are copied here until a devtools release ships that entry. Then the
 * constants take the types of the package's, as `src/diagnostics` does with
 * `@solidjs/diagnostics/protocol`, so drift fails this plugin's compile.
 */

/** Opens a file in the editor: `GET /__solid/devtools/open-in-editor?file=src/App.tsx:12:5`. */
export const OPEN_IN_EDITOR_PATH = '/__solid/devtools/open-in-editor';

/** Toolbar to server, once it connects. The payload is a `DevServerHello`. */
export const DEVTOOLS_HELLO_EVENT = 'solid:devtools:hello';

/** Server to toolbar, the answer to the hello. The payload is a `DevServerInfo`. */
export const DEVTOOLS_INFO_EVENT = 'solid:devtools:info';

/** Server to toolbar, each server error after the hello. The payload is a `ServerErrorMessage`. */
export const DEVTOOLS_SERVER_ERROR_EVENT = 'solid:devtools:server-error';

export interface DevServerHello {
  /** When the page started loading, in milliseconds since the epoch. */
  since: number;
}

/** Package versions resolved from the app root. A package that was not found is left out. */
export interface DevServerVersions {
  'solid-js'?: string;
  '@solidjs/web'?: string;
  '@solidjs/vite-plugin'?: string;
  vite?: string;
}

export interface DevServerInfo {
  versions: DevServerVersions;
  /** The server errors kept since the hello's `since`, oldest first. */
  errors: ServerErrorMessage[];
}

/** A failure the server runtime reported, as `configureServerErrors` hears it. */
export interface ServerErrorMessage {
  /** Unique for the life of the dev server. */
  id: number;
  /** When the server heard it, in milliseconds since the epoch. */
  at: number;
  name: string;
  message: string;
  stack?: string;
  kind: 'render' | 'server-function' | 'request';
  handling: string;
  functionId?: string;
  ownerPath?: string[];
  method?: string;
  url?: string;
}
