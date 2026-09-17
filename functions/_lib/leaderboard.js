// Access to the deployment's baked-in leaderboard.json — the API's data
// source for profile lookups, rank/percentile math, and the degraded
// leaderboard-snapshot report mode. The same artifact the static site
// renders is the source of truth; there is no separate backend database.

import { fetchAsset } from './api.js';

export async function loadLeaderboard(context) {
    try {
        const response = await fetchAsset(context, '/leaderboard.json');
        if (!response.ok) return null;
        const data = await response.json();
        return Array.isArray(data?.rankings) ? data : null;
    } catch (error) {
        console.error('Error loading leaderboard data:', error);
        return null;
    }
}

export function findByUsername(rankings, username) {
    if (!Array.isArray(rankings) || !username) return null;
    const needle = username.toLowerCase();
    return rankings.find(
        (entry) =>
            typeof entry?.username === 'string' &&
            entry.username.toLowerCase() === needle
    ) || null;
}

// Shape documented in docs/notes/report-sse-api-contract.md §4. `cached_at`
// mirrors the data's own `generated_at` — the baked-in file is the cache.
export function toUserPayload(entry, totalRanked, generatedAt) {
    return {
        username: entry.username,
        rank: entry.rank,
        commit_count: entry.commit_count,
        commits_30d: entry.commits_30d,
        unique_repos: entry.unique_repos,
        by_tool: entry.by_tool ?? {},
        recent_repos: entry.recent_repos ?? [],
        avatar_url: entry.avatar_url || `https://github.com/${entry.username}.png`,
        profile_url: entry.profile_url || `https://github.com/${entry.username}`,
        total_ranked: totalRanked,
        cached_at: generatedAt || new Date().toISOString(),
    };
}

// Where a scanned user would sit relative to the leaderboard. The
// leaderboard counts AI-assisted commits, which is what the scan counts,
// so the comparison is like-for-like. Users already on the board keep
// their published rank so the report and the table never disagree.
export function computeRank(scanResult, leaderboardData) {
    const rankings = Array.isArray(leaderboardData?.rankings) ? leaderboardData.rankings : [];
    const entry = findByUsername(rankings, scanResult.username);

    let rank;
    let totalRanked;

    if (entry) {
        rank = entry.rank;
        totalRanked = rankings.length;
    } else {
        rank = 1 + rankings.filter((r) => (Number(r?.commit_count) || 0) > scanResult.total_commits).length;
        totalRanked = rankings.length + 1;
    }

    const percentile = totalRanked > 0 ? rank / totalRanked : 0;
    return { rank, totalRanked, percentile };
}

// Degraded-mode report assembled from the leaderboard snapshot when a live
// GitHub scan is unavailable (no GITHUB_TOKEN and the unauthenticated
// budget is exhausted). Per-repo counts are not in the snapshot, so
// top_repos stays empty rather than inventing numbers.
export function leaderboardDerivedReport(entry, leaderboardData) {
    const rankings = leaderboardData?.rankings ?? [];
    const totalRanked = rankings.length;
    return {
        username: entry.username,
        rank: entry.rank,
        total_ranked: totalRanked,
        percentile: totalRanked > 0 ? entry.rank / totalRanked : 0,
        total_commits: entry.commit_count,
        repos_with_commits: entry.unique_repos,
        by_tool: entry.by_tool ?? {},
        sparkline_30d: (Array.isArray(entry.sparkline_30d) ? entry.sparkline_30d : [])
            .map((day) => Number(day?.count) || 0),
        top_repos: [],
        source: 'leaderboard-snapshot',
    };
}
