import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

// Turnkey typed env: `start.env` is left unset here so the suite covers the
// convention — env.ts at the project root is probed and picked up with zero
// config. No loadEnv one-liner either: the plugin folds the .env files into
// process.env itself.
//
// Fixture knobs (all driven by test/run.mjs):
// - CLIENT_MODE=1 flips to turnkey client mode (same env layer; the build
//   output is a static dist/client).
// - ENV_APP overrides the app root: src/BadApp.tsx imports
//   virtual:env/server from the client graph (must fail the build with the
//   server-only error), src/LeakApp.tsx hard-codes the secret's literal
//   value (must trip the client-chunk leak scan).
// - ENV_SCHEMA points start.env at a fixture schema (explicit-path option):
//   env.fail.ts requires a variable no .env provides (validation failure),
//   env.badprefix.ts declares a client var without the VITE_ prefix
//   (config-time prefix error).
export default defineConfig({
  plugins: [
    solidPlugin({
      start: {
        middleware: './src/middleware.ts',
        ...(process.env.ENV_APP ? { app: process.env.ENV_APP } : {}),
        ...(process.env.ENV_SCHEMA ? { env: process.env.ENV_SCHEMA } : {}),
      },
      ssr: !process.env.CLIENT_MODE,
    }),
  ],
});
