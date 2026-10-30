// CSS module class names in JSX, in builds. `class={styles.button}` reads a
// member of an imported object, so Solid's compiler has to treat it as
// reactive: it emits an effect instead of putting the class in the
// element's template. A build's class names are fixed, so they are inlined
// as strings first, read from Vite's own output for the CSS module.
//
// An import whose every use was inlined would be dropped (TypeScript elides
// it, and Vite drops a CSS module's stylesheet once no export is used), so
// it becomes a bare import, and `plugin` keeps the module whole. A module
// someone else loaded first can no longer be marked, so it stays as written.
import MagicString from 'magic-string';
import { parseSync, type Plugin, type Rolldown, Visitor, withFilter } from 'vite';

export const CSS_MODULE_ID =
  /\.module\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;
const MAY_IMPORT_CSS_MODULE = /\.module\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)\b/;

interface CssModuleImport {
  /** Where the import declaration starts. */
  declaration: number;
  source: string;
  /** `default` (an object of class names), `*` (the module), or a named class. */
  imported: string;
}

export function createCssModuleClasses() {
  const requested = new Set<string>();
  const kept = new Set<string>();

  const plugin: Plugin = {
    name: 'solid:css-module-classes',
    apply: 'build',
    enforce: 'post',
    transform(code, id) {
      if (!requested.has(id)) return null;
      kept.add(id);
      return { code, map: null, moduleSideEffects: 'no-treeshake' };
    },
  };
  withFilter(plugin, { transform: { id: CSS_MODULE_ID } });

  async function inline(
    ctx: Rolldown.TransformPluginContext,
    code: string,
    id: string,
    typescript: boolean,
  ): Promise<{ code: string; map: string } | null> {
    if (!MAY_IMPORT_CSS_MODULE.test(code)) return null;
    const parsed = parseSync(id, code, { lang: typescript ? 'tsx' : 'jsx', sourceType: 'module' });
    if (parsed.errors.length) return null;

    const imports = new Map<string, CssModuleImport>();
    for (const statement of parsed.program.body) {
      if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
      const source = statement.source.value;
      if (!CSS_MODULE_ID.test(source)) continue;
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue;
        imports.set(specifier.local.name, {
          declaration: statement.start,
          source,
          imported:
            specifier.type === 'ImportDefaultSpecifier'
              ? 'default'
              : specifier.type === 'ImportNamespaceSpecifier'
                ? '*'
                : specifier.imported.type === 'Identifier'
                  ? specifier.imported.name
                  : String(specifier.imported.value),
        });
      }
    }
    if (!imports.size) return null;
    // A name declared anywhere else might shadow its import somewhere.
    for (const name of declaredNames(parsed.program)) imports.delete(name);

    // Class names per source, from Vite's output for the module.
    const classes = new Map<string, CssModuleExports | null>();
    for (const { source } of imports.values()) {
      if (classes.has(source)) continue;
      classes.set(source, null);
      const resolved = await ctx.resolve(source, id);
      if (!resolved || resolved.external) continue;
      requested.add(resolved.id);
      const info = await ctx.load({ id: resolved.id });
      if (kept.has(resolved.id) && info.code) classes.set(source, cssModuleExports(info.code));
    }
    for (const [name, entry] of imports) if (!classes.get(entry.source)) imports.delete(name);
    if (!imports.size) return null;

    const className = (expression: any): { value: string; references: number[] } | null => {
      if (expression.type === 'Identifier') {
        const entry = imports.get(expression.name);
        const value = entry && classes.get(entry.source)!.named.get(entry.imported);
        return value === undefined ? null : { value, references: [expression.start] };
      }
      if (expression.type === 'MemberExpression' && expression.object.type === 'Identifier') {
        const entry = imports.get(expression.object.name);
        if (!entry || (entry.imported !== 'default' && entry.imported !== '*')) return null;
        const key = expression.computed
          ? expression.property.type === 'Literal' && typeof expression.property.value === 'string'
            ? expression.property.value
            : null
          : expression.property.name;
        const exports = classes.get(entry.source)!;
        const value =
          key === null
            ? undefined
            : (entry.imported === '*' ? exports.named : exports.default).get(key);
        return value === undefined ? null : { value, references: [expression.object.start] };
      }
      if (expression.type === 'TemplateLiteral') {
        let value = expression.quasis[0].value.cooked;
        const references: number[] = [];
        for (let index = 0; index < expression.expressions.length; index++) {
          const part = className(expression.expressions[index]);
          const text = expression.quasis[index + 1].value.cooked;
          if (!part || value == null || text == null) return null;
          value += part.value + text;
          references.push(...part.references);
        }
        return value == null || !references.length ? null : { value, references };
      }
      return null;
    };

    const s = new MagicString(code);
    const inlined = new Set<number>();
    const references = new Map<string, number[]>();
    const notReferences = new Set<number>();
    new Visitor({
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) notReferences.add(specifier.local.start);
      },
      MemberExpression(node) {
        if (!node.computed) notReferences.add(node.property.start);
      },
      Property(node) {
        if (!node.computed && !node.shorthand) notReferences.add(node.key.start);
      },
      MethodDefinition(node) {
        if (!node.computed) notReferences.add(node.key.start);
      },
      PropertyDefinition(node) {
        if (!node.computed) notReferences.add(node.key.start);
      },
      JSXAttribute(node) {
        const value = node.value;
        if (value?.type !== 'JSXExpressionContainer') return;
        const result = className(value.expression);
        if (!result) return;
        s.overwrite(value.start, value.end, `{${JSON.stringify(result.value)}}`);
        for (const reference of result.references) inlined.add(reference);
      },
      Identifier(node) {
        if (!imports.has(node.name) || notReferences.has(node.start)) return;
        references.set(node.name, [...(references.get(node.name) ?? []), node.start]);
      },
      // A JSX name (`<styles.Item />`) is a use too, never inlined.
      JSXIdentifier(node) {
        if (imports.has(node.name)) {
          references.set(node.name, [...(references.get(node.name) ?? []), -1]);
        }
      },
    }).visit(parsed.program);
    if (!inlined.size) return null;

    // A declaration whose every binding is now unused stays as a bare import.
    const declarations = new Map<number, string[]>();
    for (const [name, entry] of imports) {
      declarations.set(entry.declaration, [...(declarations.get(entry.declaration) ?? []), name]);
    }
    for (const statement of parsed.program.body) {
      if (statement.type !== 'ImportDeclaration' || !declarations.has(statement.start)) continue;
      const names = declarations.get(statement.start)!;
      const unused = (name: string) =>
        (references.get(name) ?? []).every((reference) => inlined.has(reference));
      if (names.length === statement.specifiers.length && names.every(unused)) {
        s.overwrite(statement.start, statement.end, `import ${statement.source.raw};`);
      }
    }
    return {
      code: s.toString(),
      map: s.generateMap({ hires: 'boundary', source: id, includeContent: true }).toString(),
    };
  }

  return { plugin, inline };
}

interface CssModuleExports {
  /** The default export's class names, by key. */
  default: Map<string, string>;
  /** Named exports (the classes whose names are identifiers). */
  named: Map<string, string>;
}

// Vite's CSS module output: `export const a = "..."` per identifier class,
// and `export default { a: a, "b-c": "..." }`.
function cssModuleExports(code: string): CssModuleExports {
  const exports: CssModuleExports = { default: new Map(), named: new Map() };
  const parsed = parseSync('module.js', code, { sourceType: 'module' });
  for (const statement of parsed.program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.declaration?.type !== 'VariableDeclaration') continue;
      for (const declarator of statement.declaration.declarations) {
        const init = declarator.init;
        if (declarator.id.type === 'Identifier' && init?.type === 'Literal') {
          if (typeof init.value === 'string') exports.named.set(declarator.id.name, init.value);
        }
      }
    } else if (
      statement.type === 'ExportDefaultDeclaration' &&
      statement.declaration.type === 'ObjectExpression'
    ) {
      for (const property of statement.declaration.properties) {
        if (property.type !== 'Property' || property.computed) continue;
        const key =
          property.key.type === 'Identifier'
            ? property.key.name
            : String((property.key as any).value);
        const value = property.value;
        if (value.type === 'Literal' && typeof value.value === 'string') {
          exports.default.set(key, value.value);
        } else if (value.type === 'Identifier' && exports.named.has(value.name)) {
          exports.default.set(key, exports.named.get(value.name)!);
        }
      }
    }
  }
  return exports;
}

// Every binding name the module declares, besides its imports.
function declaredNames(program: any): Set<string> {
  const names = new Set<string>();
  const addPattern = (pattern: any): void => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') names.add(pattern.name);
    else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        addPattern(property.type === 'RestElement' ? property.argument : property.value);
      }
    } else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(addPattern);
    else if (pattern.type === 'RestElement') addPattern(pattern.argument);
    else if (pattern.type === 'AssignmentPattern') addPattern(pattern.left);
    else if (pattern.type === 'TSParameterProperty') addPattern(pattern.parameter);
  };
  const addFunction = (node: any) => {
    if (node.id) names.add(node.id.name);
    node.params.forEach(addPattern);
  };
  new Visitor({
    VariableDeclarator: (node) => addPattern(node.id),
    FunctionDeclaration: addFunction,
    FunctionExpression: addFunction,
    ArrowFunctionExpression: addFunction,
    ClassDeclaration: (node) => node.id && names.add(node.id.name),
    ClassExpression: (node) => node.id && names.add(node.id.name),
    CatchClause: (node) => addPattern(node.param),
  }).visit(program);
  return names;
}
