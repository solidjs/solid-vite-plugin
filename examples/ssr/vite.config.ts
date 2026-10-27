import { defineConfig } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

export default defineConfig({
  plugins: [solidPlugin({ compiler: 'native', ssr: true })],
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
