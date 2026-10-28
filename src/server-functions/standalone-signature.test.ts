import { expect, it } from 'vitest';
import { createServerFunctionsPlugins, serverFunctions } from './index.js';

it('the standalone export ignores the internal wiring parameter', () => {
  const internal = { devMiddleware: true, tsrxAfterSolid: true };
  const names = (plugins: { name: string }[]) => plugins.map((plugin) => plugin.name);
  expect(
    names((serverFunctions as (...args: unknown[]) => { name: string }[])({}, internal)),
  ).toEqual(names(serverFunctions()));
  // The internal path does honor it, so the comparison above is meaningful.
  expect(names(createServerFunctionsPlugins({}, internal))).not.toEqual(names(serverFunctions()));
});
