---
'@solidjs/vite-plugin': patch
---

Chunk and asset names derived from file names no longer carry runs of dots. A catch-all route module such as `[...404].tsx` built to `_...404_-<hash>.js`, and hosts, CDNs or middleware that reject any URL containing `..` refused that chunk, so the lazy route failed to hydrate. Builds now run the configured `output.sanitizeFileName` (or the bundler default) and then collapse every run of dots in the last segment of the name to one: the chunk becomes `_.404_-<hash>.js`. Directories are left alone: with `preserveModules` they are part of the name. The server build is named the same way, so the asset URLs it writes into server-rendered markup keep pointing at the files the client build wrote. A custom `sanitizeFileName` still runs, with the collapse applied after it, whether it comes from the config or from another plugin's `outputOptions` hook; `sanitizeFileName: false` is left alone. Fixes #391.
