import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';

import {
  runSmoke,
  validateLeaderboard,
  validateReportResponse,
  validateUserResponse,
} from '../scripts/production-smoke.mjs';

const CORS = { 'Access-Control-Allow-Origin': 'http://127.0.0.1:0' };
const REPORT = {
  username: 'octocat',
  rank: 1,
  total_ranked: 10,
  percentile: 0.9,
  total_commits: 100,
  repos_with_commits: 2,
  by_tool: { claude: 70, cursor: 30 },
  sparkline_30d: Array.from({ length: 30 }, () => 1),
  top_repos: [{ repo: 'octocat/site', commits: 100, tools: ['claude'] }],
  first_ai_commit: '2024-01-01T00:00:00Z',
};
const LEADERBOARD = {
  generated_at: '2026-09-17T00:00:00Z',
  rankings: [{
    rank: 1,
    username: 'octocat',
    commit_count: 100,
    commits_30d: 10,
    unique_repos: 2,
    recent_repos: ['octocat/site'],
    by_tool: { claude: 70 },
  }],
};

let server;
let baseUrl;

before(async () => {
  let releaseStream;
  const streamReady = new Promise((resolve) => { releaseStream = resolve; });

  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const headers = { ...CORS, 'Access-Control-Allow-Methods': 'GET, HEAD, POST' };

    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Vibe Code Leaderboard</title>');
      return;
    }
    if (url.pathname === '/leaderboard.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(LEADERBOARD));
      return;
    }
    if (url.pathname === '/health' && request.method === 'HEAD') {
      response.writeHead(200, headers);
      response.end();
      return;
    }
    if (url.pathname === '/user/octocat' && request.method === 'GET') {
      response.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ...LEADERBOARD.rankings[0], total_ranked: 10 }));
      return;
    }
    if (url.pathname === '/report/octocat/stream' && request.method === 'GET') {
      response.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      response.write(': connected\n\n');
      await streamReady;
      response.write('event: queued\ndata: {"position":0,"estimated_wait_seconds":0}\n\n');
      response.write('event: started\ndata: {"repos_found":1}\n\n');
      response.write('event: scanning\ndata: {"repo":"octocat/site","index":0,"total":1}\n\n');
      response.write('event: scanned\ndata: {"repo":"octocat/site","commits_found":100,"tools":{"claude":70}}\n\n');
      response.write(`event: complete\ndata: ${JSON.stringify(REPORT)}\n\n`);
      response.end();
      return;
    }
    if (url.pathname === '/report/octocat' && request.method === 'POST') {
      response.writeHead(202, { ...headers, 'Content-Type': 'application/json' });
      response.end('{}');
      releaseStream();
      return;
    }
    response.writeHead(404, headers);
    response.end(JSON.stringify({ detail: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Replace the fixture's placeholder with the actual site origin in all API
  // responses. The smoke runner checks the browser-facing CORS contract.
  CORS['Access-Control-Allow-Origin'] = baseUrl;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('production smoke runner checks site, data, API, and report SSE end-to-end', async () => {
  const result = await runSmoke({
    siteUrl: baseUrl,
    apiUrl: baseUrl,
    username: 'octocat',
    timeoutMs: 5_000,
    log: () => {},
  });

  assert.deepEqual(result.events, ['queued', 'started', 'scanning', 'scanned', 'complete']);
});

test('documented response validators reject missing required shapes', () => {
  assert.throws(() => validateLeaderboard({ generated_at: '2026-09-17T00:00:00Z', rankings: [{}] }), /username/);
  assert.throws(() => validateUserResponse({ username: 'octocat' }), /rank/);
  assert.throws(() => validateReportResponse({ username: 'octocat', rank: 1 }), /total_ranked/);
  assert.throws(() => validateReportResponse({
    ...REPORT,
    top_repos: [{ repo: 'octocat/site', commits: 100 }],
  }), /tools/);
});
