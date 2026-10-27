/**
 * Chrome Performance panel tracks, on by default under `vite dev`.
 *
 * `@solidjs/web/performance-tracks` paints Solid's records — re-runs,
 * interactions, holds, async flights, navigations, server-function calls —
 * as custom tracks in the Performance panel. It has to be enabled before
 * the app renders or hydrates for the first paint and the first
 * interaction to be on the timeline (and for the dev component wrapper to
 * capture each component's JSX site while an attribution engine is
 * installed), so the plugin injects a small virtual module that calls
 * `enablePerformanceTracks(<options>)` ahead of the client entry, the same
 * way the diagnostics bridge reaches the page:
 * - plain (index.html) apps: a `<script type="module">` prepended to
 *   `<head>` by `transformIndexHtml` (module scripts run in document order,
 *   so it evaluates before the app's own entry script);
 * - app mode: an import the generated client entry emits, or the
 *   authored client entry is given, ahead of every other import (see
 *   `src/ssr/index.ts`).
 *
 * Dev serve only, by decision: the tracks are a dev-server feature. Never
 * on `vite build` — not for `dev: true` builds, not for `observe` builds
 * (an observe app that wants tracks in production calls
 * `enablePerformanceTracks()` itself); never in test mode (vitest runs a
 * dev serve) or preview.
 *
 * The server needs nothing from this plugin: the dev server runtime writes
 * the request's timed work as `Server-Timing` metrics on its own
 * (`solid-shell`, `solid-boundary`, `solid-invocation` — `@solidjs/web`'s
 * `server.ts`, the trace context appended before the head freezes), and the
 * adapter in the page reads them back onto the `Server` track.
 *
 * `@solidjs/web` is the app's peer: the runtime import always resolves to
 * the app's own copy (the resolveId assist below), so the tracks share the
 * `@solidjs/signals` core the app renders with.
 */
import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';
import type { PerformanceTracksOptions } from '@solidjs/web/performance-tracks';
import { joinBase } from '../http.js';

export const PERFORMANCE_TRACKS_PACKAGE = '@solidjs/web/performance-tracks';
export const PERFORMANCE_TRACKS_CLIENT_ID = 'virtual:solid-performance-tracks';

/** The plugin option: `true`/omitted enables with defaults, an object passes options through, `false` opts out. */
export type PerformanceTracksOption = boolean | PerformanceTracksOptions;

/**
 * The options the injected module enables the tracks with, or `null` when
 * the option opts out. Omitted and `true` are the adapter's defaults.
 */
export function resolvePerformanceTracksOptions(
  option: PerformanceTracksOption | undefined,
): PerformanceTracksOptions | null {
  if (option === false) return null;
  if (option === true || option === undefined) return {};
  return option;
}

/**
 * Whether the app's `@solidjs/web` exports the `./performance-tracks`
 * subpath. The peer range (^2.0.0-rc.10) always has it, so this should be
 * unreachable — but an app pinned outside the range would otherwise get a
 * broken page (an unresolvable import in the entry) instead of a warning.
 * Located the way Vite resolves a bare package — `node_modules/@solidjs/web`
 * walking up from the root — and read off the manifest's `exports` map
 * directly, so no resolver condition (`node`, `browser`, `development`)
 * colours the answer. A package that can't be found at all is reported as
 * present: `@solidjs/web` is the runtime the app renders with, and its
 * absence is Vite's clear error to give, not this plugin's to guess at.
 */
export function detectPerformanceTracksSubpath(root: string): boolean {
  let dir = path.resolve(root);
  while (true) {
    const manifestPath = path.join(dir, 'node_modules', '@solidjs', 'web', 'package.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
          exports?: Record<string, unknown>;
        };
        return (
          !!manifest.exports &&
          Object.prototype.hasOwnProperty.call(manifest.exports, './performance-tracks')
        );
      } catch {
        return false;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return true;
    dir = parent;
  }
}

/**
 * The injected module. Options are plain data only (`minMs`, `rich`, and
 * `attribution`'s thresholds/levels — every field of `PerformanceTracksOptions`
 * is a number, boolean, string literal or a plain object of those), so they
 * serialize as JSON into the call. A second evaluation of this module (an
 * HMR re-import of the entry) joins the running instance: the adapter keeps
 * one painter per page.
 */
export function performanceTracksClientModuleCode(options: PerformanceTracksOptions): string {
  return [
    `import { enablePerformanceTracks } from '${PERFORMANCE_TRACKS_PACKAGE}';`,
    ``,
    `enablePerformanceTracks(${JSON.stringify(options)});`,
  ].join('\n');
}

export function solidPerformanceTracks(options: PerformanceTracksOptions): Plugin {
  let root = process.cwd();
  let base = '/';
  // Resolved at configResolved: the installed `@solidjs/web` must export
  // the subpath the injected module imports.
  let enabled = false;

  return {
    name: 'solid:performance-tracks',
    // Dev-serve only (see the module comment). Test mode excluded for the
    // same reason as the diagnostics surface: vitest runs a dev serve, and
    // an engine hold taken in test pages perturbs suites that never asked
    // for it.
    apply(_config, env) {
      return env.command === 'serve' && !env.isPreview && env.mode !== 'test';
    },

    configResolved(config) {
      root = config.root;
      base = config.base;
      enabled = detectPerformanceTracksSubpath(root);
      if (!enabled) {
        config.logger.warn(
          `[@solidjs/vite-plugin] the installed @solidjs/web does not export ${PERFORMANCE_TRACKS_PACKAGE} ` +
            '(added in 2.0.0-rc.10); the Chrome Performance panel tracks are not enabled. ' +
            'Update @solidjs/web, or set `performanceTracks: false` to silence this warning.',
        );
      }
    },

    // `@solidjs/web/performance-tracks` is already in `optimizeDeps.include`
    // under serve (the main plugin adds it alongside `solid-js/attribution`,
    // whether or not this module imports it), so the virtual module's import
    // — which reaches the page behind the scanner's back — is pre-bundled
    // in the first optimizer pass and shares the app's `@solidjs/signals`
    // core.
    async resolveId(source, importer) {
      if (source === PERFORMANCE_TRACKS_CLIENT_ID) {
        return { id: PERFORMANCE_TRACKS_CLIENT_ID, moduleSideEffects: true };
      }
      // The virtual module has no directory to resolve bare imports from;
      // resolve the app's `@solidjs/web` from the project root.
      if (importer === PERFORMANCE_TRACKS_CLIENT_ID && source === PERFORMANCE_TRACKS_PACKAGE) {
        return this.resolve(source, path.resolve(root, 'index.html'), { skipSelf: true });
      }
      return null;
    },

    load(id) {
      if (id === PERFORMANCE_TRACKS_CLIENT_ID) return performanceTracksClientModuleCode(options);
      return null;
    },

    // Plain (index.html) apps get the module injected here; app-mode apps
    // import it from the client entry instead (generated or authored). Head
    // *prepend*, unlike the diagnostics bridge's `head`: this module has an
    // ordering requirement — it must evaluate before the app's entry module
    // (wherever that script sits in the document) so the render/hydration
    // is on the timeline. Module scripts execute in document order.
    transformIndexHtml() {
      if (!enabled) return undefined;
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: joinBase(base, '/@id/' + PERFORMANCE_TRACKS_CLIENT_ID) },
          injectTo: 'head-prepend' as const,
        },
      ];
    },
  };
}
