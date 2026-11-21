// Helpers shared by the specs. Users are created through the API on a browser context's own
// request client, so the session cookie lands in that context (= that user's "browser window").
import { expect } from '@playwright/test';

export const PASSWORD = 'e2e-password-1';
export const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A fresh browser context signed in as a new user. */
export async function newUser(browser, { role, company, name }) {
  const context = await browser.newContext();
  const email = `${role.toLowerCase()}-${uid()}@e2e.test`;
  const res = await context.request.post('/api/auth/register', {
    data: { email, name: name || email, role, companyName: company, password: PASSWORD },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { user } = await res.json();
  const page = await context.newPage();
  return { context, page, user, email };
}

/** Create an RFQ over the API as `buyer` (for scenarios that need precise timings). */
export async function createRfqApi(buyer, supplierIds, overrides = {}) {
  const now = Date.now();
  const res = await buyer.context.request.post('/api/rfqs', {
    data: {
      referenceId: `E2E-${uid()}`, name: `E2E lane ${uid()}`, pickupDate: '2026-12-31', currency: 'USD',
      bidStartAt: now - 60_000, bidCloseAt: now + 30 * 60_000, forcedCloseAt: now + 60 * 60_000,
      triggerWindowMinutes: 10, extensionMinutes: 5, triggerType: 'BID_RECEIVED',
      invitedSupplierIds: supplierIds, ...overrides,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

export async function bidApi(supplier, rfqId, freight) {
  const res = await supplier.context.request.post(`/api/rfqs/${rfqId}/bids`, {
    data: { carrierName: 'API Carrier', freightCharges: String(freight), originCharges: '0', destinationCharges: '0', transitTimeDays: 7, quoteValidUntil: '2026-12-31' },
  });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

/** Value for <input type="datetime-local"> in the browser's local time, rounded down to the minute. */
export function localInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Place a bid through the supplier UI (review → confirm). */
export async function placeBidUi(page, { freight, carrier = 'UI Carrier', transit = '10' }) {
  const carrierInput = page.getByLabel('Carrier name');
  if (!(await carrierInput.inputValue())) await carrierInput.fill(carrier);
  const transitInput = page.getByLabel('Transit time (days)');
  if (!(await transitInput.inputValue())) await transitInput.fill(transit);
  await page.getByLabel(/Freight charges/).fill(String(freight));
  await page.getByRole('button', { name: 'Review bid' }).click();
  await page.getByRole('button', { name: 'Confirm bid' }).click();
  await expect(page.getByRole('status')).toContainText('Bid placed');
}
