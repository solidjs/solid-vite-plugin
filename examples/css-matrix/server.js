import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';
const port = process.env.PORT || 3000;

function getClientEntry() {
  if (!isProduction) return '/src/entry-client.tsx';
  const manifest = JSON.parse(
    readFileSync(path.resolve(__dirname, 'dist/client/.vite/manifest.json'), 'utf-8'),
  );
  const entry = manifest['src/entry-client.tsx'];
  return '/' + entry.file;
}

async function start() {
  let vite;
  let devHeadInjection = '';

  const server = createHttpServer(async (req, res) => {
    const url = req.url || '/';

    try {
      if (!isProduction) {
        const handled = await new Promise((resolve) => {
          vite.middlewares(req, res, () => resolve(false));
        });
        if (handled !== false) return;
        if (!req.headers.accept?.includes('text/html')) {
          if (!res.headersSent) {
            res.statusCode = 404;
            res.end();
          }
          return;
        }
      }

      if (isProduction && url !== '/' && !url.startsWith('/api')) {
        const filePath = path.resolve(__dirname, 'dist/client' + url);
        try {
          const content = readFileSync(filePath);
          const ext = path.extname(url);
          const types = {
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.html': 'text/html',
            '.json': 'application/json',
          };
          res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
          res.end(content);
          return;
        } catch {
          // Fall through to SSR
        }
      }

      let render;
      if (!isProduction) {
        ({ render } = await vite.environments.ssr.runner.import('/src/entry-server.tsx'));
      } else {
        ({ render } = await import('./dist/server/entry-server.js'));
      }

      const stream = render(url);
      const clientEntry = getClientEntry();

      res.setHeader('Content-Type', 'text/html');
      res.write('<!DOCTYPE html>');

      stream.pipe({
        write(chunk) {
          let html = chunk;
          if (!isProduction && html.includes('</head>')) {
            html = html.replace('</head>', devHeadInjection + '</head>');
          }
          if (isProduction && html.includes('/src/entry-client.tsx')) {
            html = html.replace('/src/entry-client.tsx', clientEntry);
          }
          return res.write(html);
        },
        end() {
          res.end();
        },
      });
    } catch (e) {
      console.error(e);
      res.statusCode = 500;
      res.end(e.message);
    }
  });

  if (!isProduction) {
    const { createServer } = await import('vite');
    vite = await createServer({
      server: { middlewareMode: true, hmr: { server } },
      appType: 'custom',
    });
    // devStylePatch reconciles SSR'd <style data-vite-dev-id> tags with
    // Vite's HMR client (virtual-id rewriting + twin dedupe). Must be
    // inline in <head> before any module script.
    const { devStylePatch } = await import('@solidjs/vite-plugin');
    devHeadInjection =
      `<script>${devStylePatch}</script>` +
      '<script type="module" src="/@vite/client"></script>';
  }

  server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

start();
