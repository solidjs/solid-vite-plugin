/// <reference types="@vitest/browser/providers/playwright" />
import { render } from '@solidjs/testing-library';
import { page } from 'vitest/browser';
import { expect, test } from 'vitest';

import App from '../src/App.jsx';

test('App', async () => {
  const root = page.elementLocator(render(() => <App />).baseElement);

  const count = root.getByText('Counter:');
  await expect.element(count).toHaveTextContent('Counter: 0');

  const incrementButton = root.getByText('Increment');
  await incrementButton.click();
  await expect.element(count).toHaveTextContent('Counter: 1');

  const decrementButton = root.getByText('Decrement');
  await decrementButton.click();
  await expect.element(count).toHaveTextContent('Counter: 0');

  const tsrxCard = root.getByTestId('tsrx-card');
  await expect.element(tsrxCard).toHaveTextContent('TSRX scoped styles');
  await expect.element(tsrxCard).toHaveAttribute('data-server-function', 'function');
  await expect.element(tsrxCard).toHaveStyle({ color: 'rgb(12, 34, 56)' });
});
