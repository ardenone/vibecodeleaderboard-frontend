import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { mockHealth } from '../helpers/api-mock.mjs';
import { launchBrowser } from '../helpers/browser.mjs';
import { searchLeaderboard } from '../helpers/fixtures.mjs';
import { assertNoPageErrors, openPage, waitForRowCount } from '../helpers/page-utils.mjs';
import { createSiteServer } from '../helpers/server.mjs';

let browser;
let server;

before(async () => {
  browser = await launchBrowser();
  server = await createSiteServer({ leaderboard: searchLeaderboard() });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test('debounced input search lists matching users, capped at ten', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 14);

    // Input event only — the result must arrive via the 200ms debounce.
    await page.fill('#searchInput', 'fan');
    await page.locator('#searchResult .user-result-card').first().waitFor();

    assert.equal(await page.locator('#searchResult .user-result-card').count(), 10);
    assert.equal(await page.locator('#searchResult .search-results-more').textContent(), 'and 2 more...');

    // Results are sorted by rank ascending.
    const firstCard = page.locator('#searchResult .user-result-card').first();
    assert.equal((await firstCard.locator('h3').textContent()).trim(), 'fan001');
    assert.equal(await firstCard.locator('.rank').textContent(), '#3 of 14');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('search matches usernames case-insensitively', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 14);

    await page.fill('#searchInput', 'alice');
    await page.locator('#searchResult .user-result-card').first().waitFor();

    const card = page.locator('#searchResult .user-result-card').first();
    assert.equal(await card.locator('h3 a').textContent(), 'AliceArdern');
    assert.equal(await card.locator('.rank').textContent(), '#1 of 14');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('pressing Enter runs the search immediately', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 14);

    await page.fill('#searchInput', 'bobby');
    await page.press('#searchInput', 'Enter');
    await page.locator('#searchResult .user-result-card').first().waitFor();

    const card = page.locator('#searchResult .user-result-card').first();
    assert.equal(await card.locator('h3 a').textContent(), 'bobby');
    assert.equal(await card.locator('.rank').textContent(), '#2 of 14');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('clearing the query clears the results', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 14);

    await page.fill('#searchInput', 'fan');
    await page.locator('#searchResult .user-result-card').first().waitFor();

    await page.fill('#searchInput', '');
    await page.waitForFunction(() => document.getElementById('searchResult').innerHTML === '');
    assert.equal(await page.locator('#searchResult').textContent(), '');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('an unknown user gets a report-generation card when the API is reachable', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await mockHealth(page, 'ok');
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 14);

    await page.fill('#searchInput', 'ghost');
    await page.locator('[data-report-option]').waitFor();

    assert.equal(await page.locator('[data-report-option] .not-found').textContent(), 'Not on the leaderboard yet');

    // Reachability is checked asynchronously; the generate button replaces
    // the availability note once the health probe answers.
    const button = page.locator('.btn-generate-report');
    await button.waitFor();
    assert.equal(await button.getAttribute('data-username'), 'ghost');
    assert.equal(await page.locator('.report-availability').count(), 0, 'availability note is removed');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});
