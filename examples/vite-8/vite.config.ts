import { defineConfig } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

export default defineConfig({
  plugins: [
    {
      name: 'simulate-eliminated-lazy-importer',
      enforce: 'pre',
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk') {
            output.dynamicImports = [];
          }
        }
      },
    },
    // Rides the native compiler default.
    solidPlugin({ ssr: true }),
    {
      name: 'assert-single-entry',
      enforce: 'post',
      generateBundle(_options, bundle) {
        const entries = Object.values(bundle).filter(
          (output) => output.type === 'chunk' && output.isEntry,
        );
        if (entries.length !== 1) {
          throw new Error(
            `Expected one entry chunk, received: ${entries
              .map((entry) => entry.fileName)
              .join(', ')}`,
          );
        }
      },
    },
  ],
});
