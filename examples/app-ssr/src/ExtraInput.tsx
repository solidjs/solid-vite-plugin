// Extra configured client input (extra-input mode, EXTRA_CLIENT_INPUT=1 in
// vite.config.ts): a route-like module that is BOTH listed in the client
// build's `rollupOptions.input` — the shape filesystem-routing's
// `buildInputs` produces for every route module — and lazily imported by
// App.tsx. Its manifest record is therefore a genuine `isEntry` (#347) whose
// key sorts ahead of the plugin's own `virtual:` client entry; the built
// handler must still boot the page with the real entry and link the entry
// graph's CSS, not this module's (#353).
import './ExtraInput.css';

export default function ExtraInputPage() {
  return <main id="extra-input">EXTRA-INPUT-PAGE</main>;
}
