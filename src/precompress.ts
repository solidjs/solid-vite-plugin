// Client build variants for `start.nodeServer`, like Nitro's `compressPublicAssets`.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import {
  ENCODINGS,
  PRECOMPRESS_MIN_BYTES,
  PRECOMPRESSIBLE_EXTENSIONS,
  type Encoding,
} from './node-entry/encoding.js';

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

function compress(encoding: Encoding, source: Buffer): Promise<Buffer> {
  if (encoding.name === 'br') {
    return brotliAsync(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    });
  }
  return gzipAsync(source, { level: constants.Z_BEST_COMPRESSION });
}

/** Writes the variants worth having and removes stale ones, which the server would prefer. */
export async function precompressFile(file: string): Promise<void> {
  const source = await readFile(file);
  await Promise.all(
    ENCODINGS.map(async (encoding) => {
      const variant = file + encoding.suffix;
      const compressed =
        source.length >= PRECOMPRESS_MIN_BYTES ? await compress(encoding, source) : null;
      if (compressed && compressed.length < source.length) {
        await writeFile(variant, compressed);
      } else {
        await rm(variant, { force: true });
      }
    }),
  );
}

/** Precompresses every eligible file under `dir`, skipping dot segments (.vite/). */
export async function precompressDir(dir: string): Promise<void> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() && PRECOMPRESSIBLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
    )
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) =>
      path
        .relative(dir, file)
        .split(path.sep)
        .every((segment) => !segment.startsWith('.')),
    );
  let next = 0;
  const worker = async () => {
    while (next < files.length) await precompressFile(files[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(files.length, availableParallelism()) }, worker));
}
