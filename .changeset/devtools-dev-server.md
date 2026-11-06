---
'@solidjs/vite-plugin': minor
---

Connect the start-mode development toolbar to the dev server. Errors the server runtime reports through `configureServerErrors` reach the toolbar, and the app's own hook is still called. The toolbar also gets the installed versions of `solid-js`, `@solidjs/web`, the plugin and Vite, and an endpoint that opens files in the editor.
