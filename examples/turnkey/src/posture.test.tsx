// Vitest posture regression test (vitest mode in test/run.mjs): this app is
// `ssr: true`, but tests must compile and resolve with the CLIENT posture —
// dom codegen, non-hydratable, browser export conditions, jsdom by default
// (the plugin injects all of that in test mode; this example's config has no
// `test` block and no `ssr: mode !== 'test'` workaround). Before the fix this
// file would compile hydratable (or with server semantics under a node
// environment) and DOM component tests broke.
import { expect, it } from 'vitest';
import { createSignal } from 'solid-js';
import { isServer, render } from '@solidjs/web';

function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <button type="button" onClick={() => setCount(count() + 1)}>
      count: {count()}
    </button>
  );
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

it('resolves the browser build despite ssr: true', () => {
  // Server-condition resolution was half the breakage: solid resolved its
  // node/server entry in tests, so DOM rendering was impossible.
  expect(isServer).toBe(false);
});

it('compiles the client posture: dom codegen, non-hydratable', () => {
  const compiled = String(Counter);
  // dom codegen clones templates; ssr codegen concatenates strings and
  // hydratable dom codegen walks existing markup instead of creating it.
  expect(compiled).not.toMatch(/getNextElement|ssrElement|ssr\(/);
});

it('renders and updates a DOM component under jsdom', async () => {
  const dispose = render(() => <Counter />, document.body);
  try {
    const button = document.body.querySelector('button')!;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain('count: 0');

    button.click();
    // Solid 2 schedules updates; give the graph a tick (poll briefly to
    // stay robust against scheduler changes across 2.0 releases).
    for (let i = 0; i < 20 && !button.textContent!.includes('count: 1'); i++) {
      await nextTick();
    }
    expect(button.textContent).toContain('count: 1');
  } finally {
    dispose();
  }
});
