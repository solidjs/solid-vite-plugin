export const DEVTOOLS_PACKAGE = '@solidjs/start-devtools';
export const DEVTOOLS_MOUNT_ID = 'virtual:solid-devtools/mount';

/**
 * Connects the toolbar to the dev server (see `./server.ts`). The toolbar
 * is pre-bundled and has no `import.meta.hot` of its own, so the generated
 * module passes its own. A namespace import, because a devtools release
 * older than `connectDevServer` does not export it.
 */
export function devtoolsConnectCode(): string[] {
  return [
    `import * as __solidDevtools from '${DEVTOOLS_PACKAGE}';`,
    `if (import.meta.hot && typeof __solidDevtools.connectDevServer === 'function') {`,
    `  __solidDevtools.connectDevServer(import.meta.hot);`,
    `}`,
  ];
}

export function devtoolsMountModuleCode(): string {
  return [
    `import { mountDevToolbar } from '${DEVTOOLS_PACKAGE}';`,
    ...devtoolsConnectCode(),
    `mountDevToolbar();`,
  ].join('\n');
}
