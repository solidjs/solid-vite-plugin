// Vite hook filters (`{ filter, handler }` hooks). Under Rolldown a hook
// whose filter rejects a module is never called from Rust, so the plugin's
// virtual-module hooks and transforms skip the JavaScript call for every
// module they would only return null for. Each handler keeps its own
// checks: a filter only has to let through everything the handler acts on.

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches exactly these ids. */
export function exactIds(...ids: string[]): RegExp {
  return new RegExp(`^(?:${ids.map(escapeRegExp).join('|')})$`);
}

/** Matches ids with one of these extensions (leading dot optional), query allowed. */
export function extensionIds(extensions: string[]): RegExp {
  const names = extensions.map((extension) => escapeRegExp(extension.replace(/^\./, '')));
  return new RegExp(`\\.(?:${names.join('|')})(?:$|\\?)`, 'i');
}
