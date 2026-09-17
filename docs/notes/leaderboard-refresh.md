# Leaderboard data refresh and validation

How `leaderboard.json` gets refreshed from the backend, how it is validated,
and what happens when the API is unavailable. Implemented by three scripts in
`scripts/`; covered end-to-end by `scripts/definition-of-done.sh`.

## Why scripts and not CI

This repo has no build step and deploys as-is to Cloudflare Pages via the
Argo Workflows `website-build` template (see `docs/plan/plan.md` ADR-001).
GitHub Actions are disabled org-wide and are not an option. The refresh is
therefore a standalone, dependency-light shell workflow (`bash` + `curl` +
`jq`) that can be run by hand, by a scheduled runner, or by an agent, and
whose failure behavior is safe enough to run unattended.

The historical approach — the deleted `.github/workflows/deploy.yml` step
that did `curl -fsSL "$API_URL" -o leaderboard.json || echo warning` — is the
anti-model: it accepted whatever the API returned, including stale data, a
proxy error page, or a schema change that would blank the site, and it only
"failed" loudly when curl itself failed.

## Pieces

| Script | Purpose |
|---|---|
| `scripts/validate-leaderboard.sh` | Validates JSON syntax, schema, and (optionally) freshness of any leaderboard.json file. Standalone gate; also the validator the refresh script uses internally. |
| `scripts/refresh-leaderboard.sh` | The refresh workflow: fetch → validate → regression check → atomic install. Never writes on failure. |
| `scripts/definition-of-done.sh` | Runs the OG-injection test suite plus self-tests for both scripts, including a live refresh against a throwaway local HTTP server. |

## Data contract

`leaderboard.json` is consumed by `js/app.js` (table, search, filters),
`js/profile.js`, and `functions/u/[username].js` / `functions/og/[username].js`
(OG tag injection). The validator enforces exactly what those consumers need:

```
generated_at                    UTC ISO-8601 timestamp (Z, +00:00, or +0000
                                offset; fractional seconds allowed)
rankings                        non-empty array
  rank          int >= 1        ranks ascend starting at 1 (ties allowed)
  username      non-empty string
  avatar_url    non-empty string
  profile_url   non-empty string
  commit_count  int >= 0
  commits_30d   int >= 0
  unique_repos  int >= 0
  recent_repos  array of strings
  by_tool       object mapping tool name -> number
  latest_commit (optional) UTC ISO-8601 timestamp
```

Timestamps must be UTC; a non-UTC offset (`-05:00`) is rejected rather than
interpreted, so there is exactly one canonical form. `generated_at` more than
10 minutes in the future is rejected as clock skew / bad data. Fields beyond
those listed above (e.g. `sparkline_30d`) are tolerated but not validated —
the gate checks what the site consumes, and extra fields cannot break it.

The committed `leaderboard.json` is currently synthetic `testuserNNN` fixture
data (the site shows a demo banner for it). It is schema-valid and passes
`validate-leaderboard.sh --skip-freshness`, but it is stale, which is correct
and expected: the backend has been offline since before 2026-07 (scaled to
zero, no DNS), so there is nothing fresher to fetch.

## Freshness policy

- A `generated_at` older than the maximum age (default **26 hours** — a daily
  backend regeneration with slack; `--max-age-hours N` or
  `$LEADERBOARD_MAX_AGE_HOURS` to change) makes the data **stale** (validator
  exit 2). For the *fetched* payload, stale is treated the same as unusable:
  it is not installed.
- `--skip-freshness` turns the age check off (schema-only validation). This is
  the right mode for the committed snapshot while the backend is offline.
- Regression guard: the fetched data must be **strictly newer** than the
  current file's `generated_at`, or the refresh is a no-op success. Data can
  move forward, never backward. `--force` overrides this (but never the
  schema/freshness validation) for deliberate reinstalls.

## The refresh workflow

`scripts/refresh-leaderboard.sh`, in order:

1. **Fetch** the payload into a temp directory (`curl -f --max-time 30
   --max-filesize 10MB`). HTTP failures, timeouts, and oversize responses all
   abort here. Only `https://` URLs are allowed, except loopback `http://`
   for local testing.
2. **Validate** the fetched bytes with `validate-leaderboard.sh` (schema +
   freshness). Nothing on disk has been touched yet.
3. **Regression check**: fetched `generated_at` must be strictly newer than
   the current file's. Equal or older → no-op exit 0. Current file corrupt or
   missing `generated_at` → warned about and replaced (a corrupt file is not
   a fallback worth protecting). Uncomparable timestamps → refuse unless
   `--force`.
4. **Atomic install**: stage a copy next to the target (same filesystem),
   re-validate the staged copy, then `mv` it into place — readers see either
   the old file or the new file, never a partial one.
5. **Post-install tripwire**: validate the installed file; if that somehow
   fails, exit nonzero and say so loudly.

`--dry-run` runs steps 1–3 and reports what would happen without writing.

### Exit codes (refresh)

| Code | Meaning | Effect on `leaderboard.json` |
|---|---|---|
| 0 | Updated; already up to date; or `--dry-run` succeeded | Written only in the first case |
| 1 | API unreachable, response unusable (bad JSON / schema / stale), or fetched data not provably newer | **Untouched, byte-for-byte** |
| 3 | Usage or environment error (missing tool, bad option, non-HTTPS URL) | Untouched |

### Exit codes (validate)

| Code | Meaning |
|---|---|
| 0 | Schema-valid and within max age (or freshness skipped) |
| 1 | Missing, unreadable, invalid JSON, or schema violations |
| 2 | Schema-valid but stale (only when freshness checking is on) |
| 3 | Usage or environment error |

## Failure behavior in one table

| Condition | Refresh script | Site impact |
|---|---|---|
| API unreachable (DNS, refused, timeout, 5xx, 4xx) | exit 1, fallback kept | None — site serves last-known-good `leaderboard.json` |
| API returns invalid JSON or wrong schema | exit 1, fallback kept | None |
| API returns stale data (`generated_at` too old) | exit 1, fallback kept | None |
| API returns data older than or equal to current | exit 0 no-op, fallback kept | None |
| API returns valid, fresh, newer data | exit 0, file atomically replaced | Next deploy (or local serve) picks it up |
| Committed file itself corrupt | warns, replaces with fetched data if the fetch succeeded; if the API is also down the corrupt file ships — fix by re-running refresh when the API returns, or restore from git | Table fails to render (`showNoResults`), search reports "Failed to load leaderboard data" |

Client-side, `js/app.js` always falls back to the baked-in file and only
shows an error if even that is missing; report generation and live profile
lookups additionally gate on `/health` reachability
(`checkApiReachability`), so a dead backend degrades those features
gracefully rather than breaking the page.

## How to run

```bash
# Check the committed snapshot (schema only — it is expected to be stale)
scripts/validate-leaderboard.sh --skip-freshness leaderboard.json

# See whether the API has anything newer, without writing anything
scripts/refresh-leaderboard.sh --dry-run

# Real refresh (safe to run unattended: failures never clobber the file)
scripts/refresh-leaderboard.sh

# Point somewhere else (local testing against a fixture server)
scripts/refresh-leaderboard.sh --url http://127.0.0.1:8080/leaderboard.json

# Everything the repo considers "done"
scripts/definition-of-done.sh
```

Environment overrides: `LEADERBOARD_API_URL`, `LEADERBOARD_OUTPUT`,
`LEADERBOARD_MAX_AGE_HOURS`, `LEADERBOARD_FETCH_TIMEOUT`,
`LEADERBOARD_MAX_BYTES`.

## Automation status and activation path

**Currently nothing schedules the refresh** — deliberately. The backend is
offline (ADR-001), so every run would take the fallback path, and automating
a guaranteed-failure would add noise, not safety. The workflow is built to be
switched on the day the backend returns, without code changes:

1. **Commit-on-success runner (recommended).** A scheduled job (cron on a
   runner, or a NEEDLE-style agent loop) runs
   `scripts/refresh-leaderboard.sh` and, on exit 0 with the file actually
   changed, commits and pushes `leaderboard.json` to `main`. The existing
   push hook on `website-build` deploys it. Because the script refuses to
   regress and never writes on failure, the committed history can only move
   forward, and a dead backend simply produces no commits.
2. **Deploy-time refresh (explicitly rejected).** Running the refresh as the
   Argo `website-build` `build-command` would couple deploys to API health
   and muddy what a deploy means; ADR-001 already removed the deploy-time
   step for this reason. Keep the refresh producing commits, not build
   artifacts.

Either way, `scripts/validate-leaderboard.sh --skip-freshness
leaderboard.json` is the cheap pre-push gate to run on any change that
touches the data file.
