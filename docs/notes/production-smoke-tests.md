# Production smoke tests

Run the post-deployment check from a machine that can reach the public site and
API:

```bash
node scripts/production-smoke.mjs
```

The runner checks:

- the production site returns the leaderboard HTML shell;
- `/leaderboard.json` is JSON and matches the leaderboard entry shape;
- `HEAD /health` is reachable (a documented `404` is accepted as an API that
  is up but does not expose a health route);
- `GET /user/{username}` returns either the documented profile shape or the
  documented JSON `404` shape;
- the report stream returns HTTP 200 with `text/event-stream`, has the
  production site's CORS origin, and emits valid named SSE events through a
  terminal `complete` report; and
- `POST /report/{username}` succeeds after the stream is connected.

The default report probe uses `octocat`. Override it, or point the check at a
preview/staging deployment, with environment variables:

```bash
SMOKE_SITE_URL=https://preview.example.com \
SMOKE_API_URL=https://api.preview.example.com \
SMOKE_USERNAME=known-cached-user \
node scripts/production-smoke.mjs
```

The script validates the event payloads and the completed report shape from
[`report-sse-api-contract.md`](report-sse-api-contract.md). It intentionally
opens the SSE stream before sending the report `POST`, matching the browser
client's ordering contract and exercising both the proxy and backend stream
path.
