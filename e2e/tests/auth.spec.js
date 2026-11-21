import { test, expect } from '@playwright/test';
import { uid, PASSWORD, newUser } from './fixtures.js';

test('register as a supplier, sign out, sign back in', async ({ page }) => {
  const email = `ui-${uid()}@e2e.test`;
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/); // protected pages redirect
  await page.getByRole('link', { name: 'Create one' }).click();
  await page.getByLabel('Supplier / Carrier', { exact: true }).check();
  await page.getByLabel('Your name').fill('UI Supplier');
  await page.getByLabel(/Company name/).fill(`UI Lines ${uid()}`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Auctions you are invited to' })).toBeVisible();
  await expect(page.locator('.role-pill')).toHaveText('Supplier');
  await expect(page.getByRole('link', { name: '+ New RFQ' })).toHaveCount(0); // buyer-only

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel(/^Password/).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password');
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Auctions you are invited to' })).toBeVisible();
});

test('field errors from the server appear under the right input', async ({ page, browser }) => {
  const existing = await newUser(browser, { role: 'BUYER' });
  await page.goto('/register');
  await page.getByLabel('Buyer', { exact: true }).check();
  await page.getByLabel('Your name').fill('Dup');
  await page.getByLabel('Email', { exact: true }).fill(existing.email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('An account with this email already exists')).toBeVisible();
  await existing.context.close();
});

test('suppliers cannot reach buyer-only pages', async ({ browser }) => {
  const sup = await newUser(browser, { role: 'SUPPLIER', company: `Gate ${uid()}` });
  await sup.page.goto('/rfqs/new');
  await expect(sup.page).toHaveURL(/\/$/);
  await sup.page.goto('/dashboard');
  await expect(sup.page).toHaveURL(/\/$/);
  await sup.context.close();
});
