import { defineConfig } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

export default defineConfig({
  plugins: [solidPlugin({ compiler: 'native', ssr: true })],
  // TEMPORARY: the workspace links solid-js to a sibling worktree (see
  // pnpm-workspace.yaml), which stops Vite from externalizing it in SSR and
  // splits it into two instances (bundled app copy vs the one the external
  // @solidjs/web loads). Force it external to match published-package
  // behavior; remove together with the workspace link.
  ssr: { external: ['solid-js'] },
  build: {
    manifest: true,
    rollupOptions: {
      input: 'src/entry-client.tsx',
      output: {
        // Group route modules into one shared chunk (no facade) to exercise
        // manifest aliasing for dynamically-imported modules in shared chunks.
        manualChunks: (id) => (id.includes('/routes/') ? 'routes' : undefined),
      },
    },
  },
});
