/**
 * Cross-instance-safe stand-in for vite's `isRunnableDevEnvironment`.
 *
 * Vite's helper is an `instanceof RunnableDevEnvironment` check against the
 * class of whichever `vite` module the CALLER imported. When this plugin is
 * consumed through a workspace/`link:` install, its own `vite` import can
 * resolve to a different physical copy than the one running the dev server —
 * and then the `instanceof` is false for every environment, silently standing
 * the SSR/dev middlewares down. The `runner` accessor is the type's defining
 * member (`RunnableDevEnvironment` is exactly "a DevEnvironment with a
 * runner"), so presence-check it instead of trusting class identity.
 */
export function isRunnableEnvironment(environment: unknown): boolean {
  return !!environment && typeof environment === 'object' && 'runner' in environment;
}
