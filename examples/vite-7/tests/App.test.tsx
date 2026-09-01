/// <reference types="@vitest/browser/providers/playwright" />
import { render } from '@solidjs/testing-library';
import { page } from '@vitest/browser/context';
import { expect, test } from 'vitest';

import App from '../src/App.jsx';

test('App', async () => {
  const root = page.elementLocator(render(() => <App />).baseElement);

  // Label is a .jsx component — verifies the plugin processes .jsx files correctly
  const label = root.getByTestId('label');
  await expect.element(label).toHaveTextContent('solid');

  const count = root.getByText('Count:');
  await expect.element(count).toHaveTextContent('Count: 0');

  const incrementButton = root.getByText('Increment');
  await incrementButton.click();
  await expect.element(count).toHaveTextContent('Count: 1');

  const decrementButton = root.getByText('Decrement');
  await decrementButton.click();
  await expect.element(count).toHaveTextContent('Count: 0');
});
