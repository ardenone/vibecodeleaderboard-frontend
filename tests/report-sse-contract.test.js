/**
 * Contract tests for the report-generation SSE client (js/report.js).
 *
 * Every assertion pins a rule documented in
 * docs/notes/report-sse-api-contract.md — event payloads, terminal states,
 * reachability semantics, reconnect/timeout behavior, and the completed
 * report response.
 *
 * Zero-dependency by repo convention: a minimal DOM + EventSource stub is
 * installed, then js/report.js is evaluated against it.
 *
 * Run with: node tests/report-sse-contract.test.js   (or `make test`)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function fakeElement(id) {
  const el = {
    id,
    innerHTML: '',
    className: '',
    dataset: {},
    style: {},
    children: [],
    textContent: '',
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      add() {},
      remove() {},
      contains: () => false,
    },
    addEventListener() {},
    appendChild(child) {
      el.children.push(child);
    },
    querySelector(selector) {
      const match = selector.match(/\[data-repo="([^"]+)"\]/);
      if (match) {
        return el.children.find((c) => c.dataset.repo === match[1]) || null;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return el;
}

const dom = {};
for (const id of ['reportModal', 'reportContent', 'closeModal']) {
  dom[id] = fakeElement(id);
}
// The repo-progress list is created via innerHTML assignment in the real
// DOM, which this stub cannot parse; the module looks it up by id on every
// handler call, so a persistent stand-in keeps those code paths live.
dom.repoListProgress = fakeElement('repoListProgress');

// js/report.js captures its elements once at load, so the id map must hand
// back the same objects for the module's lifetime; per-test resets clear
// them in place instead of replacing them.
globalThis.document = {
  getElementById: (id) => dom[id] || null,
  createElement: () => fakeElement(undefined),
  querySelector: () => null,
  querySelectorAll: () => [],
};
function resetDom() {
  for (const el of Object.values(dom)) {
    el.innerHTML = '';
    el.children.length = 0;
  }
}

globalThis.window = { location: { hostname: 'localhost' } };

globalThis.TOOL_ICONS = {
  claude: '🟣',
  cursor: '🔵',
  aider: '🟢',
  codex: '🟡',
  gemini: '🔴',
  opencode: '🟠',
};

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.closed = false;
    this.listeners = {};
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  // Models the browser dispatching an event. Mirrors the real contract that
  // no events reach listeners after close().
  emit(type, dataObj) {
    if (this.closed) return;
    this.emitRaw(type, dataObj === undefined ? '' : JSON.stringify(dataObj));
  }

  emitRaw(type, data) {
    if (this.closed) return;
    const event = { type, data };
    for (const fn of this.listeners[type] || []) fn(event);
  }

  close() {
    this.closed = true;
    this.readyState = 2; // CLOSED
  }
}
FakeEventSource.instances = [];
globalThis.EventSource = FakeEventSource;

let fetchCalls = [];
let fetchImpl = null;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const call = {
    url,
    method: init?.method || 'GET',
    headers: init?.headers,
    body: init?.body,
    signal: init?.signal,
  };
  fetchCalls.push(call);
  return fetchImpl(url, call);
};

// Load the real configuration module first, exactly as index.html does, then
// the client under test against it.
vm.runInThisContext(readFileSync(path.join(here, '../js/config.js'), 'utf8'), {
  filename: 'js/config.js',
});
vm.runInThisContext(readFileSync(path.join(here, '../js/report.js'), 'utf8'), {
  filename: 'js/report.js',
});
const { generate } = globalThis.window.ReportGenerator;

// Evaluates js/config.js against an arbitrary hostname in a throwaway window
// and returns the apiBaseUrl it resolves. Used to pin the production-URL rule
// without disturbing the frozen config the client under test captured.
function resolveBaseUrlFor(hostname) {
  const sandboxWindow = { location: { hostname } };
  const previousWindow = globalThis.window;
  globalThis.window = sandboxWindow;
  try {
    vm.runInThisContext(readFileSync(path.join(here, '../js/config.js'), 'utf8'), {
      filename: 'js/config.js',
    });
  } finally {
    globalThis.window = previousWindow;
  }
  return sandboxWindow.VibeCodeConfig.apiBaseUrl;
}

const CONNECTING = 'Connecting to API...';
const GENERIC_FAILURE = 'Report generation failed. Please try again.';
const UNAVAILABLE =
  'Report generation is temporarily unavailable. The API service is currently unreachable.';

const FULL_REPORT = {
  username: 'octocat',
  rank: 42,
  total_ranked: 12000,
  percentile: 0.127,
  total_commits: 497,
  repos_with_commits: 5,
  by_tool: { claude: 300, cursor: 150, aider: 47 },
  sparkline_30d: [3, 1, 4, 1, 5, 9, 2, 6],
  top_repos: [
    { repo: 'octocat/Hello-World', commits: 210, tools: ['claude', 'cursor'] },
    { repo: 'octocat/second-repo', commits: 120, tools: ['aider'] },
  ],
  first_ai_commit: '2024-03-15T12:00:00Z',
};

function okResponse(url) {
  return { ok: true, status: 200, url };
}

// Default route table: health is up, POST trigger succeeds.
function healthyFetch() {
  fetchImpl = (url) => {
    if (url.endsWith('/health')) return { ok: true, status: 200 };
    return okResponse(url);
  };
}

async function startGeneration(username = 'octocat') {
  healthyFetch();
  await generate(username);
  const es = FakeEventSource.instances.at(-1);
  assert.ok(es, 'expected an EventSource to be opened');
  return es;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// --- Base URL resolution (js/config.js) --------------------------------------

test('config: local dev hostnames resolve to http://localhost:8080', () => {
  assert.equal(resolveBaseUrlFor('localhost'), 'http://localhost:8080');
  assert.equal(resolveBaseUrlFor('127.0.0.1'), 'http://localhost:8080');
  assert.equal(resolveBaseUrlFor('[::1]'), 'http://localhost:8080');
});

test('config: production hostnames resolve to https://api.<host> with www stripped', () => {
  assert.equal(resolveBaseUrlFor('vibecodeleaderboard.com'), 'https://api.vibecodeleaderboard.com');
  assert.equal(
    resolveBaseUrlFor('www.vibecodeleaderboard.com'),
    'https://api.vibecodeleaderboard.com',
  );
  assert.equal(resolveBaseUrlFor('preview.example.test'), 'https://api.preview.example.test');
});

// --- Reachability pre-check (HEAD /health, 2s budget) -----------------------

test('any 2xx /health is reachable: stream opens, POST trigger is fired after it', async () => {
  healthyFetch();
  fetchImpl = (url) => url.endsWith('/health') ? { ok: true, status: 204 } : okResponse(url);
  await generate('octocat');
  const es = FakeEventSource.instances.at(-1);
  assert.equal(es.url, 'http://localhost:8080/report/octocat/stream');
  // The stream itself is an EventSource connection, not a fetch() call, so
  // only the pre-check and the trigger appear here — in that order.
  assert.deepEqual(
    fetchCalls.map((c) => `${c.method} ${c.url}`),
    [
      'HEAD http://localhost:8080/health',
      'POST http://localhost:8080/report/octocat',
    ],
  );
  assert.deepEqual(fetchCalls[1].headers, { 'Content-Type': 'application/json' });
  assert.equal(fetchCalls[1].body, undefined, 'the POST has no body');
  assert.equal(fetchCalls[1].signal, undefined, 'the POST has no AbortSignal');
  assert.match(dom.reportContent.innerHTML, new RegExp(CONNECTING));
});

test('404 /health is treated as reachable (server up, route missing)', async () => {
  healthyFetch();
  fetchImpl = (url) =>
    url.endsWith('/health') ? { ok: false, status: 404 } : okResponse(url);
  await generate('octocat');
  assert.equal(FakeEventSource.instances.at(-1).url, 'http://localhost:8080/report/octocat/stream');
});

test('5xx /health is unreachable: feature disabled before any stream opens', async () => {
  healthyFetch();
  fetchImpl = (url) =>
    url.endsWith('/health') ? { ok: false, status: 503 } : okResponse(url);
  await generate('octocat');
  assert.equal(FakeEventSource.instances.length, 0);
  assert.match(dom.reportContent.innerHTML, new RegExp(UNAVAILABLE));
});

test('3xx and 5xx /health responses are both unreachable', async () => {
  for (const status of [302, 503]) {
    healthyFetch();
    fetchImpl = (url) =>
      url.endsWith('/health') ? { ok: false, status } : okResponse(url);
    await generate('octocat');
    assert.equal(FakeEventSource.instances.length, 0, `${status} must not open a stream`);
    assert.match(dom.reportContent.innerHTML, new RegExp(UNAVAILABLE));
  }
});

test('health network rejection is unreachable', async () => {
  healthyFetch();
  fetchImpl = () => { throw new TypeError('offline'); };
  await generate('octocat');
  assert.equal(FakeEventSource.instances.length, 0);
  assert.match(dom.reportContent.innerHTML, new RegExp(UNAVAILABLE));
});

test('health uses a 2-second AbortController timeout and abort prevents stream creation', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { timer.cleared = true; };

  try {
    fetchImpl = (url, call) => {
      if (!url.endsWith('/health')) return okResponse(url);
      return new Promise((_, reject) => {
        call.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
    };

    const generation = generate('octocat');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 2000);
    assert.equal(fetchCalls[0].method, 'HEAD');
    assert.ok(fetchCalls[0].signal instanceof AbortSignal);
    timers[0].callback();
    await generation;

    assert.equal(timers[0].cleared, true);
    assert.equal(FakeEventSource.instances.length, 0);
    assert.match(dom.reportContent.innerHTML, new RegExp(UNAVAILABLE));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

// --- Progress lifecycle and payloads ----------------------------------------

test('queued payload consumes position and estimated_wait_seconds', async () => {
  const es = await startGeneration();
  es.emit('queued', { position: 2, estimated_wait_seconds: 30 });
  assert.match(dom.reportContent.innerHTML, /Your Report is Queued/);
  assert.match(dom.reportContent.innerHTML, /Position: 2/);
  assert.match(dom.reportContent.innerHTML, /Est\. wait: 30s/);

  es.emit('queued', { position: 1, estimated_wait_seconds: 10 });
  assert.match(dom.reportContent.innerHTML, /Position: 1/);
  assert.match(dom.reportContent.innerHTML, /Est\. wait: 10s/);
});

test('started payload consumes repos_found as the progress denominator', async () => {
  const es = await startGeneration();
  es.emit('started', { repos_found: 3 });
  assert.match(dom.reportContent.innerHTML, /Scanning 3 Repos/);
  assert.match(dom.reportContent.innerHTML, /0 \/ 3 repos scanned/);
});

test('scanning payload keys rows by repo and consumes index/total', async () => {
  const es = await startGeneration();
  es.emit('started', { repos_found: 3 });
  es.emit('scanning', { repo: 'octocat/Hello-World', index: 0, total: 3 });
  const row = dom.repoListProgress.querySelector('[data-repo="octocat/Hello-World"]');
  assert.ok(row, 'scanning row must be keyed by the repo field');
  assert.match(row.innerHTML, /octocat\/Hello-World/);
  assert.match(row.innerHTML, /Scanning\.\.\./);
  // pending placeholders rendered for the remaining positions (index..total-1)
  assert.equal(dom.repoListProgress.children.length, 4);
});

test('scanning uses index and total for pending placeholder labels', async () => {
  const es = await startGeneration();
  es.emit('started', { repos_found: 3 });
  es.emit('scanning', { repo: 'octocat/second-repo', index: 1, total: 3 });
  assert.equal(dom.repoListProgress.children.length, 3);
  assert.match(dom.repoListProgress.children[1].innerHTML, /Repo #2/);
  assert.match(dom.repoListProgress.children[2].innerHTML, /Repo #3/);
});

test('duplicate scanning repo keys are ignored', async () => {
  const es = await startGeneration();
  es.emit('started', { repos_found: 2 });
  es.emit('scanning', { repo: 'octocat/Hello-World', index: 0, total: 2 });
  const originalRow = dom.repoListProgress.children[0];
  es.emit('scanning', { repo: 'octocat/Hello-World', index: 1, total: 9 });
  assert.equal(dom.repoListProgress.children.length, 3);
  assert.equal(dom.repoListProgress.children[0], originalRow);
});

test('scanned payload consumes repo/commits_found and a tool→count map, filtering non-positive counts', async () => {
  const es = await startGeneration();
  es.emit('started', { repos_found: 2 });
  es.emit('scanning', { repo: 'octocat/Hello-World', index: 0, total: 2 });
  es.emit('scanned', {
    repo: 'octocat/Hello-World',
    commits_found: 12,
    tools: { claude: 7, cursor: 0, unknowntool: 3 },
  });
  const row = dom.repoListProgress.querySelector('[data-repo="octocat/Hello-World"]');
  assert.match(row.innerHTML, /12 commits/);
  assert.match(row.innerHTML, /🟣 7/); // claude, count > 0
  assert.match(row.innerHTML, /⬜ 3/); // unknown tool degrades to ⬜
  assert.doesNotMatch(row.innerHTML, /🔵/); // cursor count 0 is filtered
});

test('scanned payload without optional tools uses an empty map', async () => {
  const es = await startGeneration();
  es.emit('started', { repos_found: 1 });
  es.emit('scanning', { repo: 'octocat/Hello-World', index: 0, total: 1 });
  es.emit('scanned', { repo: 'octocat/Hello-World', commits_found: 0 });
  const row = dom.repoListProgress.querySelector('[data-repo="octocat/Hello-World"]');
  assert.match(row.innerHTML, /0 commits/);
  assert.doesNotMatch(row.innerHTML, /🟣|🔵|⬜/);
});

test('scanned event without a matching scanning row has no visible effect', async () => {
  const es = await startGeneration();
  es.emit('started', { repos_found: 1 });
  const before = dom.reportContent.innerHTML;
  es.emit('scanned', { repo: 'octocat/missing', commits_found: 9, tools: { claude: 9 } });
  assert.equal(dom.reportContent.innerHTML, before);
  assert.equal(dom.repoListProgress.children.length, 0);
});

test('terminal complete closes the stream and renders the full report response', async () => {
  const es = await startGeneration();
  es.emit('complete', FULL_REPORT);
  assert.equal(es.closed, true, 'complete must close the EventSource (terminal success)');

  const html = dom.reportContent.innerHTML;
  assert.match(html, /octocat/);
  assert.match(html, /#42 of (<span[^>]*>)?12,?000/); // rank + toLocaleString'd total_ranked
  assert.match(html, /Top 12\.7%/); // percentile 0.127 × 100
  assert.match(html, /497 commits · 5 repos/);
  assert.match(html, /Claude/); // by_tool breakdown rendered
  assert.match(html, /octocat\/Hello-World/);
  assert.match(html, /210 commits/);
  assert.match(html, /March 15, 2024/); // first_ai_commit (12:00Z stays same date in any TZ)
  assert.match(html, /🟣 🔵/); // top_repos[].tools is an array of tool names
  assert.match(html, /300 \(60\.4%\)/);
  assert.match(html, /150 \(30\.2%\)/);
  assert.match(html, /47 \(9\.5%\)/);
  assert.ok(html.indexOf('Claude') < html.indexOf('Cursor'));
  assert.ok(html.indexOf('Cursor') < html.indexOf('Aider'), 'by_tool bars are sorted descending');
  assert.match(html, /height: 100%/);
  assert.match(html, /height: 11\.11111111111111%/);

  const rendered = dom.reportContent.innerHTML;
  es.emit('error', { message: 'a terminal stream cannot fail again' });
  assert.equal(dom.reportContent.innerHTML, rendered, 'events after complete are ignored');
});

test('a cached report replays terminal complete immediately, without progress events', async () => {
  const es = await startGeneration('cached-user');
  es.emit('complete', { ...FULL_REPORT, username: 'cached-user' });
  assert.equal(es.closed, true);
  assert.match(dom.reportContent.innerHTML, /cached-user/);
});

test('complete with absent optionals renders the documented defaults', async () => {
  const es = await startGeneration();
  es.emit('complete', { rank: 999 });
  const html = dom.reportContent.innerHTML;
  assert.match(html, /<h2>Unknown<\/h2>/);
  assert.match(html, /src="https:\/\/github\.com\/unknown\.png"/);
  assert.match(html, /#999 of N\/A/);
  assert.match(html, /0 commits · 0 repos/);
  assert.match(html, /Top 0\.0%/);
  assert.match(html, /No tools detected/);
  assert.match(html, /No recent activity/);
  assert.match(html, /No repos found/);
  assert.doesNotMatch(html, /First AI Commit/);
});

test('complete applies defaults to falsy values and empty collections', async () => {
  const es = await startGeneration();
  es.emit('complete', {
    username: '', rank: 1, total_ranked: 0, percentile: 0,
    total_commits: 0, repos_with_commits: 0, by_tool: {},
    sparkline_30d: [], top_repos: [], first_ai_commit: '',
  });
  const html = dom.reportContent.innerHTML;
  assert.match(html, /<h2>Unknown<\/h2>/);
  assert.match(html, /src="https:\/\/github\.com\/unknown\.png"/);
  // Zero is stringified before the fallback, so it renders as "0"; absence is N/A.
  assert.match(html, /#1 of 0/);
  assert.match(html, /0 commits · 0 repos/);
  assert.match(html, /Top 0\.0%/);
  assert.match(html, /No tools detected/);
  assert.match(html, /No recent activity/);
  assert.match(html, /No repos found/);
  assert.doesNotMatch(html, /First AI Commit/);
});

test('complete without rank renders the documented literal undefined rank', async () => {
  const es = await startGeneration();
  es.emit('complete', { username: 'rankless' });
  assert.match(dom.reportContent.innerHTML, /#undefined of N\/A/);
});

test('complete accepts unknown tool keys and renders the documented fallback icon', async () => {
  const es = await startGeneration();
  es.emit('complete', {
    username: 'u', rank: 1, total_commits: 2, by_tool: { mystery: 2 },
    top_repos: [{ repo: 'u/repo', commits: 2, tools: ['mystery'] }],
  });
  const html = dom.reportContent.innerHTML;
  assert.match(html, /⬜ Mystery/);
  assert.match(html, /class="repo-tools">⬜/);
  assert.match(html, /2 \(100\.0%\)/);
});

test('complete: a top_repos entry without tools throws — tools is required within the array', async () => {
  const es = await startGeneration();
  const before = dom.reportContent.innerHTML;
  // (repo.tools || {}).map is not a function: the {} fallback has no .map, so
  // showReport aborts before assigning innerHTML. The server must send tools
  // in every top_repos entry — [] for "no tools", never an absent field.
  assert.throws(
    () => es.emit('complete', {
      username: 'u', rank: 1, total_commits: 10,
      top_repos: [{ repo: 'u/repo', commits: 1 }], // no tools field
    }),
    /map is not a function/,
  );
  assert.equal(es.closed, true, 'close() already ran — the freeze happens at render time');
  assert.equal(dom.reportContent.innerHTML, before, 'the report never renders: modal keeps the stale progress frame');
});

test('complete: an empty tools array is the documented no-tools value and renders safely', async () => {
  const es = await startGeneration();
  es.emit('complete', {
    username: 'u', rank: 1, total_commits: 10,
    top_repos: [{ repo: 'u/repo', commits: 1, tools: [] }],
  });
  const html = dom.reportContent.innerHTML;
  assert.match(html, /u\/repo/);
  assert.match(html, /1 commits/);
});

test('complete: by_tool without total_commits renders NaN percentages — send them together', async () => {
  const es = await startGeneration();
  // by_tool percentages divide by the raw total_commits, not the defaulted
  // one: absent total_commits yields "N (NaN%)" bars. Pinning the failure so
  // the "always send total_commits with by_tool" rule in the doc is enforced.
  es.emit('complete', { username: 'u', rank: 1, by_tool: { claude: 5 } });
  const html = dom.reportContent.innerHTML;
  assert.match(html, /5 \(NaN%\)/);
  assert.match(html, /width: NaN%/);
});

// --- Framing -----------------------------------------------------------------

test('default message events are ignored: only named events drive the UI', async () => {
  const es = await startGeneration();
  const before = dom.reportContent.innerHTML;
  es.emit('message', { position: 1, estimated_wait_seconds: 5 });
  assert.equal(dom.reportContent.innerHTML, before, 'a message event must not change anything');
  assert.match(before, new RegExp(CONNECTING));
});

for (const eventType of ['queued', 'started', 'scanning', 'scanned', 'complete']) {
  test(`${eventType} requires one valid JSON data object`, async () => {
    const es = await startGeneration();
    if (eventType === 'scanning' || eventType === 'scanned') {
      es.emit('started', { repos_found: 1 });
      if (eventType === 'scanned') {
        es.emit('scanning', { repo: 'octocat/Hello-World', index: 0, total: 1 });
      }
    }
    const before = dom.reportContent.innerHTML;
    assert.throws(() => es.emitRaw(eventType, '{"split":\n'), SyntaxError);
    assert.equal(dom.reportContent.innerHTML, before, 'malformed/split JSON leaves stale content');
    assert.equal(es.closed, false, 'JSON parse failure is not handled as a terminal event');
  });
}

// --- Terminal failure and reconnect behavior ---------------------------------

test('named error event is terminal: stream closed, generic message, server detail never surfaced', async () => {
  const es = await startGeneration();
  assert.doesNotThrow(() => es.emitRaw('error', 'not JSON: github rate limited'));
  assert.equal(es.closed, true, 'error must close the EventSource (terminal failure)');
  const html = dom.reportContent.innerHTML;
  assert.match(html, new RegExp(GENERIC_FAILURE));
  assert.doesNotMatch(html, /rate limited/, 'error payload is not consumed by this client');
});

test('native transport error is terminal: reconnect is cancelled, later events are dropped', async () => {
  const es = await startGeneration();
  es.emit('error'); // native error events carry no data
  assert.equal(es.closed, true, 'client closes instead of letting EventSource auto-reconnect');
  const before = dom.reportContent.innerHTML;
  es.emit('complete', FULL_REPORT);
  assert.equal(dom.reportContent.innerHTML, before, 'no events are processed after the stream is closed');
});

test('non-200, wrong content type, and dropped stream all use terminal transport failure handling', async () => {
  for (const cause of ['non-200 HTTP response', 'wrong Content-Type', 'connection drop']) {
    const es = await startGeneration();
    const openedCount = FakeEventSource.instances.length;
    es.emit('started', { repos_found: 2 });
    es.emit('error'); // EventSource reports these transport failures as a native error.
    assert.equal(es.closed, true, `${cause} closes the EventSource`);
    assert.match(dom.reportContent.innerHTML, new RegExp(GENERIC_FAILURE));
    assert.equal(FakeEventSource.instances.length, openedCount, `${cause} does not create a replacement stream`);
  }
});

test('an idle SSE stream has no client inactivity watchdog', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { timer.cleared = true; };

  try {
    const es = await startGeneration();
    assert.deepEqual(timers.map((timer) => timer.delay), [2000]);
    assert.equal(timers[0].cleared, true, 'only the completed health timer exists');
    assert.match(dom.reportContent.innerHTML, new RegExp(CONNECTING));
    assert.equal(es.closed, false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('a pending POST has no timeout or AbortSignal and leaves the opened stream connecting', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { timer.cleared = true; };

  try {
    fetchImpl = (url) => {
      if (url.endsWith('/health')) return { ok: true, status: 200 };
      return new Promise(() => {});
    };
    let settled = false;
    const generation = generate('octocat').then(() => { settled = true; });
    await new Promise((resolve) => originalSetTimeout(resolve, 0));

    assert.equal(FakeEventSource.instances.length, 1, 'the stream opens before the POST');
    assert.equal(fetchCalls[1].method, 'POST');
    assert.equal(fetchCalls[1].signal, undefined);
    assert.deepEqual(timers.map((timer) => timer.delay), [2000]);
    assert.equal(timers[0].cleared, true);
    assert.equal(settled, false, 'the POST promise remains pending');
    assert.match(dom.reportContent.innerHTML, new RegExp(CONNECTING));
    assert.equal(FakeEventSource.instances[0].closed, false);
    void generation;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

// --- POST trigger -------------------------------------------------------------

test('POST network rejection closes the current stream and surfaces the raw error', async () => {
  fetchImpl = (url) => {
    if (url.endsWith('/health')) return { ok: true, status: 200 };
    throw new Error('post failed');
  };
  await generate('octocat'); // resolves — generate() catches the rejected POST
  const es = FakeEventSource.instances.at(-1);
  assert.equal(es.closed, true);
  assert.match(dom.reportContent.innerHTML, /post failed/);
});

test('POST HTTP statuses and bodies are ignored while the stream remains responsible', async () => {
  for (const status of [201, 400, 503]) {
    healthyFetch();
    let statusReads = 0;
    let bodyReads = 0;
    fetchImpl = (url) => {
      if (url.endsWith('/health')) return { ok: true, status: 200 };
      return {
        get ok() { statusReads += 1; return status >= 200 && status < 300; },
        get status() { statusReads += 1; return status; },
        json() { bodyReads += 1; },
        text() { bodyReads += 1; },
      };
    };
    await generate('octocat');
    assert.equal(statusReads, 0, `${status} status/body metadata must not be inspected`);
    assert.equal(bodyReads, 0, `${status} response body must not be read`);
    assert.equal(FakeEventSource.instances.at(-1).closed, false);
    assert.match(dom.reportContent.innerHTML, new RegExp(CONNECTING));
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failed = 0;
for (const { name, fn } of tests) {
  resetDom();
  fetchCalls = [];
  FakeEventSource.instances = [];
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${tests.length} contract tests failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${tests.length} report SSE contract tests passed.`);
}
