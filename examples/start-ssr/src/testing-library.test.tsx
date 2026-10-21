// Client-posture regression test for runtime-consuming packages (#369). The
// vitest mode of test/run.mjs runs it with test/deno-conditions.mjs
// preloaded. `@solidjs/testing-library` has no `solid` export condition.
// Left external, its own `import "@solidjs/web"` is resolved by the host
// runtime, and under Deno that is the server build, so `render` ran with
// `isServer` true. The plugin inlines it with the runtime, so its imports go
// through Vite's `browser` condition and share the test file's instance.
import { expect, it } from 'vitest';
import { createSignal } from 'solid-js';
import { isServer } from '@solidjs/web';
import { render } from '@solidjs/testing-library';

function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <button type="button" onClick={() => setCount(count() + 1)}>
      count: {count()}
    </button>
  );
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

it('resolves the browser build in the test file', () => {
  expect(isServer).toBe(false);
});

it('renders and updates through @solidjs/testing-library', async () => {
  const { getByRole, unmount } = render(() => <Counter />);
  try {
    const button = getByRole('button');
    expect(button.textContent).toContain('count: 0');
    button.click();
    for (let i = 0; i < 20 && !button.textContent!.includes('count: 1'); i++) {
      await nextTick();
    }
    expect(button.textContent).toContain('count: 1');
  } finally {
    unmount();
  }
});
