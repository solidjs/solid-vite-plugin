// jsdom regression test for solidjs/solid-vite-plugin#369, run by
// `pnpm test:jsdom` with tests/deno-conditions.mjs preloaded.
// `@solidjs/testing-library` has no `solid` export condition. Left external,
// its own `import "solid-js/web"` is resolved by the host runtime, and under
// Deno that is the server build, so `render` threw "Client-only API called
// on the server side". The plugin inlines it with solid-js, so its imports
// go through Vite's `browser` condition and share the test file's instance.
import { render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { isServer } from 'solid-js/web';
import { expect, test } from 'vitest';

function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <button type="button" onClick={() => setCount(count() + 1)}>
      count: {count()}
    </button>
  );
}

test('resolves the browser build in the test file', () => {
  expect(isServer).toBe(false);
});

test('renders and updates through @solidjs/testing-library', () => {
  const { getByRole, unmount } = render(() => <Counter />);
  const button = getByRole('button');
  expect(button.textContent).toBe('count: 0');
  button.click();
  expect(button.textContent).toBe('count: 1');
  unmount();
});
