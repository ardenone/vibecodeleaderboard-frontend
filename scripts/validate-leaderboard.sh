#!/usr/bin/env bash
# Validate a leaderboard.json file: JSON syntax, schema, and optionally freshness.
#
# Usage: validate-leaderboard.sh [--max-age-hours N] [--skip-freshness] FILE
#
# Exit codes:
#   0  file is schema-valid and (if freshness checking is on) within max age
#   1  file missing, unreadable, invalid JSON, or schema violations
#   2  file is schema-valid but stale (generated_at older than --max-age-hours)
#   3  usage or environment error (missing jq, bad option value)
#
# Schema (the shape js/app.js, js/profile.js, and functions/u/[username].js consume):
#   generated_at                  UTC ISO-8601 timestamp (Z, +00:00, or +0000)
#   rankings[]                    non-empty array of objects:
#     rank          int >= 1      ranks ascend starting at 1 (ties allowed)
#     username      non-empty string
#     avatar_url    non-empty string
#     profile_url   non-empty string
#     commit_count  int >= 0
#     commits_30d   int >= 0
#     unique_repos  int >= 0
#     recent_repos  array of strings
#     by_tool       object mapping tool name -> number
#     latest_commit (optional) UTC ISO-8601 timestamp

set -euo pipefail

MAX_AGE_HOURS="${LEADERBOARD_MAX_AGE_HOURS:-26}"
CHECK_FRESHNESS=1
FILE=""

usage() {
    cat <<'USAGE'
Usage: validate-leaderboard.sh [--max-age-hours N] [--skip-freshness] FILE

Validates JSON syntax, schema, and (unless --skip-freshness) that
generated_at is within N hours of now (default 26, or $LEADERBOARD_MAX_AGE_HOURS).

Exit codes: 0 valid; 1 invalid; 2 stale; 3 usage/environment error.
USAGE
}

die() {
    local code="$1"; shift
    printf 'validate: %s\n' "$*" >&2
    exit "$code"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --max-age-hours)
            [ $# -ge 2 ] || die 3 "--max-age-hours requires a value"
            MAX_AGE_HOURS="$2"; shift 2 ;;
        --skip-freshness)
            CHECK_FRESHNESS=0; shift ;;
        -h|--help)
            usage; exit 0 ;;
        --*)
            die 3 "unknown option: $1" ;;
        *)
            [ -z "$FILE" ] || die 3 "unexpected extra argument: $1"
            FILE="$1"; shift ;;
    esac
done

[ -n "$FILE" ] || { usage; die 3 "no input file given"; }
command -v jq >/dev/null 2>&1 || die 3 "jq is required but not installed"
case "$MAX_AGE_HOURS" in
    ''|*[!0-9.]*) die 3 "--max-age-hours must be a number, got: $MAX_AGE_HOURS" ;;
esac
[ -f "$FILE" ] || die 1 "file not found: $FILE"
[ -r "$FILE" ] || die 1 "file not readable: $FILE"

JQPROG="$(mktemp)"
trap 'rm -f "$JQPROG"' EXIT
cat > "$JQPROG" <<'EOF'
def utcEpoch:
  if type == "string"
  then (sub("\\.[0-9]+"; "")
        | sub("\\+00:00$"; "Z")
        | sub("\\+0000$"; "Z")
        | try fromdateiso8601 catch null)
  else null
  end;

def reqStr($k):
  if has($k) | not then "missing required field '\($k)'"
  elif (.[$k] | type) != "string" then "field '\($k)' must be a string"
  elif (.[$k] | length) == 0 then "field '\($k)' must not be empty"
  else empty end;

def reqInt($k; $min):
  if has($k) | not then "missing required field '\($k)'"
  elif (.[$k] | type) != "number" then "field '\($k)' must be a number"
  elif (.[$k] | floor) != .[$k] then "field '\($k)' must be an integer"
  elif .[$k] < $min then "field '\($k)' must be >= \($min)"
  else empty end;

def reqStrArray($k):
  if has($k) | not then "missing required field '\($k)'"
  elif (.[$k] | type) != "array" then "field '\($k)' must be an array"
  elif any(.[$k][]; type != "string") then "field '\($k)' must contain only strings"
  else empty end;

def reqToolMap:
  if has("by_tool") | not then "missing required field 'by_tool'"
  elif (.by_tool | type) != "object" then "field 'by_tool' must be an object"
  elif any(.by_tool[]; type != "number") then "field 'by_tool' must map tool names to numbers"
  else empty end;

def optTimestamp($k):
  if has($k) | not then empty
  elif (.[$k] | utcEpoch) == null then "field '\($k)' must be a UTC ISO-8601 timestamp"
  else empty end;

def entryErrors:
  if type != "object" then ["entry is not an object"]
  else [reqStr("username"),
        reqStr("avatar_url"),
        reqStr("profile_url"),
        reqInt("rank"; 1),
        reqInt("commit_count"; 0),
        reqInt("commits_30d"; 0),
        reqInt("unique_repos"; 0),
        reqStrArray("recent_repos"),
        reqToolMap,
        optTimestamp("latest_commit")]
  end;

. as $root
| if ($root | type) != "object"
  then {ok: false, generated_at: null, age_hours: null, entries: null,
        errors: ["top-level value must be an object (got \($root | type))"]}
  else
    ($root.generated_at // null) as $gen
    | ($gen | utcEpoch) as $genEpoch
    | (if $genEpoch == null then null else ((now - $genEpoch) / 3600) end) as $ageHours
    | (if ($root.rankings | type) == "array" then ($root.rankings | length) else null end) as $entries
    | (
        [
          (if $genEpoch == null
           then "generated_at must be a UTC ISO-8601 timestamp (got \($gen | tojson))"
           else empty end),
          (if $genEpoch != null and ($genEpoch - now) > 600
           then "generated_at is more than 10 minutes in the future"
           else empty end),
          (if ($root.rankings | type) != "array"
           then "rankings must be an array"
           else empty end),
          (if ($root.rankings | type) == "array" and ($root.rankings | length) == 0
           then "rankings must not be empty"
           else empty end)
        ]
        +
        (if ($root.rankings | type) != "array"
         then []
         else [$root.rankings | to_entries[]
                 | .key as $i | .value as $u
                 | ($u | entryErrors) | map("rankings[\($i)]: \(.)")]
              | flatten
         end)
        +
        (if ($root.rankings | type) != "array"
         then []
         else ([$root.rankings[]
                 | if type == "object" then (.rank // null) else null end]) as $ranks
              | (if any($ranks[]; . == null) then []
                 elif ($ranks | length) == 0 then []
                 elif $ranks[0] != 1 then ["rankings must start at rank 1"]
                 elif $ranks != ($ranks | sort) then ["rank values must be in ascending order"]
                 else []
                 end)
         end)
      ) as $errors
    | {ok: ($errors | length == 0),
       generated_at: (if ($gen | type) == "string" then $gen else null end),
       age_hours: $ageHours,
       entries: $entries,
       errors: $errors}
  end
EOF

RESULT="$(jq -c -f "$JQPROG" "$FILE")" || die 1 "not valid JSON: $FILE"

if ! jq -e '.ok == true' >/dev/null 2>&1 <<<"$RESULT"; then
    while IFS= read -r err; do
        printf 'validate: error: %s\n' "$err" >&2
    done < <(jq -r '.errors[]' <<<"$RESULT")
    die 1 "schema validation failed for $FILE"
fi

if [ "$CHECK_FRESHNESS" -eq 1 ]; then
    AGE="$(jq -r '.age_hours // empty' <<<"$RESULT")"
    if [ -z "$AGE" ]; then
        # Unreachable in practice: schema validation already rejects a
        # missing/unparseable generated_at, which is what feeds age_hours.
        die 1 "could not compute age of generated_at"
    fi
    if awk -v a="$AGE" -v m="$MAX_AGE_HOURS" 'BEGIN { exit !(a > m) }'; then
        GEN="$(jq -r '.generated_at' <<<"$RESULT")"
        printf 'validate: stale: %s was generated at %s (%.1fh old, limit %sh)\n' \
            "$FILE" "$GEN" "$AGE" "$MAX_AGE_HOURS" >&2
        exit 2
    fi
fi

jq -r --arg file "$FILE" --argjson fresh "$CHECK_FRESHNESS" \
    '"validate: OK: \($file): \(.entries) entries, generated_at=\(.generated_at)" +
     (if .age_hours != null then " (\(.age_hours * 10 | round / 10)h old)" else "" end) +
     (if $fresh == 0 then " [freshness not checked]" else "" end)' <<<"$RESULT"
