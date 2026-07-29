// Ambient declarations for the `server-only` / `client-only` boundary
// markers claimed by vite-plugin-solid. Reference from an env.d.ts:
//   /// <reference types="vite-plugin-solid/boundary-modules" />

/**
 * Import `server-only` to ensure this module is never bundled for the
 * client. Importing it in a client-bundled module fails the build.
 */
declare module "server-only" {}

/**
 * Import `client-only` to ensure this module is never bundled for the
 * server. Importing it in a server-bundled module fails the build.
 */
declare module "client-only" {}
