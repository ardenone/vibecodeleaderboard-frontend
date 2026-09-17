# Plan: Vibe Code Leaderboard — Frontend

This file is the single plan document for `vibecodeleaderboard-frontend`, per this
workspace's repo convention. It was started retroactively during an artifact-improvement
audit on 2026-07-20 — it does not claim to reconstruct the original design intent, only to
record verified current state and decisions made from here forward.

## What this repo is

A public, static HTML/CSS/JS site (no build step, no framework, no `package.json`):

- `index.html` + `js/app.js` + `css/style.css` — the leaderboard table, client-side search
  (exact-match against the baked-in `leaderboard.json`), and tool filtering.
- `user.html` + `js/profile.js` + `css/profile.css` — shareable per-user profile page at
  `/u/<username>` (routed via `_redirects`), intended to carry per-user Open Graph tags for
  link unfurls.
- `js/config.js` — the shared browser API base URL configuration used by the API clients.
- `js/report.js` — SSE client for an on-demand "generate a report for any GitHub user"
  feature, talking to a backend API at `https://api.<hostname>`.
- `leaderboard.json` — baked-in leaderboard data, fetched at page load for instant render.

## Audited status (2026-07-20)

Verified directly (DNS lookups, `gh run list`/`gh run view --log`, read-only kubectl against
apexalgo-iad, Forgejo API) rather than assumed from the repo name:

- **Nothing is live.** `vibecodeleaderboard.com` has no A/AAAA record at all (only NS
  records at Spaceship and MX records for mail) — `www` and `api` subdomains return
  NXDOMAIN. There is no Cloudflare Pages `*.pages.dev` deployment either.
- **The only deploy pipeline at the time (`.github/workflows/deploy.yml`, GitHub Actions →
  Cloudflare Pages) failed on both of its two runs ever** (2026-07-06 and 2026-07-07):
  repository-level Pages credentials were missing, and its optional "refresh
  leaderboard.json from the API" step also failed because `api.vibecodeleaderboard.com`
  did not resolve. This historical workflow has since been removed; the active path is the
  Forgejo-to-Argo process documented in ADR-001 below.
- **The backend is offline.** The paired private repo `ardenone/vibecodeleaderboard-backend`
  deploys as the `claude-leaderboard` namespace on `apexalgo-iad`
  (`cluster-configuration/apexalgo-iad/claude-leaderboard/` per its README). Read-only
  kubectl confirms `deployment.apps/claude-leaderboard` is scaled to `0/0` replicas, while a
  `migration-exporter` Deployment is present and running in the same namespace — consistent
  with this workspace's tracked history that the claude-leaderboard service was taken
  offline and superseded by the devimprint pipeline.
- **`leaderboard.json` as committed is synthetic test fixture data** — every entry is
  `testuserNNN` with an identical stat block (497 commits, 174 commits_30d, 5 repos) — not
  real leaderboard content.
- **The local git checkout's `origin` remote was pointed directly at
  `github.com/jedarden/...`**, bypassing the Forgejo-primary/GitHub-mirror setup this
  workspace uses everywhere else (the Forgejo repo `git.ardenone.com/jedarden/
  vibecodeleaderboard-frontend` already exists with two working push mirrors to
  `github.com/ardenone/...` and `github.com/jedarden/...`). Corrected as part of this audit.

Net: the frontend's actual code (rendering, search, filtering, SSE report UX, OG-tag
scaffolding) is real and reviewed-quality — the entire gap is in what serves it and feeds
it. That gap, and specifically the CI/CD path, is the subject of ADR-001 below.

## ADR-001: 2026-07-20 — Deploy via the fleet's Argo Workflows `website-build` template, not GitHub Actions

### Context

This repo ships a purely static site with zero build step. It needs exactly one thing to go
live: push the contents of the repo root to a Cloudflare Pages project on every merge to
`main`. The source of truth is the Forgejo repository
`git.ardenone.com/jedarden/vibecodeleaderboard-frontend`; GitHub is a read-only push mirror.

The fleet's CI/CD system of record is Argo Workflows in the `iad-ci` cluster. The old
repo-local GitHub Actions deployment was removed. `declarative-config` provides the generic
`website-build` `WorkflowTemplate`
(`k8s/iad-ci/argo-workflows/website-build-workflowtemplate.yml`) plus the Argo Events
configuration that receives Forgejo push webhooks and submits it. The template clones from
Forgejo, runs an arbitrary build command, and deploys the output with Wrangler. Static sites
use `build-command: "true"` and deploy a directory as-is.

### Decision

Deploy `vibecodeleaderboard-frontend` through the existing `website-build` WorkflowTemplate:

- Add the Forgejo event-source route, webhook ingress route, and sensor dependency/trigger
  in `declarative-config` for `jedarden/vibecodeleaderboard-frontend` on `main`, using
  `build-command: "true"`, `output-dir: "."`, and
  `cf-project: vibecodeleaderboard-frontend`.
- Create the Cloudflare Pages project named `vibecodeleaderboard-frontend` and attach the
  `vibecodeleaderboard.com` and `www.vibecodeleaderboard.com` custom domains. The DNS zone
  must be managed by the provider serving the Pages project, and HTTPS must be issued before
  production launch.
- Provision the shared `cloudflare-pages-secret` ExternalSecret in `iad-ci`; the Pages API
  credential is cluster-managed and must not be copied into this repository or either GitHub
  mirror.
- Ensure `api.vibecodeleaderboard.com` resolves to the live backend, has a valid certificate,
  and permits both frontend origins through CORS before advertising report generation or live
  profile lookups.
- Do **not** fetch or replace `leaderboard.json` during deploy. The committed file is the
  production artifact until the data pipeline publishes a reviewed replacement.

Implementation is cross-repo (this repo + `declarative-config`) and is tracked as beads
rather than done inline in this documentation pass, consistent with this workspace's rule
that `declarative-config` changes are commit-and-let-ArgoCD-sync, never a live mutation
performed ad hoc.

### Alternatives Considered

1. **Fix the existing GitHub Actions workflow** (add the missing Cloudflare secrets). Rejected
   outright — directly contradicts the explicit "GitHub Actions disabled everywhere, use
   Argo instead" policy; would also leave this repo as the one exception to a fleet-wide
   convention for no technical reason.
2. **One-off manual deploy** (`wrangler pages deploy .` run by hand from a dev box). Rejected
   — not repeatable, doesn't survive across machines/agents, no audit trail, and reintroduces
   exactly the kind of untracked live-mutation this workspace's GitOps model exists to avoid.
3. **Serve as an in-cluster static pod** (nginx Deployment + Traefik IngressRoute on an
   existing cluster) instead of Cloudflare Pages. Rejected — this is a pure static site with
   no need for cluster compute, and the fleet already has a working, zero-maintenance
   Cloudflare Pages path for exactly this shape of artifact; running it in-cluster would add
   a pod, Service, IngressRoute, and Certificate to operate for no benefit over the existing
   pattern.
4. **Leave it undeployed** until the backend/data-source question is resolved. Rejected as
   the default — deploying costs nothing once the pipeline exists and unblocks visually
   validating future frontend changes and data-pipeline decisions against a real URL.
   Explicitly not the same as calling the site "launched": until the `leaderboard.json`
   placeholder-data bead is resolved, the deployed site must not be promoted/linked publicly
   as if it shows real data.

### Consequences

- Every push to Forgejo `main` will auto-deploy via Argo once the Forgejo sensor, Pages
  project, shared credential, and DNS prerequisites are provisioned.
- GitHub remains a mirror and is not a deployment control plane. There are no per-repository
  Pages credentials or manual Wrangler deployments in the release path.
- The site serves the committed `leaderboard.json` until the data pipeline publishes a
  reviewed production replacement; a successful Pages deployment is not by itself a data
  quality sign-off.
- Without a live `api.vibecodeleaderboard.com`, the static leaderboard still renders but
  report generation and live profile fallbacks are unavailable.

## ADR-002: 2026-09-17 — Leaderboard refresh runs as a standalone safe script, not at deploy time

### Context

The removed GitHub Actions deploy workflow contained the only leaderboard refresh logic
this repo ever had: `curl -fsSL https://api.vibecodeleaderboard.com/leaderboard.json -o
leaderboard.json || echo warning`. That is unsafe in every failure direction: it accepts
stale payloads, proxy error pages, and schema changes that would blank the site, and its
only guard is curl's own exit code. ADR-001 dropped the step entirely rather than carry it
into the Argo deploy path while the backend is offline, leaving the repo with no refresh
or validation tooling at all.

### Decision

Implement the refresh as a standalone, unattended-safe shell workflow in `scripts/`
(`validate-leaderboard.sh`, `refresh-leaderboard.sh`), documented in
`docs/notes/leaderboard-refresh.md`:

- Fetch, validate schema + freshness, and check for regression **before** touching
  `leaderboard.json`; every failure path leaves it byte-for-byte untouched, so the
  baked-in fallback always survives a dead or lying API.
- Install atomically (stage + rename in the target directory) so readers never see a
  partial file.
- Validation is also usable standalone: `scripts/validate-leaderboard.sh
  --skip-freshness leaderboard.json` is the pre-push gate for any change touching the
  data file (the committed fixture is schema-valid but intentionally stale).
- `scripts/definition-of-done.sh` runs the OG-injection suite plus self-tests for both
  scripts, including live refresh runs against a throwaway local HTTP server covering
  success, no-op regression, and fallback preservation.

Activation when the backend returns: a scheduled runner commits refreshed data to `main`
and the existing `website-build` push hook deploys it. Deploy-time refresh stays rejected
(a deploy must not depend on API health). It is deliberately not scheduled yet: while the
backend is offline every run correctly takes the fallback path and changes nothing, and
automating a guaranteed-failure adds noise, not safety.

### Consequences

- The refresh can be run by hand, cron, or agent with identical safety properties; nothing
  in the deploy path needs to change when it is switched on.
- Committed `leaderboard.json` history can only move forward in `generated_at` — the
  regression guard makes stale re-commits a no-op rather than a silent downgrade.
