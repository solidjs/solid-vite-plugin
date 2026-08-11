// Typed, validated environment variables as a start-mode feature (`start.env`):
// an `env.ts` at the project root default-exports `{ server, client }` maps
// of Standard Schema validators (zod, valibot, arktype — mixable per key),
// and the plugin exposes the validated values through two virtual modules:
//
// - `virtual:env/server` — every var; importable only from server module
//   graphs (a client-graph import is a hard error naming the importer).
// - `virtual:env/client` — the `client` side only, whose keys must carry
//   the public env prefix (`VITE_` unless `envPrefix` says otherwise).
//
// Validation runs at config/build time in node only, against Vite's
// `loadEnv` merge of the `.env*` files with `process.env` winning (CI
// secrets take precedence) — and the plugin folds the file-loaded vars into
// `process.env` itself, so templates don't need the classic
// `process.env = { ...process.env, ...loadEnv(mode, root, '') }` one-liner.
//
// Client values are baked into the bundles as validated plain JSON —
// that's what the public `VITE_` prefix means — so no validator library
// ever reaches a browser bundle. Server values are NOT baked anywhere:
// `virtual:env/server` reads `process.env` at module init (server boot)
// and validates through the user's own schema, which only the server
// module graph imports. Platform-injected vars that don't exist at build
// time work, secrets rotate without a rebuild, and no secret value exists
// in any dist artifact. Build-time server-value failures downgrade to a
// warning (boot enforces); dev failures stay hard errors — dev IS runtime.
//
// A failed validation fails the build; in dev it renders Vite's error
// overlay with the per-key report (the virtual modules throw it on load)
// and `.env*`/schema edits revalidate live. A `solid-env.d.ts` is generated
// next to the schema file so both virtual modules are fully typed by
// inference from the user's own schema — no manual declarations.
//
// Design credit: the shape of this feature — env.ts schema file, the
// virtual module pair and their names, build-time validation with baked
// JSON values, the leak scan — follows @vite-env/core by pyyupsk (MIT,
// https://github.com/pyyupsk/vite-env), the design-correct prior art. The
// implementation is fresh against this plugin's machinery: Standard Schema
// is the only contract (no zod dependency or zod-specific paths), the
// schema file loads through Vite's own `runnerImport`/`loadConfigFromFile`
// (no jiti), server-graph protection keys off the environment *consumer*
// rather than environment-name lists, and the types are inferred from the
// user's schema instead of introspected per-library.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { loadEnv, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';

export const CLIENT_ENV_ID = 'virtual:env/client';
export const SERVER_ENV_ID = 'virtual:env/server';
const RESOLVED_CLIENT_ENV_ID = '\0' + CLIENT_ENV_ID;
const RESOLVED_SERVER_ENV_ID = '\0' + SERVER_ENV_ID;

// Conventional schema locations, project-root relative. TypeScript first —
// the whole point is inferred types — but a plain-JS project works too.
const ENV_FILE_CANDIDATES = ['env.ts', 'env.js'];
// Generated ambient types, written next to the schema file. Deliberately
// NOT `env.d.ts`: a declaration file sharing the schema file's stem would
// shadow it in TS resolution (and self-reference its own `typeof import`).
const GENERATED_TYPES_FILE = 'solid-env.d.ts';

/**
 * The minimal structural slice of the Standard Schema v1 interface
 * (https://standardschema.dev) this plugin consumes — the spec is designed
 * to be vendored so validating libraries stay decoupled.
 */
interface StandardSchemaLike {
  '~standard': {
    version: number;
    vendor?: string;
    validate: (value: unknown) => StandardResultLike | Promise<StandardResultLike>;
  };
}
interface StandardResultLike {
  value?: unknown;
  issues?: ReadonlyArray<{
    message: string;
    path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
  }>;
}

interface EnvSchema {
  server?: Record<string, StandardSchemaLike>;
  client?: Record<string, StandardSchemaLike>;
}

interface LoadedEnv {
  schema: EnvSchema;
  /**
   * Every validated output value (server + client) as seen by the BUILD
   * process — used for fast feedback and the client-chunk leak scan. The
   * server virtual module does not bake these: it re-reads process.env at
   * boot. Keys whose build-time validation failed (deferred to boot) are
   * absent.
   */
  all: Record<string, unknown>;
  /** The client-side subset of {@link all}. */
  client: Record<string, unknown>;
  /** Files the schema module transitively loaded (for dev watching). */
  dependencies: string[];
}

function isStandardSchema(value: unknown): value is StandardSchemaLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as StandardSchemaLike)['~standard']?.validate === 'function'
  );
}

/**
 * Keys the loadEnv fold added to process.env, tracked process-globally.
 * Real environment always wins over files — but values *we* folded must not
 * count as "real" on revalidation, or the first fold would pin every .env
 * value forever and live edits would never be seen. Process-global (not
 * plugin-closure) state because Vite restarts the dev server on .env
 * changes, recreating the plugin instances inside the same node process:
 * the new instance must be able to clear the old instance's fold.
 */
const FOLDED_KEYS = Symbol.for('vite-plugin-solid:env-folded-keys');
function foldedKeys(): Set<string> {
  const holder = globalThis as { [FOLDED_KEYS]?: Set<string> };
  return (holder[FOLDED_KEYS] ??= new Set());
}

function stringEntries(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key in env) {
    const value = env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Formats the per-key validation report shared by builds and the dev overlay. */
function formatValidationError(
  issues: Array<{ key: string; message: string }>,
  envFile: string,
  mode: string,
): string {
  const lines = issues.map(({ key, message }) => `  ✗ ${key}: ${message}`);
  return (
    `[vite-plugin-solid] env validation failed (${issues.length} issue${
      issues.length === 1 ? '' : 's'
    }) — schema: ${envFile}, mode: ${mode}\n\n` +
    lines.join('\n') +
    `\n\nSet the variables in your environment or .env files, or adjust the schema.`
  );
}

/**
 * Loads the schema module at config time through Vite itself: `runnerImport`
 * (Vite 6.1+) evaluates TypeScript in-process with project resolution;
 * older Vite 6 falls back to `loadConfigFromFile`, the exact machinery that
 * loads vite.config.ts.
 */
async function importSchemaModule(
  envFileAbs: string,
  root: string,
  mode: string,
): Promise<{ exported: unknown; dependencies: string[] }> {
  const vite = await import('vite');
  if (typeof (vite as any).runnerImport === 'function') {
    const { module, dependencies } = await (vite as any).runnerImport(envFileAbs, {
      root,
      mode,
    });
    return {
      exported: (module as Record<string, unknown> | undefined)?.default,
      dependencies: (dependencies || [])
        .map((dep: string) => path.resolve(root, dep))
        .filter((dep: string) => existsSync(dep)),
    };
  }
  const result = await vite.loadConfigFromFile(
    { command: 'serve', mode },
    envFileAbs,
    root,
  );
  if (!result) {
    throw new Error(`[vite-plugin-solid] failed to load env schema from ${envFileAbs}`);
  }
  return {
    exported: result.config as unknown,
    dependencies: (result.dependencies || [])
      .map((dep) => path.resolve(root, dep))
      .filter((dep) => existsSync(dep)),
  };
}

function assertSchemaShape(
  exported: unknown,
  envFile: string,
  envPrefixes: string[],
): EnvSchema {
  if (!exported || typeof exported !== 'object') {
    throw new Error(
      `[vite-plugin-solid] ${envFile} must default-export an object of the shape ` +
        `{ server?: { VAR: schema }, client?: { VITE_VAR: schema } } where every schema ` +
        `is a Standard Schema validator (zod, valibot, arktype, ...). Got: ${
          exported === null ? 'null' : typeof exported
        }.`,
    );
  }
  const schema = exported as Record<string, unknown>;
  for (const key of Object.keys(schema)) {
    if (key !== 'server' && key !== 'client') {
      throw new Error(
        `[vite-plugin-solid] unknown key "${key}" in ${envFile}: the env schema takes ` +
          `only \`server\` and \`client\` maps of Standard Schema validators.`,
      );
    }
  }
  for (const side of ['server', 'client'] as const) {
    const shape = schema[side];
    if (shape === undefined) continue;
    if (!shape || typeof shape !== 'object') {
      throw new Error(
        `[vite-plugin-solid] \`${side}\` in ${envFile} must be an object mapping variable ` +
          `names to Standard Schema validators.`,
      );
    }
    for (const [key, validator] of Object.entries(shape)) {
      if (!isStandardSchema(validator)) {
        throw new Error(
          `[vite-plugin-solid] ${side}.${key} in ${envFile} is not a Standard Schema ` +
            `validator (no callable \`~standard.validate\`). Any zod/valibot/arktype ` +
            `schema qualifies; plain values and functions don't.`,
        );
      }
    }
  }
  const typed = schema as EnvSchema;
  for (const key of Object.keys(typed.client ?? {})) {
    if (!envPrefixes.some((prefix) => key.startsWith(prefix))) {
      const wanted = envPrefixes[0] ?? 'VITE_';
      throw new Error(
        `[vite-plugin-solid] client env var "${key}" in ${envFile} must carry the public ` +
          `env prefix ("${envPrefixes.join('" or "')}") — client vars are baked into the ` +
          `browser bundle. Rename it to "${wanted}${key}", or move it to \`server\` if it ` +
          `is a secret.`,
      );
    }
    if (typed.server && key in typed.server) {
      throw new Error(
        `[vite-plugin-solid] "${key}" is defined in both \`server\` and \`client\` in ` +
          `${envFile}; a variable belongs to exactly one side (\`client\` vars are ` +
          `visible to the server too).`,
      );
    }
  }
  // The reverse guard: Vite itself bakes every prefixed variable into
  // `import.meta.env` for the browser, so declaring one under `server`
  // cannot keep it secret — it leaks through Vite's channel with no
  // diagnostics from this plugin's leak scan (which only watches the
  // virtual server module's values).
  for (const key of Object.keys(typed.server ?? {})) {
    const prefix = envPrefixes.find((p) => key.startsWith(p));
    if (prefix) {
      const bare = key.slice(prefix.length);
      throw new Error(
        `[vite-plugin-solid] server env var "${key}" in ${envFile} carries the public ` +
          `env prefix "${prefix}". Vite exposes every "${prefix}"-prefixed variable to ` +
          `the browser through import.meta.env no matter which side declares it, so a ` +
          `\`server\` entry cannot keep it secret. ` +
          (bare
            ? `Rename it to "${bare}" (in the schema and in your .env/environment), or `
            : `Rename it without the prefix, or `) +
          `move it to \`client\` if it is public.`,
      );
    }
  }
  return typed;
}

/**
 * Generates the ambient `solid-env.d.ts` next to the schema file. The file
 * is self-contained: it infers each variable's type from the user's own
 * schema through the Standard Schema `~standard.types.output` phantom, so
 * any compliant validator library yields full types with no per-library
 * introspection. Only rewritten when the content actually changes.
 */
function generateTypes(schema: EnvSchema, envFileAbs: string): void {
  const dtsPath = path.join(path.dirname(envFileAbs), GENERATED_TYPES_FILE);
  const importSpec = './' + path.basename(envFileAbs).replace(/\.[mc]?[tj]s$/, '');

  const field = (side: 'server' | 'client', key: string) =>
    `    readonly ${JSON.stringify(key)}: __Out<__Schema[${JSON.stringify(side)}][${JSON.stringify(key)}]>;`;

  const moduleBlock = (id: string, fields: string[]) =>
    [
      `declare module '${id}' {`,
      `  type __Schema = typeof import(${JSON.stringify(importSpec)})['default'];`,
      `  type __Out<T> = T extends { '~standard': { types?: { output: infer O } | undefined } }`,
      `    ? O`,
      `    : string;`,
      `  const env: {`,
      ...fields,
      `  };`,
      `  export { env };`,
      `  export default env;`,
      `}`,
    ].join('\n');

  const clientFields = Object.keys(schema.client ?? {}).map((key) => field('client', key));
  const serverFields = [
    ...Object.keys(schema.server ?? {}).map((key) => field('server', key)),
    ...clientFields,
  ];

  const content =
    `// Generated by vite-plugin-solid (start.env) — do not edit.\n` +
    `// Regenerated on every dev server and build start from ${path.basename(envFileAbs)}.\n` +
    `// Keep this file (and the schema) inside your tsconfig "include".\n\n` +
    moduleBlock(CLIENT_ENV_ID, clientFields) +
    '\n\n' +
    moduleBlock(SERVER_ENV_ID, serverFields) +
    '\n';

  try {
    if (existsSync(dtsPath) && readFileSync(dtsPath, 'utf-8') === content) return;
    writeFileSync(dtsPath, content);
  } catch (error) {
    const reason = error instanceof Error ? `: ${error.message}` : '';
    console.warn(
      `[vite-plugin-solid] could not write ${GENERATED_TYPES_FILE} next to the env schema` +
        `${reason} — the virtual env modules stay untyped until it can be written.`,
    );
  }
}

/**
 * Start-mode typed env (the `start.env` option). Returns no plugin when the
 * feature is off (`env: false`, or nothing to probe); the feature is
 * start-only by construction — the option lives on `start`, so a bare
 * `ssr: true` setup has no env layer (documented).
 */
export function startEnv(option: boolean | string | undefined): Plugin[] {
  if (option === false) return [];

  let root = process.cwd();
  let config: ResolvedConfig;
  let isBuild = false;
  let isPreview = false;
  let enabled = false;
  /** Absolute path of the schema file once resolved. */
  let envFileAbs: string | null = null;
  /** Root-relative schema path for messages. */
  let envFile = 'env.ts';

  let envPromise: Promise<LoadedEnv> | null = null;
  let devErrorLogged = false;

  function resolveEnvFile(): void {
    if (typeof option === 'string') {
      const absolute = path.isAbsolute(option) ? option : path.resolve(root, option);
      if (!existsSync(absolute)) {
        throw new Error(`[vite-plugin-solid] start.env does not exist: ${option}`);
      }
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (relative.startsWith('..')) {
        throw new Error(
          `[vite-plugin-solid] start.env must live inside the Vite root: ${option}`,
        );
      }
      envFileAbs = absolute;
      envFile = relative;
      enabled = true;
      return;
    }
    for (const candidate of ENV_FILE_CANDIDATES) {
      const absolute = path.resolve(root, candidate);
      if (existsSync(absolute)) {
        envFileAbs = absolute;
        envFile = candidate;
        enabled = true;
        return;
      }
    }
    if (option === true) {
      throw new Error(
        `[vite-plugin-solid] start.env is enabled but no schema file was found: add ` +
          `${ENV_FILE_CANDIDATES.join(' or ')} at the project root (default-exporting ` +
          `{ server, client } maps of Standard Schema validators), or point start.env ` +
          `at a path.`,
      );
    }
  }

  function envPrefixes(): string[] {
    const prefix = config?.envPrefix ?? 'VITE_';
    return Array.isArray(prefix) ? prefix : [prefix];
  }

  async function loadAndValidate(): Promise<LoadedEnv> {
    const { exported, dependencies } = await (async () => {
      try {
        return await importSchemaModule(envFileAbs!, root, config.mode);
      } catch (error) {
        const reason = error instanceof Error ? `\n\nCause: ${error.message}` : '';
        throw new Error(
          `[vite-plugin-solid] could not load the env schema at ${envFile}. It must be a ` +
            `server-side module default-exporting { server?, client? } maps of Standard ` +
            `Schema validators.${reason}`,
        );
      }
    })();

    const schema = assertSchemaShape(exported, envFile, envPrefixes());
    // Types depend only on the schema, not the values: generate before
    // validating so a missing variable doesn't also break editor types.
    generateTypes(schema, envFileAbs!);

    // Vite's .env story with `loadEnv` merge priority — process.env wins
    // (CI/pipeline secrets over files), then .env.[mode].local down to .env.
    // The fold into process.env is what removes the template's classic
    // `process.env = { ...process.env, ...loadEnv(mode, root, '') }` line:
    // server code reading process.env directly (db clients, SDKs) sees the
    // file-loaded vars too, in dev, build, and the client-mode prerender.
    const envDir =
      (config as { envDir?: string | false }).envDir === false
        ? null
        : config.envDir || root;
    const folded = foldedKeys();
    for (const key of folded) delete process.env[key];
    folded.clear();
    const fileEnv = envDir ? loadEnv(config.mode, envDir, '') : {};
    for (const [key, value] of Object.entries(fileEnv)) {
      if (!(key in process.env)) {
        process.env[key] = value;
        folded.add(key);
      }
    }
    const raw: Record<string, string> = { ...fileEnv, ...stringEntries(process.env) };

    const issues: Array<{ key: string; message: string; side: 'server' | 'client' }> = [];
    const all: Record<string, unknown> = {};
    for (const side of ['server', 'client'] as const) {
      for (const [key, validator] of Object.entries(schema[side] ?? {})) {
        let result = validator['~standard'].validate(raw[key]);
        if (result instanceof Promise) result = await result;
        if (result.issues && result.issues.length) {
          for (const issue of result.issues) {
            const at = (issue.path ?? [])
              .map((segment) =>
                typeof segment === 'object' && segment !== null && 'key' in segment
                  ? String(segment.key)
                  : String(segment),
              )
              .join('.');
            issues.push({ key: at ? `${key}.${at}` : key, message: issue.message, side });
          }
        } else {
          all[key] = result.value;
        }
      }
    }
    if (issues.length) {
      // Client values are baked at build time, so their failures always
      // fail hard. Server values are read from process.env at boot: a
      // build may legitimately run without them (platform-injected vars),
      // so build-time server failures downgrade to a warning and boot
      // validation enforces. Dev failures stay hard — dev IS runtime.
      const clientIssues = issues.filter((issue) => issue.side === 'client');
      if (!isBuild || clientIssues.length) {
        throw new Error(
          formatValidationError(!isBuild ? issues : clientIssues, envFile, config.mode),
        );
      }
      config.logger.warn(
        `\n[vite-plugin-solid] server env not valid at build time (deferred to boot ` +
          `validation — server env is read from process.env at runtime):\n` +
          issues.map(({ key, message }) => `  ⚠ ${key}: ${message}`).join('\n') +
          '\n',
      );
    }

    const client: Record<string, unknown> = {};
    for (const key of Object.keys(schema.client ?? {})) client[key] = all[key];

    return { schema, all, client, dependencies };
  }

  function ensureEnv(): Promise<LoadedEnv> {
    return (envPromise ??= loadAndValidate());
  }

  /**
   * Whether the current hook runs for a server-destined module graph. The
   * environment's `consumer` is authoritative (covers workerd and friends
   * without name lists); classic contexts fall back to the ssr flag.
   */
  function isServerContext(
    ctx: { environment?: { config?: { consumer?: string } } },
    opts?: { ssr?: boolean },
  ): boolean {
    const consumer = ctx.environment?.config?.consumer;
    if (consumer) return consumer === 'server';
    return !!opts?.ssr;
  }

  function serverOnlyError(importer?: string): string {
    return (
      `[vite-plugin-solid] ${SERVER_ENV_ID} is server-only and was imported from the ` +
      `client module graph` +
      (importer ? ` (by ${importer})` : '') +
      `. Server env values must never reach the browser bundle: import ` +
      `${CLIENT_ENV_ID} for the public ${envPrefixes().join('/')}-prefixed vars, or move ` +
      `this import into a server-only module (a "use server" module, middleware, or the ` +
      `server entry).`
    );
  }

  // Baked-JSON module emission (pattern from @vite-env/core, MIT): the
  // validated output values serialize as a frozen object literal, so no
  // validator code exists in the client bundle and tree-shaking sees plain
  // data. `moduleType` marks the virtual source as plain JS for rolldown
  // (Vite 8).
  function envModuleCode(values: Record<string, unknown>) {
    return {
      code:
        `// Generated by vite-plugin-solid (start.env)\n` +
        `export const env = Object.freeze(${JSON.stringify(values)});\n` +
        `export default env;`,
      moduleType: 'js' as const,
    };
  }

  // The server module is NOT baked: server values are read from
  // process.env at module init (server boot) and validated through the
  // user's own schema, imported straight into the server graph (the
  // validator library is server-only, so shipping it there is fine).
  // Client (public) values stay baked — that's what the VITE_ prefix
  // means. Platform-injected vars that don't exist at build time work,
  // secrets rotate without a rebuild, and no secret value exists in any
  // dist artifact.
  function serverEnvModuleCode(loaded: LoadedEnv) {
    const serverKeys = Object.keys(loaded.schema.server ?? {});
    const baked = `const __env = ${JSON.stringify(loaded.client)};`;
    if (!serverKeys.length) {
      return {
        code:
          `// Generated by vite-plugin-solid (start.env) — server env.\n` +
          `${baked}\n` +
          `export const env = Object.freeze(__env);\n` +
          `export default env;`,
        moduleType: 'js' as const,
      };
    }
    return {
      code: [
        `// Generated by vite-plugin-solid (start.env) — server env.`,
        `// Server values are read from process.env and validated at boot;`,
        `// client (public) values are baked at build time.`,
        `import __schema from ${JSON.stringify(envFileAbs)};`,
        baked,
        `const __issues = [];`,
        `for (const __key of ${JSON.stringify(serverKeys)}) {`,
        `  let __result = __schema.server[__key]['~standard'].validate(process.env[__key]);`,
        `  if (__result instanceof Promise) __result = await __result;`,
        `  if (__result.issues && __result.issues.length) {`,
        `    for (const __issue of __result.issues) __issues.push('  \\u2717 ' + __key + ': ' + __issue.message);`,
        `  } else {`,
        `    __env[__key] = __result.value;`,
        `  }`,
        `}`,
        `if (__issues.length) {`,
        `  throw new Error(`,
        `    '[vite-plugin-solid] server env validation failed at boot (' + __issues.length +`,
        `    ' issue' + (__issues.length === 1 ? '' : 's') + ') \\u2014 schema: ' + ${JSON.stringify(envFile)} +`,
        `    '\\n\\n' + __issues.join('\\n') +`,
        `    '\\n\\nServer env is read from process.env at boot, not baked at build time: set the ' +`,
        `    'variables in the server process environment.'`,
        `  );`,
        `}`,
        `export const env = Object.freeze(__env);`,
        `export default env;`,
      ].join('\n'),
      moduleType: 'js' as const,
    };
  }

  return [
    {
      name: 'solid:start-env',

      config(userConfig, env) {
        root = path.resolve(userConfig.root || process.cwd());
        isPreview = !!env.isPreview;
        resolveEnvFile();
        // Preview serves finished artifacts, so no schema loading or
        // validation happens there — but the built server module reads
        // process.env at boot, and `vite preview` should smoke-test the
        // artifact as hands-off as dev runs it: fold the .env files into
        // process.env (real environment still wins). A production process
        // brings its own environment instead.
        if (isPreview && enabled) {
          const envDirOption = (userConfig as { envDir?: string | false }).envDir;
          const envDir =
            envDirOption === false ? null : path.resolve(root, envDirOption || '.');
          if (envDir) {
            const folded = foldedKeys();
            for (const key of folded) delete process.env[key];
            folded.clear();
            const fileEnv = loadEnv(userConfig.mode || env.mode, envDir, '');
            for (const [key, value] of Object.entries(fileEnv)) {
              if (!(key in process.env)) {
                process.env[key] = value;
                folded.add(key);
              }
            }
          }
        }
      },

      configResolved(resolved) {
        config = resolved;
        root = resolved.root;
        isBuild = resolved.command === 'build';
        if (!enabled || isPreview) return;
        // Kick validation off eagerly (the fold must precede any server
        // module execution); buildStart awaits it and owns error routing.
        ensureEnv().catch(() => {});
      },

      async buildStart() {
        if (!enabled) return;
        try {
          await ensureEnv();
        } catch (error) {
          // Builds fail with the report; dev logs it once and lets the
          // virtual modules rethrow on load, which renders Vite's error
          // overlay (client imports) or the overlay-enabled 500 (SSR).
          if (isBuild) throw error;
          if (!devErrorLogged) {
            devErrorLogged = true;
            config.logger.error(
              '\n' + (error instanceof Error ? error.message : String(error)) + '\n',
            );
          }
        }
      },

      resolveId(source, importer, options) {
        if (!enabled) return null;
        if (source === CLIENT_ENV_ID) return RESOLVED_CLIENT_ENV_ID;
        if (source === SERVER_ENV_ID) {
          // The dep scanner probes client entries' import graphs without
          // executing them; deny real client-graph imports only (the load
          // hook double-checks — scanners never load `\0` ids).
          if (!(options as { scan?: boolean } | undefined)?.scan && !isServerContext(this, options)) {
            this.error(serverOnlyError(importer));
          }
          return RESOLVED_SERVER_ENV_ID;
        }
        return null;
      },

      async load(id, opts) {
        if (!enabled) return null;
        if (id !== RESOLVED_CLIENT_ENV_ID && id !== RESOLVED_SERVER_ENV_ID) return null;
        // Throws the validation report when env is invalid — the dev
        // overlay / failed build carries the per-key details.
        const loaded = await ensureEnv();
        if (id === RESOLVED_SERVER_ENV_ID) {
          if (!isServerContext(this, opts)) this.error(serverOnlyError());
          return serverEnvModuleCode(loaded);
        }
        return envModuleCode(loaded.client);
      },

      configureServer(server: ViteDevServer) {
        if (!enabled) return;
        const envDir =
          (config as { envDir?: string | false }).envDir === false
            ? null
            : config.envDir || root;
        // Explicit file list (no globs — chokidar 4 dropped them): the four
        // .env variants Vite consults for this mode, the schema module, and
        // whatever it transitively loaded.
        const envFiles = envDir
          ? ['.env', '.env.local', `.env.${config.mode}`, `.env.${config.mode}.local`].map(
              (file) => path.join(envDir, file),
            )
          : [];
        const watched = new Set<string>([...envFiles, envFileAbs!]);
        server.watcher.add([...watched]);
        ensureEnv()
          .then(({ dependencies }) => {
            for (const dep of dependencies) watched.add(dep);
            server.watcher.add(dependencies);
          })
          .catch(() => {});

        // Live revalidation (flow from @vite-env/core, MIT): reload sources,
        // rerun the schema, invalidate both virtual modules in every
        // environment, and full-reload — on failure the reload makes the
        // client re-import the virtual module, whose load() now throws the
        // fresh report into the error overlay.
        let debounce: ReturnType<typeof setTimeout> | undefined;
        const onFileEvent = (file: string) => {
          if (!watched.has(file)) return;
          clearTimeout(debounce);
          debounce = setTimeout(async () => {
            envPromise = null;
            devErrorLogged = false;
            let failed = false;
            try {
              const { dependencies } = await ensureEnv();
              for (const dep of dependencies) watched.add(dep);
              server.watcher.add(dependencies);
            } catch (error) {
              failed = true;
              devErrorLogged = true;
              config.logger.error(
                '\n' + (error instanceof Error ? error.message : String(error)) + '\n',
              );
            }
            let invalidated = false;
            for (const environment of Object.values(server.environments ?? {})) {
              const graph = (environment as { moduleGraph?: any }).moduleGraph;
              if (!graph) continue;
              for (const id of [RESOLVED_CLIENT_ENV_ID, RESOLVED_SERVER_ENV_ID]) {
                const mod = graph.getModuleById(id);
                if (mod) {
                  graph.invalidateModule(mod);
                  invalidated = true;
                }
              }
            }
            if (invalidated) {
              const hot = server.hot ?? (server as any).ws;
              hot?.send({ type: 'full-reload' });
            }
            if (!failed) {
              config.logger.info(`[vite-plugin-solid] env revalidated (${envFile})`);
            }
          }, 100);
        };
        server.watcher.on('change', onFileEvent);
        server.watcher.on('add', onFileEvent);
        server.watcher.on('unlink', onFileEvent);
      },

      // Leak scan (heuristics from @vite-env/core, MIT): a server var's
      // *value* appearing as a quoted string literal in a client chunk means
      // something inlined it (an env.ts import from shared code, a define,
      // a copy-paste). Values under 8 chars skip (too collision-prone), as
      // do values shared with a client var and pure-vendor chunks.
      async generateBundle(_options, bundle) {
        if (!enabled || !isBuild || isServerContext(this, { ssr: !!config.build.ssr })) return;
        const loaded = await ensureEnv().catch(() => null);
        if (!loaded) return;

        const clientValues = new Set(Object.values(loaded.client));
        const secrets = Object.entries(loaded.all).filter(
          (entry): entry is [string, string] =>
            !(entry[0] in loaded.client) &&
            typeof entry[1] === 'string' &&
            entry[1].length >= 8 &&
            !clientValues.has(entry[1]),
        );
        if (!secrets.length) return;

        const leaks: string[] = [];
        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk' || !chunk.code) continue;
          const moduleIds = (chunk as { moduleIds?: string[] }).moduleIds ?? [];
          if (moduleIds.length > 0 && moduleIds.every((id) => /[\\/]node_modules[\\/]/.test(id)))
            continue;
          for (const [key, value] of secrets) {
            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`(["'\`])${escaped}\\1`).test(chunk.code)) {
              leaks.push(`${key} in ${fileName}`);
            }
          }
        }
        if (leaks.length) {
          this.error(
            `[vite-plugin-solid] server env values leaked into client chunks:\n` +
              leaks.map((leak) => `  ✗ ${leak}`).join('\n') +
              `\n\nServer env values belong to the server process only (they are not even ` +
              `baked into the server bundle). Check for hand-inlined values and imports of ` +
              `the env schema module from client code, and use ${SERVER_ENV_ID} from ` +
              `server-only modules instead.`,
          );
        }
      },
    },
  ];
}
