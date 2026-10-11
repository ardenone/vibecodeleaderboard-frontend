import assert from 'node:assert/strict';
import { API_ORIGIN } from './api-mock.mjs';

// Opens a page against the test site with external requests blocked and any
// unmocked API request denied, so tests never touch the network.
//
// `apiBaseUrl` forwards the app's dev API traffic (js/config.js pins it to
// http://localhost:8080) to a live local test server by rewriting the URL at
// the route layer — the browser never opens a socket to the real port. It
// also drops the baseline that aborts unmocked API traffic.
export async function openPage(browser, { viewport = { width: 1280, height: 800 }, apiBaseUrl } = {}) {
  const context = await browser.newContext({ viewport });
  await context.route('**/*', (route) => {
    const { hostname } = new URL(route.request().url());
    if (hostname === 'localhost' || hostname === '127.0.0.1') return route.fallback();
    return route.abort();
  });

  const page = await context.newPage();

  if (apiBaseUrl) {
    await page.route(`${API_ORIGIN}/**`, (route) => route.continue({
      url: route.request().url().replace(API_ORIGIN, apiBaseUrl),
    }));
  } else {
    // Baseline: unmocked API routes fail fast instead of reaching a live
    // service. Mocks registered later on the page take precedence (LIFO).
    await page.route(`${API_ORIGIN}/**`, (route) => route.abort());
  }

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  page.setDefaultTimeout(10_000);

  return {
    page,
    pageErrors,
    close: () => context.close(),
  };
}

export function assertNoPageErrors(pageErrors) {
  assert.deepEqual(pageErrors, [], 'the page threw uncaught JavaScript errors');
}

// The leaderboard body is virtualized (a bounded window of rows plus
// spacers), so row counts are asserted through the data-virtual-index
// markers the renderer leaves on each row.
export async function waitForRowCount(page, count, timeout = 10_000) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll('#leaderboardBody tr[data-virtual-index]').length === expected,
    count,
    { timeout },
  );
}
