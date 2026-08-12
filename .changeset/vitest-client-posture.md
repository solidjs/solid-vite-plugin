---
'@solidjs/vite-plugin': patch
---

Vitest always gets the client posture, regardless of the app's `ssr` flag: test-mode transforms compile non-hydratable (dom codegen under a DOM environment — nothing hydrates in a test), the `browser` export condition applies so solid resolves its client builds, and `test.environment` defaults to `jsdom` for server-rendered apps too. DOM component tests in an `ssr: true` app work without the `ssr: mode !== 'test'` workaround; explicit `test.environment: 'node'` still gets server codegen for `renderToString`-style tests.
