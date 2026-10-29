import { expect, it } from 'vitest';
import solidPlugin, { serverFunctions } from '../index.js';

it('serverFunctions.configure names its replacement', () => {
  const message = '`serverFunctions.configure` has been renamed to `serverFunctions.serverSetup`.';
  expect(() => solidPlugin({ serverFunctions: { configure: './src/setup.ts' } as never })).toThrow(
    message,
  );
  expect(() => serverFunctions({ configure: './src/setup.ts' } as never)).toThrow(message);
});

it('accepts serverFunctions.serverSetup', () => {
  expect(() => solidPlugin({ serverFunctions: { serverSetup: './src/setup.ts' } })).not.toThrow();
  expect(() => serverFunctions({ serverSetup: './src/setup.ts' })).not.toThrow();
});
