// @vitest-environment node
// Regression test for solidjs/solid-vite-plugin#534. This file runs in the
// `ssr` environment while the suite defaults to jsdom, and must still load
// the client build of solid-js.
import { createEffect, createRoot } from 'solid-js';
import { isServer } from 'solid-js/web';
import { expect, test } from 'vitest';

test('loads the client build of solid-js', () => {
  expect(isServer).toBe(false);
});

test('runs effects', async () => {
  let ran = false;
  createRoot(() =>
    createEffect(() => {
      ran = true;
    }),
  );
  await Promise.resolve();
  expect(ran).toBe(true);
});
