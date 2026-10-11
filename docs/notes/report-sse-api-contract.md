# Report & SSE API Contract

The contract the frontend (`js/report.js`, `js/profile.js`, base URL from
`js/config.js`) expects from the backend at `apiBaseUrl`. This is written from the client
side: every field, ordering rule, and failure path below is what the shipped client code
actually consumes, not an aspiration. The backend should treat this as its implementation
spec.

**Status:** the backend repo (`vibecodeleaderboard-backend`) is gone and never implemented
the `/report/*` SSE endpoints. All four endpoints in this contract are now implemented
server-side by this repository's Cloudflare Pages Functions (`functions/` — see
[`functions/README.md`](../../functions/README.md) and ADR-003 in
[`docs/plan/plan.md`](../plan/plan.md)), served from `api.vibecodeleaderboard.com` once
that hostname is attached as a custom domain of the Pages project. The server-side
behavior is pinned by `functions/test-api.js`; the client side by
`tests/report-sse-contract.test.js`.

## Base URL resolution

Resolved once when `js/config.js` is evaluated and consumed everywhere as
`window.VibeCodeConfig.apiBaseUrl` (frozen — it is the single source of truth;
`js/config.js:5-15`):

```
hostname in {localhost, 127.0.0.1, [::1]}   ->  http://localhost:8080
otherwise (www. stripped)                   ->  https://api.<hostname>
```

All paths below are relative to that base.

## Endpoints

| # | Endpoint | Method | Consumed by | Purpose |
|---|----------|--------|-------------|---------|
| 1 | `/health` | HEAD | both | reachability pre-check |
| 2 | `/report/{username}` | POST | report modal | trigger generation (fire-and-forget status) |
| 3 | `/report/{username}/stream` | GET (SSE) | report modal | live progress + terminal result |
| 4 | `/user/{username}` | GET | profile page | leaderboard-miss fallback lookup |

### 1. `HEAD /health` — reachability pre-check

Issued before every report generation and before the profile page's API fallback, with a
**2-second `AbortController` timeout** (`js/report.js:22-39`; profile fallback uses the
same behavior at `js/profile.js:58-75`).

Reachability semantics, exactly as the client applies them:

| Outcome | Verdict |
|---|---|
| any 2xx (`response.ok`) | **reachable** |
| **404** | **reachable** — a server that is up but lacks a `/health` route is still up |
| any other final HTTP status (e.g. 3xx or 5xx) | **not reachable** |
| fetch/network rejection | not reachable |
| no response within 2s (`AbortError`) | not reachable |

Unreachable means the feature is disabled up front, with a distinct message:
*"Report generation is temporarily unavailable. The API service is currently
unreachable."* — `generate()` returns before constructing an EventSource
(`js/report.js:42-47`). The exact `response.ok || response.status === 404` decision and
the separate timeout/network-error handling are in `js/report.js:26-38`.

### 2. `POST /report/{username}` — trigger generation

Called **after** the stream (endpoint 3) is already open. No body is sent beyond
`Content-Type: application/json` (empty body).

* The response **status and body are never inspected**. A 2xx, 4xx, 5xx, or any other
  HTTP response resolves `fetch()` and produces no direct UI error; generation results
  arrive exclusively over the stream. The server must therefore use the stream for
  success/failure signaling rather than relying on the POST status.
* A **fetch-level failure** of this POST (for example a network/CORS rejection) is not
  silent: the `await` rejects, the current EventSource is closed, and the modal shows
  the rejection's raw `error.message` (`js/report.js:61-81`, `js/report.js:219-235`).
  There is no POST timeout or `AbortSignal` (`js/report.js:73-77`), so a POST that hangs
  leaves `generate()` waiting indefinitely.

HTTP response failures are therefore handled as follows:

| Response surface | Trigger | Client handling |
|---|---|---|
| `HEAD /health` | any final status other than 2xx or 404 | pre-flight fails; no stream is opened and the unavailable message is shown |
| `POST /report/{username}` | any HTTP status, including 4xx/5xx | status/body ignored; no direct error is shown; the stream remains responsible for the outcome |
| `GET /report/{username}/stream` | non-200 response or wrong content type | native EventSource `error`; stream closes and the generic report-failure message is shown (`js/report.js:64-71`, `js/report.js:210-217`) |

The health and POST rows describe HTTP responses. A rejected `fetch()` is not an HTTP
response; it follows the separate POST fetch-level failure path above.

Ordering contract: the client connects to the stream *first* and triggers generation
*second*, so the server must not require the POST to arrive before it accepts stream
connections. The stream must behave correctly for both orders:

* report **not cached** — stream holds open, emits the `queued` → `started` → … lifecycle
  once the POST arrives;
* report **already cached** — the stream may emit terminal `complete` immediately,
  without waiting for the POST.

### 3. `GET /report/{username}/stream` — SSE progress stream

Framing requirements (the client breaks otherwise):

* HTTP **200** with `Content-Type: text/event-stream`. EventSource hard-fails the
  connection on any other status or content type, and that failure is terminal (see
  [Reconnect behavior](#reconnect-behavior)).
* Every application event **must carry a named `event:` field** (`queued`, `started`,
  `scanning`, `scanned`, `complete`, `error`). The client registers only named listeners;
  a default `message` event is silently ignored — the UI would sit at "Connecting…"
  forever.
* For `queued`, `started`, `scanning`, `scanned`, and `complete`, each event's `data:`
  **must be exactly one JSON object**. Those handlers call bare `JSON.parse(e.data)` with
  no error handling; a malformed or split payload throws inside the listener and freezes
  the modal on stale content. The `error` handler does not parse `e.data`, and a native
  transport error has no application payload. Multi-line `data:` fields are therefore
  not safe for the JSON-parsed events.
* `id:` fields are unused (the client never replays via `Last-Event-ID`), and `retry:`
  is effectively meaningless to this client — see [Reconnect behavior](#reconnect-behavior).
* **Heartbeat:** the client has no inactivity timeout on the stream. Until the first
  application event arrives the modal shows "Connecting to API…" indefinitely, so the
  server MUST emit its first event promptly and SHOULD emit SSE comment lines
  (`: ping`) at a regular interval (≲15s) to keep proxies from idling the connection out.

#### Event lifecycle

```
uncached: queued* → started → (scanning → scanned)* → complete
cached:   complete
failure:  error (at any point before the stream is closed)
```

* `queued` may repeat while the job waits (each replaces the position display).
* For an uncached report, each `scanning` row is keyed by `repo` and its matching `scanned`
  event must use the same key to update that row. A duplicate `scanning` key is ignored by
  the client; a `scanned` event with no matching row has no visible effect.
* A cached report may go directly to `complete`, without `queued`, `started`, `scanning`,
  or `scanned` events.
* `complete` and `error` are the **terminal** events: at most one, always last, and the
  server should end the stream immediately after. The client closes the connection upon
  receiving either.

#### Event payloads

Fields the client actually reads. Anything not listed is ignored.

**`queued`**

| Field | Type | Required | Client use |
|---|---|---|---|
| `position` | number | yes | "Position: N" |
| `estimated_wait_seconds` | number | yes | "Est. wait: Ns" |

**`started`**

| Field | Type | Required | Client use |
|---|---|---|---|
| `repos_found` | number | yes | "Scanning N Repos"; progress denominator; per-repo list sizing |

**`scanning`**

| Field | Type | Required | Client use |
|---|---|---|---|
| `repo` | string | yes | row identity (`data-repo` key); must match the later `scanned` |
| `index` | number | yes | 0-based position of this repo; remaining positions render as pending placeholders |
| `total` | number | yes | total repo count (should equal `started.repos_found`) |

**`scanned`**

| Field | Type | Required | Client use |
|---|---|---|---|
| `repo` | string | yes | matches the prior `scanning` row |
| `commits_found` | number | yes | "N commits" on the row |
| `tools` | map of tool → count | no | per-row tool icons; entries with count ≤ 0 are filtered out |

**`error`** (terminal failure)

The client **never reads this event's data** — it closes the stream and shows a fixed
message: *"Report generation failed. Please try again."* Failure detail sent today is
unobservable. A `{ "code": string, "message": string }` body is still the recommended
shape so future clients (and server logs) can distinguish causes; do not rely on it
reaching users.

**`complete`** (terminal success) — the client parses the event data and closes the
EventSource before rendering it; see [The completed report response](#the-completed-report-response).

## Terminal states

For a handled terminal condition, the client applies exactly one of these outcomes:

| Terminal state | Trigger | Client action |
|---|---|---|
| **Success** | `complete` event | closes the EventSource, then renders the report |
| **Failure (application)** | named `error` event | closes the EventSource, then shows the fixed generic message |
| **Failure (transport)** | native EventSource error: non-200 status, wrong content type, connection drop | invokes the same handler, which closes the EventSource and shows the fixed generic message |
| **Failure (pre-flight)** | reachability check fails, or the POST trigger rejects at the fetch level | no stream is opened for a failed reachability check; a failed POST is caught, the current stream is closed, and the raw rejection message is shown |

Because the application `error` event and a native transport error land in the *same*
listener, the client cannot tell them apart. They are indistinguishable in the UI, and
neither terminal failure path permits EventSource auto-reconnect.

## Reconnect behavior

Standard `EventSource` auto-reconnects on transient drops. **This client treats every
stream error as terminal and never auto-reconnects.** The listener is attached alongside
the other stream listeners at `js/report.js:64-71`; it catches both server-sent
`event: error` and the browser's native error events, then unconditionally calls
`close()` at `js/report.js:210-217`, cancelling any pending reconnection the browser had
scheduled.

Consequences, binding on the server:

1. **Generation must survive client disconnect.** A user whose connection drops mid-scan
   abandons a job that keeps running.
2. **Completed reports must be cached.** When the user retries, the fresh
   `POST /report/{username}` + stream connection must replay terminal `complete` from
   cache immediately instead of rescanning (this is the "triggers generation if not
   cached" path the client already assumes).
3. **Do not rely on `retry:` or resume semantics.** No `Last-Event-ID` is ever sent; any
   mid-stream progress the client missed is gone until retry.

## Timeout behavior

| Surface | Timeout | Effect on expiry |
|---|---|---|
| `HEAD /health` pre-check | 2s (`AbortController`; `js/report.js:22-39`) | abort is treated as unreachable; report generation is stopped before `EventSource` creation (`js/report.js:42-47`) |
| `POST /report/{username}` | none (`js/report.js:73-77`) | a hang leaves the already-open modal on "Connecting to API…" indefinitely; an HTTP status is otherwise ignored |
| SSE stream | none — no client inactivity watchdog (`js/report.js:64-71`) | a silent connection leaves the modal on "Connecting to API…" or the last progress frame forever; a transport `error` is handled only when the browser emits one, then closes the stream (`js/report.js:210-217`) |

## The completed report response

The terminal `complete` event payload — the only "report response" the client consumes.
(The `POST /report/{username}` response is never read; the stream event is the source of
truth. A future REST `GET /report/{username}` should return this same shape.)

| Field | Type | Presence / constraint | Client use / handling when absent |
|---|---|---|---|
| `username` | string | optional; falsy values use the default | report header; `"Unknown"` and `unknown` avatar when absent/falsy (`js/report.js:274-280`) |
| `rank` | number | required for a meaningful report; no fallback | `"#${data.rank}"` in the badge; absent renders the literal `undefined` (`js/report.js:277-280`) |
| `total_ranked` | number | optional | denominator of the badge; `"N/A"` if absent/falsy |
| `percentile` | number 0–1 | optional | rendered ×100 as "Top N.N%"; `"Top 0.0%"` if absent/falsy |
| `total_commits` | number | optional for the headline; **required when `by_tool` is present** | headline uses `"0"` if absent, but `by_tool` percentages use the raw value and become `NaN%` if it is absent |
| `repos_with_commits` | number | optional | `"· N repos"` line; `0` if absent/falsy |
| `by_tool` | map of tool → count | optional; individual keys are optional and unknown keys are accepted | Tools Used bars, sorted descending; section shows "No tools detected" if empty/absent (`js/report.js:254-266`) |
| `sparkline_30d` | array of numbers (normally 30) | optional; the client does not enforce length | daily commit counts, max-normalized bar heights; "No recent activity" if empty/absent (`js/report.js:268-272`) |
| `top_repos` | array | optional | see below; "No repos found" if empty/absent (`js/report.js:237-252`) |
| `top_repos[].repo` | string | expected within each entry; interpolated without validation | repo name |
| `top_repos[].commits` | number | expected within each entry; interpolated without validation | "N commits" |
| `top_repos[].tools` | **array of tool names** | **required within each entry and must be an array** | icon strip; an entry *without* `tools` throws and freezes the modal — `tools: []` is the correct empty value (`js/report.js:238-241`) |
| `first_ai_commit` | ISO 8601 timestamp | optional; rendered when truthy | "First AI Commit" section; section omitted if absent/falsy (`js/report.js:311-316`) |

The client does not validate the payload schema. The presence rules above describe the
wire values that are safe and meaningful for the actual renderer: top-level fields with
defaults may be omitted, but `top_repos[].tools` cannot be omitted once its containing
entry exists. The report renderer is implemented in `js/report.js:237-323`.

> **Shape asymmetry, deliberate:** `tools` is a *map of counts* in the `scanned` event but
> an *array of names* inside `top_repos[]`. Both are consumed as typed above; do not
> normalize one to the other without updating `js/report.js`.

## Tool keys

The client has icons/colors for this fixed enum (unknown keys degrade to ⬜):

```
claude · cursor · aider · codex · gemini · opencode
```

No key in that enum is individually required. `scanned.tools` may be absent and defaults
to an empty map, and `by_tool` may be absent or empty; when present, the client iterates
whatever keys the server sends. The same fallback applies to tool names in
`top_repos[].tools` (`js/report.js:166-176`, `js/report.js:238-241`, `js/report.js:254-266`;
the enum is declared in `js/app.js:32-40`).

## 4. `GET /user/{username}` — profile fallback

Used by the profile page only when the username is missing from the baked-in
`leaderboard.json`. Implemented in the backend (`src/user_api.py`).

Success — 200:

```json
{
  "username": "octocat",
  "rank": 42,
  "commit_count": 497,
  "commits_30d": 174,
  "unique_repos": 5,
  "by_tool": { "claude": 300 },
  "recent_repos": [],
  "avatar_url": "https://github.com/octocat.png",
  "profile_url": "https://github.com/octocat",
  "total_ranked": 12000,
  "cached_at": "2026-09-17T00:00:00Z"
}
```

Errors, as the client treats them:

| Status | Meaning (backend) | Client behavior |
|---|---|---|
| 404 | user not in cache — `{"detail": "User '<name>' not found"}` | **distinct "User Not Found" UI** with a leaderboard-search link; not an error state |
| 503 | cache unavailable/expired or empty | generic "Failed to load user profile from API" error |
| 500 | internal error | same generic error |
| network failure / unreachable | — | reachability pre-check should have caught it; generic error if it races |

Field notes: `commit_count`, `commits_30d`, `unique_repos` are rendered with
`toLocaleString()`/`0` defaults; `by_tool` uses the same tool-key enum as above;
`avatar_url`/`profile_url` default to the github.com patterns shown.

## Known client-side gaps (documented, not spec'd)

Recorded so nobody mistakes them for server obligations:

* No client watchdog on the stream — a silent server stalls the UI silently (mitigated by
  the heartbeat SHOULD above).
* A malformed JSON payload in a JSON-parsed event (`queued`, `started`, `scanning`,
  `scanned`, or `complete`) throws unhandled and freezes the modal; the `error` event is
  not parsed (`js/report.js:88-90`, `104-106`, `125-127`, `166-168`, `199-200`,
  `210-217`).
* The `scanning` handler renders pending placeholder rows for indices
  `data.index … data.total - 1` *in addition to* the scanning row itself, so the first
  repo's scan momentarily shows one extra placeholder row. Cosmetic; `index` is still
  0-based and `total` is the repo count (`js/report.js:130-159`).
* A `top_repos[]` entry **without** a `tools` field throws
  (`TypeError: (repo.tools || {}).map is not a function` — the `{}` fallback is
  map-less, unlike the `scanned` event's `Object.entries(data.tools || {})`), so
  `showReport` aborts before assigning `innerHTML`: the stream is already closed and
  the modal freezes on the last progress frame. This is why `top_repos[].tools` is
  marked required above; use `[]`, not an absent field, for "no tools"
  (`js/report.js:237-252`).
* `by_tool` percentages divide by the raw `total_commits` field, not the defaulted
  one — `by_tool` present without `total_commits` renders bars labelled
  `N (NaN%)` with `width: NaN%`. Always send `total_commits` alongside `by_tool`
  (`js/report.js:254-266`).
