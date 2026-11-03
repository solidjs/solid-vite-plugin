import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptedEncodings } from './node-entry/encoding.js';
import { precompressDir, precompressFile } from './precompress.js';

const root = mkdtempSync(path.join(tmpdir(), 'solid-node-compress-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Repetitive enough to compress well, large enough to clear the 1 KiB floor.
const bigJs = Array.from({ length: 200 }, (_, i) => `export const value${i} = ${i};`).join('\n');

describe('acceptedEncodings', () => {
  it('prefers br, then gzip', () => {
    expect(acceptedEncodings('gzip, deflate, br').map((e) => e.name)).toEqual(['br', 'gzip']);
  });
  it('accepts nothing without a header or with identity only', () => {
    expect(acceptedEncodings(undefined)).toEqual([]);
    expect(acceptedEncodings('identity')).toEqual([]);
  });
  it('honors q-values and q=0 refusals', () => {
    expect(acceptedEncodings('br;q=0, gzip').map((e) => e.name)).toEqual(['gzip']);
    expect(acceptedEncodings('br;q=0.5, gzip;q=0.8').map((e) => e.name)).toEqual(['gzip', 'br']);
    expect(acceptedEncodings('GZIP ; Q=1').map((e) => e.name)).toEqual(['gzip']);
  });
  it('keeps identity when the header ranks it above a coding', () => {
    expect(acceptedEncodings('identity;q=1, br;q=0.1')).toEqual([]);
    expect(acceptedEncodings('identity;q=0.5, br, gzip;q=0.1').map((e) => e.name)).toEqual(['br']);
    expect(acceptedEncodings('identity, br').map((e) => e.name)).toEqual(['br']);
  });
  it('treats * as every coding the header does not name', () => {
    expect(acceptedEncodings('*').map((e) => e.name)).toEqual(['br', 'gzip']);
    expect(acceptedEncodings('br;q=0, *').map((e) => e.name)).toEqual(['gzip']);
  });
});

describe('precompressDir', () => {
  const dir = path.join(root, 'build');
  beforeAll(async () => {
    mkdirSync(path.join(dir, 'assets'), { recursive: true });
    mkdirSync(path.join(dir, '.vite'), { recursive: true });
    writeFileSync(path.join(dir, 'assets/app.js'), bigJs);
    writeFileSync(path.join(dir, 'assets/tiny.css'), 'body{margin:0}');
    writeFileSync(path.join(dir, 'assets/tiny.css.br'), 'stale');
    writeFileSync(path.join(dir, 'assets/image.png'), Buffer.alloc(4096));
    writeFileSync(path.join(dir, '.vite/manifest.json'), JSON.stringify({ bigJs }));
    await precompressDir(dir);
  });

  it('writes br and gzip variants that decode to the file', () => {
    const file = path.join(dir, 'assets/app.js');
    expect(brotliDecompressSync(readFileSync(file + '.br')).toString()).toBe(bigJs);
    expect(gunzipSync(readFileSync(file + '.gz')).toString()).toBe(bigJs);
  });
  it('skips files under the floor and removes their stale variants', () => {
    expect(existsSync(path.join(dir, 'assets/tiny.css.br'))).toBe(false);
    expect(existsSync(path.join(dir, 'assets/tiny.css.gz'))).toBe(false);
  });
  it('skips binary formats and dot directories', () => {
    expect(existsSync(path.join(dir, 'assets/image.png.br'))).toBe(false);
    expect(existsSync(path.join(dir, '.vite/manifest.json.br'))).toBe(false);
  });
  it('precompressFile handles a single late file (the client-mode shell)', async () => {
    const shell = path.join(dir, 'index.html');
    writeFileSync(shell, `<!doctype html><script>${bigJs}</script>`);
    await precompressFile(shell);
    expect(existsSync(shell + '.br')).toBe(true);
    expect(existsSync(shell + '.gz')).toBe(true);
  });
});

type Reply = { status: number; headers: Record<string, unknown>; body: Buffer };

// The entry as it ships: the runtime bundle behind the generated config
// header, beside a stub server.js (see nodeEntryCode in src/ssr/index.ts).
async function emitNodeEntry(serverDir: string, clientDir: string, precompressed: boolean) {
  const bundle = await rolldown({
    input: fileURLToPath(new URL('./node-entry/index.ts', import.meta.url)),
    platform: 'node',
    external: (id) => id === './server.js' || id.startsWith('node:'),
    makeAbsoluteExternalsRelative: false,
  });
  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();
  const config = {
    clientDir: path.relative(serverDir, clientDir),
    assetsDir: 'assets',
    base: '/',
    spa: false,
    entry: 'node.js',
    precompressed,
  };
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(
    path.join(serverDir, 'server.js'),
    `export const handleRequest = async () => new Response('from handler', { status: 404 });\n`,
  );
  const file = path.join(serverDir, 'node.js');
  writeFileSync(file, `const SOLID_NODE_CONFIG = ${JSON.stringify(config)};\n${output[0].code}`);
  return file;
}

async function startListener(clientDir: string, precompressed: boolean) {
  const serverDir = path.join(root, precompressed ? 'server' : 'server-plain');
  const entry = await emitNodeEntry(serverDir, clientDir, precompressed);
  const { createListener } = await import(/* @vite-ignore */ pathToFileURL(entry).href);
  const server = createServer(createListener());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const get = (pathname: string, headers: Record<string, string> = {}, method = 'GET') =>
    new Promise<Reply>((resolve, reject) => {
      // http.request never decodes, so the bytes on the wire are what we see.
      const req = request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      });
      req.on('error', reject);
      req.end();
    });
  return { server, get };
}

describe('node entry static negotiation', () => {
  const clientDir = path.join(root, 'client');
  let server: Server;
  let get: Awaited<ReturnType<typeof startListener>>['get'];
  beforeAll(async () => {
    mkdirSync(path.join(clientDir, 'assets'), { recursive: true });
    writeFileSync(path.join(clientDir, 'assets/app.js'), bigJs);
    writeFileSync(path.join(clientDir, 'assets/gzip-only.js'), bigJs);
    writeFileSync(path.join(clientDir, 'assets/small.js'), 'export {};');
    writeFileSync(path.join(clientDir, 'assets/image.png'), Buffer.alloc(4096));
    await precompressDir(clientDir);
    rmSync(path.join(clientDir, 'assets/gzip-only.js.br'));
    // A variant beside a binary file is never consulted.
    writeFileSync(path.join(clientDir, 'assets/image.png.br'), 'not served');
    ({ server, get } = await startListener(clientDir, true));
  });
  afterAll(() => server?.close());

  const brSize = () => readFileSync(path.join(clientDir, 'assets/app.js.br')).length;

  it('serves br when accepted', async () => {
    const res = await get('/assets/app.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers['vary']).toBe('Accept-Encoding');
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(Number(res.headers['content-length'])).toBe(brSize());
    expect(brotliDecompressSync(res.body).toString()).toBe(bigJs);
  });

  it('serves gzip when br is not accepted', async () => {
    const res = await get('/assets/app.js', { 'accept-encoding': 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toBe('Accept-Encoding');
    expect(Number(res.headers['content-length'])).toBe(res.body.length);
    expect(gunzipSync(res.body).toString()).toBe(bigJs);
  });

  it('serves the file as is without Accept-Encoding or with identity', async () => {
    for (const headers of [
      {},
      { 'accept-encoding': 'identity' },
      { 'accept-encoding': 'br;q=0, gzip;q=0' },
    ]) {
      const res = await get('/assets/app.js', headers);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers['vary']).toBe('Accept-Encoding');
      expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(bigJs));
      expect(res.body.toString()).toBe(bigJs);
    }
  });

  it('answers HEAD with the variant headers and no body', async () => {
    const res = await get('/assets/app.js', { 'accept-encoding': 'br' }, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    expect(Number(res.headers['content-length'])).toBe(brSize());
    expect(res.body.length).toBe(0);
  });

  it('falls back to the next accepted coding when a variant is missing', async () => {
    const res = await get('/assets/gzip-only.js', { 'accept-encoding': 'br, gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(res.body).toString()).toBe(bigJs);
  });

  it('serves files without variants as is', async () => {
    const small = await get('/assets/small.js', { 'accept-encoding': 'br, gzip' });
    expect(small.headers['content-encoding']).toBeUndefined();
    expect(small.body.toString()).toBe('export {};');
    const png = await get('/assets/image.png', { 'accept-encoding': 'br' });
    expect(png.headers['content-encoding']).toBeUndefined();
    expect(png.headers['vary']).toBeUndefined();
    expect(png.body.length).toBe(4096);
  });

  it('leaves handler responses alone', async () => {
    const res = await get('/missing', { 'accept-encoding': 'br' });
    expect(res.status).toBe(404);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString()).toBe('from handler');
  });

  it('ignores variants when the build did not precompress', async () => {
    const plain = await startListener(clientDir, false);
    try {
      const res = await plain.get('/assets/app.js', { 'accept-encoding': 'br' });
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers['vary']).toBeUndefined();
      expect(res.body.toString()).toBe(bigJs);
    } finally {
      plain.server.close();
    }
  });
});
