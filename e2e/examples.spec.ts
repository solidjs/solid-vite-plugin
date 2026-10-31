import { expect, test } from '@playwright/test';

test('increments the counter', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1', { hasText: /(?:Count|Counter): 0/ })).toBeVisible();
  await page.getByRole('button', { name: 'Increment' }).click();
  await expect(page.locator('h1', { hasText: /(?:Count|Counter): 1/ })).toBeVisible();
});
