// HMR fixture: test/run.mjs edits the rendered text below on disk and
// asserts the page picks it up through solid-refresh without a full reload
// and without resetting sibling component state. Keep the marker text and
// element id in sync with the test.
export default function HmrTarget() {
  return <p id="hmr-text">HMR-ORIGINAL</p>;
}
