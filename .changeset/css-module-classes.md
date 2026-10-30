---
'@solidjs/vite-plugin': patch
---

In builds, inline CSS module class names used directly in JSX attributes (`class={styles.button}`, template literals of them, named imports), so they compile into the element's template instead of a reactive effect. The stylesheet is kept even when every use was inlined.
