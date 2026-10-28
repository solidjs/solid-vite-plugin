---
"@solidjs/vite-plugin": patch
---

With `serverFunctions: { components: true }`, stylesheets that a `'use server'` module reaches (directly or through the components it imports) now reach the production client build, so the SSR document links them. The client compile replaces a server module with references, so its imports never joined the client graph: dev looked right, since its CSS crawl walks the SSR graph, but production rendered server components unstyled (#456). The client build now walks what the module imports and imports those stylesheets from its client module. Script modules on the way are only loaded, never imported, so no server code reaches the client bundle, and compile-time CSS plugins such as StyleX still see them. Builds without `components` are unchanged.
