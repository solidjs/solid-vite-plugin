// Preloaded into the vitest workers (NODE_OPTIONS=--import) by the vitest
// mode of test/run.mjs. It makes Node resolve bare imports the way Deno does.
// In worker threads, Deno does not apply the `browser` condition that vitest
// passes to the workers as `--conditions`, so an externalized package's own
// `import "@solidjs/web"` resolves `deno`/`node`, which is the server build
// (#369).
import module from 'node:module';

const denoConditions = (context) => ({
  ...context,
  conditions: [...context.conditions.filter((c) => c !== 'browser'), 'deno'],
});

if (module.registerHooks) {
  module.registerHooks({
    resolve: (specifier, context, next) => next(specifier, denoConditions(context)),
  });
} else {
  // Node < 22.15 has only the async loader API.
  module.register(
    'data:text/javascript,' +
      encodeURIComponent(`
        export async function resolve(specifier, context, next) {
          const conditions = context.conditions.filter((c) => c !== 'browser');
          return next(specifier, { ...context, conditions: [...conditions, 'deno'] });
        }
      `),
  );
}
