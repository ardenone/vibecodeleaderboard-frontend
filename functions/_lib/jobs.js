// Report-generation job registry.
//
// One job per username, per isolate. The scan itself always runs under
// `context.waitUntil`, which is what makes the contract's disconnect rules
// hold: generation survives a dropped SSE connection, and the completed
// report is cached so a retry replays the terminal `complete` event instead
// of rescanning.
//
// Caching layers:
//   - module-scope memory (this isolate), TTL REPORT_CACHE_TTL_SECONDS
//   - optional `REPORT_CACHE` KV namespace binding, same TTL — survives
//     isolate recycling and shares results across isolates. Without the
//     binding the cache is best-effort per-isolate only.
// Failed jobs are never cached: a retry rescans.

import { scanUserCommits } from './github.js';
import { computeRank, findByUsername, leaderboardDerivedReport, loadLeaderboard } from './leaderboard.js';

const CACHE_TTL_SECONDS_DEFAULT = 6 * 60 * 60; // 6h
const JOB_LINGER_MS = 5 * 60 * 1000; // keep finished jobs for stream replay
const QUEUE_GRACE_MS_DEFAULT = 400;
const KV_KEY_PREFIX = 'report:v1:';

const registry = new Map(); // lowercase username -> job
const memoryCache = new Map(); // lowercase username -> { report, cachedAt }

function numberEnv(env, name, fallback) {
    const value = Number(env?.[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function jobKey(username) {
    return username.toLowerCase();
}

function createJob(username) {
    return {
        username,
        status: 'queued',
        events: [],
        subscribers: new Set(),
        report: null,
        errorCode: null,
        errorMessage: null,
        createdAt: Date.now(),
        finishedAt: null,
        runPromise: null,

        emit(name, data) {
            this.events.push({ name, data });
            for (const subscriber of this.subscribers) {
                try {
                    subscriber(name, data);
                } catch {
                    // A broken subscriber must not break the scan.
                }
            }
        },

        subscribe(subscriber) {
            this.subscribers.add(subscriber);
        },

        unsubscribe(subscriber) {
            this.subscribers.delete(subscriber);
        },

        isTerminal() {
            return this.status === 'complete' || this.status === 'error';
        },
    };
}

function syntheticCompleteJob(username, report) {
    const job = createJob(username);
    job.status = 'complete';
    job.report = report;
    job.finishedAt = Date.now();
    job.events.push({ name: 'complete', data: report });
    return job;
}

function scheduleLingerCleanup(username) {
    if (typeof setTimeout !== 'function') return;
    setTimeout(() => {
        const job = registry.get(jobKey(username));
        if (job && job.isTerminal()) {
            registry.delete(jobKey(username));
        }
    }, JOB_LINGER_MS).unref?.();
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export async function cacheReport(username, report, env) {
    const key = jobKey(username);
    const ttl = numberEnv(env, 'REPORT_CACHE_TTL_SECONDS', CACHE_TTL_SECONDS_DEFAULT) * 1000;
    memoryCache.set(key, { report, cachedAt: Date.now() });

    if (env?.REPORT_CACHE?.put) {
        try {
            const kvTtl = Math.max(60, Math.floor(ttl / 1000));
            await env.REPORT_CACHE.put(`${KV_KEY_PREFIX}${key}`, JSON.stringify({ report }), {
                expirationTtl: kvTtl,
            });
        } catch (error) {
            console.error('Report KV cache write failed:', error?.message || error);
        }
    }
}

export async function getCachedReport(username, env) {
    const key = jobKey(username);
    const ttl = numberEnv(env, 'REPORT_CACHE_TTL_SECONDS', CACHE_TTL_SECONDS_DEFAULT) * 1000;

    const memoryHit = memoryCache.get(key);
    if (memoryHit) {
        if (Date.now() - memoryHit.cachedAt < ttl) return memoryHit.report;
        memoryCache.delete(key);
    }

    if (env?.REPORT_CACHE?.get) {
        try {
            const wrapped = await env.REPORT_CACHE.get(`${KV_KEY_PREFIX}${key}`, 'json');
            if (wrapped?.report) {
                memoryCache.set(key, { report: wrapped.report, cachedAt: Date.now() });
                return wrapped.report;
            }
        } catch (error) {
            console.error('Report KV cache read failed:', error?.message || error);
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

export async function getOrCreateReportJob(context, username, fetchImpl = fetch) {
    const env = context.env ?? {};
    const key = jobKey(username);

    const cached = await getCachedReport(username, env);
    if (cached) {
        return syntheticCompleteJob(username, cached);
    }

    let job = registry.get(key);
    if (job && !job.isTerminal()) {
        return job;
    }

    job = createJob(username);
    registry.set(key, job);

    const run = runReportJob(job, context, fetchImpl).catch((error) => {
        // Safety net: runReportJob already converts expected failures into
        // `error` events; this guards against a bug in that conversion.
        console.error('Report job crashed:', error?.stack || error);
        if (!job.isTerminal()) {
            job.status = 'error';
            job.errorCode = 'internal_error';
            job.errorMessage = String(error?.message || error);
            job.emit('error', { code: job.errorCode, message: job.errorMessage });
            scheduleLingerCleanup(username);
        }
    });
    job.runPromise = run;

    if (typeof context.waitUntil === 'function') {
        context.waitUntil(run);
    }

    return job;
}

export function getJob(username) {
    return registry.get(jobKey(username)) || null;
}

export async function runReportJob(job, context, fetchImpl = fetch) {
    const env = context.env ?? {};
    const graceMs = numberEnv(env, 'REPORT_QUEUE_GRACE_MS', QUEUE_GRACE_MS_DEFAULT);

    job.status = 'queued';
    job.emit('queued', { position: 1, estimated_wait_seconds: 5 });
    if (graceMs > 0) await sleep(graceMs);

    let leaderboardData = null;
    let entry = null;

    try {
        leaderboardData = await loadLeaderboard(context);
        entry = leaderboardData ? findByUsername(leaderboardData.rankings, job.username) : null;

        const raw = await scanUserCommits(job.username, env, (name, data) => job.emit(name, data), fetchImpl);

        const { rank, totalRanked, percentile } = computeRank(raw, leaderboardData);
        const report = {
            username: raw.username,
            rank,
            total_ranked: totalRanked,
            percentile,
            total_commits: raw.total_commits,
            repos_with_commits: raw.repos_with_commits,
            by_tool: raw.by_tool,
            sparkline_30d: raw.sparkline_30d,
            top_repos: raw.top_repos,
            ...(raw.first_ai_commit ? { first_ai_commit: raw.first_ai_commit } : {}),
            source: 'github-scan',
        };

        job.report = report;
        job.status = 'complete';
        job.emit('complete', report);
        await cacheReport(job.username, report, env);
        scheduleLingerCleanup(job.username);
    } catch (error) {
        // Degraded mode: without a GITHUB_TOKEN the unauthenticated budget is
        // usually exhausted (shared egress IPs). If the user is on the baked-in
        // leaderboard, serve the leaderboard snapshot as the report — the
        // site's own data, honestly labeled via `source`.
        if (error?.code === 'rate_limited' && entry) {
            const report = leaderboardDerivedReport(entry, leaderboardData);
            job.report = report;
            job.status = 'complete';
            job.emit('complete', report);
            await cacheReport(job.username, report, env);
            scheduleLingerCleanup(job.username);
            return;
        }

        job.status = 'error';
        job.errorCode = error?.code || 'internal_error';
        job.errorMessage = String(error?.message || error);
        job.emit('error', { code: job.errorCode, message: job.errorMessage });
        scheduleLingerCleanup(job.username);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test hook: reset module-scope state between test cases.
export function __resetReportState() {
    registry.clear();
    memoryCache.clear();
}
