import { defineConfig, type Plugin } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

// Records what a downstream plugin sees in the client bundle after the solid
// plugin's generateBundle (post order, like TanStack Start's manifest
// capture): entry classification per chunk, written next to Vite's manifest
// for test/run.mjs to assert against (#269/#271/#342).
function bundleChunksProbe(): Plugin {
  return {
    name: 'css-matrix:bundle-chunks-probe',
    apply: 'build',
    enforce: 'post',
    generateBundle(_outputOptions, bundle) {
      if (this.environment.config.consumer !== 'client') return;
      const chunks: Record<string, unknown> = {};
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue;
        chunks[fileName] = {
          facadeModuleId: output.facadeModuleId,
          isEntry: output.isEntry,
          isDynamicEntry: output.isDynamicEntry,
          dynamicImports: output.dynamicImports,
        };
      }
      this.emitFile({
        type: 'asset',
        fileName: '.vite/bundle-chunks.json',
        source: JSON.stringify(chunks, null, 2),
      });
    },
  };
}

// Virtual CSS modules (CSS with no backing file, e.g. generated styles).
// Handles query suffixes (?direct, ?inline, ?url) the way real plugins must:
// Vite's css pipeline re-requests the module with queries appended.
const VIRTUAL_CSS: Record<string, string> = {
  'virtual:route.css': '.virtual-probe { color: rgb(50, 60, 70); }',
  'virtual:lazy.css': '.lazy-virtual-probe { color: rgb(75, 85, 95); }',
};

function virtualCssPlugin(): Plugin {
  return {
    name: 'css-matrix:virtual-css',
    resolveId(id) {
      const [base, query] = id.split('?');
      if (base in VIRTUAL_CSS) return '\0' + base + (query ? '?' + query : '');
    },
    load(id) {
      const [base] = id.split('?');
      if (base.startsWith('\0') && base.slice(1) in VIRTUAL_CSS) {
        return VIRTUAL_CSS[base.slice(1)];
      }
    },
  };
}

export default defineConfig({
  plugins: [
    virtualCssPlugin(),
    solidPlugin({ compiler: 'native', ssr: true }),
    bundleChunksProbe(),
  ],
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
        // Force both shared-chunk lazy routes and their common dep into one
        // chunk with no facade — the Rollup behavior that historically broke
        // manifest lookups for lazy modules (Katja's SharedChunk case). The
        // plugin's moduleParsed facade emission must keep them resolvable.
        manualChunks: (id) =>
          id.includes('/routes/Shared') || id.includes('/shared/') ? 'shared' : undefined,
      },
    },
  },
});
