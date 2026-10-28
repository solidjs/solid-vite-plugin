import { expect, it } from 'vitest';
import solidPlugin from './index.js';

it('start.external names its replacement', () => {
  expect(() => solidPlugin({ start: { external: true } as never, ssr: true })).toThrow(
    '`start.external` has been renamed to `start.externalServer`.',
  );
});

it('accepts start.externalServer', () => {
  expect(() => solidPlugin({ start: { externalServer: true }, ssr: true })).not.toThrow();
});
