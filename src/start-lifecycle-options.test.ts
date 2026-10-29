import { expect, it } from 'vitest';
import solidPlugin from './index.js';

it('start.setup names its replacement', () => {
  expect(() =>
    solidPlugin({ start: { setup: './src/setup.tsx' } as never, ssr: true }),
  ).toThrow('`start.setup` has been renamed to `start.serverRenderSetup`.');
});

it('start.instrument names its replacement', () => {
  expect(() =>
    solidPlugin({ start: { instrument: './src/instrument.ts' } as never, ssr: true }),
  ).toThrow('`start.instrument` has been renamed to `start.serverSetup`.');
});

it('accepts start.serverRenderSetup and start.serverSetup', () => {
  expect(() =>
    solidPlugin({
      start: { serverRenderSetup: './src/server-render-setup.tsx', serverSetup: './src/server-setup.ts' },
      ssr: true,
    }),
  ).not.toThrow();
});
