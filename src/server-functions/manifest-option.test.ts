import { expect, it } from 'vitest';
import solidPlugin, { serverFunctions } from '../index.js';

it('serverFunctions.manifest says the module id is fixed', () => {
  const message =
    '`serverFunctions.manifest` has been removed: the module id is always `virtual:solid-server-function-manifest`.';
  expect(() => solidPlugin({ serverFunctions: { manifest: 'virtual:custom' } as never })).toThrow(
    message,
  );
  expect(() => serverFunctions({ manifest: 'virtual:custom' } as never)).toThrow(message);
});
