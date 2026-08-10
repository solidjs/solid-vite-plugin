---
'vite-plugin-solid': patch
---

The dev-manifest bridge resolver no longer caches failed lookups. The convergence cache introduced for the nested-lazy render-pass fix stored the `null` a bridge failure resolves to, so one transient miss (dev server briefly unreachable, non-OK response) silently stripped that module's client assets — and its hydration preload entry — for the rest of the dev session. Only successful answers are cached now; failures keep logging loudly and stay retryable, while in-flight dedupe still hands retries of the same render pass a stable promise, so convergence is unaffected.
