---
'vite-plugin-solid': patch
---

Ignore `NODE_PATH` when checking whether the project has `@testing-library/jest-dom` (fixes #541). pnpm's bin shims (`pnpm vitest`) point `NODE_PATH` at the hoisted virtual store, so in a workspace where any package depends on jest-dom the setup file was injected into projects without it, and Vitest failed with `Cannot find module '<root>/@testing-library/jest-dom/vitest'`. The check now walks `node_modules` up from the project root, as Vite does when it resolves `setupFiles` (backported from the `next` branch).
