import { expect, it } from 'vitest';
import solidPlugin from './index.js';

it('start.css names the top-level replacement', () => {
  expect(() => solidPlugin({ start: { css: { devInline: {} } } as never })).toThrow(
    '`start.css` has moved to the top-level `css` option',
  );
});

it('css.filter names its replacement', () => {
  expect(() => solidPlugin({ css: { filter: {} } as never })).toThrow(
    '`css.filter` has been renamed to `css.devInline`.',
  );
});

it('accepts css.devInline', () => {
  expect(() => solidPlugin({ css: { devInline: { include: /some-ui-lib/ } } })).not.toThrow();
});
