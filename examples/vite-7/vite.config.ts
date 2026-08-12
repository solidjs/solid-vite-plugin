import { defineConfig } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

export default defineConfig({
  plugins: [
    // Explicit babel mode: keeps CI coverage of the Babel JSX backend now
    // that the plugin defaults to the native compiler.
    solidPlugin({ compiler: 'babel' }),
  ],
});