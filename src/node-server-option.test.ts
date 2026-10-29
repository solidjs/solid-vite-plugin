import { expect, it } from 'vitest';
import solidPlugin from './index.js';

it('start.node names its replacement', () => {
  expect(() => solidPlugin({ start: { node: true } as never, ssr: true })).toThrow(
    '`start.node` has been renamed to `start.nodeServer`.',
  );
});

it('accepts start.nodeServer', () => {
  expect(() => solidPlugin({ start: { nodeServer: true }, ssr: true })).not.toThrow();
});
