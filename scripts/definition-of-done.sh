#!/usr/bin/env bash
# Definition of Done for vibecodeleaderboard-frontend.
#
# Runs the OG-injection test suite plus self-tests for the leaderboard
# refresh/validation workflow (scripts/validate-leaderboard.sh,
# scripts/refresh-leaderboard.sh). Exits nonzero if anything fails.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VAL="$ROOT/scripts/validate-leaderboard.sh"
REFRESH="$ROOT/scripts/refresh-leaderboard.sh"
FAILURES=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() { printf 'ok   - %s\n' "$1"; }
fail() { printf 'FAIL - %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# expect_rc WANT_RC DESC CMD [ARGS...]
expect_rc() {
    local want="$1" desc="$2" rc=0
    shift 2
    "$@" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq "$want" ]; then
        pass "$desc"
    else
        fail "$desc (want exit $want, got $rc)"
    fi
}

# ---------------------------------------------------------------------------
# 1. OG-injection test suite (the repo's existing test).
#    Node >= 23 removed --experimental-default-type and detects ESM itself;
#    older node needs the flag, so try plain first and fall back.
OG_RC=0
node functions/test-og-injection.js >"$TMP/og.log" 2>&1 || OG_RC=$?
if [ "$OG_RC" -ne 0 ]; then
    node --experimental-default-type=module functions/test-og-injection.js >"$TMP/og.log" 2>&1 && OG_RC=0
fi
if [ "$OG_RC" -eq 0 ]; then pass "og-injection tests"; else fail "og-injection tests"; sed 's/^/       /' "$TMP/og.log"; fi

# ---------------------------------------------------------------------------
# 1b. API functions test suite (the backend-replacement endpoints).
API_RC=0
node functions/test-api.js >"$TMP/api.log" 2>&1 || API_RC=$?
if [ "$API_RC" -eq 0 ]; then pass "api-functions tests"; else fail "api-functions tests"; sed 's/^/       /' "$TMP/api.log"; fi

# ---------------------------------------------------------------------------
# 2. Fixtures: fresh timestamp is generated at test time so the freshness
#    assertions never age out; the stale fixture uses a fixed past date.
NOW_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n --arg ts "$NOW_TS" '{
  generated_at: $ts,
  rankings: [
    {rank: 1, username: "doctest", avatar_url: "https://github.com/doctest.png?size=80",
     profile_url: "https://github.com/doctest", commit_count: 120, commits_30d: 40,
     unique_repos: 3, recent_repos: ["doctest/r1", "doctest/r2"],
     latest_commit: "2026-09-01T00:00:00Z", by_tool: {claude: 100, cursor: 20}},
    {rank: 2, username: "example", avatar_url: "https://github.com/example.png?size=80",
     profile_url: "https://github.com/example", commit_count: 90, commits_30d: 10,
     unique_repos: 2, recent_repos: ["example/r1"], by_tool: {aider: 90}}
  ]
}' > "$TMP/fresh.json"
jq '.generated_at = "2026-07-06T22:00:00Z"' "$TMP/fresh.json" > "$TMP/stale.json"
jq '.rankings[0].username = null' "$TMP/fresh.json" > "$TMP/broken.json"
printf '%s' '{"generated_at": "not a timestamp", "rankings": []}' > "$TMP/badts.json"
printf '%s' '{not json' > "$TMP/garbage.json"

expect_rc 0 "validator accepts fresh valid data"       "$VAL" --max-age-hours 26 "$TMP/fresh.json"
expect_rc 2 "validator flags stale data"               "$VAL" --max-age-hours 26 "$TMP/stale.json"
expect_rc 0 "validator --skip-freshness accepts stale" "$VAL" --skip-freshness "$TMP/stale.json"
expect_rc 1 "validator rejects schema violation"       "$VAL" --skip-freshness "$TMP/broken.json"
expect_rc 1 "validator rejects bad generated_at"       "$VAL" --skip-freshness "$TMP/badts.json"
expect_rc 1 "validator rejects invalid JSON"           "$VAL" "$TMP/garbage.json"
expect_rc 1 "validator rejects missing file"           "$VAL" "$TMP/does-not-exist.json"
expect_rc 0 "committed leaderboard.json is schema-valid" "$VAL" --skip-freshness "$ROOT/leaderboard.json"
expect_rc 3 "validator usage error on bad option value" "$VAL" --max-age-hours nope "$TMP/fresh.json"

# ---------------------------------------------------------------------------
# 3. Refresh workflow end-to-end against a throwaway local HTTP server.
mkdir -p "$TMP/serve"
cp "$TMP/fresh.json" "$TMP/serve/leaderboard.json"
cp "$TMP/broken.json" "$TMP/serve/broken.json"

cat > "$TMP/serve.mjs" <<'EOF'
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.argv[2];
const srv = http.createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(req.url.replace(/^\//, '').split('?')[0]) || 'leaderboard.json';
    const body = await readFile(path.join(root, name));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
srv.listen(0, '127.0.0.1', () => console.log(srv.address().port));
EOF
node "$TMP/serve.mjs" "$TMP/serve" >"$TMP/port" &
SRV_PID=$!
for _ in $(seq 1 50); do [ -s "$TMP/port" ] && break; sleep 0.1; done
PORT="$(cat "$TMP/port" 2>/dev/null || true)"
if [ -z "$PORT" ]; then
    fail "local fixture server started"
    kill "$SRV_PID" 2>/dev/null
    exit 1
fi
pass "local fixture server started"
BASE="http://127.0.0.1:$PORT"
OUT="$TMP/out/leaderboard.json"
mkdir -p "$TMP/out"
cp "$TMP/stale.json" "$OUT"
md5() { md5sum "$1" | cut -d' ' -f1; }

# dry-run: reports success but must not write
expect_rc 0 "refresh --dry-run succeeds" "$REFRESH" --url "$BASE/leaderboard.json" --output "$OUT" --dry-run
[ "$(md5 "$OUT")" = "$(md5 "$TMP/stale.json")" ] && pass "dry-run left output untouched" || fail "dry-run left output untouched"

# success: fresh + newer replaces the stale file atomically
expect_rc 0 "refresh installs newer data" "$REFRESH" --url "$BASE/leaderboard.json" --output "$OUT"
[ "$(jq -r .generated_at "$OUT")" = "$NOW_TS" ] && pass "installed data has fetched generated_at" || fail "installed data has fetched generated_at"
expect_rc 0 "installed output passes validator" "$VAL" --max-age-hours 26 "$OUT"

# up-to-date: equal generated_at is a no-op success
cp "$OUT" "$TMP/before-noop.json"
expect_rc 0 "refresh is a no-op when not newer" "$REFRESH" --url "$BASE/leaderboard.json" --output "$OUT"
[ "$(md5 "$OUT")" = "$(md5 "$TMP/before-noop.json")" ] && pass "no-op left output untouched" || fail "no-op left output untouched"

# failure paths: every one must preserve the output byte-for-byte
cp "$OUT" "$TMP/lastgood.json"
expect_rc 1 "refresh fails on HTTP 404" "$REFRESH" --url "$BASE/missing.json" --output "$OUT"
[ "$(md5 "$OUT")" = "$(md5 "$TMP/lastgood.json")" ] && pass "404 preserved fallback" || fail "404 preserved fallback"

expect_rc 1 "refresh rejects schema-broken payload" "$REFRESH" --url "$BASE/broken.json" --output "$OUT"
[ "$(md5 "$OUT")" = "$(md5 "$TMP/lastgood.json")" ] && pass "broken payload preserved fallback" || fail "broken payload preserved fallback"

expect_rc 3 "refresh refuses non-HTTPS remote URL" "$REFRESH" --url "http://example.invalid/leaderboard.json" --output "$OUT"

kill "$SRV_PID" 2>/dev/null
wait "$SRV_PID" 2>/dev/null
expect_rc 1 "refresh fails when server is down" "$REFRESH" --url "$BASE/leaderboard.json" --output "$OUT"
[ "$(md5 "$OUT")" = "$(md5 "$TMP/lastgood.json")" ] && pass "server-down preserved fallback" || fail "server-down preserved fallback"

# ---------------------------------------------------------------------------

if [ "$FAILURES" -eq 0 ]; then
    printf 'definition-of-done: all checks passed\n'
    exit 0
fi
printf 'definition-of-done: %s check(s) failed\n' "$FAILURES"
exit 1
