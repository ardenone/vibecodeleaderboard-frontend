// GitHub scanning for report generation. Replaces the scan the offline
// vibecodeleaderboard-backend service never grew: walks a user's recently
// pushed (non-fork) repos, reads their commits, and attributes commits to
// AI coding tools by their commit-message signatures.
//
// Budgets are chosen to stay inside Cloudflare's free-plan subrequest limit
// (50/request): 1 user lookup + 1 repo list + MAX_REPOS * MAX_COMMIT_PAGES.

const MAX_REPOS = 20;
const MAX_COMMIT_PAGES = 2;
const COMMITS_PER_PAGE = 100;
const TOP_REPOS_LIMIT = 10;
const SPARKLINE_DAYS = 30;

export class GitHubError extends Error {
    constructor(code, message, status) {
        super(message);
        this.name = 'GitHubError';
        this.code = code;
        this.status = status;
    }
}

export function githubClient(env, fetchImpl = fetch) {
    const token = typeof env?.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0
        ? env.GITHUB_TOKEN
        : null;

    return async function gh(path) {
        const headers = {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'vibecodeleaderboard-api',
        };
        if (token) headers.Authorization = `Bearer ${token}`;

        let response;
        try {
            response = await fetchImpl(`https://api.github.com${path}`, { headers });
        } catch (error) {
            throw new GitHubError('github_unreachable', `GitHub API request failed: ${error?.message || error}`, 0);
        }

        if (response.status === 404) {
            throw new GitHubError('user_not_found', `GitHub user not found: ${path}`, 404);
        }

        if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
            throw new GitHubError(
                'rate_limited',
                token
                    ? 'GitHub API rate limit exhausted for the configured token'
                    : 'GitHub API unauthenticated rate limit exhausted (bind GITHUB_TOKEN for production scans)',
                response.status
            );
        }

        if (response.status === 403) {
            throw new GitHubError('github_forbidden', 'GitHub API refused the request (403)', 403);
        }

        if (!response.ok) {
            throw new GitHubError('github_error', `GitHub API error ${response.status}`, response.status);
        }

        return response.json();
    };
}

// A commit counts for a tool when its message (including trailers) matches
// one of that tool's signatures. Detection is intentionally anchored on
// attribution phrases ("co-authored-by", "generated with", vendor domains)
// except for aider/opencode, which have no common-English collision risk.
// A single commit may count for several tools.
const TOOL_SIGNATURES = [
    ['claude', [/co-authored-by:[^>\n]*claude/i, /generated with[^\n]*claude/i, /noreply@anthropic\.com/i]],
    ['cursor', [/co-authored-by:[^>\n]*cursor/i, /generated with[^\n]*cursor/i, /cursor@cursor\.(?:com|ai)/i]],
    ['aider', [/co-authored-by:[^>\n]*aider/i, /\baider\b/i]],
    ['codex', [/co-authored-by:[^>\n]*codex/i, /generated with[^\n]*codex/i, /codex@openai\.com/i, /\bopenai codex\b/i]],
    ['gemini', [/co-authored-by:[^>\n]*gemini/i, /generated with[^\n]*gemini/i, /gemini@[^\n]*google/i]],
    ['opencode', [/co-authored-by:[^>\n]*opencode/i, /\bopencode\b/i]],
];

export function detectTools(message) {
    const text = typeof message === 'string' ? message : '';
    const tools = [];
    for (const [tool, patterns] of TOOL_SIGNATURES) {
        if (patterns.some((pattern) => pattern.test(text))) tools.push(tool);
    }
    return tools;
}

function dayKey(isoTimestamp) {
    return isoTimestamp.slice(0, 10);
}

// full_name is "owner/repo" and must stay two path segments — encoding the
// whole string would turn the slash into %2F and break the route.
function encodeRepoPath(fullName) {
    return String(fullName)
        .split('/')
        .map(encodeURIComponent)
        .join('/');
}

function buildSparkline(dailyCounts, now = new Date()) {
    const counts = [];
    for (let i = SPARKLINE_DAYS - 1; i >= 0; i--) {
        const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        counts.push(dailyCounts.get(day) || 0);
    }
    return counts;
}

// The scan itself. `emit(name, data)` receives the progress events exactly
// as they go on the SSE stream (started / scanning / scanned); the caller
// owns event framing and transport.
export async function scanUserCommits(username, env, emit, fetchImpl = fetch) {
    const gh = githubClient(env, fetchImpl);
    const encoded = encodeURIComponent(username);

    // Throws user_not_found / rate_limited / ... before any progress events.
    const user = await gh(`/users/${encoded}`);
    const allRepos = await gh(`/users/${encoded}/repos?sort=pushed&per_page=100`);
    const repos = (Array.isArray(allRepos) ? allRepos : [])
        .filter((repo) => repo && typeof repo.full_name === 'string' && !repo.fork)
        .slice(0, MAX_REPOS);

    emit('started', { repos_found: repos.length });

    const perTool = {};
    const dailyCounts = new Map();
    const todayKey = new Date().toISOString().slice(0, 10);
    let firstAiCommit = null;
    let totalCommits = 0;
    const repoResults = [];

    for (let index = 0; index < repos.length; index++) {
        const repo = repos[index];
        emit('scanning', { repo: repo.full_name, index, total: repos.length });

        let repoAiCommits = 0;
        const repoTools = {};

        for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
            const commits = await gh(
                `/repos/${encodeRepoPath(repo.full_name)}/commits` +
                `?author=${encoded}&per_page=${COMMITS_PER_PAGE}&page=${page}`
            );
            if (!Array.isArray(commits) || commits.length === 0) break;

            for (const commit of commits) {
                const tools = detectTools(commit?.commit?.message || '');
                if (tools.length === 0) continue;

                repoAiCommits++;
                totalCommits++;
                for (const tool of tools) {
                    perTool[tool] = (perTool[tool] || 0) + 1;
                    repoTools[tool] = (repoTools[tool] || 0) + 1;
                }

                const authoredAt = commit?.commit?.author?.date;
                if (typeof authoredAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(authoredAt)) {
                    const key = dayKey(authoredAt);
                    if (key <= todayKey) {
                        dailyCounts.set(key, (dailyCounts.get(key) || 0) + 1);
                    }
                    if (!firstAiCommit || authoredAt < firstAiCommit) {
                        firstAiCommit = authoredAt;
                    }
                }
            }

            if (commits.length < COMMITS_PER_PAGE) break;
        }

        emit('scanned', { repo: repo.full_name, commits_found: repoAiCommits, tools: repoTools });

        if (repoAiCommits > 0) {
            repoResults.push({ repo: repo.full_name, commits: repoAiCommits, tools: Object.keys(repoTools) });
        }
    }

    repoResults.sort((a, b) => b.commits - a.commits);

    return {
        username: typeof user?.login === 'string' ? user.login : username,
        total_commits: totalCommits,
        repos_with_commits: repoResults.length,
        by_tool: perTool,
        sparkline_30d: buildSparkline(dailyCounts),
        top_repos: repoResults.slice(0, TOP_REPOS_LIMIT),
        // Omitted entirely when unknown — the contract makes this field
        // optional and the client hides the section when it is absent.
        ...(firstAiCommit ? { first_ai_commit: firstAiCommit } : {}),
    };
}
