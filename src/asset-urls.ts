// Asset URLs in JSX. Solid's compiler puts a static attribute such as
// `<img src="./logo.png">` into the element's template as written, so Vite
// never sees the asset: a module-relative URL resolves against the page at
// runtime, and a public-directory URL misses a non-root or relative `base`
// (Electron's file:// builds, sub-path deployments). Like
// @vitejs/plugin-vue's `transformAssetUrls`, the attributes below are
// rewritten before compiling: a relative URL becomes an import of the
// asset, and a `/` URL naming a public-directory file takes the base.
import { existsSync, statSync } from 'fs';
import MagicString from 'magic-string';
import path from 'path';
import { parseSync, Visitor } from 'vite';

/** Elements and their asset URL attributes (plugin-vue's defaults). */
const ASSET_ATTRIBUTES: Record<string, readonly string[]> = {
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'],
};
const MAY_HAVE_ASSET_URLS = /<(?:img|source|video|image|use)[\s/>]/;

export interface AssetUrlOptions {
  /**
   * What a `/name` URL naming a public-directory file becomes: the URL
   * under `base` (an absolute path or URL), an import (builds with a
   * relative base, where the asset plugin emits a chunk-relative URL), or
   * unchanged (`null`, the root base).
   */
  publicUrls: { base: string } | 'import' | null;
  /** Vite's resolved `publicDir`, '' when disabled. */
  publicDir: string;
}

export function transformAssetUrls(
  code: string,
  id: string,
  typescript: boolean,
  options: AssetUrlOptions,
): { code: string; map: string } | null {
  if (!MAY_HAVE_ASSET_URLS.test(code)) return null;
  const parsed = parseSync(id, code, { lang: typescript ? 'tsx' : 'jsx', sourceType: 'module' });
  // The compiler reports syntax errors, with more context.
  if (parsed.errors.length) return null;

  const s = new MagicString(code);
  const imports = new Map<string, string>();
  let nextName = 0;
  const importName = (specifier: string) => {
    let name = imports.get(specifier);
    if (!name) {
      do name = `__solidAsset${nextName++}`;
      while (code.includes(name));
      imports.set(specifier, name);
    }
    return name;
  };

  // One URL as parts (an imported asset's binding or literal text), or
  // null when it stays as written.
  const rewriteUrl = (url: string): Part[] | null => {
    const hashIndex = url.indexOf('#');
    const target = hashIndex === -1 ? url : url.slice(0, hashIndex);
    const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
    const imported = (): Part[] => [{ name: importName(target) }, hash];
    if (/^\.{1,2}\//.test(target)) return imported();
    if (!options.publicUrls || !isPublicFile(target, options.publicDir)) return null;
    if (options.publicUrls === 'import') return imported();
    return [options.publicUrls.base + url.slice(1)];
  };

  // srcset: comma-separated candidates of a URL and an optional descriptor.
  // Data URLs carry commas, so a srcset with one stays as written.
  const rewriteSrcset = (value: string): Part[] | null => {
    if (value.includes('data:')) return null;
    let changed = false;
    const parts: Part[] = [];
    for (const candidate of value.split(',')) {
      const [url, ...descriptor] = candidate.trim().split(/\s+/);
      if (!url) continue;
      const rewritten = rewriteUrl(url);
      if (rewritten) changed = true;
      if (parts.length) parts.push(', ');
      parts.push(...(rewritten ?? [url]), ...descriptor.map((text) => ' ' + text));
    }
    return changed ? parts : null;
  };

  new Visitor({
    JSXOpeningElement(node) {
      if (node.name.type !== 'JSXIdentifier') return;
      const attributes = ASSET_ATTRIBUTES[node.name.name];
      if (!attributes) return;
      for (const attribute of node.attributes) {
        if (attribute.type !== 'JSXAttribute' || !attribute.value) continue;
        const name =
          attribute.name.type === 'JSXNamespacedName'
            ? `${attribute.name.namespace.name}:${attribute.name.name.name}`
            : attribute.name.name;
        if (!attributes.includes(name)) continue;
        const value = stringValue(attribute.value);
        if (value === null) continue;
        const parts = name === 'srcset' ? rewriteSrcset(value) : rewriteUrl(value);
        if (parts)
          s.overwrite(attribute.value.start, attribute.value.end, `{${expression(parts)}}`);
      }
    },
  }).visit(parsed.program);
  if (!s.hasChanged()) return null;

  if (imports.size) {
    const statements = [...imports]
      .map(([specifier, name]) => `import ${name} from ${JSON.stringify(specifier)};`)
      .join('\n');
    // After the directive prologue ("use server" must stay first).
    let end = 0;
    for (const statement of parsed.program.body) {
      if (statement.type !== 'ExpressionStatement' || !('directive' in statement)) break;
      end = statement.end;
    }
    if (end) s.appendLeft(end, '\n' + statements);
    else s.prepend(statements + '\n');
  }
  return {
    code: s.toString(),
    map: s.generateMap({ hires: 'boundary', source: id, includeContent: true }).toString(),
  };
}

/** Literal text, or the binding of an imported asset's URL. */
type Part = string | { name: string };

// A plain string (a base-prefixed public URL) compiles into the static
// template; an imported URL alone is its binding, set once; anything else is
// a template literal.
function expression(parts: Part[]): string {
  const filled = parts.filter((part) => part !== '');
  if (filled.every((part) => typeof part === 'string')) return JSON.stringify(filled.join(''));
  if (filled.length === 1) return (filled[0] as { name: string }).name;
  const body = filled
    .map((part) =>
      typeof part === 'string'
        ? part.replace(/\\|`|\$\{/g, (match) => '\\' + match)
        : '${' + part.name + '}',
    )
    .join('');
  return '`' + body + '`';
}

function stringValue(value: any): string | null {
  if (value.type === 'Literal') return typeof value.value === 'string' ? value.value : null;
  if (value.type !== 'JSXExpressionContainer') return null;
  const expression = value.expression;
  if (expression.type === 'Literal' && typeof expression.value === 'string')
    return expression.value;
  if (expression.type === 'TemplateLiteral' && expression.expressions.length === 0) {
    return expression.quasis[0].value.cooked ?? null;
  }
  return null;
}

function isPublicFile(url: string, publicDir: string): boolean {
  if (!publicDir || !url.startsWith('/') || url.startsWith('//')) return false;
  let pathname = url.replace(/[?#].*$/, '');
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const file = path.join(publicDir, pathname);
  if (!file.startsWith(path.join(publicDir, path.sep))) return false;
  return existsSync(file) && statSync(file).isFile();
}
