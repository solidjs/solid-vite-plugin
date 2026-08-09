import type { Plugin } from 'vite';

const VIRTUAL_ID = '\0vite-plugin-solid:boundary-modules';

/**
 * `server-only` and `client-only` marker modules: importing `server-only`
 * from a module bundled for the client fails the build at resolve time with
 * a descriptive error (and vice versa for `client-only`); in the allowed
 * environment the marker resolves to an empty module.
 *
 * Server-only code pulled into a client bundle otherwise ships silently and
 * crashes at runtime (in hydrating apps, typically as a cryptic hydration
 * failure far from the real cause) — the marker turns that into a build
 * error naming the importer.
 *
 * Always on (`enforce: 'pre'`), so the bare specifiers are claimed by this
 * plugin even when React's `server-only`/`client-only` npm packages are
 * installed — the environment semantics are the same, and claiming them
 * keeps the behavior deterministic and the errors identifiable as ours.
 */
export function boundaryModules(): Plugin {
  return {
    name: 'solid:boundary-modules',
    enforce: 'pre',
    resolveId(id, importer, options) {
      // The dep scanner (`vite:dep-scan`) crawls the client entries' RAW
      // import graph — no directive transforms have run, so it walks
      // straight through 'use server' modules into genuinely server-only
      // code. That graph is legal once transforms split it, so the guard
      // must not fire on the scan pass (`options.scan`, the flag Vite's
      // scanner sets on plugin-container resolves in v6/7 and the rolldown
      // scanner in v8). Still claim the specifier: resolving to the empty
      // virtual module keeps the scanner from chasing `server-only` /
      // `client-only` as missing bare dependencies, which would abort the
      // scan all the same. Real dev/build module graphs resolve without
      // the flag and stay fully guarded.
      const scan = !!(options as { scan?: boolean } | undefined)?.scan;
      if (id === 'server-only') {
        if (!options?.ssr && !scan)
          this.error(
            `[vite-plugin-solid] Attempt to import 'server-only' in a client module: ${importer}. ` +
              `Code that uses this module must run only on the server — make sure it is only ` +
              `imported by server code (e.g. a server entry, a "use server" module, or code ` +
              `reached exclusively from them).`,
          );
      } else if (id === 'client-only') {
        if (options?.ssr && !scan)
          this.error(
            `[vite-plugin-solid] Attempt to import 'client-only' in a server module: ${importer}. ` +
              `Code that uses this module must run only in the browser — make sure it is only ` +
              `imported by client code (e.g. behind a client-only lazy boundary).`,
          );
      } else {
        return null;
      }
      return VIRTUAL_ID;
    },
    load(id) {
      if (id === VIRTUAL_ID) return 'export {}';
    },
  };
}
