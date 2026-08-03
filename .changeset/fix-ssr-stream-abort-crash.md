---
"vite-plugin-solid": patch
---

The generated SSR handler no longer crashes the server process when a client aborts a streaming response mid-flight. Enqueueing into a closed `ReadableStream` controller throws, and a streamed fragment can land seconds after the shell — an abort (page reload, navigation away) during that window took down the whole Node process with `ERR_INVALID_STATE`. Writes are now dropped once the stream closes or is cancelled.
