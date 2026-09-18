---
'vite-plugin-solid': patch
---

Only inject the `@testing-library/jest-dom` Vitest setup file when the package resolves from the project root. Previously the check ran from the plugin's own location, so with pnpm a transitive jest-dom (for example via Storybook) made Vitest fail with `Failed to load url .../@testing-library/jest-dom/vitest`.
