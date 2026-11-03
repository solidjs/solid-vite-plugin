// Shared by the build-time precompression and the Node entry's static handler.

/** Text-like extensions; images and woff2 are compressed already, maps only reach devtools. */
export const PRECOMPRESSIBLE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.json',
  '.svg',
  '.txt',
  '.xml',
  '.webmanifest',
  '.wasm',
  '.ico',
  '.ttf',
  '.otf',
]);

/** Files smaller than this are served as they are. */
export const PRECOMPRESS_MIN_BYTES = 1024;

/** Content-Encoding token and file suffix, in server preference order. */
export const ENCODINGS = [
  { name: 'br', suffix: '.br' },
  { name: 'gzip', suffix: '.gz' },
] as const;

export type Encoding = (typeof ENCODINGS)[number];

/** Encodings an `Accept-Encoding` header prefers over identity, by q-value, br first on ties. */
export function acceptedEncodings(header: string | string[] | undefined): Encoding[] {
  if (!header) return [];
  const weights = new Map<string, number>();
  for (const part of String(header).split(',')) {
    const [token, ...params] = part.split(';');
    const name = token.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split('=');
      if (key.trim().toLowerCase() === 'q') q = Number(value);
    }
    weights.set(name, Number.isFinite(q) ? q : 0);
  }
  const wildcard = weights.get('*') ?? 0;
  const identity = weights.get('identity') ?? 0;
  const weightOf = (encoding: Encoding) => weights.get(encoding.name) ?? wildcard;
  return ENCODINGS.filter(
    (encoding) => weightOf(encoding) > 0 && weightOf(encoding) >= identity,
  ).sort((a, b) => weightOf(b) - weightOf(a));
}
