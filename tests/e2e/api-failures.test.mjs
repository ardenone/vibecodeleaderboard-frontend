import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { API_ORIGIN, mockHealth } from '../helpers/api-mock.mjs';
import { launchBrowser } from '../helpers/browser.mjs';
import { smallLeaderboard } from '../helpers/fixtures.mjs';
import { assertNoPageErrors, openPage, waitForRowCount } from '../helpers/page-utils.mjs';
import { createSiteServer } from '../helpers/server.mjs';

let browser;
let server;

before(async () => {
  browser = await launchBrowser();
  server = await createSiteServer({ leaderboard: smallLeaderboard() });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test('a failing leaderboard response shows the failure message', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.route('**/leaderboard.json', (route) => route.fulfill({ status: 500, body: 'boom' }));
    await page.goto(`${server.url}/`);

    await page.locator('#leaderboardBody .no-results').waitFor();
    assert.equal(
      await page.locator('#leaderboardBody .no-results').textContent(),
      'Failed to load leaderboard data',
    );
    assert.equal(await page.locator('#totalUsers').textContent(), 'Loading...', 'stats stay pending');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('a network failure loading the leaderboard shows the failure message', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.route('**/leaderboard.json', (route) => route.abort());
    await page.goto(`${server.url}/`);

    await page.locator('#leaderboardBody .no-results').waitFor();
    assert.equal(
      await page.locator('#leaderboardBody .no-results').textContent(),
      'Failed to load leaderboard data',
    );
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('search degrades gracefully when the API is unreachable', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await mockHealth(page, 'down');
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 9);

    await page.fill('#searchInput', 'ghost');
    await page.locator('[data-report-option]').waitFor();

    const availability = page.locator('.report-availability');
    await availability.getByText('Report generation is temporarily unavailable', { exact: false }).waitFor();
    assert.equal(await page.locator('.btn-generate-report').count(), 0, 'no generate button when API is down');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('report generation with an unreachable API shows the error modal', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await mockHealth(page, 'down');
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 9);

    await page.evaluate(() => window.ReportGenerator.generate('ghost'));

    await page.locator('#reportModal.active').waitFor();
    const content = page.locator('#reportContent');
    await content.getByText('Report generation is temporarily unavailable', { exact: false }).waitFor();
    assert.equal(await page.locator('#reportContent .repo-status.error').count(), 1);
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('an unmocked API path fails fast instead of reaching a live service', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.goto(`${server.url}/`);

    // No page route is registered for this path, so the baseline deny
    // route from openPage() answers it. Assert the fetch is rejected —
    // registering a route here would override the baseline (LIFO) and
    // defeat the check.
    const rejected = await page.evaluate(async (url) => {
      try {
        await fetch(url, { method: 'HEAD' });
        return false;
      } catch {
        return true;
      }
    }, `${API_ORIGIN}/never-mocked`);

    assert.equal(rejected, true, 'baseline deny route keeps unmocked API paths offline');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});
