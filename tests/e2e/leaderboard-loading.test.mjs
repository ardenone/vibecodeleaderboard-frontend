import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { launchBrowser } from '../helpers/browser.mjs';
import { demoDataLeaderboard, smallLeaderboard } from '../helpers/fixtures.mjs';
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

test('loads the leaderboard, renders rows and fills the stats bar', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 9);

    const firstRow = page.locator('#leaderboardBody tr[data-virtual-index="0"]');
    assert.equal(await firstRow.locator('.col-rank').textContent(), '#1');
    assert.equal(await firstRow.locator('.user-link').textContent(), 'alice');
    assert.equal(await firstRow.locator('.user-link').getAttribute('href'), 'https://github.com/alice');
    assert.equal(await firstRow.locator('.col-commits-30d').textContent(), '120');
    assert.equal(await firstRow.locator('.col-commits-total').textContent(), '500');
    assert.equal(await firstRow.locator('.col-repos').textContent(), '3');

    assert.equal(await page.locator('#totalUsers').textContent(), '9 users');
    assert.equal(await page.locator('#totalCommits').textContent(), '1,790 commits');
    assert.equal(await page.locator('#totalRepos').textContent(), '14 repos');

    assert.equal(await page.locator('#demoDataBanner').isHidden(), true, 'demo banner stays hidden for real data');
    assert.equal(await page.locator('#leaderboardBody .loading').count(), 0, 'placeholder row is gone');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('renders the tool mix for each row', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 9);

    const aliceRow = page.locator('#leaderboardBody tr[data-virtual-index="0"]');
    assert.equal(await aliceRow.locator('.tool-mix-segment.claude').count(), 1);
    assert.equal(await aliceRow.locator('.tool-mix-segment.cursor').count(), 1);

    const daveRow = page.locator('tr[data-virtual-index]', { has: page.locator('.user-link', { hasText: 'dave' }) });
    assert.equal(await daveRow.locator('.tool-mix-segment').count(), 0, 'no segments without tool data');
    assert.match(await daveRow.locator('.tool-mix').textContent(), /No data/);
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('shows the demo-data banner for synthetic test users', async () => {
  const demoServer = await createSiteServer({ leaderboard: demoDataLeaderboard() });
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.goto(`${demoServer.url}/`);
    await waitForRowCount(page, 3);
    assert.equal(await page.locator('#demoDataBanner').isVisible(), true, 'banner is shown for testuserNNN data');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
    await demoServer.close();
  }
});
