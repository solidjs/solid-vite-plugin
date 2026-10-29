import * as babel from '@babel/core';
import solid from 'babel-preset-solid';
import { readFileSync } from 'fs';
import { mergeAndConcat } from 'merge-anything';
import { createRequire } from 'module';
import path from 'path';
import solidRefresh from 'solid-refresh/babel';
import type { FilterPattern, Plugin } from 'vite';
import { createFilter, searchForWorkspaceRoot, version } from 'vite';
import { crawlFrameworkPkgs } from 'vitefu';

const require = createRequire(import.meta.url);

const runtimePublicPath = '/@solid-refresh';
const runtimeFilePath = require.resolve('solid-refresh/dist/solid-refresh.mjs');
const runtimeCode = readFileSync(runtimeFilePath, 'utf-8');

const viteVersionMajor = +version.split('.')[0];
const isVite6OrNewer = viteVersionMajor >= 6;
const isVite8OrNewer = viteVersionMajor >= 8;

/** Possible options for the extensions property */
export interface ExtensionOptions {
  typescript?: boolean;
}

/** Configuration options for vite-plugin-solid. */
export interface Options {
  /**
   * A [picomatch](https://github.com/micromatch/picomatch) pattern, or array of patterns, which specifies the files
   * the plugin should operate on.
   */
  include?: FilterPattern;
  /**
   * A [picomatch](https://github.com/micromatch/picomatch) pattern, or array of patterns, which specifies the files
   * to be ignored by the plugin.
   */
  exclude?: FilterPattern;
  /**
   * This will inject solid-js/dev in place of solid-js in dev mode. Has no
   * effect in prod. If set to `false`, it won't inject it in dev. This is
   * useful for extra logs and debugging.
   *
   * @default true
   */
  dev?: boolean;
  /**
   * This will force SSR code in the produced files.
   *
   * With `true`, client code is hydratable and server code is hydratable SSR
   * output. With `false`, client code is non-hydratable DOM output, and modules
   * loaded on the server (for example through `ssrLoadModule` to prerender a
   * page) get non-hydratable SSR output.
   *
   * @default false
   */
  ssr?: boolean;

  /**
   * This will inject HMR runtime in dev mode. Has no effect in prod. If
   * set to `false`, it won't inject the runtime in dev.
   *
   * @default true
   */
  hot?: boolean;
  /**
   * This registers additional extensions that should be processed by
   * vite-plugin-solid.
   *
   * @default undefined
   */
  extensions?: (string | [string, ExtensionOptions])[];
  /**
   * Pass any additional babel transform options. They will be merged with
   * the transformations required by Solid.
   *
   * @default {}
   */
  babel?:
    | babel.TransformOptions
    | ((source: string, id: string, ssr: boolean) => babel.TransformOptions)
    | ((source: string, id: string, ssr: boolean) => Promise<babel.TransformOptions>);
  /**
   * Pass any additional [babel-plugin-jsx-dom-expressions](https://github.com/ryansolid/dom-expressions/tree/main/packages/babel-plugin-jsx-dom-expressions#plugin-options).
   * They will be merged with the defaults sets by [babel-preset-solid](https://github.com/solidjs/solid/blob/main/packages/babel-preset-solid/index.js#L8-L25).
   *
   * @default {}
   */
  solid?: {
    /**
     * Remove unnecessary closing tags from template strings. More info here:
     * https://github.com/solidjs/solid/blob/main/CHANGELOG.md#smaller-templates
     *
     * @default false
     */
    omitNestedClosingTags?: boolean;

    /**
     * Remove the last closing tag from template strings. Enabled by default even when `omitNestedClosingTags` is disabled.
     * Can be disabled for compatibility for some browser-like environments.
     *
     * @default true
     */
    omitLastClosingTag?: boolean;

    /**
     * Remove unnecessary quotes from template strings.
     * Can be disabled for compatibility for some browser-like environments.
     *
     * @default true
     */
    omitQuotes?: boolean;

    /**
     * Only applies when `hydratable` is `true`. When `true`, an element marked
     * `$ServerOnly` registers no client template, so it can only be obtained by
     * hydrating server-rendered DOM and throws if it is ever re-created on the client.
     *
     * The plugin sets this to `false` for client transforms in dev while HMR is
     * enabled, since Solid Refresh re-runs components outside of hydration. Pass
     * an explicit value to override that.
     *
     * @default true
     */
    omitServerOnlyTemplates?: boolean;

    /**
     * The name of the runtime module to import the methods from.
     *
     * @default "solid-js/web"
     */
    moduleName?: string;

    /**
     * The output mode of the compiler.
     * Can be:
     * - "dom" is standard output
     * - "ssr" is for server side rendering of strings.
     * - "universal" is for using custom renderers from solid-js/universal
     *
     * @default "dom"
     */
    generate?: 'ssr' | 'dom' | 'universal';

    /**
     * Indicate whether the output should contain hydratable markers.
     *
     * @default false
     */
    hydratable?: boolean;

    /**
     * Boolean to indicate whether to enable automatic event delegation on camelCase.
     *
     * @default true
     */
    delegateEvents?: boolean;

    /**
     * Boolean indicates whether smart conditional detection should be used.
     * This optimizes simple boolean expressions and ternaries in JSX.
     *
     * @default true
     */
    wrapConditionals?: boolean;

    /**
     * Boolean indicates whether to set current render context on Custom Elements and slots.
     * Useful for seemless Context API with Web Components.
     *
     * @default true
     */
    contextToCustomElements?: boolean;

    /**
     * Array of Component exports from module, that aren't included by default with the library.
     * This plugin will automatically import them if it comes across them in the JSX.
     *
     * @default ["For","Show","Switch","Match","Suspense","SuspenseList","Portal","Index","Dynamic","ErrorBoundary"]
     */
    builtIns?: string[];
  };
}

function getExtension(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index < 0 ? '' : filename.substring(index);
}

/**
 * The path the transform compiles for `id`. This is normally `id` without its
 * query. Some plugins put the extension after the query instead, such as
 * unplugin-icons' `~icons/mdi/folder?width=2em.tsx`. Then the full id is used,
 * as it was before queries were stripped. #206
 */
function getTransformPath(id: string, isHandled: (path: string) => boolean): string {
  const cleanId = id.replace(/\?.*$/, '');
  return cleanId !== id && !isHandled(cleanId) && isHandled(id) ? id : cleanId;
}
function containsSolidField(fields: Record<string, any>) {
  const keys = Object.keys(fields);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'solid') return true;
    if (typeof fields[key] === 'object' && fields[key] != null && containsSolidField(fields[key]))
      return true;
  }
  return false;
}

function getJestDomExport(setupFiles: string[], root: string) {
  if (setupFiles?.some((file) => /jest-dom/.test(file))) return undefined;

  // Resolve from the project root, not from this plugin's own location. With pnpm's
  // isolated node_modules layout the plugin can reach a jest-dom that only exists as a
  // transitive dependency (e.g. of Storybook), while Vitest resolves `setupFiles` from the
  // project root, where it isn't installed, and fails to load it.
  // https://github.com/solidjs/solid-vite-plugin/issues/231
  // The bare specifier (not the resolved path) is injected on purpose: `require.resolve` picks
  // jest-dom's CommonJS entry, which Vitest refuses to load, while Vitest itself resolves the
  // specifier to the ESM entry.
  const projectRequire = createRequire(path.join(root, 'package.json'));
  return ['@testing-library/jest-dom/vitest', '@testing-library/jest-dom/extend-expect'].find(
    (specifier) => {
      try {
        projectRequire.resolve(specifier);
        return true;
      } catch (e) {
        return false;
      }
    },
  );
}

function readPackageJson(specifier: string, requires: NodeRequire[]) {
  for (const req of requires) {
    try {
      const file = req.resolve(`${specifier}/package.json`);
      return { dir: path.dirname(file), pkg: JSON.parse(readFileSync(file, 'utf-8')) };
    } catch (e) {}
  }
  return undefined;
}

/**
 * Vitest before 1.0 resolves `setupFiles` with `require.resolve`, which picks
 * jest-dom's CommonJS `vitest` entry. In that file `require('vitest').expect`
 * is undefined, so it throws "Cannot read properties of undefined (reading
 * 'extend')". For those versions, return the path of jest-dom's ESM entry. #141
 */
function getJestDomVitestEsmPath(root: string): string | undefined {
  const rootRequire = createRequire(path.join(path.resolve(root), 'package.json'));
  const vitest = readPackageJson('vitest', [rootRequire, require]);
  if (!vitest || +String(vitest.pkg.version).split('.')[0] >= 1) return undefined;
  const jestDom = readPackageJson('@testing-library/jest-dom', [require, rootRequire]);
  const entry = jestDom?.pkg.exports?.['./vitest']?.import;
  const file = typeof entry === 'string' ? entry : entry?.default;
  return typeof file === 'string' ? path.join(jestDom.dir, file) : undefined;
}

export default function solidPlugin(options: Partial<Options> = {}): Plugin {
  const filter = createFilter(options.include, options.exclude);

  let needHmr = false;
  let replaceDev = false;
  let projectRoot = process.cwd();
  let isTestMode = false;
  let solidPkgsConfig: Awaited<ReturnType<typeof crawlFrameworkPkgs>>;
  // Packages that import solid-js without a `solid` export condition, found
  // by the crawl in test mode. They are inlined with solid-js (see
  // `test.server.deps` below).
  const testRuntimeConsumers = new Set<string>();
  // True when a DOM test run inlines the Solid runtime. The `ssr`
  // environment then does not get the `browser` condition (see
  // `configEnvironment` below).
  let domTestRuntimeInlined = false;

  return {
    name: 'solid',
    enforce: 'pre',

    async config(userConfig, { command }) {
      // We inject the dev mode only if the user explicitly wants it or if we are in dev (serve) mode
      replaceDev = options.dev === true || (options.dev !== false && command === 'serve');
      projectRoot = userConfig.root;
      isTestMode = userConfig.mode === 'test';
      domTestRuntimeInlined = false;

      // Leave the user's `resolve.alias` as it is. Turning an object into an
      // array changes how Vite merges it with aliases from later plugins:
      // their entries then take priority over the user's. #130

      solidPkgsConfig = await crawlFrameworkPkgs({
        viteUserConfig: userConfig,
        root: projectRoot || process.cwd(),
        isBuild: command === 'build',
        isFrameworkPkgByJson(pkgJson) {
          return containsSolidField(pkgJson.exports || {});
        },
        // Only records the runtime consumers for the jsdom test posture.
        // Returning false keeps vitefu's output unchanged.
        isSemiFrameworkPkgByJson(pkgJson) {
          if (
            isTestMode &&
            !options.ssr &&
            typeof pkgJson.name === 'string' &&
            (pkgJson.dependencies?.['solid-js'] || pkgJson.peerDependencies?.['solid-js'])
          ) {
            testRuntimeConsumers.add(pkgJson.name);
          }
          return false;
        },
      });

      const solidDeps = ['solid-js', 'solid-js/web', 'solid-js/store', 'solid-js/html', 'solid-js/h'];

      // vitefu only reads the dependencies of the package.json at the Vite
      // root. In a workspace, the project can also import packages that are
      // only declared in the workspace root's package.json (npm and yarn
      // hoist them). A framework package found that way was left external,
      // so Node loaded its raw `.jsx` source and failed with
      // `Unknown file extension ".jsx"` (#157). Crawl the workspace root too
      // and inline its framework packages. Only `ssr.noExternal` is merged:
      // inlining a name that is never imported does nothing, while
      // `optimizeDeps.include` entries must resolve from the project root.
      const crawlRoot = path.resolve(projectRoot || process.cwd());
      const workspaceRoot = searchForWorkspaceRoot(crawlRoot);
      if (workspaceRoot !== crawlRoot) {
        const workspacePkgs = await crawlFrameworkPkgs({
          viteUserConfig: userConfig,
          root: workspaceRoot,
          isBuild: command === 'build',
          isFrameworkPkgByJson(pkgJson) {
            return containsSolidField(pkgJson.exports || {});
          },
        });
        for (const name of workspacePkgs.ssr.noExternal) {
          if (!solidPkgsConfig.ssr.noExternal.includes(name)) {
            solidPkgsConfig.ssr.noExternal.push(name);
          }
        }
      }

      // fix for bundling dev in production
      const nestedDeps = replaceDev ? solidDeps : [];

      const userTest = (userConfig as any).test ?? {};
      const test = {} as any;
      if (userConfig.mode === 'test') {
        // to simplify the processing of the config, we normalize the setupFiles to an array
        const userSetupFiles: string[] =
          typeof userTest.setupFiles === 'string'
            ? [userTest.setupFiles]
            : userTest.setupFiles || [];

        if (!userTest.environment && !userTest.workspace && !userTest.projects && !options.ssr) {
          test.environment = 'jsdom';
        }

        // Vitest 5 defaults `test.sharedViteServer` to true: inline projects
        // then reuse the root Vite server and take their `test` options from
        // the raw root block captured before any `config` hook runs, so
        // nothing injected here (jsdom, jest-dom, server.deps) reaches them.
        // Vitest reads the option off the resolved root config, so this
        // restores per-project resolution as under Vitest 4. Older Vitest
        // versions ignore the option.
        if (userTest.projects && userTest.sharedViteServer === undefined) {
          test.sharedViteServer = false;
        }

        if (
          !userTest.server?.deps?.external?.find((item: string | RegExp) =>
            /solid-js/.test(item.toString()),
          )
        ) {
          if (options.ssr) {
            test.server = { deps: { external: [/solid-js/] } };
          } else if (userTest.server?.deps?.inline !== true) {
            // An externalized package is imported natively, and its own
            // imports are resolved by the host runtime, not by Vite. Node
            // gets the `browser` condition from vitest's worker
            // `--conditions`, but Deno (in a worker thread) resolves
            // `deno`/`node` and lands on the server build: `render` from
            // `@solidjs/testing-library` threw "Client-only API called on the
            // server side" (#369). Inline solid-js and the packages that
            // import it, so these imports go through Vite's `browser`
            // condition and load one client-build instance. A consumer left
            // external would load a second, native copy. Packages with a
            // `solid` export condition are inlined already through vitefu.
            // A user `inline` list is merged with this one; `inline: true`
            // inlines everything already.
            test.server = {
              deps: {
                inline: [/[\\/]node_modules[\\/]solid-js[\\/]/, ...testRuntimeConsumers],
              },
            };
          }
          const environment = userTest.environment ?? test.environment;
          domTestRuntimeInlined =
            !options.ssr &&
            !userTest.browser?.enabled &&
            (environment === 'jsdom' || environment === 'happy-dom');
        }
        if (!userTest.browser?.enabled) {
          // vitest browser mode already has bundled jest-dom assertions
          // https://main.vitest.dev/guide/browser/assertion-api.html#assertion-api
          const jestDomImport = getJestDomExport(
            userSetupFiles,
            path.resolve(projectRoot || process.cwd()),
          );
          if (jestDomImport) {
            test.setupFiles = [
              (jestDomImport === '@testing-library/jest-dom/vitest' &&
                getJestDomVitestEsmPath(userConfig.root || process.cwd())) ||
                jestDomImport,
            ];
          }
        }
      }

      // Before Vite 6, conditions are set here for every build.
      const legacyConditions = [
        'solid',
        ...(replaceDev ? ['development'] : []),
        ...(userConfig.mode === 'test' && !options.ssr ? ['browser'] : []),
      ];
      // A server build with `ssr.target: 'webworker'` resolves solid-js to its
      // browser build, so add the `worker` condition, which selects the server
      // build. #153 Vite 4 and 5 read `ssr.resolve.conditions` instead of
      // `resolve.conditions` when it is set, so it repeats the top-level list
      // unless the user set their own. Vite 3 has no such option.
      const userSsrConditions = (userConfig.ssr as any)?.resolve?.conditions;
      const legacySsr =
        userConfig.ssr?.target === 'webworker'
          ? {
              ...solidPkgsConfig.ssr,
              resolve: {
                conditions: userSsrConditions
                  ? ['solid', 'worker']
                  : [...legacyConditions, ...(userConfig.resolve?.conditions ?? []), 'worker'],
              },
            }
          : solidPkgsConfig.ssr;

      return {
        /**
         * We only need esbuild on .ts or .js files.
         * .tsx & .jsx files are handled by us
         */
        // esbuild: { include: /\.ts$/ },
        resolve: {
          conditions: isVite6OrNewer ? undefined : legacyConditions,
          // Dedupe in builds too. A dependency that ships its own nested
          // solid-js would otherwise add a second runtime to the bundle. #112
          dedupe: solidDeps,
        },
        optimizeDeps: {
          include: [...nestedDeps, ...solidPkgsConfig.optimizeDeps.include],
          exclude: solidPkgsConfig.optimizeDeps.exclude,
          // Vite 8+ uses Rolldown for dependency scanning. Rolldown defaults to
          // React's automatic JSX runtime for .tsx files, injecting a
          // react/jsx-dev-runtime import that fails to resolve and aborts the
          // scan. 'preserve' is no fix: the scanner re-parses the transformed
          // output as plain JS, so any preserved JSX is a hard parse error
          // (issue #262). The classic runtime is the only scan-safe lowering:
          // it emits bare `React.createElement` calls without injecting any
          // import, and the scan output is never executed — it only exists so
          // rolldown can walk the import graph.
          ...(isVite8OrNewer
            ? { rolldownOptions: { transform: { jsx: { runtime: 'classic' as const } } } }
            : {}),
        },
        ...(!isVite6OrNewer ? { ssr: legacySsr } : {}),
        ...(Object.keys(test).length ? { test } : {}),
      };
    },

    // @ts-ignore This hook only works in Vite 6
    async configEnvironment(name, config, opts) {
      config.resolve ??= {};
      // Emulate Vite default fallback for `resolve.conditions` if not set
      if (config.resolve.conditions == null) {
        // @ts-ignore These exports only exist in Vite 6
        const { defaultClientConditions, defaultServerConditions } = await import('vite');
        if (config.consumer === 'client' || name === 'client' || opts.isSsrTargetWebworker) {
          config.resolve.conditions = [...defaultClientConditions];
        } else {
          config.resolve.conditions = [...defaultServerConditions];
        }
      }
      // Vitest passes the `ssr` environment's conditions to Node as
      // `--conditions` for the packages it leaves external. With `browser`
      // there, Node-only packages fail to load. For example, `msw/node`
      // imports `@mswjs/interceptors/ClientRequest`, whose `browser`
      // export is `null` (#125). DOM tests run in the `client` environment,
      // and the Solid runtime is inlined in that case, so the `ssr`
      // environment does not need `browser`.
      const addBrowser =
        isTestMode &&
        !opts.isSsrTargetWebworker &&
        !options.ssr &&
        !(domTestRuntimeInlined && name === 'ssr');
      config.resolve.conditions = [
        'solid',
        // A server build with `ssr.target: 'webworker'` starts from Vite's
        // client conditions, which select the browser build of solid-js. Its
        // `worker` export points at the server build. #153
        ...(opts.isSsrTargetWebworker ? ['worker'] : []),
        ...(replaceDev ? ['development'] : []),
        ...(addBrowser ? ['browser'] : []),
        ...config.resolve.conditions,
      ];

      // Set resolve.noExternal and resolve.external for SSR environment (Vite 6+)
      // Only set resolve.external if noExternal is not true (to avoid conflicts with plugins like Cloudflare)
      if (isVite6OrNewer && name === 'ssr' && solidPkgsConfig) {
        if (config.resolve.noExternal !== true) {
          config.resolve.noExternal = [
            ...(Array.isArray(config.resolve.noExternal) ? config.resolve.noExternal : []),
            ...solidPkgsConfig.ssr.noExternal,
          ];
          config.resolve.external = [
            ...(Array.isArray(config.resolve.external) ? config.resolve.external : []),
            ...solidPkgsConfig.ssr.external,
          ];
        }
      }
    },

    configResolved(config) {
      needHmr =
        !isTestMode &&
        config.command === 'serve' &&
        config.mode !== 'production' &&
        options.hot !== false;
    },

    resolveId(id) {
      // `solid-refresh` is the import added by the HMR transform. It is
      // resolved here rather than through `resolve.alias`, because adding an
      // alias array would also change how the user's aliases merge. #130
      if (id === runtimePublicPath || id === 'solid-refresh') return runtimePublicPath;
    },

    load(id) {
      if (id === runtimePublicPath) return runtimeCode;
    },

    async transform(source, id, transformOptions) {
      const isSsr = this.environment
        ? this.environment.config.consumer === 'server'
        : Boolean(transformOptions?.ssr);

      const extensionsToWatch = options.extensions || [];
      const allExtensions = extensionsToWatch.map((extension) =>
        // An extension can be a string or a tuple [extension, options]
        typeof extension === 'string' ? extension : extension[0],
      );

      if (!filter(id)) {
        return null;
      }

      id = getTransformPath(
        id,
        (path) => /\.[mc]?[tj]sx$/i.test(path) || allExtensions.includes(getExtension(path)),
      );
      // Read the extension from the query-free path, so a dot inside the
      // query (`a.mdx?x=1.5`) is not taken as the extension.
      const currentFileExtension = getExtension(id);

      if (!(/\.[mc]?[tj]sx$/i.test(id) || allExtensions.includes(currentFileExtension))) {
        return null;
      }

      const inNodeModules = /node_modules/.test(id);

      let solidOptions: { generate: 'ssr' | 'dom'; hydratable: boolean };

      if (options.ssr) {
        if (isSsr) {
          solidOptions = { generate: 'ssr', hydratable: true };
        } else {
          solidOptions = { generate: 'dom', hydratable: true };
        }
      } else {
        // A client-rendered app can still load modules on the server, for
        // example to prerender static pages with `ssrLoadModule`. DOM output
        // cannot run there, so server transforms use the SSR generate. Nothing
        // hydrates the result, so it stays non-hydratable. Vitest keeps DOM
        // output, since tests resolve the browser build of solid-js.
        solidOptions = {
          generate: isSsr && !isTestMode ? 'ssr' : 'dom',
          hydratable: false,
        };
      }

      // We need to know if the current file extension has a typescript options tied to it
      const shouldBeProcessedWithTypescript =
        /\.[mc]?tsx$/i.test(id) ||
        extensionsToWatch.some((extension) => {
          if (typeof extension === 'string') {
            return extension.includes('tsx');
          }

          const [extensionName, extensionOptions] = extension;
          if (extensionName !== currentFileExtension) return false;

          return extensionOptions.typescript;
        });
      const plugins: NonNullable<NonNullable<babel.TransformOptions['parserOpts']>['plugins']> = [
        'jsx',
      ];

      if (shouldBeProcessedWithTypescript) {
        plugins.push('typescript');
      }

      // babel-plugin-jsx-dom-expressions >= 0.40.10 omits the client template of
      // `$ServerOnly` elements by default, so re-creating such an element outside
      // of hydration throws "template is not a function". Solid Refresh does
      // exactly that on every hot update, so keep the templates in client HMR
      // transforms. An explicit user setting still wins.
      const presetOptions = {
        ...solidOptions,
        ...(needHmr && !isSsr ? { omitServerOnlyTemplates: false } : {}),
        ...(options.solid || {}),
      };

      const opts: babel.TransformOptions = {
        root: projectRoot,
        filename: id,
        sourceFileName: id,
        presets: [[solid, presetOptions]],
        plugins: needHmr && !isSsr && !inNodeModules ? [[solidRefresh, { bundler: 'vite' }]] : [],
        ast: false,
        sourceMaps: true,
        configFile: false,
        babelrc: false,
        parserOpts: {
          plugins,
        },
      };

      // Default value for babel user options
      let babelUserOptions: babel.TransformOptions = {};

      if (options.babel) {
        if (typeof options.babel === 'function') {
          const babelOptions = options.babel(source, id, isSsr);
          babelUserOptions = babelOptions instanceof Promise ? await babelOptions : babelOptions;
        } else {
          babelUserOptions = options.babel;
        }
      }

      const babelOptions = mergeAndConcat(babelUserOptions, opts) as babel.TransformOptions;

      const { code, map } = await babel.transformAsync(source, babelOptions);

      return { code, map };
    },
  };
}
