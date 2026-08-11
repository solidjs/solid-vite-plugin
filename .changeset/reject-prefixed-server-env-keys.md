---
'vite-plugin-solid': patch
---

`start.env` now rejects `server` schema keys that carry the public env prefix at config time. Vite bakes every `VITE_`-prefixed variable (or whatever `envPrefix` selects) into the browser's `import.meta.env` regardless of which side of the schema declares it, so `server: { VITE_API_SECRET: ... }` silently shipped the secret to every client through Vite's own channel — with no diagnostics, since the leak scan only watches the virtual server module's values. The prefix rule was previously enforced one-way (client keys must have it); the reverse guard now fails fast with a rename message, mirroring the existing client-side guard.
