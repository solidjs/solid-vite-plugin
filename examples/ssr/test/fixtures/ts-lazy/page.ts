// SSR lazy target with no JSX (#406). The server compile stamps the
// module id; the client compile must not.
export default function Page() {
  return 'TS-LAZY-PAGE';
}
