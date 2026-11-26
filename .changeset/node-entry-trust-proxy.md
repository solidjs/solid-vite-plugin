---
'@solidjs/vite-plugin': patch
---

The emitted `node.js` entry can take the request scheme from a trusted
proxy's `X-Forwarded-Proto`. Set `TRUST_PROXY` (`loopback`, a comma-separated
list of peer addresses, or `true`) or pass `trustProxy` to `createListener` or
`serve`. Behind a TLS-terminating proxy, `request.url` was always `http://`,
so the server-function same-origin check refused every protected call from
browsers that send no `Sec-Fetch-Site`, such as Safari before 16.4
(solidjs/solid#5196).
