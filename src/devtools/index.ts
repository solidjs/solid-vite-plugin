export const DEVTOOLS_PACKAGE = '@solidjs/start-devtools';
export const DEVTOOLS_MOUNT_ID = 'virtual:solid-devtools/mount';

export function devtoolsMountModuleCode(): string {
  return [
    `import { mountDevToolbar } from '${DEVTOOLS_PACKAGE}';`,
    `mountDevToolbar();`,
  ].join('\n');
}
