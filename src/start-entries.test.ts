import { describe, expect, it } from 'vitest';
import solidPlugin from './index.js';

describe('start.entries', () => {
  it.each([
    ['entryServer', 'entries.server'],
    ['entryClient', 'entries.client'],
  ])('start.%s names its replacement', (key, replacement) => {
    expect(() => solidPlugin({ start: { [key]: './src/entry.tsx' } as never })).toThrow(
      `\`start.${key}\` has been renamed to \`start.${replacement}\``,
    );
  });
});
