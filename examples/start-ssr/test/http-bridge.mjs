// Node↔web bridge hardening e2e, run against the real start-mode dev
// middleware over TLS. Vite's dev server uses
// `http2.createSecureServer({ allowHTTP1: true })` whenever `server.https`
// is set without a proxy, so under https the plugin's middlewares receive
// Http2ServerRequests — this suite boots exactly that server shape
// (in-process, with the middleware chain enabled so /api/* surfaces
// dispatch) and asserts:
//   - HTTP/2 requests work at all: h2 headers carry :method/:path/
//     :authority/:scheme pseudo-headers that are illegal Headers names
//     (Headers#append throws) and no Host header — every h2 request used to
//     500 (`TypeError: ":path" is an invalid header name`),
//   - a full SSR page render and a POST body round-trip survive h2,
//   - protocol/authority derivation: request.url is https:// with the
//     :authority host over h2, and https:// over the h1-on-TLS fallback
//     (used to be hardcoded http://),
//   - abort propagation: a client disconnect mid-stream fires the
//     request's AbortSignal (read back off a process global the in-process
//     SSR middleware records on — see /api/abort-probe in src/middleware.ts),
//   - HEAD short-circuit: a HEAD to a never-ending streamed response
//     answers immediately with no body and cancels the body stream (used to
//     pump forever into node's discarded HEAD writes).
//
// Techniques under test are reimplemented from srvx's Node adapter
// (github.com/h3js/srvx) — see src/http.ts.
//
// Requires the plugin built (pnpm build at the repo root) and openssl (for
// a throwaway self-signed cert). No browser.
// Usage: node test/http-bridge.mjs

import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http2 from 'node:http2';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The middleware chain fronts every dispatch path — the /api/* bridge
// surfaces need it. Must be set before the config file is evaluated.
process.env.SSR_MIDDLEWARE = '1';
const { createServer } = await import('vite');

const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [http-bridge] ${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Throwaway self-signed cert
// ---------------------------------------------------------------------------
const certDir = mkdtempSync(path.join(os.tmpdir(), 'solid-http-bridge-'));
execSync(
  'openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj /CN=localhost',
  { cwd: certDir, stdio: 'ignore' },
);

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
function h2Request(origin, { path: reqPath, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(origin, { rejectUnauthorized: false });
    client.on('error', reject);
    const stream = client.request({
      ':path': reqPath,
      ':method': method,
      // The SSR dev middleware only treats requests accepting HTML as page
      // requests; API surfaces are reached through the middleware chain.
      accept: reqPath === '/' ? 'text/html' : '*/*',
      ...(body ? { 'content-type': 'application/json' } : {}),
    });
    let status;
    const chunks = [];
    stream.on('response', (headers) => {
      status = headers[':status'];
    });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('close', () => {
      client.close();
      resolve({ status, body: Buffer.concat(chunks).toString() });
    });
    stream.end(body);
  });
}

function h1Request(origin, reqPath, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(reqPath, origin), { method, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.()),
  ]);
}

async function poll(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// The dev server: root the start-ssr app, TLS on — exactly Vite's
// `server.https` shape (http2 secure server with h1 fallback).
// ---------------------------------------------------------------------------
const server = await createServer({
  root: exampleDir,
  logLevel: 'silent',
  server: {
    port: 0,
    https: {
      key: readFileSync(path.join(certDir, 'key.pem')),
      cert: readFileSync(path.join(certDir, 'cert.pem')),
    },
  },
});
await server.listen();

let exitCode = 0;
try {
  const origin = new URL(server.resolvedUrls.local[0]).origin;
  record('dev server is https', origin.startsWith('https://'), origin);

  // ---- HTTP/2 through the dev middleware ----------------------------------
  // Pseudo-headers used to crash webRequestFromNode on every h2 request.
  const page = await withTimeout(h2Request(origin, { path: '/' }), 15000, 'h2 page');
  record(
    'h2 SSR page renders (pseudo-headers skipped)',
    page.status === 200 && page.body.includes('SSR Start Mode'),
    `status ${page.status}: ${page.body.slice(0, 200)}`,
  );

  const info = await withTimeout(h2Request(origin, { path: '/api/request-info' }), 10000, 'h2 info');
  let infoJson = {};
  try {
    infoJson = JSON.parse(info.body);
  } catch {}
  record('h2 request reaches the middleware chain', info.status === 200, `status ${info.status}`);
  record(
    'h2 request really travelled HTTP/2',
    infoJson.httpVersion === '2.0',
    `httpVersion ${infoJson.httpVersion}`,
  );
  record(
    'h2 request.url derives https + :authority host',
    infoJson.url === `${origin}/api/request-info`,
    `url ${infoJson.url}, expected ${origin}/api/request-info`,
  );

  const echoed = await withTimeout(
    h2Request(origin, { path: '/api/echo', method: 'POST', body: JSON.stringify({ over: 'h2' }) }),
    10000,
    'h2 echo',
  );
  let echoJson = {};
  try {
    echoJson = JSON.parse(echoed.body);
  } catch {}
  record(
    'h2 POST body round-trips the bridge',
    echoed.status === 200 && echoJson.echoed?.over === 'h2',
    `status ${echoed.status}: ${echoed.body.slice(0, 200)}`,
  );

  // ---- Protocol on the h1-over-TLS fallback --------------------------------
  const h1info = await withTimeout(h1Request(origin, '/api/request-info'), 10000, 'h1 info');
  let h1json = {};
  try {
    h1json = JSON.parse(h1info.body);
  } catch {}
  record(
    'h1-over-TLS request.url says https (socket.encrypted)',
    h1json.httpVersion === '1.1' && h1json.url === `${origin}/api/request-info`,
    `httpVersion ${h1json.httpVersion}, url ${h1json.url}`,
  );

  // ---- Abort propagation ----------------------------------------------------
  // The middleware runs in-process (ssrLoadModule), so the probe global it
  // records on is this very globalThis.
  const probe = () => globalThis.__solidBridgeProbe ?? { aborts: 0, cancels: 0 };
  {
    const abortsBefore = probe().aborts;
    await new Promise((resolve, reject) => {
      const req = https.request(new URL('/api/abort-probe', origin), { rejectUnauthorized: false }, (res) => {
        // First chunk proves the stream is live; then the client goes away.
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', reject);
      req.end();
    });
    const aborted = await poll(() => probe().aborts > abortsBefore);
    record(
      'client disconnect fires request.signal (abort propagation)',
      aborted,
      `aborts ${probe().aborts}, was ${abortsBefore}`,
    );
  }

  // ---- HEAD short-circuit ---------------------------------------------------
  // Without it, HEAD to the endless stream pumps forever into node's
  // discarded writes and this request never ends.
  {
    const cancelsBefore = probe().cancels;
    const head = await withTimeout(
      h1Request(origin, '/api/abort-probe', { method: 'HEAD' }),
      5000,
      'HEAD short-circuit',
    );
    record(
      'HEAD answers immediately with no body',
      head.status === 200 && head.body === '',
      `status ${head.status}, body ${JSON.stringify(head.body.slice(0, 40))}`,
    );
    const cancelled = await poll(() => probe().cancels > cancelsBefore);
    record('HEAD cancels the body stream', cancelled, `cancels ${probe().cancels}, was ${cancelsBefore}`);
  }
} catch (error) {
  record('suite completed without unexpected errors', false, error?.stack || String(error));
} finally {
  await server.close();
  rmSync(certDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} http-bridge assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name} — ${f.detail}`);
  exitCode = 1;
}
process.exit(exitCode);
