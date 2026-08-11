---
'vite-plugin-solid': patch
---

Custom `extensions` work with the native compiler again. The native compiler picks its parser dialect from the file extension, so the transform builds a borrowed-extension filename (`foo.mdx` → `foo.mdx.jsx`, or `.tsx` when the extension is registered as TypeScript) for exactly this case — but only the lazy and refresh passes used it; the JSX transform itself still received the raw id, and `@dom-expressions/compiler` rejected it with "Unknown file extension" (#297). `compiler: 'babel'` was unaffected because that path names the parser plugins explicitly. The JSX transform now receives the same borrowed filename as the other native passes.
