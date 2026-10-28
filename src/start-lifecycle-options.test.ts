import { expect, it } from 'vitest';
import solidPlugin from './index.js';

it('start.setup names its replacement', () => {
  expect(() =>
    solidPlugin({ start: { setup: './src/setup.tsx' } as never, ssr: true }),
  ).toThrow('`start.setup` has been renamed to `start.renderSetup`.');
});

it('start.instrument names its replacement', () => {
  expect(() =>
    solidPlugin({ start: { instrument: './src/instrument.ts' } as never, ssr: true }),
  ).toThrow('`start.instrument` has been renamed to `start.serverBootstrap`.');
});

it('accepts start.renderSetup and start.serverBootstrap', () => {
  expect(() =>
    solidPlugin({
      start: { renderSetup: './src/render-setup.tsx', serverBootstrap: './src/server-bootstrap.ts' },
      ssr: true,
    }),
  ).not.toThrow();
});
