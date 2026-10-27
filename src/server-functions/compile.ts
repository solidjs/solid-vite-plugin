// The `"use server"` directive compiler. This wraps the native
// `transformDirectives` pass from @solidjs/compiler (Rust/Oxc); the
// original Babel implementation (hoisted from solid-start) lived in this
// directory through vite-plugin-solid@c052963e and remains the frozen
// reference for the native pass's fixture suite.

export interface NamedImportDefinition {
  kind: 'named';
  name: string;
  source: string;
}

export interface DefaultImportDefinition {
  kind: 'default';
  source: string;
}

export type ImportDefinition = DefaultImportDefinition | NamedImportDefinition;

export interface CompileOptions {
  mode: 'server' | 'client';
  env: 'production' | 'development';
  /** The directive text (default "use server" upstream). */
  directive: string;
  /** Project root; function IDs hash the root-relative path. */
  root: string;
  /** Whether to emit a map for this pass. Defaults to true. */
  sourceMap?: boolean;
  definitions: {
    register: ImportDefinition;
    create: ImportDefinition;
  };
}

export interface CompileResult {
  valid: boolean;
  code: string;
  map: string | null;
  functions: import('@solidjs/compiler').ServerFunctionMeta[];
}

type NativeCompiler = typeof import('@solidjs/compiler');
let compilerPromise: Promise<NativeCompiler> | undefined;

// Loaded lazily so importing the plugin never pays for the native binding —
// only setups that enable server functions load it (mirrors the JSX
// compiler's opt-in loader in index.ts).
async function loadCompiler(): Promise<NativeCompiler> {
  try {
    return await (compilerPromise ??= import('@solidjs/compiler'));
  } catch (error) {
    compilerPromise = undefined;
    const reason = error instanceof Error ? `\n\nCause: ${error.message}` : '';
    throw new Error(
      '@solidjs/vite-plugin: failed to load @solidjs/compiler (the "use server" ' +
        'transform). Your platform should get a prebuilt native binary or the ' +
        '@solidjs/compiler-wasm32-wasi fallback — check that optional ' +
        'dependencies were installed.' +
        reason,
    );
  }
}

/**
 * Runs the directive transform over one module. Function IDs are
 * `hash(relative path)-<counter>`, so the client and server builds of the
 * same checkout agree on every ID (the wire contract) without baking
 * machine-specific absolute paths into the output. A `valid: false` result
 * means the module contained no matching directive and must be left
 * untransformed. Invalid closure captures (a server function referencing a
 * non-top-level binding) throw with the variable name and location.
 */
export async function compile(
  id: string,
  code: string,
  options: CompileOptions,
): Promise<CompileResult> {
  const { transformDirectives } = await loadCompiler();
  const result = transformDirectives(code, {
    filename: id,
    root: options.root,
    mode: options.mode,
    env: options.env,
    directive: options.directive,
    sourceMap: options.sourceMap !== false,
    register: options.definitions.register,
    create: options.definitions.create,
  });
  return {
    valid: result.valid,
    code: result.code,
    map: result.map ?? null,
    functions: result.functions,
  };
}
