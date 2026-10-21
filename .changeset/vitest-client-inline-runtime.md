---
'@solidjs/vite-plugin': patch
---

In the Vitest client posture (jsdom, happy-dom), the plugin now inlines `solid-js`, `@solidjs/web` and the packages that import them without a `solid` export condition, such as `@solidjs/testing-library`. Before, they stayed external, and the host runtime resolved their own imports. Node gets the `browser` condition from Vitest's worker `--conditions`, but Deno does not apply it in worker threads (the `threads` pool) and resolves `deno`/`node`. Under Deno, `@solidjs/testing-library` loaded the server build of `@solidjs/web` and `render` failed with `isServer` true (#369). Inlining sends these imports through Vite's `browser` condition and loads one client-build instance. A `test.server.deps.inline` list is merged with the plugin's, and a `test.server.deps.external` entry for `solid-js` still opts out.
