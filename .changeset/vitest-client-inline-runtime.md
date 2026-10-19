---
'vite-plugin-solid': patch
---

In Vitest DOM tests (the jsdom default, no `ssr` option), the plugin now inlines `solid-js` and the packages that import it without a `solid` export condition, such as `@solidjs/testing-library`. Before, they stayed external, and the host runtime resolved their own imports. Node gets the `browser` condition from Vitest's worker `--conditions`, but Deno does not apply it in worker threads and resolves `deno`/`node`. Under Deno, `@solidjs/testing-library` loaded the server build of `solid-js/web` and `render` threw "Client-only API called on the server side" (solidjs/solid-vite-plugin#369). Inlining sends these imports through Vite's `browser` condition and loads one client-build instance. A `test.server.deps.inline` list is merged with the plugin's, and a `test.server.deps.external` entry for `solid-js` still opts out. With `ssr: true`, tests keep `solid-js` external as before.
