import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { launchBrowser } from '../helpers/browser.mjs';
import { smallLeaderboard } from '../helpers/fixtures.mjs';
import { assertNoPageErrors, openPage, waitForRowCount } from '../helpers/page-utils.mjs';
import { createSiteServer } from '../helpers/server.mjs';

// Tall viewport so the virtualized window covers every loaded row.
const VIEWPORT = { width: 1280, height: 6000 };

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

async function visibleUsernames(page) {
  return page.locator('#leaderboardBody .user-link').allTextContents();
}

test('filters the table down to users of the selected tool', async () => {
  const { page, pageErrors, close } = await openPage(browser, { viewport: VIEWPORT });
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 9);

    await page.click('.tool-filter[data-tool="claude"]');
    await waitForRowCount(page, 5);

    assert.deepEqual(await visibleUsernames(page), ['alice', 'carol', 'eve', 'grace', 'ivan']);
    assert.equal(await page.locator('.tool-filter.active').getAttribute('data-tool'), 'claude');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('multi-tool users appear under each tool they use', async () => {
  const { page, pageErrors, close } = await openPage(browser, { viewport: VIEWPORT });
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 9);

    await page.click('.tool-filter[data-tool="cursor"]');
    await waitForRowCount(page, 3);
    assert.deepEqual(await visibleUsernames(page), ['alice', 'bob', 'heidi']);

    await page.click('.tool-filter[data-tool="aider"]');
    await waitForRowCount(page, 1);
    assert.deepEqual(await visibleUsernames(page), ['carol']);
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('a tool nobody uses shows the empty-filter message', async () => {
  const { page, pageErrors, close } = await openPage(browser, { viewport: VIEWPORT });
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 9);

    await page.click('.tool-filter[data-tool="gemini"]');

    await page.locator('#leaderboardBody .no-results').waitFor();
    assert.equal(
      await page.locator('#leaderboardBody .no-results').textContent(),
      'No users found for this filter',
    );
    assert.equal(await page.locator('#loadMoreBtn').isHidden(), true, 'Load More stays hidden with no rows');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('switching back to All Tools restores the unfiltered list', async () => {
  const { page, pageErrors, close } = await openPage(browser, { viewport: VIEWPORT });
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 9);

    await page.click('.tool-filter[data-tool="codex"]');
    await waitForRowCount(page, 1);

    await page.click('.tool-filter[data-tool="all"]');
    await waitForRowCount(page, 9);
    assert.equal(await page.locator('.tool-filter.active').getAttribute('data-tool'), 'all');
    assert.equal((await visibleUsernames(page))[0], 'alice');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});
