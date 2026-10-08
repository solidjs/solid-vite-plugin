// Build fixture for #396. Not imported by the app. Vite's `define` replaces
// `__SOLID_SERVER_COMPONENTS__` with a boolean literal, and the unused branch
// has to fold away — that is the whole point of a define versus a runtime flag.
declare const __SOLID_SERVER_COMPONENTS__: boolean | undefined;

const marker =
  typeof __SOLID_SERVER_COMPONENTS__ !== 'undefined' && __SOLID_SERVER_COMPONENTS__
    ? 'SC_DEFINE_ON'
    : 'SC_DEFINE_OFF';

console.log(marker);
