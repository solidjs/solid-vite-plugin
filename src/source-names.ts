/**
 * `solid.sourceNames`: which names as written in source the compilers carry
 * into output for the dev and observe runtimes, and the source locations
 * that ride along with them. This module resolves the user's value to one
 * flag per kind and builds the option objects each compiler receives; the
 * plugin's transform hooks (src/index.ts) decide when to call it.
 */

/**
 * Which source names are carried into output for the dev and observe
 * runtimes to label the reactive graph with (see
 * `Options.solid.sourceNames`). Each kind defaults to the posture: on for
 * dev and `observe`, off for production builds — except `locations`, which
 * defaults on for dev only. `components` and `bindings` are the JSX
 * compiler's `sourceNames` option; `primitives` is the native compiler's
 * standalone `transformSourceNames` pass, which the plugin runs on every
 * module — babel apps included; `locations` qualifies all three.
 */
export interface SourceNamesOptions {
  /** `createComponent(Home, props, "Home")` — owners labelled `<Home>`. */
  components?: boolean;
  /** Binding effects named by what they write: `span.textContent`, `div.children`. */
  bindings?: boolean;
  /**
   * Primitives named after the identifier they are declared as —
   * `createSignal(0, { name: "count" })`, `createCounter.value` inside a
   * composed primitive — by the native compiler's `transformSourceNames`
   * pass. Runs on `.ts`/`.js` modules as well as components (outside
   * node_modules), whichever JSX compiler the app uses.
   */
  primitives?: boolean;
  /**
   * A `file:line:col` source location next to every name the other kinds
   * emit — `createComponent(Home, props, "Home", "src/App.tsx:12:5")`,
   * `{ name: "count", loc: "src/store.ts:3:22" }` — so a diagnostic
   * report, a `whyDidRun` chain, or a devtools entry points at the line
   * that declared the node. Paths are relative to the Vite root, so under
   * `vite dev` the console link `http://localhost:5173/src/App.tsx:12:5`
   * opens the file in the browser's sources panel. A location is only
   * emitted where its name is (a kind that is off emits neither).
   *
   * Defaults on under `dev` and off otherwise: an `observe` build is a
   * production bundle, and shipping source paths in it is an opt-in
   * (`{ locations: true }`), unlike the names, which `observe` turns on.
   * `sourceNames: true` turns it on with every other kind. Requires a
   * compiler release that accepts the option; on an older
   * `@solidjs/compiler` the names keep coming without locations (a one-time
   * warning when it was asked for explicitly).
   */
  locations?: boolean;
}

/** Every kind resolved to a flag. */
export type ResolvedSourceNames = Required<SourceNamesOptions>;

/**
 * Resolve `solid.sourceNames` to one flag per kind — `components` and
 * `bindings` go to the JSX compiler, `primitives` gates the standalone
 * `transformSourceNames` pass in the transform hook, and `locations`
 * qualifies all of them.
 *
 * The default follows the posture. `dev` here is the same flag the compilers
 * receive as `dev` (`options.dev`, which defaults to on under `vite dev` and
 * off for `vite build`), and `observe` is `options.observe`; those are the
 * two runtimes that read the names, and the production runtime ignores them.
 * `locations` is the one kind that does not follow `observe`: an observe
 * build is a production bundle, and a source path inside it is an opt-in.
 *
 * | `solid.sourceNames`     | dev                     | observe (no dev)          | production                 |
 * | ----------------------- | ----------------------- | ------------------------- | -------------------------- |
 * | (unset)                 | all on                  | names on, locations off   | all off                    |
 * | `true`                  | all on                  | all on                    | all on                     |
 * | `false`                 | all off                 | all off                   | all off                    |
 * | `{ kind: true/false }`  | as given; the rest on   | as given; the rest as unset | as given; the rest off   |
 */
export function getSourceNames(
  user: boolean | SourceNamesOptions | undefined,
  dev: boolean,
  observe: boolean,
): ResolvedSourceNames {
  const posture = dev || observe;
  if (typeof user === 'boolean') {
    return { components: user, bindings: user, primitives: user, locations: user };
  }
  return {
    components: user?.components ?? posture,
    bindings: user?.bindings ?? posture,
    primitives: user?.primitives ?? posture,
    locations: user?.locations ?? dev,
  };
}

/**
 * Whether the user asked for locations in so many words (`sourceNames:
 * true` or `{ locations: true }`), as opposed to getting them from the dev
 * default. Decides whether an older compiler's silence is worth a warning.
 */
export function requestedLocations(user: boolean | SourceNamesOptions | undefined): boolean {
  return user === true || (typeof user === 'object' && user.locations === true);
}

/** The slice of `@solidjs/compiler` the location probe exercises. */
export interface LocationProbeCompiler {
  transform(code: string, options?: object | null): unknown;
  transformSourceNames?(code: string, options?: object | null): unknown;
}

/**
 * Whether the installed `@solidjs/compiler` takes the `locations` kind and
 * the `root` option — on `transform` (`sourceNames.locations`) and on
 * `transformSourceNames` (`locations`), which ship together. The compiler
 * validates its options in JavaScript ahead of the native call and throws
 * `received unknown option` for a key it does not know, so one transform of
 * an empty module per function is a cheap, exact probe: it asks the
 * compiler that is actually loaded rather than inferring from a version
 * string what a prerelease carries. Called once per compiler load.
 */
export function detectLocationSupport(compiler: LocationProbeCompiler): boolean {
  if (typeof compiler.transformSourceNames !== 'function') return false;
  try {
    compiler.transform('', { filename: '/probe.jsx', root: '/', sourceNames: { locations: true } });
    compiler.transformSourceNames('', { filename: '/probe.ts', root: '/', locations: true });
    return true;
  } catch {
    return false;
  }
}

/** What the compiler about to receive the options can do with locations. */
export interface LocationTarget {
  /**
   * The compiler accepts `locations` and `root`. The native compiler is
   * probed (`detectLocationSupport`); `@solidjs/babel-plugin` ignores keys
   * it does not know, so it always takes them.
   */
  supportsLocations: boolean;
  /** The resolved Vite root locations are made relative to. */
  root: string;
}

/** The `sourceNames` value a JSX compiler receives, plus `root` when locations ride along. */
export interface JsxSourceNamesOptions {
  sourceNames: false | { components: boolean; bindings: boolean; locations?: boolean };
  root?: string;
}

/**
 * The JSX compiler's share of the resolved names: `sourceNames` as the
 * compilers define it (`false` when neither JSX kind is on — the compilers
 * default their own `sourceNames` on under `dev`, so the resolved value is
 * always passed and the plugin's table, not the compiler default, decides)
 * and, on a compiler that takes it, `locations` resolved the same way, with
 * `root` whenever a location is going to be written. On an older compiler
 * neither key is present: `@solidjs/compiler` throws on an unknown option.
 */
export function getJsxSourceNamesOptions(
  names: ResolvedSourceNames,
  target: LocationTarget,
): JsxSourceNamesOptions {
  const { components, bindings, locations } = names;
  if (!components && !bindings) return { sourceNames: false };
  if (!target.supportsLocations) return { sourceNames: { components, bindings } };
  return {
    sourceNames: { components, bindings, locations },
    ...(locations ? { root: target.root } : {}),
  };
}

/** Options for `transformSourceNames`, the primitives pass. */
export interface PrimitiveNamesOptions {
  filename: string;
  sourceMap: true;
  locations?: boolean;
  root?: string;
}

/**
 * The primitives pass's options: `locations` (whose compiler default is on,
 * so the resolved flag is always passed) and `root` when a location is
 * going to be written — both only on a compiler that takes them.
 */
export function getPrimitiveNamesOptions(
  names: ResolvedSourceNames,
  target: LocationTarget,
  filename: string,
): PrimitiveNamesOptions {
  if (!target.supportsLocations) return { filename, sourceMap: true };
  return {
    filename,
    sourceMap: true,
    locations: names.locations,
    ...(names.locations ? { root: target.root } : {}),
  };
}
