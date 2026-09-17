# Vibe Code Leaderboard - Frontend

Public frontend for the Vibe Code Leaderboard, tracking AI-assisted coding across GitHub.

## Overview

This is a static HTML/CSS/JavaScript site that displays the leaderboard of developers using AI coding tools. The site works standalone with baked-in `leaderboard.json` data and includes an on-demand report generation feature powered by the backend API.

## Features

- **Leaderboard Display**: Browse top AI-assisted developers ranked by commit count
- **Client-Side Search**: Search for any GitHub username
- **Tool Filtering**: Filter by specific AI tools (Claude, Cursor, Aider, etc.)
- **On-Demand Reports**: Generate detailed reports for any user (not just those on the leaderboard)
- **Real-Time Progress**: SSE-powered progress updates during report generation
- **Responsive Design**: Works on desktop and mobile devices

## Architecture

```
Static Site (this repo)
    ├── index.html         - Main leaderboard page
    ├── css/style.css      - Styling
    ├── js/config.js       - Shared API base URL configuration
    ├── js/app.js          - Leaderboard rendering, search, filtering
    └── js/report.js       - SSE client, report generation UX
```

The site includes `leaderboard.json` at build time for instant rendering. The API is only required for the on-demand report feature.

## Local Development

### Prerequisites

- A modern web browser
- (Optional) Local backend API server listening on `http://localhost:8080`

### Running Locally

1. Clone the repo:
   ```bash
   git clone https://git.ardenone.com/jedarden/vibecodeleaderboard-frontend.git
   cd vibecodeleaderboard-frontend
   ```

2. Serve the files with any static server:
   ```bash
   # Using Python 3
   python -m http.server 3000

   # Using Node.js
   npx serve . --listen 3000
   ```

3. Open `http://localhost:3000` in your browser. Keep the frontend and backend
   on different ports: the backend API uses `http://localhost:8080`.

   To exercise the Pages Functions locally instead, use Wrangler, which serves
   the frontend from `http://localhost:8788`:

   ```bash
   wrangler pages dev .
   ```

### API Configuration

`js/config.js` is the single source of truth for the browser API base URL. It
uses `http://localhost:8080` when the page is served from `localhost`,
`127.0.0.1`, or `[::1]`; otherwise it derives the API origin as
`https://api.<frontend-hostname>` (so the production frontend uses
`https://api.vibecodeleaderboard.com`). The leaderboard data itself is still
loaded from the frontend's same-origin `leaderboard.json`.

Do not edit `js/app.js`, `js/report.js`, or `js/profile.js` to change the API
origin. If a different local backend origin is required, update the one value
in `js/config.js` and make the backend's CORS allowlist match it.

### Local CORS and proxy behavior

The static site has no development proxy. Report generation, health checks, and
profile fallbacks go directly from the browser to the configured API origin;
the `_redirects` file only handles Pages profile/page routing and does not proxy
`/health`, `/report/*`, or `/user/*`.

For a local frontend on port 3000, the backend must allow the exact origin
`http://localhost:3000`. If using Wrangler, allow `http://localhost:8788` as
well. If the frontend is opened through a loopback address, allow the matching
`http://127.0.0.1:<port>` origin too. The API must allow the methods used by
the clients (`GET`, `HEAD`, and `POST`) and the `Content-Type` request header.
The report stream is cross-origin SSE, so its response also needs the matching
`Access-Control-Allow-Origin` header and a proxy that forwards the stream
without buffering or an overly short idle timeout.

If a host-specific reverse proxy is introduced, point `js/config.js` at that
proxy origin and ensure it forwards `/health`, `/report/*` (including the SSE
stream), and `/user/*` to the backend. A proxy does not remove the need to
configure CORS unless the browser request becomes same-origin.

Production CORS should allow both `https://vibecodeleaderboard.com` and
`https://www.vibecodeleaderboard.com` when both frontend domains are enabled.

## Deployment

Deployment is Forgejo-primary and GitOps-managed. The production path is:

```text
Forgejo push to main
    -> Forgejo webhook
    -> Argo Events / Argo Workflows in iad-ci
    -> website-build WorkflowTemplate
    -> Cloudflare Pages project
```

The source-of-truth repository is
[`git.ardenone.com/jedarden/vibecodeleaderboard-frontend`](https://git.ardenone.com/jedarden/vibecodeleaderboard-frontend).
GitHub repositories are mirrors for discovery and must not be treated as the
authoritative checkout or deployment target. This repository has no GitHub
Actions deployment workflow and does not require repository-level Cloudflare
secrets.

### One-time prerequisites

Before the first production push, the following must exist:

- **Argo wiring:** `declarative-config` must contain the Forgejo webhook route
  and a `website-build` sensor trigger for `jedarden/vibecodeleaderboard-frontend`
  on `main`. The trigger uses `build-command: true`, `output-dir: .`, and
  `cf-project: vibecodeleaderboard-frontend`.
- **Cloudflare Pages project:** Create a Pages project named exactly
  `vibecodeleaderboard-frontend`. The Argo template deploys the repository root
  as-is, including Pages Functions, `_redirects`, and `_routes.json`.
- **Central deployment credential:** The `cloudflare-pages-secret`
  `ExternalSecret` in the `iad-ci` Argo Workflows configuration must be
  healthy. The Pages API credential belongs in the cluster's central secret
  store; never add it to Forgejo, a GitHub mirror, this repository, or a local
  `.env` file.
- **Frontend DNS:** Put the `vibecodeleaderboard.com` DNS zone under the DNS
  provider used for the Pages project, attach both the apex domain and
  `www.vibecodeleaderboard.com` as Pages custom domains, and publish the
  Cloudflare-provided Pages records. Wait for HTTPS certificates before calling
  the site production-ready.
- **API DNS and service:** If report generation and live profile lookups are
  part of the launch, `api.vibecodeleaderboard.com` must resolve to the
  production backend ingress and have a valid TLS certificate. The backend must
  serve the documented report/health endpoints and allow CORS from both
  frontend origins. The static leaderboard still renders without the API, but
  API-backed features do not.
- **Production data:** Review `leaderboard.json` before launch. It is shipped
  unchanged because this site has no build step; Argo does not fetch or replace
  it during deployment.

### Normal release

1. Make and test the change locally.
2. Commit to `main` and push to the Forgejo `origin`:

   ```bash
   git push origin main
   ```

3. The authenticated Forgejo webhook submits an Argo Workflow in `iad-ci`.
   The workflow clones the Forgejo repository, runs the configured build
   command (`true` for this static site), and deploys `.` to the named Pages
   project.
4. Verify the Argo Workflow completed successfully, then check the Pages
   deployment and the production custom domain.

Changes to webhook routes, sensors, WorkflowTemplates, ExternalSecrets, or
other cluster configuration belong in
[`declarative-config`](https://git.ardenone.com/jedarden/declarative-config).
Commit and push those manifests and let ArgoCD reconcile them; do not apply
Argo-managed resources directly with `kubectl`.

### Production hostname configuration

The frontend derives its production API URL from the browser hostname:
`https://api.<frontend-hostname>`. Therefore the expected production hosts are
`https://vibecodeleaderboard.com` or `https://www.vibecodeleaderboard.com` for
the site and `https://api.vibecodeleaderboard.com` for the API. Keep those DNS,
TLS, backend-ingress, and CORS settings aligned; there is no deployment-time
API URL secret to update.

### Other Static Hosts

The site can be hosted on any static hosting service:
- GitHub Pages
- Netlify
- Vercel
- AWS S3 + CloudFront

Simply upload the contents of this directory.

## leaderboard.json Format

The leaderboard data is a JSON file with the following structure:

```json
{
  "generated_at": "2026-07-06T00:00:00Z",
  "rankings": [
    {
      "rank": 1,
      "username": "poweruser42",
      "avatar_url": "https://github.com/poweruser42.png?size=80",
      "profile_url": "https://github.com/poweruser42",
      "commit_count": 2341,
      "commits_30d": 187,
      "unique_repos": 31,
      "recent_repos": ["poweruser42/webapp", "poweruser42/cli", ...],
      "latest_commit": "2026-07-05T16:00:07.356990+00:00",
      "by_tool": {
        "claude": 2100,
        "cursor": 200,
        "aider": 41
      },
      "sparkline_30d": [
        {"date": "2026-06-05", "count": 5},
        {"date": "2026-06-06", "count": 8},
        ...
      ]
    },
    ...
  ]
}
```

## API Contract

The frontend expects the backend API to provide these endpoints:

### GET /leaderboard.json

Returns the full leaderboard data (same format as baked-in JSON).

### POST /report/{username}

Triggers report generation for a user. Returns 202 if queued/started.

### GET /report/{username}/stream

SSE endpoint streaming report generation progress:
- `queued` - Report is in queue
- `started` - Scan has started
- `scanning` - Currently scanning a repo
- `scanned` - Repo scan complete
- `complete` - Full report data
- `error` - Generation failed

### GET /report/{username}

Returns cached report data (if available).

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile Safari/Chrome (iOS 14+, Android 10+)

## Contributing

This is the public frontend repo. Issues and PRs are welcome!

For backend contributions, see: https://github.com/ardenone/vibecodeleaderboard-backend

## License

MIT
