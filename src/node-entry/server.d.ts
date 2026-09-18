// Type shim for the sibling server bundle the emitted `node.js` imports at
// runtime (`dist/server/server.js`, whose entry is virtual:solid-ssr-handler).
// The import stays external in the runtime artifact — see rollup.config.js.
export function handleRequest(
  request: Request,
  options?: { event?: Record<string, unknown> },
): Promise<Response>;
