import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCssModuleClasses } from './css-module-classes.js';
import solidPlugin from './index.js';

// Vite's output for a CSS module with `.foo` and `.bar-baz`.
const cssOutput =
  'export const foo = "_foo_1";\nexport default {\n\tfoo: foo,\n\t"bar-baz": "_bar-baz_1"\n};\n';

async function inline(code: string, { loadedElsewhere = false } = {}) {
  const classes = createCssModuleClasses();
  const ctx = {
    resolve: async (source: string) => ({ id: '/root/src/' + source.slice(2), external: false }),
    // The post plugin sees a module this pass loads first.
    load: async ({ id }: { id: string }) => {
      if (!loadedElsewhere) (classes.plugin.transform as any).handler(cssOutput, id);
      return { code: cssOutput };
    },
  };
  return (await classes.inline(ctx as any, code, '/root/src/App.tsx', true))?.code;
}

describe('CSS module classes in JSX', () => {
  it('inlines member, bracket, template and named uses', async () => {
    const code = await inline(
      [
        "import styles from './a.module.css';",
        "import { foo } from './b.module.css';",
        'export const A = () => <>',
        '  <div class={styles.foo} />',
        '  <span class={`${styles.foo} ${styles["bar-baz"]}`} />',
        '  <p class={foo} />',
        '</>;',
      ].join('\n'),
    );
    expect(code).toContain('<div class={"_foo_1"} />');
    expect(code).toContain('<span class={"_foo_1 _bar-baz_1"} />');
    expect(code).toContain('<p class={"_foo_1"} />');
    // Every use inlined: the stylesheets stay through bare imports.
    expect(code).toContain("import './a.module.css';");
    expect(code).toContain("import './b.module.css';");
  });

  it('keeps the import while a use remains', async () => {
    const code = await inline(
      "import styles from './a.module.css';\nexport const A = (p) => <div class={styles.foo} id={styles[p.key]} />;",
    );
    expect(code).toContain('<div class={"_foo_1"} id={styles[p.key]} />');
    expect(code).toContain("import styles from './a.module.css';");
  });

  it('leaves a shadowable name, an unknown class and an unmarked module alone', async () => {
    expect(
      await inline(
        "import styles from './a.module.css';\nexport const A = () => <div class={styles.foo} />;\nfunction f(styles) { return styles; }",
      ),
    ).toBeUndefined();
    expect(
      await inline(
        "import styles from './a.module.css';\nexport const A = () => <div class={styles.missing} />;",
      ),
    ).toBeUndefined();
    expect(
      await inline(
        "import styles from './a.module.css';\nexport const A = () => <div class={styles.foo} />;",
        { loadedElsewhere: true },
      ),
    ).toBeUndefined();
  });
});

describe('CSS module classes in a build', () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-css-module-classes-')));
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      path.join(root, 'node_modules'),
      'dir',
    );
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/a.module.css'), '.foo { color: red; }\n');
    await writeFile(path.join(root, 'src/b.module.css'), '.bar { color: blue; }\n');
    await writeFile(
      path.join(root, 'src/main.tsx'),
      [
        "import a from './a.module.css';",
        "import b from './b.module.css';",
        'const App = (props: { key: string }) => <>',
        '  <div class={a.foo} />',
        '  <span class={b[props.key]} />',
        '</>;',
        // A side effect keeps App: app builds drop the entry's exports.
        'globalThis.App = App;',
      ].join('\n'),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('compiles inlined classes into the template and keeps every stylesheet', async () => {
    const result = (await build({
      root,
      configFile: false,
      // Own optimizer cache: node_modules is a symlink to the repo's.
      cacheDir: path.join(root, '.vite'),
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        rollupOptions: { input: path.join(root, 'src/main.tsx') },
      },
      plugins: [solidPlugin()],
    })) as Rollup.RollupOutput;
    const chunk = result.output.find((file) => file.type === 'chunk') as Rollup.OutputChunk;
    const css = result.output
      .filter((file) => file.fileName.endsWith('.css'))
      .map((file) => String((file as Rollup.OutputAsset).source))
      .join('\n');
    expect(chunk.code).toMatch(/<div class=_foo_\w+>/);
    expect(chunk.code).toMatch(/\[props\.key\]/);
    expect(css).toMatch(/\._foo_\w+ \{/);
    expect(css).toMatch(/\._bar_\w+ \{/);
  }, 60_000);
});
