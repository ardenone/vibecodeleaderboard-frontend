# Cloudflare Pages Functions

This directory contains Cloudflare Pages Functions that enable server-side processing for the Vibe Code Leaderboard site: the API surface (backend replacement, see ADR-003 in `docs/plan/plan.md`) and server-side OG tag injection.

## API Functions (backend replacement)

The paired backend service (`vibecodeleaderboard-backend`, formerly the `claude-leaderboard` deployment) is gone, and it never implemented the report/SSE endpoints anyway. The API is now served by Pages Functions from this same project, implementing the contract documented in [`docs/notes/report-sse-api-contract.md`](../docs/notes/report-sse-api-contract.md):

| Endpoint | Method | File | Purpose |
|---|---|---|---|
| `/health` | HEAD, GET | `health.js` | reachability pre-check (instant, touches nothing) |
| `/leaderboard.json` | GET | `leaderboard.json.js` | leaderboard payload from the API origin (used by `scripts/refresh-leaderboard.sh`) |
| `/user/{username}` | GET, HEAD | `user/[username].js` | profile fallback lookup from the baked-in leaderboard |
| `/report/{username}` | POST, GET | `report/[username].js` | trigger generation (202) / fetch cached report |
| `/report/{username}/stream` | GET (SSE) | `report/[username]/stream.js` | live progress + terminal `complete`/`error` |

Shared logic lives in `_lib/` — never routed, because `_routes.json` lists the routed paths explicitly:

- `_lib/api.js` — hostname gate, method/CORS/error wrapper, username validation
- `_lib/cors.js` — cross-origin allowlist and preflight handling
- `_lib/sse.js` — SSE writer (single-line JSON frames) + heartbeat
- `_lib/leaderboard.js` — baked-in `leaderboard.json` access, `/user` payload shape, rank/percentile math
- `_lib/github.js` — GitHub client, AI-tool signature detection, the repo scan
- `_lib/jobs.js` — per-username job registry, memory + optional KV report cache

### Hostname gate

`js/config.js` derives the API origin as `https://api.<frontend-hostname>`, so the API functions live at root paths and decide per request whether they are answering an API hostname:

- `api.*` hostnames → API behavior. **`api.vibecodeleaderboard.com` must be attached as a custom domain of this Pages project** (same project as the site — one deployment serves both).
- `localhost` / `127.0.0.1` / `[::1]` → API behavior, so `wrangler pages dev .` exercises the endpoints at `http://localhost:8788/health` etc.
- anything else (apex, `www`, `*.pages.dev` previews) → `context.next()` — static serving, byte-for-byte identical to a deployment without these functions. A broken function can never take down the site's static paths.

### CORS

The API is cross-origin from both frontend origins, so every API response carries CORS headers and `OPTIONS` preflight is answered (the report POST sends `Content-Type: application/json`, which is not CORS-safelisted). The allowlist defaults to `https://vibecodeleaderboard.com`, `https://www.vibecodeleaderboard.com`, and the local dev origins (`localhost:3000`, `localhost:8788` and their `127.0.0.1` variants); set the `ALLOWED_ORIGINS` environment variable (comma-separated) to replace the list.

### Bindings (Pages project settings)

| Binding | Kind | Required | Purpose |
|---|---|---|---|
| `GITHUB_TOKEN` | secret | recommended | GitHub API token for report scans. Without it, unauthenticated calls from shared Cloudflare egress IPs are usually rate-limited immediately; the API then falls back to the degraded mode below. Provision with `wrangler pages secret put GITHUB_TOKEN` or the dashboard — never commit the value. |
| `REPORT_CACHE` | KV namespace | optional | durable report cache shared across isolates (6h TTL). Without it the cache is per-isolate memory only. |
| `ALLOWED_ORIGINS` | plain text | optional | replaces the CORS origin allowlist |

### Report generation behavior

- The scan runs under `context.waitUntil`, so **generation survives client disconnects**, and completed reports are **cached** so a retry replays the terminal `complete` instead of rescanning (both are contract requirements). Failed jobs are never cached — a retry rescans.
- Scan budgets: at most 20 non-fork repos (most recently pushed first), at most 2 pages × 100 commits per repo — staying inside the 50-subrequest free-plan limit.
- Tool attribution matches commit-message signatures (`Co-Authored-By: …`, `Generated with …`, vendor domains) for the six documented tool keys; a commit can count for several tools.
- **Degraded mode:** when the GitHub API is rate-limited and no token is bound, a user who is on the baked-in leaderboard gets a report assembled from the leaderboard snapshot (`"source": "leaderboard-snapshot"`); anyone else gets a terminal `error` event.
- Rank/percentile for off-leaderboard users is computed against the baked-in leaderboard (where their scan count would place them); users already on the board keep their published rank so the report and the table never disagree.

### Testing

Runtime-free unit/contract tests with mocked ASSETS and GitHub fetch:

```bash
node functions/test-api.js    # or: make test
```

`make test` runs these alongside the OG-injection and report-SSE client contract suites; `scripts/definition-of-done.sh` includes them in the pre-push gate.

For a live local check with the real Pages runtime:

```bash
wrangler pages dev .
curl -s http://localhost:8788/health
curl -N http://localhost:8788/report/<username>/stream
```

## User Profile Function (`u/[username].js`)

### Purpose
Intercepts requests to `/u/[username]` paths and injects server-side Open Graph (OG) meta tags for social media crawlers. This ensures that when someone shares a user profile link on platforms like Twitter, Slack, Discord, or iMessage, the unfurl preview shows the actual user's rank and stats rather than generic placeholder text.

### How It Works
1. **Request Interception**: The function runs before static file serving for any `/u/[username]` path
2. **Data Loading**: Reads `leaderboard.json` through Cloudflare Pages' `ASSETS` binding to find the requested user's data
3. **Template Processing**: Loads the `user.html` template
4. **Tag Injection**: Replaces static OG meta tags with dynamic user-specific content
5. **Response**: Returns the modified HTML with proper caching headers

### Why This Is Needed
- **Client-side JavaScript isn't enough**: Social media crawlers (Twitter Card, Slack unfurl, etc.) fetch raw HTML without executing JavaScript
- **Existing client-side code remains**: `js/profile.js` still handles the interactive page functionality and provides a fallback
- **Server-side first impression**: Crawlers see proper OG tags immediately, improving share appearance

### Features
- **Personalized OG title**: Shows rank and username (e.g., "#123 johndoe - Vibe Code Leaderboard")
- **Dynamic description**: Includes commit count, repos, and rank
- **Fallback handling**: Gracefully handles missing users or data errors
- **Caching**: 5-minute cache for user profiles, 1-minute for error states
- **URL consistency**: Updates canonical URLs and OG URLs to match the request

### OG Tag Examples

**For an existing user:**
```html
<meta property="og:title" content="#123 johndoe - Vibe Code Leaderboard">
<meta property="og:description" content="johndoe has 5,432 AI-assisted commits across 12 repos. Ranked #123 on the Vibe Code Leaderboard.">
<meta property="og:image" content="https://vibecodeleaderboard.com/og/testuser090">
<meta property="og:url" content="https://vibecodeleaderboard.com/u/johndoe">
```

**For a non-existent user:**
```html
<meta property="og:title" content="unknownuser - Vibe Code Leaderboard">
<meta property="og:description" content="unknownuser is not yet on the Vibe Code Leaderboard. Check the full leaderboard to see top AI-assisted developers.">
```

### Deployment
This function automatically deploys with the Cloudflare Pages project via the `website-build` WorkflowTemplate (see `docs/plan/plan.md` ADR-001).

### Local Testing
To test locally with Wrangler:
```bash
wrangler pages dev .
```

Then visit `http://localhost:8788/u/testuser090` to verify the function works.

## Per-user OG images (`og/[username].js`)

Known users get a generated SVG card at `/og/<username>`, containing their username,
rank, commit count, and repository count. The profile function points `og:image` and
Twitter's image tag at this endpoint; unknown users retain the static PNG fallback.

## Automated testing

Run the metadata tests with Node (22.7+ auto-detects ESM; the old
`--experimental-default-type=module` flag was removed in Node 24):

```bash
node functions/test-og-injection.js
```

`make test` runs these plus the report SSE contract tests
(`tests/report-sse-contract.test.js`, pinning the client side of the API
contract documented in `docs/notes/report-sse-api-contract.md`) and the API
functions suite (`functions/test-api.js`, pinning the server side).

For an end-to-end Pages runtime test, use Wrangler:

```bash
wrangler pages dev .
```

Then visit `http://localhost:8788/u/testuser090` and inspect the raw HTML, not just the
browser DOM.
