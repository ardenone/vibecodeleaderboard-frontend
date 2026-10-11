import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { mockApiUser, mockHealth } from '../helpers/api-mock.mjs';
import { launchBrowser } from '../helpers/browser.mjs';
import { smallLeaderboard } from '../helpers/fixtures.mjs';
import { assertNoPageErrors, openPage } from '../helpers/page-utils.mjs';
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

// Same-origin profile_url fixture: the leaderboard's user links point at the
// site's own /u/<username> creator pages, so clicking one must land on that
// creator's profile.
function routingLeaderboard() {
  const base = smallLeaderboard();
  return {
    ...base,
    rankings: base.rankings.map((user) => ({ ...user, profile_url: `/u/${user.username}` })),
  };
}

test('a leaderboard user gets their profile at /u/<username>', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.goto(`${server.url}/u/alice`);
    await page.locator('.profile-card').waitFor();

    assert.equal(await page.locator('.profile-name a').textContent(), 'alice');
    assert.equal(await page.locator('.profile-name a').getAttribute('href'), 'https://github.com/alice');
    // Cached leaderboard entries carry no total_ranked, so the denominator
    // falls back to N/A.
    assert.equal(await page.locator('.profile-rank').textContent(), '#1 of N/A');

    const statValues = await page.locator('.stat-card .stat-value').allTextContents();
    assert.deepEqual(statValues, ['120', '500', '3']);

    assert.equal(await page.locator('.tool-mix-segment').count(), 2, 'claude + cursor segments');
    assert.equal(await page.locator('#shareUrl').getAttribute('value'), page.url());
    assert.equal(await page.locator('.back-to-leaderboard a').first().getAttribute('href'), '/');

    // Meta tags are updated for social crawlers.
    assert.equal(await page.title(), '#1 alice - Vibe Code Leaderboard');
    assert.equal(
      await page.locator('meta[property="og:image"]').getAttribute('content'),
      `${server.url}/og/alice`,
    );
    assert.equal(
      await page.locator('link[rel="canonical"]').getAttribute('href'),
      page.url(),
    );
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('a leaderboard profile link opens the correct creator page', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.route('**/leaderboard.json', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(routingLeaderboard()),
    }));

    await page.goto(`${server.url}/`);
    const link = page.locator('a.user-link[href="/u/alice"]');
    await link.waitFor();
    assert.equal((await link.textContent()).trim(), 'alice');

    // Row links open in a new tab (target="_blank"), so the creator page
    // arrives as a popup of the same context.
    const popupPromise = page.waitForEvent('popup');
    await link.click();
    const popup = await popupPromise;
    const popupErrors = [];
    popup.on('pageerror', (error) => popupErrors.push(error));

    await popup.locator('.profile-card').waitFor();
    assert.equal(popup.url(), `${server.url}/u/alice`);
    assert.equal(await popup.locator('.profile-name a').textContent(), 'alice');
    assert.equal(await popup.locator('.profile-rank').textContent(), '#1 of N/A');
    assert.equal(await popup.title(), '#1 alice - Vibe Code Leaderboard');
    assert.deepEqual(popupErrors, [], 'the creator page threw uncaught JavaScript errors');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('refreshing a valid profile URL renders that profile again', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.goto(`${server.url}/u/alice`);
    await page.locator('.profile-card').waitFor();

    await page.reload();
    await page.locator('.profile-card').waitFor();

    assert.equal(page.url(), `${server.url}/u/alice`);
    assert.equal(await page.locator('.profile-name a').textContent(), 'alice');
    assert.equal(await page.title(), '#1 alice - Vibe Code Leaderboard');
    assert.equal(await page.locator('#shareUrl').getAttribute('value'), page.url());
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('browser back from a profile returns to the prior leaderboard state', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await page.goto(`${server.url}/`);
    const firstRow = page.locator('#leaderboardBody tr[data-virtual-index="0"]');
    await firstRow.waitFor();
    const rowTextBefore = await firstRow.textContent();
    const statsBefore = await page.locator('.stats-bar').textContent();

    // Leave the leaderboard for a different creator's profile in this tab,
    // so the session history has the leaderboard as the prior entry.
    await page.goto(`${server.url}/u/frank`);
    await page.locator('.profile-name a').waitFor();
    assert.equal(await page.locator('.profile-name a').textContent(), 'frank');

    await page.goBack();
    assert.equal(page.url(), `${server.url}/`);
    await firstRow.waitFor();
    assert.equal(await firstRow.textContent(), rowTextBefore, 'the same leaderboard rows are rendered');
    assert.equal(await page.locator('.stats-bar').textContent(), statsBefore, 'the stats bar is restored');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('an unknown user gets the not-found card with a search link', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await mockHealth(page, 'ok');
    await mockApiUser(page, 'nobody', (route) => route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' } }));

    await page.goto(`${server.url}/u/nobody`);
    await page.locator('.profile-card.not-found').waitFor();

    assert.equal(await page.locator('.profile-card.not-found h2').textContent(), 'User Not Found');
    assert.match(await page.locator('.profile-card.not-found').textContent(), /nobody/);
    assert.equal(
      await page.locator('.not-found-actions a.btn-primary').getAttribute('href'),
      '/?search=nobody',
    );
    assert.equal(await page.title(), 'nobody Not Found - Vibe Code Leaderboard');
    assert.match(
      await page.locator('meta[property="og:image"]').getAttribute('content'),
      /\/og-image\.png$/,
      'not-found falls back to the default OG image',
    );
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('an API server error shows the retry message', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await mockHealth(page, 'ok');
    await mockApiUser(page, 'oops', (route) => route.fulfill({ status: 500, body: 'kaboom', headers: { 'Access-Control-Allow-Origin': '*' } }));

    await page.goto(`${server.url}/u/oops`);
    await page.locator('.profile-card.error').waitFor();

    assert.match(
      await page.locator('.profile-card.error').textContent(),
      /Failed to load user profile from API/,
    );
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('an unreachable API shows the unavailable message instead of not-found', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await mockHealth(page, 'down');

    await page.goto(`${server.url}/u/ghost`);
    await page.locator('.profile-card.error').waitFor();

    assert.match(
      await page.locator('.profile-card.error').textContent(),
      /Profile loading is temporarily unavailable/,
    );
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('falls back to the API when the cached leaderboard is unavailable', async () => {
  const { page, pageErrors, close } = await openPage(browser);
  try {
    await mockHealth(page, 'ok');
    await mockApiUser(page, 'zed', (route) => route.fulfill({
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rank: 7,
        username: 'zed',
        avatar_url: 'https://example.com/avatars/zed.png',
        profile_url: 'https://github.com/zed',
        commit_count: 42,
        commits_30d: 5,
        unique_repos: 4,
        total_ranked: 1234,
        by_tool: { codex: 42 },
      }),
    }));
    // Break the cached payload so the profile must come from the API.
    await page.route('**/leaderboard.json', (route) => route.fulfill({ status: 500, body: 'boom' }));

    await page.goto(`${server.url}/u/zed`);
    await page.locator('.profile-card').waitFor();

    assert.equal(await page.locator('.profile-rank').textContent(), '#7 of 1,234');
    const statValues = await page.locator('.stat-card .stat-value').allTextContents();
    assert.deepEqual(statValues, ['5', '42', '4']);
    assert.equal(await page.title(), '#7 zed - Vibe Code Leaderboard');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});
