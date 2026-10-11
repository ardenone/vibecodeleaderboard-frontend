// Route mocks for the API the frontend talks to. The site under test is
// served from localhost, so js/app.js, js/profile.js and js/report.js all
// target the dev API base http://localhost:8080 (see API_BASE in app.js).

export const API_ORIGIN = 'http://localhost:8080';

const CORS = { 'Access-Control-Allow-Origin': '*' };

// Reachability probes are HEAD {API}/health. mode: 'ok' | 'down'
export async function mockHealth(page, mode = 'ok') {
  await page.route(`${API_ORIGIN}/health`, (route) => {
    if (mode === 'down') return route.abort();
    return route.fulfill({ status: 200, headers: CORS });
  });
}

export async function mockApiUser(page, username, responder) {
  await page.route(`${API_ORIGIN}/user/${username}`, (route) => responder(route));
}

// The SSE progress stream itself is served by helpers/sse-api-server.mjs —
// route interception cannot stream a body or keep the socket open, so a
// fulfilled response collapses every progress stage into one frame and then
// fires EventSource's disconnect error.

// POST {API}/report/<username> kicks off generation. The JSON content type
// makes the browser preflight, so OPTIONS must be answered too.
export async function mockReportTrigger(page, { status = 200, body = '{}' } = {}) {
  await page.route(`${API_ORIGIN}/report/*`, (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          ...CORS,
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    return route.fulfill({ status, headers: CORS, body });
  });
}
