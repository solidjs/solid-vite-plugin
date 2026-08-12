---
"@solidjs/vite-plugin": patch
---

Inject the server-component bootstrap at the top of `<head>`, before the hydration data script. It was appended at `</head>`, but the generated document renders `<HydrationScript />` inside `<head>`, so the bootstrap always landed *after* the payload it has to precede. The render plugin serializes a server component's placeholder as `self._$SC.r(id)`, so any document whose hydration payload carried a frame reference threw `Cannot read properties of undefined (reading 'r')` on boot — which aborted hydration, leaving the whole page inert: no client state, no interactivity, and no navigation, on an otherwise perfectly server-rendered document. The `examples/turnkey` app's own payload happens not to carry such a reference, so its "no page errors" check never caught this; the document assertion now verifies the ordering rather than mere presence.
