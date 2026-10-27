import { expect, it } from 'vitest';
import solidPlugin from './index.js';

it('start.css names the top-level replacement', () => {
  expect(() => solidPlugin({ start: { css: { filter: {} } } as never })).toThrow(
    '`start.css` has moved to the top-level `css` option',
  );
});
