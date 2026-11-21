// The headline scenario from the brief, with three real browser windows side by side:
// a buyer creates an RFQ in the UI, two suppliers compete, a late bid extends the auction,
// and every window updates live — with suppliers never seeing each other.
import { test, expect } from '@playwright/test';
import { newUser, uid, localInput, placeBidUi, createRfqApi, bidApi } from './fixtures.js';

test('create RFQ in the UI, two suppliers bid live, late bid extends the auction', async ({ browser }) => {
  const alphaName = `Alpha ${uid()}`;
  const bravoName = `Bravo ${uid()}`;
  const buyer = await newUser(browser, { role: 'BUYER', name: 'E2E Buyer' });
  const alpha = await newUser(browser, { role: 'SUPPLIER', company: alphaName });
  const bravo = await newUser(browser, { role: 'SUPPLIER', company: bravoName });

  // --- Buyer creates the RFQ through the form. Close in ~3 min with X = 5 → already in the trigger window.
  const now = Date.now();
  const rfqName = `Mumbai → Rotterdam ${uid()}`;
  await buyer.page.goto('/rfqs/new');
  await buyer.page.getByLabel('RFQ name').fill(rfqName);
  await buyer.page.getByLabel('Bid start', { exact: true }).fill(localInput(now - 60_000));
  await buyer.page.getByLabel('Bid close', { exact: true }).fill(localInput(now + 4 * 60_000));
  await buyer.page.getByLabel('Forced bid close').fill(localInput(now + 30 * 60_000));
  await buyer.page.getByLabel('Trigger window (X minutes)').fill('10');
  await buyer.page.getByLabel('Extension duration (Y minutes)').fill('2');
  await buyer.page.getByLabel('Lowest bidder (L1) change in last X minutes').check();
  await buyer.page.getByLabel(alphaName).check();
  await buyer.page.getByLabel(bravoName).check();
  await buyer.page.getByRole('button', { name: 'Create RFQ' }).click();
  await expect(buyer.page.getByRole('heading', { name: rfqName })).toBeVisible();
  await expect(buyer.page.locator('.badge')).toHaveText('Active');
  const rfqUrl = buyer.page.url();

  // --- Both suppliers see it in their lists and open it.
  for (const s of [alpha, bravo]) {
    await s.page.goto('/');
    await s.page.getByRole('link', { name: rfqName }).click();
    await expect(s.page.getByRole('heading', { name: rfqName })).toBeVisible();
  }

  // --- Alpha bids first and becomes L1. L1 went from nobody → Alpha inside the window, which is an L1 change → extension #1.
  await placeBidUi(alpha.page, { freight: 2000, carrier: 'Alpha Carrier' });
  await expect(alpha.page.locator('.big-rank')).toHaveText('L1');
  await expect(buyer.page.locator('.stat', { hasText: 'Current bid close' })).toContainText('1 extension(s)');

  // --- Bravo undercuts → L1 changes again inside the window → extension #2 (+2 min).
  const closeBefore = await buyer.page.locator('.stat', { hasText: 'Current bid close' }).locator('strong').innerText();
  await placeBidUi(bravo.page, { freight: 1900, carrier: 'Bravo Carrier' });
  await expect(bravo.page.getByRole('status')).toContainText('Auction extended');

  // Alpha's window updates by itself: dropped to L2, sees an anonymous competitor and the extension reason.
  await expect(alpha.page.locator('.big-rank')).toHaveText('L2');
  await expect(alpha.page.getByText('A competitor submitted a bid').first()).toBeVisible();
  await expect(alpha.page.getByText(/Reason: Lowest bidder \(L1\) changed/).first()).toBeVisible();
  await expect(alpha.page.locator('body')).not.toContainText(bravoName); // never leaks the competitor

  // Buyer's window updates by itself: full ranking with names, close time moved, extension logged.
  await expect(buyer.page.locator('.row-l1')).toContainText(bravoName);
  await expect(buyer.page.locator('.stat', { hasText: 'Current bid close' })).toContainText('2 extension(s)');
  expect(await buyer.page.locator('.stat', { hasText: 'Current bid close' }).locator('strong').innerText()).not.toBe(closeBefore);
  await expect(buyer.page.locator('.log-time_extended').first()).toContainText('Reason: Lowest bidder (L1) changed');

  // Minimum decrement shown to the supplier and enforced: Alpha can't re-bid above own best.
  await expect(alpha.page.getByText(/Your next bid must be/)).toBeVisible();

  // The buyer listing shows the new lowest bid and the extension chip.
  await buyer.page.goto('/');
  const row = buyer.page.getByRole('row', { name: new RegExp(rfqName) });
  await expect(row).toContainText('1,900.00');
  await expect(row.locator('.chip')).toHaveText('+2 ext');
  expect(rfqUrl).toMatch(/\/rfqs\/\d+$/);

  await Promise.all([buyer, alpha, bravo].map((u) => u.context.close()));
});

test('buyer pauses, resumes, then awards a non-L1 supplier with a reason', async ({ browser }) => {
  const buyer = await newUser(browser, { role: 'BUYER' });
  const a = await newUser(browser, { role: 'SUPPLIER', company: `Award A ${uid()}` });
  const b = await newUser(browser, { role: 'SUPPLIER', company: `Award B ${uid()}` });

  // Pause / resume on a long auction.
  const long = await createRfqApi(buyer, [a.user.supplierId]);
  await buyer.page.goto(`/rfqs/${long.id}`);
  await buyer.page.getByRole('button', { name: /Pause/ }).click();
  await expect(buyer.page.locator('.badge')).toHaveText('Paused');
  await a.page.goto(`/rfqs/${long.id}`);
  await expect(a.page.getByText('The buyer has paused bidding.')).toBeVisible();
  await buyer.page.getByRole('button', { name: /Resume/ }).click();
  await expect(buyer.page.locator('.badge')).toHaveText('Active');
  await expect(a.page.getByRole('button', { name: 'Review bid' })).toBeVisible(); // supplier's form came back live

  // Award on an auction that closes in a few seconds.
  const short = await createRfqApi(buyer, [a.user.supplierId, b.user.supplierId], {
    bidStartAt: Date.now() - 1000, bidCloseAt: Date.now() + 4000, forcedCloseAt: Date.now() + 5000, triggerWindowMinutes: 1, extensionMinutes: 1,
  });
  await bidApi(a, short.id, 500);
  await bidApi(b, short.id, 450);
  await buyer.page.goto(`/rfqs/${short.id}`);
  // Several windows are open; Chrome may freeze timers in a background one. A user watching the page has it
  // in front — and returning to a tab must immediately show the true status (visibility re-sync).
  await buyer.page.bringToFront();
  await expect(buyer.page.getByRole('heading', { name: /Award this RFQ/ })).toBeVisible({ timeout: 15_000 });
  const winner = buyer.page.getByLabel('Winning supplier');
  await expect(winner.locator('option').nth(1)).toContainText(`L2 · ${a.user.companyName}`); // options are in rank order
  await winner.selectOption({ index: 1 });
  await buyer.page.getByRole('button', { name: /Award to/ }).click();
  await expect(buyer.page.getByText('A reason is required when awarding to a supplier other than L1')).toBeVisible();
  await buyer.page.getByLabel(/Reason \(required/).fill('Better on-time record');
  await buyer.page.getByRole('button', { name: /Award to/ }).click();
  await expect(buyer.page.locator('.banner-success')).toContainText(`Awarded to ${a.user.companyName}`);

  await a.page.goto(`/rfqs/${short.id}`);
  await expect(a.page.getByText(/you won this RFQ/)).toBeVisible();
  await b.page.goto(`/rfqs/${short.id}`);
  await expect(b.page.getByText('This RFQ was awarded to another supplier.')).toBeVisible();

  await buyer.page.goto('/dashboard');
  await expect(buyer.page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(buyer.page.getByRole('row', { name: new RegExp(short.name) })).toContainText('Awarded');

  await Promise.all([buyer, a, b].map((u) => u.context.close()));
});
