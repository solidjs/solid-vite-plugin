---
'@solidjs/vite-plugin': patch
---

`start.env` now rejects `server` schema keys that carry the public env prefix at config time. Vite bakes every `VITE_`-prefixed variable (or whatever `envPrefix` selects) into the browser's `import.meta.env` regardless of which side of the schema declares it, so `server: { VITE_API_SECRET: ... }` silently shipped the secret to every client through Vite's own channel — the build-time leak scan does flag server values that land in client chunks as literals, but dev has no scan at all, and short or colliding values can evade the literal match. The prefix rule was previously enforced one-way (client keys must have it); the reverse guard now fails fast with a rename message, mirroring the existing client-side guard.
