#!/usr/bin/env bash
# Refresh leaderboard.json from the backend API, safely.
#
# Fetches the leaderboard from the backend, validates it (schema + freshness)
# BEFORE touching anything on disk, refuses to regress to older data, and only
# then atomically replaces leaderboard.json. On every failure path the
# existing leaderboard.json is left byte-for-byte untouched, so the site
# always has a usable baked-in fallback.
#
# Usage: refresh-leaderboard.sh [--url URL] [--output FILE] [--max-age-hours N]
#                               [--timeout SECONDS] [--dry-run] [--force]
#
# Exit codes:
#   0  leaderboard.json updated, already up to date, or --dry-run succeeded
#   1  API unreachable, response unusable, or fetched data not provably newer
#      (existing leaderboard.json preserved)
#   3  usage or environment error
#
# Configuration via environment: LEADERBOARD_API_URL, LEADERBOARD_OUTPUT,
# LEADERBOARD_MAX_AGE_HOURS, LEADERBOARD_FETCH_TIMEOUT, LEADERBOARD_MAX_BYTES.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="$SCRIPT_DIR/validate-leaderboard.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

API_URL="${LEADERBOARD_API_URL:-https://api.vibecodeleaderboard.com/leaderboard.json}"
OUTPUT="${LEADERBOARD_OUTPUT:-$REPO_ROOT/leaderboard.json}"
MAX_AGE_HOURS="${LEADERBOARD_MAX_AGE_HOURS:-26}"
FETCH_TIMEOUT="${LEADERBOARD_FETCH_TIMEOUT:-30}"
MAX_BYTES="${LEADERBOARD_MAX_BYTES:-10485760}"
DRY_RUN=0
FORCE=0

log() { printf '[refresh] %s\n' "$*" >&2; }
die() { local code="$1"; shift; log "ERROR: $*"; exit "$code"; }

usage() {
    cat <<'USAGE'
Usage: refresh-leaderboard.sh [--url URL] [--output FILE] [--max-age-hours N]
                              [--timeout SECONDS] [--dry-run] [--force]

Fetches the leaderboard JSON from the backend, validates schema and
freshness, and atomically replaces the output file only when the fetched
data is strictly newer than what is already there. Never writes on failure.

Exit codes: 0 updated / up to date / dry-run ok; 1 fallback preserved; 3 usage error.
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --url)          [ $# -ge 2 ] || die 3 "--url requires a value"; API_URL="$2"; shift 2 ;;
        --output)       [ $# -ge 2 ] || die 3 "--output requires a value"; OUTPUT="$2"; shift 2 ;;
        --max-age-hours) [ $# -ge 2 ] || die 3 "--max-age-hours requires a value"; MAX_AGE_HOURS="$2"; shift 2 ;;
        --timeout)      [ $# -ge 2 ] || die 3 "--timeout requires a value"; FETCH_TIMEOUT="$2"; shift 2 ;;
        --dry-run)      DRY_RUN=1; shift ;;
        --force)        FORCE=1; shift ;;
        -h|--help)      usage; exit 0 ;;
        --*)            die 3 "unknown option: $1" ;;
        *)              die 3 "unexpected argument: $1" ;;
    esac
done

for tool in curl jq; do
    command -v "$tool" >/dev/null 2>&1 || die 3 "$tool is required but not installed"
done
[ -x "$VALIDATOR" ] || die 3 "validator not found or not executable: $VALIDATOR"
case "$MAX_AGE_HOURS" in ''|*[!0-9.]*) die 3 "--max-age-hours must be a number, got: $MAX_AGE_HOURS" ;; esac
case "$FETCH_TIMEOUT" in ''|*[!0-9]*) die 3 "--timeout must be an integer of seconds, got: $FETCH_TIMEOUT" ;; esac

case "$API_URL" in
    https://*) ;;
    http://localhost/*|http://localhost:*|http://127.0.0.1/*|http://127.0.0.1:*|http://\[::1\]/*|http://\[::1\]:*)
        log "allowing plaintext http for loopback endpoint (dev/test)" ;;
    *) die 3 "refusing non-HTTPS API URL: $API_URL (loopback http is allowed for testing)" ;;
esac

# UTC ISO-8601 (Z, +00:00, +0000, with optional fractional seconds) -> epoch
# seconds; empty output on unparseable input.
iso_to_epoch() {
    printf '%s' "$1" | jq -R '
        if . == "" then empty
        else (sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | sub("\\+0000$"; "Z")
              | try fromdateiso8601 catch empty)
        end'
}

WORK="$(mktemp -d)"
STAGED=""
cleanup() { rm -rf "$WORK"; [ -n "$STAGED" ] && rm -f "$STAGED"; return 0; }
trap cleanup EXIT

# 1. Fetch into scratch space. Any failure here leaves the real file alone.
log "fetching $API_URL (timeout ${FETCH_TIMEOUT}s, max ${MAX_BYTES} bytes)"
CURL_RC=0
curl -fsSL --max-time "$FETCH_TIMEOUT" --max-filesize "$MAX_BYTES" \
    -o "$WORK/fetched.json" "$API_URL" || CURL_RC=$?
if [ "$CURL_RC" -ne 0 ]; then
    die 1 "API unavailable (curl exit $CURL_RC fetching $API_URL) — keeping existing $OUTPUT"
fi

# 2. Validate the fetched bytes before anything else happens. A stale or
#    schema-broken response is treated exactly like an unreachable API.
VALIDATOR_RC=0
"$VALIDATOR" --max-age-hours "$MAX_AGE_HOURS" "$WORK/fetched.json" \
    >"$WORK/validate.log" 2>&1 || VALIDATOR_RC=$?
if [ "$VALIDATOR_RC" -ne 0 ]; then
    sed 's/^validate: /[refresh] fetched data: /' "$WORK/validate.log" >&2
    if [ "$VALIDATOR_RC" -eq 2 ]; then
        die 1 "fetched leaderboard is stale (older than ${MAX_AGE_HOURS}h) — treating as unusable, keeping existing $OUTPUT"
    fi
    die 1 "fetched leaderboard failed validation — refusing to install it, keeping existing $OUTPUT"
fi
FETCHED_GEN="$(jq -r '.generated_at' "$WORK/fetched.json")"
ENTRIES="$(jq -r '.rankings | length' "$WORK/fetched.json")"
log "fetched data is valid: $ENTRIES entries, generated_at=$FETCHED_GEN"

# 3. Regression guard: never replace current data with something older or
#    equal. An unusable baseline file (corrupt, no generated_at) may be
#    replaced — a corrupt file is not a fallback worth protecting.
if [ -f "$OUTPUT" ]; then
    CURRENT_GEN="$(jq -r '.generated_at // empty' "$OUTPUT" 2>/dev/null || true)"
    if [ -n "$CURRENT_GEN" ]; then
        CUR_EP="$(iso_to_epoch "$CURRENT_GEN")"
        NEW_EP="$(iso_to_epoch "$FETCHED_GEN")"
        if [ -z "$CUR_EP" ] || [ -z "$NEW_EP" ]; then
            if [ "$FORCE" -ne 1 ]; then
                die 1 "cannot compare timestamps (current generated_at='$CURRENT_GEN', fetched='$FETCHED_GEN') — refusing to overwrite; use --force to override"
            fi
            log "forced: --force set, proceeding despite uncomparable timestamps"
        elif [ "$NEW_EP" -le "$CUR_EP" ]; then
            if [ "$FORCE" -eq 1 ]; then
                log "forced: installing fetched data even though it is not newer than current"
            else
                log "fetched data (generated_at=$FETCHED_GEN) is not newer than current (generated_at=$CURRENT_GEN) — nothing to do"
                exit 0
            fi
        fi
    else
        log "WARNING: existing $OUTPUT is corrupt or has no generated_at — it will be replaced"
    fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
    log "dry-run: fetched data is valid and newer — $OUTPUT would be updated"
    exit 0
fi

# 4. Atomic install: stage next to the target (same filesystem), then rename.
OUT_DIR="$(dirname "$OUTPUT")"
mkdir -p "$OUT_DIR"
STAGED="$OUT_DIR/.leaderboard.json.refresh.$$"
cp "$WORK/fetched.json" "$STAGED"
chmod 644 "$STAGED"

VALIDATOR_RC=0
"$VALIDATOR" --max-age-hours "$MAX_AGE_HOURS" "$STAGED" >/dev/null 2>&1 || VALIDATOR_RC=$?
if [ "$VALIDATOR_RC" -ne 0 ]; then
    die 1 "staged copy failed re-validation — aborting without touching $OUTPUT"
fi

mv -f "$STAGED" "$OUTPUT"
STAGED=""

# 5. Post-install tripwire: the shipped artifact must validate on its own.
VALIDATOR_RC=0
"$VALIDATOR" --max-age-hours "$MAX_AGE_HOURS" "$OUTPUT" >/dev/null 2>&1 || VALIDATOR_RC=$?
if [ "$VALIDATOR_RC" -ne 0 ]; then
    die 1 "post-install validation of $OUTPUT failed (exit $VALIDATOR_RC) — inspect the file manually"
fi

log "updated $OUTPUT: $ENTRIES entries, generated_at=$FETCHED_GEN"
