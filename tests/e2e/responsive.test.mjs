import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { mockHealth, mockReportTrigger } from '../helpers/api-mock.mjs';
import { launchBrowser } from '../helpers/browser.mjs';
import { smallLeaderboard } from '../helpers/fixtures.mjs';
import { assertNoPageErrors, openPage, waitForRowCount } from '../helpers/page-utils.mjs';
import { createSiteServer } from '../helpers/server.mjs';

let browser;
let server;
const MOBILE = { width: 375, height: 667 };
const DESKTOP = { width: 1280, height: 800 };

async function assertWithinViewport(page, selectors) {
  const layout = await page.evaluate((targets) => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    controls: targets.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return { selector, missing: true };
      const rect = element.getBoundingClientRect();
      return {
        selector,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
        display: getComputedStyle(element).display,
      };
    }),
  }), selectors);

  assert.ok(
    layout.documentWidth <= layout.viewportWidth,
    `document overflows horizontally: ${layout.documentWidth}px at ${layout.viewportWidth}px`,
  );
  for (const control of layout.controls) {
    assert.equal(control.missing, undefined, `${control.selector} is missing`);
    assert.notEqual(control.display, 'none', `${control.selector} is hidden`);
    assert.ok(control.width > 0 && control.height > 0, `${control.selector} has no visible area`);
    assert.ok(
      control.left >= -1 && control.right <= layout.viewportWidth + 1,
      `${control.selector} is outside the horizontal viewport: ${control.left}..${control.right}`,
    );
  }
}

before(async () => {
  browser = await launchBrowser();
  server = await createSiteServer({ leaderboard: smallLeaderboard() });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test('mobile layout hides the tool column and scrolls the table horizontally', async () => {
  const { page, pageErrors, close } = await openPage(browser, { viewport: MOBILE });
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 9);

    const styles = await page.evaluate(() => ({
      toolColumn: getComputedStyle(document.querySelector('.col-tools')).display,
      leaderboardOverflowX: getComputedStyle(document.querySelector('.leaderboard')).overflowX,
      tableMinWidth: getComputedStyle(document.querySelector('.leaderboard table')).minWidth,
      searchBoxDirection: getComputedStyle(document.querySelector('.search-box')).flexDirection,
      leaderboardScrollWidth: document.querySelector('.leaderboard').scrollWidth,
      leaderboardClientWidth: document.querySelector('.leaderboard').clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
    }));

    assert.equal(styles.toolColumn, 'none', 'Tool Mix column is hidden at 480px and below');
    assert.equal(styles.leaderboardOverflowX, 'auto', 'the table scrolls instead of stretching the page');
    assert.equal(styles.tableMinWidth, '600px', 'the table keeps a usable minimum width');
    assert.equal(styles.searchBoxDirection, 'column', 'search stacks vertically at 480px and below');
    assert.ok(
      styles.leaderboardScrollWidth > styles.leaderboardClientWidth,
      'table content is wider than its scroll container',
    );
    assert.ok(
      styles.documentScrollWidth <= 375,
      `the page itself must not overflow horizontally (was ${styles.documentScrollWidth}px)`,
    );

    await assertWithinViewport(page, ['#searchInput', '#searchBtn', '.tool-filter[data-tool="claude"]', '.leaderboard', '#leaderboardBody .user-link']);
    await page.locator('.tool-filter[data-tool="claude"]').click();
    await waitForRowCount(page, 5);
    assert.equal(await page.locator('.tool-filter[data-tool="claude"].active').count(), 1);

    await page.fill('#searchInput', 'alice');
    await page.press('#searchInput', 'Enter');
    await page.locator('#searchResult .user-result-card').waitFor();
    assert.equal(await page.locator('#searchResult h3 a').textContent(), 'alice');
    await assertWithinViewport(page, ['#searchInput', '#searchBtn', '#searchResult .user-result-card']);
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('desktop layout shows every column without horizontal scroll', async () => {
  const { page, pageErrors, close } = await openPage(browser, { viewport: DESKTOP });
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 9);

    const styles = await page.evaluate(() => ({
      toolColumn: getComputedStyle(document.querySelector('.col-tools')).display,
      searchBoxDirection: getComputedStyle(document.querySelector('.search-box')).flexDirection,
      leaderboardScrollWidth: document.querySelector('.leaderboard').scrollWidth,
      leaderboardClientWidth: document.querySelector('.leaderboard').clientWidth,
    }));

    assert.notEqual(styles.toolColumn, 'none', 'Tool Mix column is visible on desktop');
    assert.equal(styles.searchBoxDirection, 'row');
    assert.ok(
      styles.leaderboardScrollWidth <= styles.leaderboardClientWidth,
      'the table fits its container on desktop',
    );
    await assertWithinViewport(page, ['#searchInput', '#searchBtn', '.tool-filter[data-tool="claude"]', '.leaderboard', '#leaderboardBody .user-link']);
    await page.locator('.tool-filter[data-tool="claude"]').click();
    await waitForRowCount(page, 5);
    assert.equal(await page.locator('.tool-filter[data-tool="claude"].active').count(), 1);

    await page.fill('#searchInput', 'alice');
    await page.press('#searchInput', 'Enter');
    await page.locator('#searchResult .user-result-card').waitFor();
    assert.equal(await page.locator('#searchResult h3 a').textContent(), 'alice');
    await assertWithinViewport(page, ['#searchInput', '#searchBtn', '#searchResult .user-result-card']);
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('resizing between breakpoints re-applies the responsive rules and re-renders rows', async () => {
  const { page, pageErrors, close } = await openPage(browser, { viewport: DESKTOP });
  try {
    await page.goto(`${server.url}/`);
    await waitForRowCount(page, 9);
    assert.notEqual(
      await page.evaluate(() => getComputedStyle(document.querySelector('.col-tools')).display),
      'none',
    );

    await page.setViewportSize(MOBILE);

    // The resize listener reschedules the virtual render; wait for the
    // media query to take effect and rows to still be present.
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.col-tools')).display === 'none',
    );
    const rowCount = await page.locator('#leaderboardBody tr[data-virtual-index]').count();
    assert.ok(rowCount > 0, 'virtual rows are re-rendered after resize');
    assertNoPageErrors(pageErrors);
  } finally {
    await close();
  }
});

test('profile stats collapse to one column on mobile and sit side by side on desktop', async () => {
  // The grid is repeat(auto-fit, minmax(150px, 1fr)), so the desktop track
  // count depends on the viewport width — assert the *cards'* geometry
  // instead: stacked cards have distinct y offsets, side-by-side cards share one.
  const trackCount = (page, selector) => page.evaluate(
    (sel) => getComputedStyle(document.querySelector(sel)).gridTemplateColumns.split(' ').length,
    selector,
  );
  const cardOffsets = (page) => page.evaluate(() =>
    [...document.querySelectorAll('.profile-stats .stat-card')]
      .map((card) => Math.round(card.getBoundingClientRect().top)),
  );

  const mobile = await openPage(browser, { viewport: MOBILE });
  try {
    await mobile.page.goto(`${server.url}/u/alice`);
    await mobile.page.locator('.profile-card').waitFor();

    const mobileOffsets = await cardOffsets(mobile.page);
    assert.equal(
      new Set(mobileOffsets).size,
      mobileOffsets.length,
      'stat cards stack vertically at 600px and below',
    );
    assert.equal(await trackCount(mobile.page, '.profile-stats'), 1, 'the grid is a single column');
    assert.equal(await trackCount(mobile.page, '.share-url'), 1, 'share input stacks above its button');
    await assertWithinViewport(mobile.page, ['.back-link', '.profile-name', '#shareUrl', '.share-url button']);
    await mobile.page.locator('.share-url button').click();
    await mobile.page.getByRole('button', { name: 'Copied!' }).waitFor();
    assertNoPageErrors(mobile.pageErrors);
  } finally {
    await mobile.close();
  }

  const desktop = await openPage(browser, { viewport: DESKTOP });
  try {
    await desktop.page.goto(`${server.url}/u/alice`);
    await desktop.page.locator('.profile-card').waitFor();

    const desktopOffsets = await cardOffsets(desktop.page);
    assert.equal(desktopOffsets.length, 3, 'all three stat cards rendered');
    assert.equal(new Set(desktopOffsets).size, 1, 'all three stat cards sit side by side on desktop');
    await assertWithinViewport(desktop.page, ['.back-link', '.profile-name', '#shareUrl', '.share-url button']);
    await desktop.page.locator('.share-url button').click();
    await desktop.page.getByRole('button', { name: 'Copied!' }).waitFor();
    assertNoPageErrors(desktop.pageErrors);
  } finally {
    await desktop.close();
  }
});

for (const [name, viewport] of [['mobile', MOBILE], ['desktop', DESKTOP]]) {
  test(`${name} report controls remain usable after a stream failure`, async () => {
    const { page, pageErrors, close } = await openPage(browser, { viewport });
    try {
      await mockHealth(page, 'ok');
      await mockReportTrigger(page);
      await page.goto(`${server.url}/`);
      await waitForRowCount(page, 9);

      await page.fill('#searchInput', 'ghost');
      await page.press('#searchInput', 'Enter');
      const generate = page.locator('#searchResult .btn-generate-report');
      await generate.waitFor();
      await assertWithinViewport(page, ['#searchInput', '#searchBtn', '#searchResult .btn-generate-report']);
      await generate.click();

      await page.locator('#reportModal.active .repo-status.error').waitFor();
      assert.match(await page.locator('#reportContent').textContent(), /Report generation failed\. Please try again\./);
      await assertWithinViewport(page, ['#reportModal .modal-content', '#closeModal', '#reportContent .btn-generate-report']);
      await page.locator('#closeModal').click();
      assert.equal(await page.locator('#reportModal.active').count(), 0, 'the error modal can be dismissed');
      assertNoPageErrors(pageErrors);
    } finally {
      await close();
    }
  });
}
