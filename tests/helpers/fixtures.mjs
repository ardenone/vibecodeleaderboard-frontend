// Deterministic leaderboard fixtures for the browser tests.
// Object shapes mirror the baked-in /leaderboard.json payload.

export function makeUser({ rank, username, byTool = {}, commitCount = 100, commits30d = 10, repos = 1 }) {
  return {
    rank,
    username,
    avatar_url: `https://example.com/avatars/${encodeURIComponent(username)}.png`,
    profile_url: `https://github.com/${username}`,
    commit_count: commitCount,
    commits_30d: commits30d,
    unique_repos: repos,
    recent_repos: Array.from({ length: repos }, (_, i) => `${username}/repo${i + 1}`),
    latest_commit: '2026-08-01T00:00:00+00:00',
    by_tool: byTool,
  };
}

function leaderboard(rankings) {
  return { generated_at: '2026-09-01T00:00:00Z', rankings };
}

// Nine users covering: every tool button, one user with no tool data
// (dave), and one tool (gemini) that no user has, for the empty-filter
// case. Totals used by the stats-bar assertions:
//   users = 9, commits = 1790, repos = 3+2+2+1+1+2+1+1+1 = 14
export function smallLeaderboard() {
  const rows = [
    { username: 'alice', byTool: { claude: 400, cursor: 100 }, commitCount: 500, commits30d: 120, repos: 3 },
    { username: 'bob', byTool: { cursor: 300 }, commitCount: 300, commits30d: 90, repos: 2 },
    { username: 'carol', byTool: { aider: 200, claude: 50 }, commitCount: 250, commits30d: 60, repos: 2 },
    { username: 'dave', byTool: {}, commitCount: 200, commits30d: 40, repos: 1 },
    { username: 'eve', byTool: { claude: 150 }, commitCount: 150, commits30d: 30, repos: 1 },
    { username: 'frank', byTool: { codex: 140, opencode: 10 }, commitCount: 150, commits30d: 30, repos: 2 },
    { username: 'grace', byTool: { claude: 90 }, commitCount: 90, commits30d: 20, repos: 1 },
    { username: 'heidi', byTool: { cursor: 80 }, commitCount: 80, commits30d: 15, repos: 1 },
    { username: 'ivan', byTool: { claude: 70 }, commitCount: 70, commits30d: 10, repos: 1 },
  ];
  return leaderboard(rows.map((row, i) => makeUser({ rank: i + 1, ...row })));
}

// Names matching /^testuser\d{3}$/ flip the demo-data banner on.
export function demoDataLeaderboard() {
  const rows = [1, 2, 3].map((n) => ({
    username: `testuser${String(n).padStart(3, '0')}`,
    byTool: { claude: 10 },
    commitCount: 50,
  }));
  return leaderboard(rows.map((row, i) => makeUser({ rank: i + 1, ...row })));
}

// One case-insensitive target ("AliceArdern") and twelve users sharing the
// substring "fan" so the ten-result cap and the "and N more" footer both
// apply.
export function searchLeaderboard() {
  const rows = [
    { username: 'AliceArdern', byTool: { claude: 30 }, commitCount: 30 },
    { username: 'bobby', byTool: { cursor: 20 }, commitCount: 20 },
    ...Array.from({ length: 12 }, (_, i) => ({
      username: `fan${String(i + 1).padStart(3, '0')}`,
      byTool: { aider: 10 },
      commitCount: 10,
    })),
  ];
  return leaderboard(rows.map((row, i) => makeUser({ rank: i + 1, ...row })));
}

export function largeLeaderboard(count) {
  const rankings = Array.from({ length: count }, (_, i) => makeUser({
    rank: i + 1,
    username: `pager${String(i + 1).padStart(3, '0')}`,
    byTool: { claude: 100 - i },
    commitCount: 1000 - i,
    commits30d: 30,
    repos: 2,
  }));
  return leaderboard(rankings);
}
