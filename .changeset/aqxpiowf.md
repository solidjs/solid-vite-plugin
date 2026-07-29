---
"vite-plugin-solid": minor
---

Add `omitAttributeSpacing` option to `solid.*` config

Exposes the new `omitAttributeSpacing` option from `babel-plugin-jsx-dom-expressions`.
When set to `false`, the compiler emits a space between attributes in template strings
(`<svg width="12" height="13">` instead of `<svg width="12"height="13">`), producing
valid HTML for strict parsers (XML-based renderers, game-engine browser-likes, etc.).
Defaults to `true` to preserve existing behavior.
