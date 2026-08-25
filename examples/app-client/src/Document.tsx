import { HydrationScript } from '@solidjs/web';

// The document shell, shared by both modes (the flip story): it carries
// <HydrationScript /> for `ssr: true`, and in client mode the plugin strips
// the event-capture script from the served/prerendered shell — the suite
// asserts no _$HY leaks into client-mode HTML while flip-mode hydration
// still works from this same file.
export default function Document(props) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>App Client</title>
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
