import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { launchBrowser } from '../helpers/browser.mjs';
import { largeLeaderboard } from '../helpers/fixtures.mjs';
import { assertNoPageErrors, openPage, waitForRowCount } from '../helpers/page-utils.mjs';
import { createSiteServer } from '../helpers/server.mjs';

// Tall enough that the virtualized window covers all 120 rows (the window
// is capped by both the viewport and the loaded page size).
const VIEWPORT = { width: 1280, height: 12000 };

let browser;
let server;

before(async () => {
  browser = await launchBrowser();
  server = await createSiteServer({ leaderboard: largeLeaderboard(120) });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test('initial load renders one page of rows and shows Load More', async () => {
  const { page, pageErrors, close } = await openPage(browser, { viewport: VIEWPORT });
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 50);

    assert.equal(await page.locator('#loadMoreBtn').isVisible(), true);
    assert.equal(await page.locator('tr[data-virtual-index="49"] .col-rank').textContent(), '#50');
    assert.equal(await page.locator('tr[data-virtual-index="50"]').count(), 0, 'row 51 is not loaded yet');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('Load More extends the list by another page', async () => {
  const { page, pageErrors, close } = await openPage(browser, { viewport: VIEWPORT });
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 50);

    await page.click('#loadMoreBtn');
    await waitForRowCount(page, 100);

    assert.equal(await page.locator('#loadMoreBtn').isVisible(), true);
    assert.equal(await page.locator('tr[data-virtual-index="99"] .col-rank').textContent(), '#100');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('Load More hides once every row is loaded', async () => {
  const { page, pageErrors, close } = await openPage(browser, { viewport: VIEWPORT });
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 50);
    await page.click('#loadMoreBtn');
    await waitForRowCount(page, 100);
    await page.click('#loadMoreBtn');
    await waitForRowCount(page, 120);

    assert.equal(await page.locator('#loadMoreBtn').isHidden(), true);
    assert.equal(await page.locator('tr[data-virtual-index="119"] .col-rank').textContent(), '#120');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('Load More never appears when the list fits on one page', async () => {
  const smallServer = await createSiteServer({ leaderboard: largeLeaderboard(30) });
  const { page, pageErrors, close } = await openPage(browser, { viewport: VIEWPORT });
  try {
    await page.goto(`${smallServer.url}/`);
    await waitForRowCount(page, 30);

    assert.equal(await page.locator('#loadMoreBtn').isHidden(), true);
    assert.equal(await page.locator('tr[data-virtual-index="29"] .col-rank').textContent(), '#30');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
    await smallServer.close();
  }
});
