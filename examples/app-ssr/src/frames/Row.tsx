import { createSignal, type JSX } from 'solid-js';

/**
 * Client wrapper around server-owned row bodies. Its counter is the
 * policy-A assertion: refetches morph the server content underneath while
 * this component (matched by `$key`) keeps its state and DOM identity.
 *
 * The region children sit under a REACTIVE conditional — the shape that
 * used to drop nested regions on an adopted boundary's first morph
 * (dom-expressions#547); the frames test asserts the regions survive.
 */
export default function Row(props: { cid: string; children?: JSX.Element }) {
  const [n, setN] = createSignal(0);
  const [collapsed, setCollapsed] = createSignal(false);
  return (
    <div class="row">
      <button class="row-bump" onClick={() => setN(n() + 1)}>
        +
      </button>
      <span class="row-count">{n()}</span>
      <button class="row-collapse" onClick={() => setCollapsed(!collapsed())}>
        toggle
      </button>
      {!collapsed() && props.children}
    </div>
  );
}
