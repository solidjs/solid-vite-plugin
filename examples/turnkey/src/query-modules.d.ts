// TypeScript can't resolve query-suffixed module specifiers; the runtime
// module is src/QueryLazy.tsx served under its queried identity (see App.tsx).
declare module '*?variant=a' {
  const component: import('solid-js').Component;
  export default component;
}
