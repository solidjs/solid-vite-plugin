# SSR example — manual wiring (the integrator path)

This example is the **integrator / meta-framework path**: `ssr: true` gives
you the SSR transforms (hydratable client code, SSR server code) and *you*
own everything else — a middleware-mode Vite dev server embedded in your own
`server.js`, your own production server, and manual manifest handling (the
authored `/src/entry-client.tsx` script reference is rewritten to the hashed
asset the classic way). This is the escape hatch the `start` option
(`start: true` + `ssr: true`, see `examples/turnkey`) is built on: if you are building a
framework, or need to control the server, start here.

What it demonstrates:

- `src/entry-server.tsx` / `src/entry-client.tsx` entries with a
  full-document `<App />` (`<html>`, `<HydrationScript />`, entry script).
- Dev: `node server.js` creates Vite in middleware mode
  (`server.middlewareMode`, `appType: 'custom'`) and streams
  `renderToStream` output, injecting the Vite client itself.
- Prod: the classic two-step build (`vite build` for the client,
  `vite build --ssr` for the server) plus static asset serving and manifest
  lookup in the same `server.js`.
- `virtual:solid-manifest` + `lazy()` routes (including an
  `import.meta.glob` route and a forced shared chunk) exercising the
  plugin's asset manifest for dynamically imported modules.

Run it:

```bash
pnpm dev          # dev server (node server.js)
pnpm build        # client + server bundles
pnpm serve        # production server
pnpm test         # lean e2e (dev + prod SSR smoke, test/run.mjs)
```
