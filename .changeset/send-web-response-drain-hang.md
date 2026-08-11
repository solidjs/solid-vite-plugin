---
'vite-plugin-solid': patch
---

`sendWebResponse` no longer hangs forever when a client disconnects during backpressure. The write loop's `'drain'` wait had no other way to settle, but a response whose client already went away never emits `'drain'` — so every streamed SSR response aborted mid-stream (closed tab, slow mobile client) parked the promise chain, the body reader, and the Response object permanently, accumulating leaks over a turnkey dev/preview session. The backpressure wait now also settles on `'close'`/`'error'` and the loop bails out early once the response is destroyed, letting the existing close handler's reader cancellation finish cleanup.
