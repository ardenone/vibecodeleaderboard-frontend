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

Resolved once in `js/config.js` and consumed everywhere as
`window.VibeCodeConfig.apiBaseUrl` (frozen — it is the single source of truth):

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
**2-second `AbortController` timeout**.

Reachability semantics, exactly as the client applies them:

| Outcome | Verdict |
|---|---|
| any 2xx (`response.ok`) | **reachable** |
| **404** | **reachable** — a server that is up but lacks a `/health` route is still up |
| any other status (e.g. 5xx) | **not reachable** |
| network error | not reachable |
| no response within 2s (`AbortError`) | not reachable |

Unreachable means the feature is disabled up front, with a distinct message:
*"Report generation is temporarily unavailable. The API service is currently
unreachable."* — no EventSource is ever constructed. This is the state visitors see while
the backend is offline (the normal state today).

### 2. `POST /report/{username}` — trigger generation

Called **after** the stream (endpoint 3) is already open. No body is sent beyond
`Content-Type: application/json` (empty body).

* The response **status and body are never inspected**. Generation results arrive
  exclusively over the stream.
* A **network-level failure** of this POST is *not* silent: the `await` rejects and the
  modal shows the raw error message. The server must therefore keep the endpoint
  cheap — the heavy work belongs behind the stream.

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
* Each event's `data:` **must be exactly one JSON object**. Handlers call bare
  `JSON.parse(e.data)` with no error handling; a malformed or split payload throws inside
  the listener and freezes the modal on stale content. Multi-line `data:` fields are
  therefore not safe to use.
* `id:` fields are unused (the client never replays via `Last-Event-ID`), and `retry:`
  is effectively meaningless to this client — see [Reconnect behavior](#reconnect-behavior).
* **Heartbeat:** the client has no inactivity timeout on the stream. Until the first
  application event arrives the modal shows "Connecting to API…" indefinitely, so the
  server MUST emit its first event promptly and SHOULD emit SSE comment lines
  (`: ping`) at a regular interval (≲15s) to keep proxies from idling the connection out.

#### Event lifecycle

```
queued* → started → (scanning → scanned)+ → complete
                          ↘ error (from any point)
```

* `queued` may repeat while the job waits (each replaces the position display).
* One `scanning` per repo, followed by its matching `scanned`; repos are keyed by the
  `repo` field, which must be unique and consistent between the two events.
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

**`complete`** (terminal success) — see [The completed report response](#the-completed-report-response).

## Terminal states

The modal ends in exactly one of:

| Terminal state | Trigger | Client action |
|---|---|---|
| **Success** | `complete` event | closes the EventSource, renders the report |
| **Failure (application)** | named `error` event | closes the EventSource, fixed generic message |
| **Failure (transport)** | native EventSource error: non-200 status, wrong content type, connection drop | same handler fires — closes the EventSource, fixed generic message |
| **Failure (pre-flight)** | reachability check fails, or the POST trigger rejects at the network level | no stream at all (or stream torn down); error text shown |

Because the application `error` event and a native transport error land in the *same*
listener, the client cannot tell them apart. They are indistinguishable in the UI.

## Reconnect behavior

Standard `EventSource` auto-reconnects on transient drops. **This client never
reconnects.** Its handler is attached with `addEventListener('error', …)`, which catches
both server-sent `event: error` *and* the browser's native error events; the handler
unconditionally calls `close()`, cancelling any pending reconnection the browser had
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
| `HEAD /health` pre-check | 2s (`AbortController`) | feature reported unreachable; report/profile fallback disabled |
| `POST /report/{username}` | none | a hang stalls `generate()` before the modal advances; server must respond (status irrelevant) |
| SSE stream | none (no watchdog) | a silent server leaves the modal on "Connecting…" or the last progress frame forever — hence the heartbeat requirement above |

## The completed report response

The terminal `complete` event payload — the only "report response" the client consumes.
(The `POST /report/{username}` response is never read; the stream event is the source of
truth. A future REST `GET /report/{username}` should return this same shape.)

| Field | Type | Required | Client use / default when absent |
|---|---|---|---|
| `username` | string | yes* | report header; defaults to "Unknown"/`unknown` avatar |
| `rank` | number | yes* | "#N of …" badge |
| `total_ranked` | number | yes* | denominator of the badge; `"N/A"` if absent |
| `percentile` | number 0–1 | yes* | rendered ×100 as "Top N.N%"; "Top 0.0%" if absent |
| `total_commits` | number | yes* | headline count **and** denominator for `by_tool` percentages; "0" if absent |
| `repos_with_commits` | number | yes* | "· N repos" line; `0` if absent |
| `by_tool` | map of tool → count | no | Tools Used bars, sorted descending; section shows "No tools detected" if empty/absent |
| `sparkline_30d` | number[30] | no | daily commit counts, max-normalized bar heights; "No recent activity" if empty/absent |
| `top_repos` | array | no | see below; "No repos found" if empty/absent |
| `top_repos[].repo` | string | yes (within array) | repo name |
| `top_repos[].commits` | number | yes (within array) | "N commits" |
| `top_repos[].tools` | **array of tool names** | **yes (within array)** | icon strip; an entry *without* `tools` throws and freezes the modal (see [Known client-side gaps](#known-client-side-gaps-documented-not-specd)) — `tools: []` is the correct empty value |
| `first_ai_commit` | ISO 8601 timestamp | no | "First AI Commit" section; section omitted entirely if absent |

\* marked fields are read unconditionally — absent values render as the listed defaults
rather than an error, but a conforming server always sends them.

> **Shape asymmetry, deliberate:** `tools` is a *map of counts* in the `scanned` event but
> an *array of names* inside `top_repos[]`. Both are consumed as typed above; do not
> normalize one to the other without updating `js/report.js`.

## Tool keys

The fixed enum the client has icons/colors for (unknown keys degrade to ⬜):

```
claude · cursor · aider · codex · gemini · opencode
```

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
* A malformed JSON payload in any event throws unhandled and freezes the modal.
* The `scanning` handler renders pending placeholder rows for indices
  `data.index … data.total - 1` *in addition to* the scanning row itself, so the first
  repo's scan momentarily shows one extra placeholder row. Cosmetic; `index` is still
  0-based and `total` is the repo count.
* A `top_repos[]` entry **without** a `tools` field throws
  (`TypeError: (repo.tools || {}).map is not a function` — the `{}` fallback is
  map-less, unlike the `scanned` event's `Object.entries(data.tools || {})`), so
  `showReport` aborts before assigning `innerHTML`: the stream is already closed and
  the modal freezes on the last progress frame. This is why `top_repos[].tools` is
  marked required above; use `[]`, not an absent field, for "no tools".
* `by_tool` percentages divide by the raw `total_commits` field, not the defaulted
  one — `by_tool` present without `total_commits` renders bars labelled
  `N (NaN%)` with `width: NaN%`. Always send `total_commits` alongside `by_tool`.
