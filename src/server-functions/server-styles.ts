// Stylesheets below a `'use server'` boundary, for the client build (#456).
//
// The client compile replaces a server module with references, so nothing it
// imported reaches the client graph: a server component's stylesheet gets no
// client asset and the SSR document links nothing for it. Dev never notices,
// since its CSS crawl walks the SSR graph. The walk below finds what the
// module reaches in the client environment and returns those stylesheets for
// the client module to import. Script modules are only loaded (which runs
// their transforms, so compile-time CSS such as StyleX records its rules),
// never imported, so no server code joins the client bundle.

import { isTsrxCssModule } from '../tsrx.js';

const cssFileRegExp = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)$/;
// The importer controls a queried stylesheet; it is not an ambient style.
const nonAmbientQueryRegExp = /[?&](url|inline|raw)\b/;

const isStylesheet = (id: string) =>
  (cssFileRegExp.test(id.split('?')[0]!) || isTsrxCssModule(id)) &&
  !nonAmbientQueryRegExp.test(id);

/** The module's runtime import specifiers (type-only ones dropped). */
function importSources(ctx: any, code: string): string[] {
  let program;
  try {
    program = ctx.parse(code, { lang: 'tsx' });
  } catch {
    return [];
  }
  const sources: string[] = [];
  for (const node of program.body) {
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.source &&
      node.importKind !== 'type' &&
      node.exportKind !== 'type'
    ) {
      sources.push(node.source.value);
    }
  }
  return sources;
}

/** Side-effect imports of the stylesheets a server module reaches. */
export async function serverModuleStyles(ctx: any, id: string, code: string): Promise<string> {
  const seen = new Set([id]);
  const styles = new Set<string>();
  const visit = async (resolved: string) => {
    if (seen.has(resolved)) return;
    seen.add(resolved);
    if (isStylesheet(resolved)) {
      styles.add(resolved);
      return;
    }
    let info;
    try {
      info = await ctx.load({ id: resolved });
    } catch {
      // A module the client environment can't load has no client styles.
      return;
    }
    for (const next of info?.importedIds ?? []) await visit(next);
  };
  for (const source of importSources(ctx, code)) {
    const resolved = await ctx.resolve(source, id).catch(() => null);
    if (resolved && !resolved.external) await visit(resolved.id);
  }
  let out = '';
  for (const style of styles) out += `\nimport ${JSON.stringify(style)};`;
  return out;
}
