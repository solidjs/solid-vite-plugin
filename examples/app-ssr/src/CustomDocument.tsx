// Document-shell escape hatch, activated by SSR_DOCUMENT in vite.config.ts
// (named CustomDocument so the src/Document.* convention doesn't pick it up
// in the default zero-config run). A document component receives the app as
// children and must render the full <html> including <HydrationScript />.
import type { ParentProps } from 'solid-js';
import { HydrationScript } from '@solidjs/web';

export default function CustomDocument(props: ParentProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Custom Document</title>
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
