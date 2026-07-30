---
"vite-plugin-solid": patch
---

Install `frameTransformFlightResult` alongside `frameTransformResult` in the generated server-function handler module when `serverComponents` is on: mutations whose single-flight payload includes invalidated server-component markup answer with the frame stream as carrier (regions + envelope in one response). Only active when a router registers a `collectFlightData` hook.

`frameTransformDirectResult` is now installed in the handler module too (previously only in the generated SSR entry): flight collection makes direct in-process calls during handler dispatch, and the transform brands their results with the call address the client matches showing boundaries against. Without it, a mutation dispatched before the SSR entry loads (dev restart with an open page) would silently degrade in-place morphs to minted boundaries.
