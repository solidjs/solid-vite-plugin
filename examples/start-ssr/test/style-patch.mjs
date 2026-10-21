// Unit test for the dev style patch (`devStylePatch`), run in jsdom:
//   - two SSR'd twins (both `data-asset`, e.g. a stylesheet shared by the
//     entry graph and a lazy component): the later one is dropped, so the
//     sheet keeps its first position, as in production (#425),
//   - an SSR'd tag and a Vite-owned twin: the SSR'd one is dropped, whatever
//     the order, so HMR keeps updating the tag that stays.
//
// No dev server, no browser. Requires the plugin built (pnpm build at the
// repo root). Usage: node test/style-patch.mjs

import { JSDOM } from 'jsdom';
import { devStylePatch } from '@solidjs/vite-plugin';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

async function setup() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
  });
  const { window } = dom;
  if (window.document.readyState === 'loading') {
    await new Promise((r) => window.document.addEventListener('DOMContentLoaded', r));
  }
  window.eval(devStylePatch);
  return window;
}

function style(window, id, { ssr }) {
  const el = window.document.createElement('style');
  if (ssr) el.setAttribute('data-asset', id);
  el.setAttribute('data-vite-dev-id', id);
  el.textContent = `/* ${id} */`;
  return el;
}

// Let the patch's MutationObserver callbacks run.
const flush = () => new Promise((r) => setTimeout(r, 0));

function order(window) {
  return [...window.document.querySelectorAll('style[data-vite-dev-id]')].map(
    (el) =>
      el.getAttribute('data-vite-dev-id') + (el.hasAttribute('data-asset') ? ':ssr' : ':vite'),
  );
}

// ---- two SSR'd twins arriving one after another (streamed shell) ----------
{
  const window = await setup();
  const head = window.document.head;
  head.append(style(window, '/src/button.css', { ssr: true }));
  await flush();
  head.append(style(window, '/src/page.css', { ssr: true }));
  await flush();
  head.append(style(window, '/src/button.css', { ssr: true }));
  await flush();
  const got = order(window).join(', ');
  record(
    'streamed SSR twins: the later one is dropped',
    got === '/src/button.css:ssr, /src/page.css:ssr',
    got,
  );
}

// ---- two SSR'd twins arriving in the same mutation batch -------------------
{
  const window = await setup();
  window.document.head.append(
    style(window, '/src/button.css', { ssr: true }),
    style(window, '/src/page.css', { ssr: true }),
    style(window, '/src/button.css', { ssr: true }),
  );
  await flush();
  const got = order(window).join(', ');
  record(
    'batched SSR twins: the later one is dropped, the first one stays',
    got === '/src/button.css:ssr, /src/page.css:ssr',
    got,
  );
}

// ---- SSR'd tag, then a Vite-owned twin: the SSR'd one is dropped ----------
{
  const window = await setup();
  const head = window.document.head;
  head.append(style(window, '/src/a.css', { ssr: true }));
  await flush();
  head.append(style(window, '/src/a.css', { ssr: false }));
  await flush();
  const got = order(window).join(', ');
  record('SSR then Vite twin: the Vite-owned tag stays', got === '/src/a.css:vite', got);
}

// ---- Vite-owned tag, then an SSR'd twin: the SSR'd one is dropped ---------
{
  const window = await setup();
  const head = window.document.head;
  head.append(style(window, '/src/a.css', { ssr: false }));
  await flush();
  head.append(style(window, '/src/a.css', { ssr: true }));
  await flush();
  const got = order(window).join(', ');
  record('Vite then SSR twin: the Vite-owned tag stays', got === '/src/a.css:vite', got);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name} — ${f.detail}`);
  process.exit(1);
}
