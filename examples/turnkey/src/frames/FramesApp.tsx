import { createSignal, Loading } from 'solid-js';
import { dynamic } from '@solidjs/web';
import { getFreshPanel, getPanel, incrementCounter } from './data';
import Row from './Row';

/**
 * Server-components page: a plain content component like any other turnkey
 * app root. `serverFunctions: { components: true }` + turnkey SSR's
 * generated entries emit every bit of wiring (the render plugin, the
 * bootstrap script, the client-side installServerComponents() call) — this
 * file is only app code. The test's frames mode points `ssr.app` here.
 *
 * The whole client surface for server components is `dynamic` over a server
 * function call: every response for a call site resolves to the same stable
 * component and the streamed update morphs the boundary underneath.
 *
 * The root is deliberately a fragment with siblings, and the boundary lives
 * under a reactive page conditional: a frame insertable in an array insert
 * position used to be handed raw to insertBefore and crash
 * (dom-expressions#550, fixed in @solidjs/web 2.0.0-beta.26). Keep this
 * shape — it is the regression coverage, together with the frames test's
 * navigate-away-and-back cycle over `#nav-away` / `#nav-home`.
 */
export default function FramesApp() {
  const [name, setName] = createSignal('alpha');
  const [bump, setBump] = createSignal(0);
  // Client-only: mounts a second, never-SSR'd boundary post-boot.
  const [showFresh, setShowFresh] = createSignal(false);
  // Signal-driven "routing": unmounts and remounts the whole boundary set.
  const [page, setPage] = createSignal<'home' | 'away'>('home');

  const Panel = dynamic(() => getPanel(name(), bump()));
  const FreshPanel = dynamic(() => getFreshPanel(name(), bump()));

  return (
    <>
      <h1>Server Components</h1>
      <button id="nav-beta" onClick={() => setName('beta')}>
        beta
      </button>
      <button id="refetch" onClick={() => setBump(bump() + 1)}>
        refetch
      </button>
      <button
        id="mutate"
        onClick={async () => {
          await incrementCounter();
          setBump(bump() + 1);
        }}
      >
        mutate
      </button>
      <button id="show-fresh" onClick={() => setShowFresh(true)}>
        fresh
      </button>
      <button id="nav-away" onClick={() => setPage('away')}>
        away
      </button>
      <button id="nav-home" onClick={() => setPage('home')}>
        home
      </button>
      {page() === 'home' ? (
        <>
          <Loading fallback={<p class="loading">loading…</p>}>
            <Panel row={(p: any) => <Row cid={p.cid}>{p.children}</Row>}>
              <input id="draft" placeholder="draft survives navigation" />
            </Panel>
          </Loading>
          {showFresh() && (
            <Loading fallback={<p class="loading">loading fresh…</p>}>
              <FreshPanel row={(p: any) => <Row cid={p.cid}>{p.children}</Row>} />
            </Loading>
          )}
        </>
      ) : (
        <p id="away-page">away</p>
      )}
    </>
  );
}
