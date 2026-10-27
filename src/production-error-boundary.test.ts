import { expect, it } from 'vitest';
import solidPlugin from './index.js';

it('start.errorBoundary names its replacement', () => {
  expect(() => solidPlugin({ start: { errorBoundary: false } as never })).toThrow(
    '`start.errorBoundary` has been renamed to `start.productionErrorBoundary`',
  );
});
