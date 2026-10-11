import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { launchBrowser } from '../helpers/browser.mjs';
import { smallLeaderboard } from '../helpers/fixtures.mjs';
import { assertNoPageErrors, openPage, waitForRowCount } from '../helpers/page-utils.mjs';
import { createSseApiServer } from '../helpers/sse-api-server.mjs';
import { createSiteServer } from '../helpers/server.mjs';

let browser;
let server;
let api;

const COMPLETE_PAYLOAD = {
  username: 'ghost',
  rank: 3,
  total_ranked: 5000,
  percentile: 0.943,
  total_commits: 320,
  repos_with_commits: 3,
  by_tool: { claude: 220, cursor: 100 },
  sparkline_30d: Array.from({ length: 30 }, (_, i) => i + 1),
  top_repos: [
    { repo: 'ghost/website', commits: 180, tools: ['claude', 'cursor'] },
    { repo: 'ghost/bot', commits: 90, tools: ['claude'] },
    { repo: 'ghost/dotfiles', commits: 50, tools: ['cursor'] },
  ],
  first_ai_commit: '2024-03-15T10:00:00Z',
};

const FULL_STREAM = [
  { event: 'queued', data: { position: 2, estimated_wait_seconds: 30 } },
  { event: 'started', data: { repos_found: 3 } },
  { event: 'scanning', data: { repo: 'ghost/website', index: 0, total: 3 } },
  { event: 'scanned', data: { repo: 'ghost/website', commits_found: 180, tools: { claude: 120, cursor: 60 } } },
  { event: 'scanning', data: { repo: 'ghost/bot', index: 1, total: 3 } },
  { event: 'scanned', data: { repo: 'ghost/bot', commits_found: 90, tools: { claude: 90 } } },
  { event: 'scanning', data: { repo: 'ghost/dotfiles', index: 2, total: 3 } },
  { event: 'scanned', data: { repo: 'ghost/dotfiles', commits_found: 50, tools: { cursor: 40 } } },
  { event: 'complete', data: COMPLETE_PAYLOAD },
];

before(async () => {
  browser = await launchBrowser();
  server = await createSiteServer({ leaderboard: smallLeaderboard() });
  api = await createSseApiServer();
});

after(async () => {
  await browser?.close();
  await server?.close();
  await api?.close();
});

// 'ghost' is not in the fixture, so the search flow offers report
// generation for it (the health probe answers on the live test API).
async function openReportModal(browser2, username) {
  const { page, pageErrors, close } = await openPage(browser2, { apiBaseUrl: api.origin });
  await page.goto(`${server.url}/`);
  await waitForRowCount(page, 9);
  await page.fill('#searchInput', username);
  const button = page.locator('.btn-generate-report[data-username]');
  await button.waitFor();
  await button.click();
  await page.locator('#reportModal.active').waitFor();
  return { page, pageErrors, close };
}

test('SSE progress walks queued → scanning → scanned with a live progress bar', async () => {
  api.play(FULL_STREAM.slice(0, 8));
  const { page, pageErrors, close } = await openReportModal(browser, 'ghost');
  try {
    const content = page.locator('#reportContent');
    await api.waitForStream();
    assert.equal(await api.waitForTrigger(), '/report/ghost', 'generation posts for the selected user');

    api.sendNext(); // queued
    await content.getByText('Your Report is Queued').waitFor();
    assert.match(await content.locator('.progress-subtitle').textContent(), /Position: 2 · Est\. wait: 30s/);

    api.sendNext(); // started
    await content.getByText('Scanning 3 Repos').waitFor();
    assert.equal(await content.locator('.progress-text').textContent(), '0 / 3 repos scanned');

    api.sendNext(); // scanning website
    await page.locator('[data-repo="ghost/website"] .repo-status.scanning').waitFor();
    assert.equal(await content.locator('.repo-status.done').count(), 0);

    api.sendNext(); // scanned website
    await page.locator('[data-repo="ghost/website"] .repo-status.done').waitFor();
    assert.equal(await content.locator('.progress-text').textContent(), '1 / 3 repos scanned');

    api.sendNext(); // scanning bot
    await page.locator('[data-repo="ghost/bot"] .repo-status.scanning').waitFor();
    assert.equal(await content.locator('.repo-status.done').count(), 1);

    api.sendNext(); // scanned bot
    await page.locator('[data-repo="ghost/bot"] .repo-status.done').waitFor();
    assert.equal(await page.locator('.repo-status.done').count(), 2);
    assert.equal(await content.locator('.progress-text').textContent(), '2 / 3 repos scanned');

    api.sendNext(); // scanning dotfiles
    await page.locator('[data-repo="ghost/dotfiles"] .repo-status.scanning').waitFor();
    assert.equal(await content.locator('.repo-status.done').count(), 2);

    api.sendNext(); // scanned dotfiles
    await page.locator('[data-repo="ghost/dotfiles"] .repo-status.done').waitFor();
    assert.equal(await content.locator('.progress-text').textContent(), '3 / 3 repos scanned');

    // done repos show their commit count and tool mix
    const website = page.locator('[data-repo="ghost/website"]');
    assert.match(await website.textContent(), /180 commits/);
    assert.match(await website.textContent(), /🟣 120 · 🔵 60/);

    const widthPercent = await page.locator('.progress-fill').evaluate((el) => parseFloat(el.style.width));
    assert.equal(widthPercent, 100, 'all three scanned repos fill the progress bar');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
    await api.waitForDisconnect();
  }
});

test('the complete event renders the full report and closes the stream', async () => {
  api.play(FULL_STREAM);
  const { page, pageErrors, close } = await openReportModal(browser, 'ghost');
  try {
    const content = page.locator('#reportContent');
    await api.waitForStream();
    assert.equal(await api.waitForTrigger(), '/report/ghost', 'generation posts for the selected user');
    for (const _ of FULL_STREAM) api.sendNext();
    await content.locator('.report-header h2').getByText('ghost').waitFor();
    await api.waitForDisconnect();

    assert.equal(await content.locator('.report-badge').textContent(), '#3 of 5,000');
    assert.match(await content.textContent(), /Top 94\.3%/);
    assert.match(await content.textContent(), /320 commits · 3 repos/);

    // Tools breakdown, one bar per tool with share of total commits.
    const claudePct = ((220 / 320) * 100).toFixed(1);
    const cursorPct = ((100 / 320) * 100).toFixed(1);
    assert.match(await content.locator('.tool-bar-fill.claude').textContent(), new RegExp(`220 \\(${claudePct}%\\)`));
    assert.match(await content.locator('.tool-bar-fill.cursor').textContent(), new RegExp(`100 \\(${cursorPct}%\\)`));

    // 30-day sparkline and top repos.
    assert.equal(await content.locator('.sparkline-bar').count(), 30);
    assert.match(await content.textContent(), /ghost\/website/);
    assert.match(await content.textContent(), /180 commits/);

    // First AI commit date is localized.
    assert.match(await content.textContent(), /March 15, 2024/);
    assert.equal(await page.locator('#reportModal.active').count(), 1, 'report remains visible after stream close');
    await page.click('#closeModal');
    assert.equal(await page.locator('#reportModal.active').count(), 0, 'completed report can be dismissed');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('an SSE error event surfaces the failure message', async () => {
  api.play([{ event: 'error', data: { message: 'scan exploded' } }]);
  const { page, pageErrors, close } = await openReportModal(browser, 'ghost');
  try {
    await api.waitForStream();
    api.sendNext();
    await page.locator('#reportContent').getByText('Report generation failed. Please try again.').waitFor();
    await api.waitForDisconnect();
    assert.equal(await page.locator('#reportModal.active').count(), 1);
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('closing the modal during progress closes the live stream', async () => {
  api.play(FULL_STREAM);
  const { page, pageErrors, close } = await openReportModal(browser, 'ghost');
  try {
    await api.waitForStream();
    api.sendNext();
    await page.locator('#reportContent').getByText('Your Report is Queued').waitFor();

    await page.click('#closeModal');
    assert.equal(await page.locator('#reportModal.active').count(), 0, 'modal deactivates on close');
    await api.waitForDisconnect();
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});
