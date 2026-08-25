'use server';
// Server components: `use server` functions that RETURN a function. The
// returned component's props are client positions (slots); the function's
// arguments are the server's inputs. This whole module is replaced by
// reference proxies in the client build — ROWS text must never reach any
// client asset (the frames test scans for it).

const SECRET_ROW_TEXT = 'SERVER-ROW-TEXT';

const ROWS = [
  { id: 'r1', text: `${SECRET_ROW_TEXT}-one` },
  { id: 'r2', text: `${SECRET_ROW_TEXT}-two` },
];

let counter = 0;

/** Plain data server function riding the same endpoint (mixed use). */
export async function incrementCounter() {
  return ++counter;
}

/**
 * Same shape as getPanel but never document-SSR'd: mounted post-boot only,
 * so its boundary streams fresh (no adoption) — isolates the non-adopted
 * morph path.
 */
export async function getFreshPanel(name: string, version: number) {
  return (props: Record<string, any>) => (
    <section class="fresh-panel">
      <h2 id="fresh-name">fresh:{name}</h2>
      <p id="fresh-version">fversion:{version}</p>
      <div class="fresh-rows">
        {ROWS.map((r) =>
          props.row({
            $key: r.id,
            cid: 'cell-' + r.id.slice(1),
            children: (
              <em class="row-body">
                {r.text}:{name}
              </em>
            ),
          }),
        )}
      </div>
    </section>
  );
}

/** Document-SSR'd server component: its boundary is adopted at boot. */
export async function getPanel(name: string, version: number) {
  return (props: Record<string, any>) => (
    <section class="panel">
      <h2 id="panel-name">panel:{name}</h2>
      <p id="server-version">version:{version}</p>
      <p id="server-counter">counter:{counter}</p>
      <div class="rows">
        {ROWS.map((r) =>
          props.row({
            $key: r.id,
            cid: 'cell-' + r.id.slice(1),
            children: (
              <em class="row-body">
                {r.text}:{name}
              </em>
            ),
          }),
        )}
      </div>
      <footer id="panel-footer">{props.children}</footer>
    </section>
  );
}
