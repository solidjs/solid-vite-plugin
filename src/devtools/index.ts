export const DEVTOOLS_PACKAGE = '@solidjs/start-devtools';
export const DEVTOOLS_ID = 'virtual:solid-devtools';
export const DEVTOOLS_MOUNT_ID = 'virtual:solid-devtools/mount';

export function devtoolsModuleCode(): string {
  return [
    `import * as serverFunctions from '@solidjs/web/server-functions';`,
    `import { DevToolbar, pushServerFunctionCall } from '${DEVTOOLS_PACKAGE}';`,
    `const observe = Reflect.get(serverFunctions, 'observeServerFunctionCalls');`,
    `if (typeof observe === 'function') observe(pushServerFunctionCall);`,
    `export { DevToolbar };`,
  ].join('\n');
}

export function devtoolsMountModuleCode(): string {
  return [
    `import ${JSON.stringify(DEVTOOLS_ID)};`,
    `import { mountDevToolbar } from '${DEVTOOLS_PACKAGE}';`,
    `mountDevToolbar();`,
  ].join('\n');
}
