import { hydrate } from '@solidjs/web';
// Regression coverage for #342: Solid's frames client lazily imports the
// serialization decoder (`loadCodec()` → import('@solidjs/web/serialization/
// decode')), and a static import of that same decoder anywhere in the client
// graph merges it into the entry chunk — the entry then lists itself under
// its own dynamicImports. The plugin's lazy-entry normalization must keep
// this chunk flagged `isEntry` (it is the configured input) rather than
// reclassify it as an emitted lazy facade. Both are referenced, not called
// (Vite drops entry exports, so a global keeps the graph edges alive without
// affecting the page).
import { getFrameHost } from '@solidjs/web/frames/client';
import { createJSONDeserializer } from '@solidjs/web/serialization/decode';
import App from './App';
import './entryClient.css';

(window as any).__decoderProbe = { getFrameHost, createJSONDeserializer };

hydrate(() => <App url={location.pathname} />, document);
