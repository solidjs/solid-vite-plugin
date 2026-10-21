import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as compiler from '@solidjs/compiler';
import solidPlugin from './index.js';
import {
  detectLocationSupport,
  getJsxSourceNamesOptions,
  getPrimitiveNamesOptions,
  getSourceNames,
  requestedLocations,
  type LocationProbeCompiler,
} from './source-names.js';

const ROOT = '/app';
const ALL_ON = { components: true, bindings: true, primitives: true, locations: true };
const ALL_OFF = { components: false, bindings: false, primitives: false, locations: false };

/**
 * A compiler that validates like `@solidjs/compiler` 2.0.0-rc.14 — the
 * release before the `locations` kind: an unknown key throws.
 */
function strictCompiler(known: {
  transform: string[];
  sourceNames: string[];
  transformSourceNames: string[];
}): LocationProbeCompiler & { calls: unknown[] } {
  const reject = (keys: string[], options: Record<string, unknown>, what: string) => {
    for (const key of Object.keys(options)) {
      if (!keys.includes(key)) throw new Error(`received unknown ${what} \`${key}\``);
    }
  };
  const calls: unknown[] = [];
  return {
    calls,
    transform(_code, options: Record<string, unknown> = {}) {
      calls.push(options);
      reject(known.transform, options, 'option');
      if (typeof options.sourceNames === 'object' && options.sourceNames) {
        reject(
          known.sourceNames,
          options.sourceNames as Record<string, unknown>,
          '`sourceNames` kind',
        );
      }
      return { code: '', map: null };
    },
    transformSourceNames(_code, options: Record<string, unknown> = {}) {
      calls.push(options);
      reject(known.transformSourceNames, options, 'option');
      return { code: '', map: null };
    },
  };
}

const RC14_KEYS = {
  transform: ['filename', 'generate', 'hydratable', 'dev', 'sourceNames', 'sourceMap'],
  sourceNames: ['components', 'bindings'],
  transformSourceNames: ['filename', 'sourceMap'],
};
const LOCATIONS_KEYS = {
  transform: [...RC14_KEYS.transform, 'root'],
  sourceNames: [...RC14_KEYS.sourceNames, 'locations'],
  transformSourceNames: [...RC14_KEYS.transformSourceNames, 'locations', 'root'],
};

describe('getSourceNames', () => {
  it('turns every kind on under dev, locations included', () => {
    expect(getSourceNames(undefined, true, false)).toEqual(ALL_ON);
    expect(getSourceNames(undefined, true, true)).toEqual(ALL_ON);
  });

  it('keeps locations off under observe alone: a production bundle', () => {
    expect(getSourceNames(undefined, false, true)).toEqual({ ...ALL_ON, locations: false });
  });

  it('turns every kind off for a production build', () => {
    expect(getSourceNames(undefined, false, false)).toEqual(ALL_OFF);
  });

  it('`true` turns every kind on whatever the posture, `false` every kind off', () => {
    expect(getSourceNames(true, false, false)).toEqual(ALL_ON);
    expect(getSourceNames(true, false, true)).toEqual(ALL_ON);
    expect(getSourceNames(false, true, false)).toEqual(ALL_OFF);
    expect(getSourceNames(false, false, true)).toEqual(ALL_OFF);
  });

  it('the object form sets the listed kinds and leaves the rest at the posture', () => {
    expect(getSourceNames({ locations: true }, false, true)).toEqual(ALL_ON);
    expect(getSourceNames({ locations: true }, false, false)).toEqual({
      ...ALL_OFF,
      locations: true,
    });
    expect(getSourceNames({ locations: false }, true, false)).toEqual({
      ...ALL_ON,
      locations: false,
    });
    expect(getSourceNames({ primitives: false }, true, false)).toEqual({
      ...ALL_ON,
      primitives: false,
    });
    expect(getSourceNames({ components: false }, false, true)).toEqual({
      components: false,
      bindings: true,
      primitives: true,
      locations: false,
    });
  });
});

describe('requestedLocations', () => {
  it('is only an explicit ask', () => {
    expect(requestedLocations(true)).toBe(true);
    expect(requestedLocations({ locations: true })).toBe(true);
    expect(requestedLocations(undefined)).toBe(false);
    expect(requestedLocations(false)).toBe(false);
    expect(requestedLocations({})).toBe(false);
    expect(requestedLocations({ locations: false })).toBe(false);
    expect(requestedLocations({ components: true })).toBe(false);
  });
});

describe('detectLocationSupport', () => {
  it('is false for a compiler that rejects the keys', () => {
    expect(detectLocationSupport(strictCompiler(RC14_KEYS))).toBe(false);
  });

  it('is false for a compiler without the primitives pass', () => {
    const { transform } = strictCompiler(LOCATIONS_KEYS);
    expect(detectLocationSupport({ transform })).toBe(false);
  });

  it('is false when only one of the two functions takes the keys', () => {
    expect(
      detectLocationSupport(
        strictCompiler({ ...LOCATIONS_KEYS, transformSourceNames: RC14_KEYS.transformSourceNames }),
      ),
    ).toBe(false);
    expect(
      detectLocationSupport(
        strictCompiler({ ...LOCATIONS_KEYS, sourceNames: RC14_KEYS.sourceNames }),
      ),
    ).toBe(false);
  });

  it('is true for a compiler that takes them, and probes with empty modules', () => {
    const stub = strictCompiler(LOCATIONS_KEYS);
    expect(detectLocationSupport(stub)).toBe(true);
    expect(stub.calls).toEqual([
      { filename: '/probe.jsx', root: '/', sourceNames: { locations: true } },
      { filename: '/probe.ts', root: '/', locations: true },
    ]);
  });
});

describe('getJsxSourceNamesOptions', () => {
  const dev = getSourceNames(undefined, true, false);

  it('passes locations and root to a compiler that takes them', () => {
    expect(getJsxSourceNamesOptions(dev, { supportsLocations: true, root: ROOT })).toEqual({
      sourceNames: { components: true, bindings: true, locations: true },
      root: ROOT,
    });
  });

  it('passes the resolved `locations: false` without root', () => {
    const observe = getSourceNames(undefined, false, true);
    const result = getJsxSourceNamesOptions(observe, { supportsLocations: true, root: ROOT });
    expect(result).toEqual({ sourceNames: { components: true, bindings: true, locations: false } });
    expect('root' in result).toBe(false);
  });

  it('leaves both keys out for a compiler that rejects them', () => {
    const result = getJsxSourceNamesOptions(dev, { supportsLocations: false, root: ROOT });
    expect(result).toEqual({ sourceNames: { components: true, bindings: true } });
    expect('locations' in (result.sourceNames as object)).toBe(false);
    expect('root' in result).toBe(false);
    expect(() =>
      strictCompiler(RC14_KEYS).transform('', { ...result, dev: true, generate: 'dom' }),
    ).not.toThrow();
  });

  it('resolves to `sourceNames: false` when neither JSX kind is on', () => {
    const production = getSourceNames(undefined, false, false);
    expect(getJsxSourceNamesOptions(production, { supportsLocations: true, root: ROOT })).toEqual({
      sourceNames: false,
    });
    expect(
      getJsxSourceNamesOptions(
        { ...production, locations: true },
        { supportsLocations: true, root: ROOT },
      ),
    ).toEqual({ sourceNames: false });
  });
});

describe('getPrimitiveNamesOptions', () => {
  const dev = getSourceNames(undefined, true, false);

  it('passes locations and root to a compiler that takes them', () => {
    expect(getPrimitiveNamesOptions(dev, { supportsLocations: true, root: ROOT }, '/a.ts')).toEqual(
      {
        filename: '/a.ts',
        sourceMap: true,
        locations: true,
        root: ROOT,
      },
    );
    const observe = getSourceNames(undefined, false, true);
    expect(
      getPrimitiveNamesOptions(observe, { supportsLocations: true, root: ROOT }, '/a.ts'),
    ).toEqual({ filename: '/a.ts', sourceMap: true, locations: false });
  });

  it('leaves both keys out for a compiler that rejects them', () => {
    const result = getPrimitiveNamesOptions(dev, { supportsLocations: false, root: ROOT }, '/a.ts');
    expect(result).toEqual({ filename: '/a.ts', sourceMap: true });
    expect(() => strictCompiler(RC14_KEYS).transformSourceNames('', result)).not.toThrow();
  });
});

describe('the installed @solidjs/compiler', () => {
  // Whether this compiler takes the kind decides what the assertions below
  // expect, so the suite is green on either side of the compiler release
  // that adds it and proves the plugin degrades (or delivers) accordingly.
  const supportsLocations = detectLocationSupport(compiler);
  const target = { supportsLocations, root: ROOT };
  const dev = getSourceNames(undefined, true, false);

  it('accepts the assembled JSX options and names the component', async () => {
    const result = await compiler.transformAsync('const a = <Home x={y()} />;', {
      generate: 'dom',
      hydratable: false,
      dev: true,
      ...getJsxSourceNamesOptions(dev, target),
      filename: `${ROOT}/src/App.jsx`,
      sourceMap: false,
    });
    expect(result.code).toContain('"Home"');
    if (supportsLocations) expect(result.code).toContain('"src/App.jsx:1:11"');
    else expect(result.code).not.toContain('src/App.jsx:');
  });

  it('accepts the assembled primitives-pass options and names the signal', async () => {
    const result = await compiler.transformSourceNamesAsync(
      'import { createSignal } from "solid-js";\nconst [count] = createSignal(0);\n',
      getPrimitiveNamesOptions(dev, target, `${ROOT}/src/store.ts`),
    );
    expect(result.code).toContain('name: "count"');
    if (supportsLocations) expect(result.code).toContain('loc: "src/store.ts:2:17"');
    else expect(result.code).not.toContain('loc:');
  });
});

describe('the plugin under vite dev', () => {
  const supportsLocations = detectLocationSupport(compiler);
  let root: string;
  let server: ViteDevServer;
  const warnings: string[] = [];

  async function serve(solidOptions: Parameters<typeof solidPlugin>[0]) {
    return createServer({
      root,
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      customLogger: {
        hasWarned: false,
        info() {},
        warn: (message: string) => void warnings.push(message),
        warnOnce: (message: string) => void warnings.push(message),
        error() {},
        clearScreen() {},
        hasErrorLogged: () => false,
      },
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [solidPlugin(solidOptions)],
    });
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'solid-vite-plugin-locations-'));
    // The app imports solid-js / @solidjs/web from this repo's install.
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      path.join(root, 'node_modules'),
      'dir',
    );
    await mkdir(path.join(root, 'src'));
    await writeFile(
      path.join(root, 'src/App.tsx'),
      [
        "import { createSignal } from 'solid-js';",
        'export function Home() {',
        '  const [count, setCount] = createSignal(0);',
        '  return <button onClick={() => setCount(count() + 1)}>{count()}</button>;',
        '}',
        'export const App = () => <Home />;',
        '',
      ].join('\n'),
    );
    await writeFile(path.join(root, 'src/Other.tsx'), 'export const Other = () => <p>other</p>;\n');
  });

  afterAll(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('compiles with names, and with locations exactly when the compiler takes them', async () => {
    server = await serve({});
    const result = await server.environments.client.transformRequest('/src/App.tsx');
    expect(result?.code).toContain('"Home"');
    expect(result?.code).toContain('name: "count"');
    if (supportsLocations) {
      expect(result?.code).toContain('"Home", "src/App.tsx:6:26"');
      expect(result?.code).toContain('loc: "src/App.tsx:3:29"');
    } else {
      // (The refresh pass's own cwd-relative `location` metadata is not a
      // source-names location.)
      expect(result?.code).not.toContain('"Home", "');
      expect(result?.code).not.toContain('loc:');
    }
    expect(warnings.filter((message) => message.includes('locations'))).toEqual([]);
    await server.close();
  });

  it('compiles the same module through the babel backend', async () => {
    server = await serve({ compiler: 'babel' });
    const result = await server.environments.client.transformRequest('/src/App.tsx');
    expect(result?.code).toContain('"Home"');
    expect(result?.code).toContain('name: "count"');
    expect(warnings.filter((message) => message.includes('locations'))).toEqual([]);
    await server.close();
  });

  it('warns once on an older compiler only when locations were asked for', async () => {
    server = await serve({ solid: { sourceNames: { locations: true } } });
    await server.environments.client.transformRequest('/src/App.tsx');
    await server.environments.client.transformRequest('/src/Other.tsx');
    const warned = warnings.filter((message) => message.includes('`locations`'));
    expect(warned).toHaveLength(supportsLocations ? 0 : 1);
    await server.close();
  });
});
