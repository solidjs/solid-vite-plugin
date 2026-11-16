---
'vite-plugin-solid': patch
---

Inline packages that import `solid-js` in jsdom tests even when they are reached only through another such package (fixes #543). They stayed external, so Node loaded a second `solid-js` for them, and components such as `solid-transition-group`'s `<Transition>` rendered nothing.
