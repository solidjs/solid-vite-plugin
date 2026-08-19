// Browser-only module behind clientOnly(): the server never starts this
// import, so its marker text must never appear in SSR HTML — only the
// modulepreload hint for its chunk does (prod). The swap into the live DOM
// happens after hydration settles; test/run.mjs asserts all three sides.
export default function ClientOnlyWidget() {
  return <p id="client-only-widget">CLIENT-ONLY-WIDGET</p>;
}
