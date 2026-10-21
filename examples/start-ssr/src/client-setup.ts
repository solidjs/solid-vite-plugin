// `start.clientSetup` (SSR_CLIENT_SETUP=1, client-setup mode): the module
// the generated client entry runs before `hydrate()`. This fake proves the
// contract without a real transport wrapper:
// - it starts FIRST: the ordering register it creates is empty, so nothing
//   from the app graph (src/ClientSetupApp.tsx appends at its module top
//   level) has evaluated yet,
// - `hydrate()` waits for it: real async work here (a timer) finishes
//   before the app renders, so ClientSetupApp finds `done` true when it
//   renders during hydration,
// - `marker` is what the HMR check edits on disk: the module has no accept
//   boundary, so an edit must reload the page with the new value.
declare global {
  // eslint-disable-next-line no-var
  var __solidClientSetup:
    | { order: string[]; done: boolean; evaluations: number; marker: string }
    | undefined;
}

const state = (globalThis.__solidClientSetup ??= {
  order: [],
  done: false,
  evaluations: 0,
  marker: '',
});
state.evaluations++;
state.marker = 'client-setup-v1';
state.order.push(`setup:start(before:${state.order.length})`);
await new Promise((resolve) => setTimeout(resolve, 50));
state.order.push('setup:done');
state.done = true;

export {};
