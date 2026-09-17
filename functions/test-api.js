/**
 * Tests for the API Pages Functions (the backend replacement).
 *
 * Every assertion pins a rule from docs/notes/report-sse-api-contract.md or
 * the deployment behavior documented in functions/README.md: hostname
 * gating, CORS, endpoint shapes, SSE framing/lifecycle, cached replay,
 * disconnect survival, and degraded modes.
 *
 * Runtime-free by repo convention: endpoint modules are exercised with
 * synthetic Pages contexts (mock ASSETS binding, mock GitHub fetch); no
 * wrangler, no network.
 *
 * Run with: node functions/test-api.js   (or `make test`)
 */

import assert from 'node:assert/strict';
import { onRequest as healthEndpoint } from './health.js';
import { onRequest as leaderboardEndpoint } from './leaderboard.json.js';
import { onRequest as userEndpoint } from './user/[username].js';
import { onRequest as reportEndpoint } from './report/[username].js';
import { onRequest as streamEndpoint } from './report/[username]/stream.js';
import { detectTools } from './_lib/github.js';
import { __resetReportState, getJob } from './_lib/jobs.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LB_GENERATED_AT = '2026-09-17T00:00:00Z';
const leaderboardFixture = {
    generated_at: LB_GENERATED_AT,
    rankings: [
        {
            rank: 1,
            username: 'topuser',
            avatar_url: 'https://github.com/topuser.png?size=80',
            profile_url: 'https://github.com/topuser',
            commit_count: 900,
            commits_30d: 90,
            unique_repos: 9,
            recent_repos: ['topuser/big'],
            by_tool: { claude: 800, cursor: 100 },
            sparkline_30d: [{ date: '2026-09-16', count: 3 }],
        },
        {
            rank: 2,
            username: 'miduser',
            commit_count: 400,
            commits_30d: 40,
            unique_repos: 4,
            recent_repos: [],
            by_tool: { aider: 400 },
            sparkline_30d: [],
        },
    ],
};

function assetFetch(url) {
    const pathname = typeof url === 'string' ? new URL(url).pathname : url.pathname;
    if (pathname === '/leaderboard.json') {
        return Response.json(leaderboardFixture);
    }
    return new Response('not found', { status: 404 });
}

function makeContext({
    path,
    method = 'GET',
    hostname = 'api.vibecodeleaderboard.com',
    origin = null,
    params = {},
    env = {},
    assets = assetFetch,
} = {}) {
    const url = new URL(path, `https://${hostname}`);
    const headers = new Headers();
    if (origin) headers.set('Origin', origin);
    if (method === 'POST') headers.set('Content-Type', 'application/json');
    const request = new Request(url, { method, headers });
    const waitUntilPromises = [];
    return {
        request,
        params,
        env: { ASSETS: { fetch: assets }, REPORT_QUEUE_GRACE_MS: '0', ...env },
        waitUntil(promise) {
            waitUntilPromises.push(promise);
        },
        __waitUntilPromises: waitUntilPromises,
        next: () => new Response('static-fallthrough', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    };
}

// --- GitHub mock -----------------------------------------------------------

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
const OLD_COMMIT_DATE = daysAgo(200);
const RECENT_A = daysAgo(5);
const RECENT_B = daysAgo(3);

function commit(message, date) {
    return { commit: { message, author: { date } } };
}

const SCAN_USER_COMMITS = {
    'scanuser/one': [
        commit(`feat: add thing\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>`, RECENT_A),
        commit('chore: tune\n\nGenerated with Cursor', RECENT_B),
        commit('fix: plain human commit', RECENT_A),
    ],
    'scanuser/two': [
        commit('refactor: with aider assistance', OLD_COMMIT_DATE),
    ],
};

function scanUserGithubMock() {
    const fetched = [];
    const fetchImpl = async (url) => {
        const { pathname, searchParams } = new URL(url);
        fetched.push(pathname);
        if (pathname === '/users/scanuser') {
            return Response.json({ login: 'scanuser' });
        }
        if (pathname === '/users/scanuser/repos') {
            return Response.json([
                { full_name: 'scanuser/one', fork: false },
                { full_name: 'scanuser/two', fork: false },
                { full_name: 'scanuser/forked', fork: true },
            ]);
        }
        const commitsMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/commits$/);
        if (commitsMatch) {
            const repo = `${commitsMatch[1]}/${commitsMatch[2]}`;
            if (repo === 'scanuser/forked') {
                throw new Error('forked repo must not be scanned');
            }
            if (SCAN_USER_COMMITS[repo]) {
                return Response.json(SCAN_USER_COMMITS[repo]);
            }
            return Response.json([]);
        }
        return new Response('mock miss', { status: 404 });
    };
    fetchImpl.fetched = fetched;
    return fetchImpl;
}

function rateLimitedGithubMock() {
    return async () =>
        new Response('rate limit exceeded', {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0' },
        });
}

function notFoundUserGithubMock() {
    return async (url) => {
        const { pathname } = new URL(url);
        if (pathname === '/users/ghostie') {
            return new Response('not found', { status: 404 });
        }
        return Response.json({ login: 'ghostie' });
    };
}

// --- SSE reader ------------------------------------------------------------

async function readSse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames = [];
    for (;;) {
        // Watchdog: a stalled stream breaks out with whatever arrived so
        // assertions report the partial frame list instead of hanging.
        const read = await Promise.race([
            reader.read(),
            new Promise((resolve) => setTimeout(() => resolve({ done: true }), 8000)),
        ]);
        if (read.done) break;
        const { value } = read;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (raw.startsWith(':')) {
                frames.push({ comment: raw.replace(/^:\s?/, '') });
                continue;
            }
            const frame = { event: null, data: null, lines: raw.split('\n') };
            for (const line of raw.split('\n')) {
                if (line.startsWith('event: ')) frame.event = line.slice(7);
                if (line.startsWith('data: ')) frame.data = line.slice(6);
            }
            frames.push(frame);
        }
    }
    return frames;
}

function namedEvents(frames) {
    return frames.filter((frame) => frame.event !== null);
}

// ---------------------------------------------------------------------------
// Tool signature detection (table-driven)
// ---------------------------------------------------------------------------

function testDetectTools() {
    const cases = [
        ['feat: x\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>', ['claude']],
        ['docs: y\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)', ['claude']],
        ['chore: z\n\nCo-Authored-By: Cursor <cursor@cursor.com>', ['cursor']],
        ['fix: w\n\nGenerated with Gemini CLI', ['gemini']],
        ['refactor: aider wrote this', ['aider']],
        ['Co-Authored-By: aider (openai) <aider@example.com>', ['aider']],
        ['docs: notes\n\nGenerated with Codex', ['codex']],
        ['feat: q\n\nCo-Authored-By: opencode <opencode@atelier.sm>', ['opencode']],
        ['fix: plain commit with no attribution', []],
        ['fix: use cursor position carefully in the renderer', []],
        ['fix: apply the gemini protocol patch to the parser', []],
        ['feat: mixed\n\nCo-Authored-By: Claude\nGenerated with Cursor', ['claude', 'cursor']],
    ];
    for (const [message, expected] of cases) {
        assert.deepEqual(
            detectTools(message).sort(),
            expected,
            `detectTools(${JSON.stringify(message)})`
        );
    }
    console.log('ok   - detectTools signature table');
}

// ---------------------------------------------------------------------------
// Hostname gate, CORS, /health
// ---------------------------------------------------------------------------

async function testGateAndHealth() {
    for (const hostname of ['vibecodeleaderboard.com', 'www.vibecodeleaderboard.com']) {
        const context = makeContext({ path: '/health', hostname });
        const response = await healthEndpoint(context);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'static-fallthrough', `${hostname} must fall through to static`);
    }

    for (const hostname of ['api.vibecodeleaderboard.com', 'localhost', '127.0.0.1']) {
        const context = makeContext({ path: '/health', hostname });
        const response = await healthEndpoint(context);
        assert.equal(response.status, 200, `${hostname} must serve the API`);
        const body = await response.json();
        assert.equal(body.status, 'ok');
    }

    // HEAD gets headers only; the wrapper strips the body.
    const headContext = makeContext({ path: '/health', method: 'HEAD' });
    const headResponse = await healthEndpoint(headContext);
    assert.equal(headResponse.status, 200);
    assert.equal(await headResponse.text(), '');

    // Disallowed methods are rejected uniformly by the wrapper.
    const putContext = makeContext({ path: '/health', method: 'PUT' });
    assert.equal((await healthEndpoint(putContext)).status, 405);

    // CORS: allowlisted origins are echoed, others get no ACAO header.
    const goodContext = makeContext({ path: '/health', origin: 'https://vibecodeleaderboard.com' });
    const goodResponse = await healthEndpoint(goodContext);
    assert.equal(goodResponse.headers.get('Access-Control-Allow-Origin'), 'https://vibecodeleaderboard.com');
    assert.match(goodResponse.headers.get('Access-Control-Allow-Methods'), /POST/);

    const evilContext = makeContext({ path: '/health', origin: 'https://evil.example' });
    const evilResponse = await healthEndpoint(evilContext);
    assert.equal(evilResponse.headers.get('Access-Control-Allow-Origin'), null);

    // Preflight (the report POST sends Content-Type: application/json).
    const preflightContext = makeContext({ path: '/report/scanuser', method: 'OPTIONS', origin: 'https://www.vibecodeleaderboard.com' });
    const preflight = await reportEndpoint(preflightContext);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://www.vibecodeleaderboard.com');
    assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Content-Type/);

    // Operator override of the allowlist.
    const overrideContext = makeContext({
        path: '/health',
        origin: 'https://custom.example',
        env: { ALLOWED_ORIGINS: 'https://custom.example' },
    });
    const overrideResponse = await healthEndpoint(overrideContext);
    assert.equal(overrideResponse.headers.get('Access-Control-Allow-Origin'), 'https://custom.example');

    console.log('ok   - hostname gate, CORS, /health');
}

// ---------------------------------------------------------------------------
// /leaderboard.json and /user/{username}
// ---------------------------------------------------------------------------

async function testLeaderboardAndUser() {
    const lbContext = makeContext({ path: '/leaderboard.json', origin: 'https://vibecodeleaderboard.com' });
    const lbResponse = await leaderboardEndpoint(lbContext);
    assert.equal(lbResponse.status, 200);
    assert.match(lbResponse.headers.get('Content-Type'), /application\/json/);
    assert.deepEqual(await lbResponse.json(), leaderboardFixture);

    const brokenContext = makeContext({ path: '/leaderboard.json', assets: async () => new Response('boom', { status: 500 }) });
    assert.equal((await leaderboardEndpoint(brokenContext)).status, 503);

    const userContext = makeContext({ path: '/user/topuser', params: { username: 'topuser' } });
    const userResponse = await userEndpoint(userContext);
    assert.equal(userResponse.status, 200);
    const payload = await userResponse.json();
    assert.deepEqual(
        { ...payload },
        {
            username: 'topuser',
            rank: 1,
            commit_count: 900,
            commits_30d: 90,
            unique_repos: 9,
            by_tool: { claude: 800, cursor: 100 },
            recent_repos: ['topuser/big'],
            avatar_url: 'https://github.com/topuser.png?size=80',
            profile_url: 'https://github.com/topuser',
            total_ranked: 2,
            cached_at: LB_GENERATED_AT,
        }
    );

    // Case-insensitive lookup.
    const caseContext = makeContext({ path: '/user/TOPUSER', params: { username: 'TOPUSER' } });
    assert.equal((await userEndpoint(caseContext)).status, 200);

    // 404 shape is load-bearing: the profile page shows a distinct
    // "User Not Found" state for it.
    const missingContext = makeContext({ path: '/user/nobody', params: { username: 'nobody' } });
    const missingResponse = await userEndpoint(missingContext);
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await missingResponse.json(), { detail: "User 'nobody' not found" });

    const invalidContext = makeContext({ path: '/user/../etc', params: { username: '../etc' } });
    assert.equal((await userEndpoint(invalidContext)).status, 400);

    const postUserContext = makeContext({ path: '/user/topuser', method: 'POST', params: { username: 'topuser' } });
    assert.equal((await userEndpoint(postUserContext)).status, 405);

    const unavailableContext = makeContext({ path: '/user/topuser', params: { username: 'topuser' }, assets: async () => new Response('x', { status: 500 }) });
    assert.equal((await userEndpoint(unavailableContext)).status, 503);

    console.log('ok   - /leaderboard.json and /user/{username}');
}

// ---------------------------------------------------------------------------
// Report trigger + cached GET
// ---------------------------------------------------------------------------

async function testReportTriggerAndCache() {
    __resetReportState();
    const realFetch = globalThis.fetch;
    globalThis.fetch = scanUserGithubMock();

    try {
        const missingContext = makeContext({ path: '/report/scanuser', params: { username: 'scanuser' } });
        const missingResponse = await reportEndpoint(missingContext);
        assert.equal(missingResponse.status, 404);
        assert.match((await missingResponse.json()).detail, /not found/);

        const postContext = makeContext({ path: '/report/scanuser', method: 'POST', params: { username: 'scanuser' } });
        const postResponse = await reportEndpoint(postContext);
        assert.equal(postResponse.status, 202);
        assert.equal((await postResponse.json()).status, 'queued');
        assert.equal(postContext.__waitUntilPromises.length, 1, 'scan must run under waitUntil');

        // A duplicate POST while the job is live joins the same job; the
        // scan itself is awaited via the first POST's waitUntil promises.
        await Promise.all(postContext.__waitUntilPromises);
        const dupContext = makeContext({ path: '/report/scanuser', method: 'POST', params: { username: 'scanuser' } });
        await reportEndpoint(dupContext);
        assert.ok(getJob('scanuser'), 'job stays registered');
        assert.equal(getJob('scanuser').status, 'complete', 'scan finished');

        const getContext = makeContext({ path: '/report/scanuser', params: { username: 'scanuser' } });
        const getResponse = await reportEndpoint(getContext);
        assert.equal(getResponse.status, 200);
        const report = await getResponse.json();
        assert.equal(report.total_commits, 3);
        assert.equal(report.source, 'github-scan');
    } finally {
        globalThis.fetch = realFetch;
        __resetReportState();
    }

    console.log('ok   - POST/GET /report/{username}');
}

// ---------------------------------------------------------------------------
// SSE stream: full lifecycle
// ---------------------------------------------------------------------------

async function testStreamLifecycle() {
    __resetReportState();
    const realFetch = globalThis.fetch;
    globalThis.fetch = scanUserGithubMock();

    try {
        const context = makeContext({
            path: '/report/scanuser/stream',
            origin: 'https://vibecodeleaderboard.com',
        });
        const response = await streamEndpoint(context);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('Content-Type'), /^text\/event-stream/);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://vibecodeleaderboard.com');
        assert.equal(response.headers.get('Cache-Control'), 'no-store');

        const frames = await readSse(response);
        const events = namedEvents(frames);
        const names = events.map((event) => event.event);

        // Lifecycle: queued → started → (scanning → scanned)* → complete,
        // exactly one terminal event, last.
        assert.equal(names[0], 'queued');
        assert.equal(names[1], 'started');
        assert.equal(names[names.length - 1], 'complete');
        assert.equal(names.filter((name) => name === 'complete' || name === 'error').length, 1);

        const queued = JSON.parse(events[0].data);
        assert.equal(typeof queued.position, 'number');
        assert.equal(typeof queued.estimated_wait_seconds, 'number');

        const started = JSON.parse(events[1].data);
        assert.equal(started.repos_found, 2, 'forked repo excluded');

        // scanning/scanned pair up by repo key, in order, 0-based index.
        const scanning = names.filter((n) => n === 'scanning');
        const scanned = names.filter((n) => n === 'scanned');
        assert.equal(scanning.length, 2);
        assert.equal(scanned.length, 2);
        events
            .filter((event) => event.event === 'scanning')
            .forEach((event, index) => {
                const data = JSON.parse(event.data);
                assert.equal(data.index, index);
                assert.equal(data.total, 2);
            });
        const scanningRepos = events.filter((e) => e.event === 'scanning').map((e) => JSON.parse(e.data).repo);
        const scannedRepos = events.filter((e) => e.event === 'scanned').map((e) => JSON.parse(e.data).repo);
        assert.deepEqual(scanningRepos, scannedRepos);

        // Every data payload is exactly one JSON object on one line.
        for (const event of events) {
            assert.equal(event.data.split('\n').length, 1, 'single-line data field');
            assert.equal(typeof JSON.parse(event.data), 'object');
        }

        // Completed report shape.
        const report = JSON.parse(events[names.length - 1].data);
        assert.equal(report.username, 'scanuser');
        assert.equal(report.total_commits, 3);
        assert.equal(report.repos_with_commits, 2);
        assert.deepEqual(report.by_tool, { claude: 1, cursor: 1, aider: 1 });
        assert.equal(report.top_repos.length, 2);
        assert.deepEqual(report.top_repos[0], { repo: 'scanuser/one', commits: 2, tools: ['claude', 'cursor'] });
        assert.deepEqual(report.top_repos[1], { repo: 'scanuser/two', commits: 1, tools: ['aider'] });
        assert.ok(Array.isArray(report.top_repos[0].tools), 'top_repos[].tools is an array');
        assert.equal(report.sparkline_30d.length, 30);
        assert.equal(report.sparkline_30d.reduce((a, b) => a + b, 0), 2, 'only in-window AI commits counted');
        assert.equal(report.first_ai_commit, OLD_COMMIT_DATE);

        // Rank math against the baked leaderboard: 900 and 400 both beat 3,
        // so scanuser lands at rank 3 of 3.
        assert.equal(report.rank, 3);
        assert.equal(report.total_ranked, 3);
        assert.equal(report.percentile, 1);

        // Second connection replays the terminal event from cache without
        // rescanning (the GitHub mock would record duplicate fetches).
        const replayContext = makeContext({ path: '/report/scanuser/stream' });
        const replayFrames = await readSse(await streamEndpoint(replayContext));
        const replayEvents = namedEvents(replayFrames);
        assert.deepEqual(replayEvents.map((e) => e.event), ['complete']);
        assert.deepEqual(JSON.parse(replayEvents[0].data), report);
    } finally {
        globalThis.fetch = realFetch;
        __resetReportState();
    }

    console.log('ok   - SSE stream lifecycle and cached replay');
}

// ---------------------------------------------------------------------------
// SSE stream: generation survives client disconnect
// ---------------------------------------------------------------------------

async function testDisconnectSurvival() {
    __resetReportState();
    const realFetch = globalThis.fetch;
    let releaseCommits;
    const gate = new Promise((resolve) => {
        releaseCommits = resolve;
    });

    const mock = async (url) => {
        const { pathname } = new URL(url);
        if (pathname.startsWith('/repos/')) {
            await gate; // hold the scan open until the test releases it
            return Response.json(SCAN_USER_COMMITS['scanuser/one']);
        }
        return scanUserGithubMock()(url);
    };
    globalThis.fetch = mock;

    try {
        const context = makeContext({ path: '/report/scanuser/stream' });
        const response = await streamEndpoint(context);

        // Client goes away mid-scan: read the first frame, then cancel.
        const reader = response.body.getReader();
        const { value } = await reader.read();
        const firstFrame = new TextDecoder().decode(value);
        assert.match(firstFrame, /^event: queued/);
        await reader.cancel();
        releaseCommits();

        // The job kept running under waitUntil and cached the result.
        await Promise.all(context.__waitUntilPromises);
        const job = getJob('scanuser');
        assert.equal(job.status, 'complete');

        // Retrying replays the cached terminal event.
        const retryFrames = await readSse(await streamEndpoint(makeContext({ path: '/report/scanuser/stream' })));
        const retryEvents = namedEvents(retryFrames);
        assert.deepEqual(retryEvents.map((e) => e.event), ['complete']);
    } finally {
        releaseCommits();
        globalThis.fetch = realFetch;
        __resetReportState();
    }

    console.log('ok   - generation survives client disconnect');
}

// ---------------------------------------------------------------------------
// SSE heartbeat
// ---------------------------------------------------------------------------

async function testHeartbeat() {
    __resetReportState();
    const realFetch = globalThis.fetch;
    let releaseCommits;
    const gate = new Promise((resolve) => {
        releaseCommits = resolve;
    });
    globalThis.fetch = async (url) => {
        const { pathname } = new URL(url);
        if (pathname.startsWith('/repos/')) {
            await gate;
            return Response.json([]);
        }
        return scanUserGithubMock()(url);
    };

    try {
        const context = makeContext({
            path: '/report/scanuser/stream',
            env: { REPORT_PING_INTERVAL_MS: '10' },
        });
        const response = await streamEndpoint(context);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let sawPing = false;
        while (!sawPing) {
            const { done, value } = await reader.read();
            assert.ok(!done, 'stream must stay open with pings while idle');
            buffer += decoder.decode(value, { stream: true });
            if (buffer.includes(': ping')) sawPing = true;
        }
        assert.ok(sawPing, 'heartbeat comment observed');
        await reader.cancel();
    } finally {
        releaseCommits();
        globalThis.fetch = realFetch;
        __resetReportState();
    }

    console.log('ok   - SSE heartbeat comments');
}

// ---------------------------------------------------------------------------
// Error and degraded modes
// ---------------------------------------------------------------------------

async function testErrorAndDegradedModes() {
    const realFetch = globalThis.fetch;

    try {
        // Unknown GitHub user -> terminal error event, stream closes.
        __resetReportState();
        globalThis.fetch = notFoundUserGithubMock();
        let frames = await readSse(await streamEndpoint(makeContext({ path: '/report/ghostie/stream' })));
        let events = namedEvents(frames);
        assert.deepEqual(events.map((e) => e.event), ['queued', 'error']);
        const errorPayload = JSON.parse(events[1].data);
        assert.equal(errorPayload.code, 'user_not_found');

        // Rate-limited, user IS on the leaderboard -> leaderboard-snapshot
        // report (degraded mode), not an error.
        __resetReportState();
        globalThis.fetch = rateLimitedGithubMock();
        frames = await readSse(await streamEndpoint(makeContext({ path: '/report/topuser/stream' })));
        events = namedEvents(frames);
        assert.deepEqual(events.map((e) => e.event), ['queued', 'complete']);
        const snapshot = JSON.parse(events[1].data);
        assert.equal(snapshot.source, 'leaderboard-snapshot');
        assert.equal(snapshot.rank, 1);
        assert.equal(snapshot.total_ranked, 2);
        assert.equal(snapshot.total_commits, 900);
        assert.deepEqual(snapshot.sparkline_30d, [3]);
        assert.deepEqual(snapshot.top_repos, []);

        // Rate-limited, user NOT on the leaderboard -> terminal error.
        __resetReportState();
        frames = await readSse(await streamEndpoint(makeContext({ path: '/report/scanuser/stream' })));
        events = namedEvents(frames);
        assert.deepEqual(events.map((e) => e.event), ['queued', 'error']);
        assert.equal(JSON.parse(events[1].data).code, 'rate_limited');

        // Failed jobs are not cached: a retry starts a new job.
        assert.equal(getJob('scanuser').status, 'error');
        const retryContext = makeContext({ path: '/report/scanuser/stream' });
        const retryResponse = await streamEndpoint(retryContext);
        await Promise.all(retryContext.__waitUntilPromises);
        assert.notEqual(getJob('scanuser').status, 'complete');
        await retryResponse.body.cancel();
    } finally {
        globalThis.fetch = realFetch;
        __resetReportState();
    }

    console.log('ok   - error events and degraded leaderboard-snapshot mode');
}

// ---------------------------------------------------------------------------
// KV cache layer
// ---------------------------------------------------------------------------

async function testKvCache() {
    __resetReportState();
    const realFetch = globalThis.fetch;
    globalThis.fetch = scanUserGithubMock();

    const store = new Map();
    const kv = {
        // Mirrors Workers KV: get(key, 'json') parses the stored string.
        async get(key, type) {
            if (!store.has(key)) return null;
            return type === 'json' ? JSON.parse(store.get(key)) : store.get(key);
        },
        async put(key, value) {
            store.set(key, value);
        },
    };

    try {
        const first = makeContext({ path: '/report/scanuser/stream', env: { REPORT_CACHE: kv } });
        const frames = await readSse(await streamEndpoint(first));
        assert.equal(namedEvents(frames).at(-1).event, 'complete');
        assert.equal(store.size, 1, 'report persisted to KV');

        // New isolate: memory cache cleared, KV still warm -> immediate
        // replay without rescanning.
        __resetReportState();
        globalThis.fetch = async () => {
            throw new Error('KV replay must not hit GitHub');
        };
        const second = makeContext({ path: '/report/scanuser/stream', env: { REPORT_CACHE: kv } });
        const replay = await readSse(await streamEndpoint(second));
        assert.deepEqual(namedEvents(replay).map((e) => e.event), ['complete']);
    } finally {
        globalThis.fetch = realFetch;
        __resetReportState();
    }

    console.log('ok   - KV cache replay across isolates');
}

// ---------------------------------------------------------------------------

const tests = [
    testDetectTools,
    testGateAndHealth,
    testLeaderboardAndUser,
    testReportTriggerAndCache,
    testStreamLifecycle,
    testDisconnectSurvival,
    testHeartbeat,
    testErrorAndDegradedModes,
    testKvCache,
];

let failed = 0;
for (const test of tests) {
    process.stderr.write(`run  - ${test.name}\n`);
    try {
        await test();
    } catch (error) {
        failed += 1;
        console.error(`FAIL - ${test.name}:`, error?.stack || error);
    }
}

if (failed > 0) {
    console.error(`\n${failed} API test group(s) failed`);
    process.exit(1);
}
console.log(`\nall ${tests.length} API test groups passed`);
