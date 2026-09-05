// Per-request render-mode policy for the render-mode e2e mode
// (SSR_RENDER_MODE=module wires it through `start.renderMode` in
// vite.config.ts). Server-only: only the generated handler imports it. The
// recipe from the README: serve one complete, settled document to clients
// that will never run the streaming swap scripts — crawlers and an explicit
// `?nojs` opt-in — and stream for everyone else. The `x-render-mode` header
// is the test's deterministic switch. Runs inside the request scope after
// the middleware chain (`event.locals` is decorated by then), and may be
// async — the handler awaits it before the render starts.
import type { RequestEvent } from '@solidjs/web';

const CRAWLER_UA = /Googlebot|bingbot|DuckDuckBot|Slurp|Baiduspider|YandexBot/i;

export default function renderMode(event: RequestEvent): 'stream' | 'async' {
  const { request } = event;
  const header = request.headers.get('x-render-mode');
  if (header === 'stream' || header === 'async') return header;
  if (new URL(request.url).searchParams.has('nojs')) return 'async';
  if (CRAWLER_UA.test(request.headers.get('user-agent') || '')) return 'async';
  return 'stream';
}
