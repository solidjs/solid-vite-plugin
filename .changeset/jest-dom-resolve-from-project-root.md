---
'@solidjs/vite-plugin': patch
---

Only inject the `@testing-library/jest-dom` Vitest setup file when the package resolves from the project root (forward-port of #364 by @brenelz, fixes #231). Previously the check ran from the plugin's own location, so with pnpm a transitive jest-dom (for example via Storybook) made Vitest fail with `Failed to load url .../@testing-library/jest-dom/vitest`. The probe now walks `node_modules` up from the Vite root the way Vitest resolves bare `setupFiles` — deliberately ignoring `NODE_PATH`, which pnpm's bin shims (`pnpm vitest`) point at the hoisted virtual store where every transitive dependency is reachable.
