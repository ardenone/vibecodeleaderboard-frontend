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
- `js/report.js` — SSE client for an on-demand "generate a report for any GitHub user"
  feature, talking to a backend API at `https://api.<hostname>`.
- `leaderboard.json` — baked-in leaderboard data, fetched at page load for instant render.

## Audited status (2026-07-20)

Verified directly (DNS lookups, `gh run list`/`gh run view --log`, read-only kubectl against
apexalgo-iad, Forgejo API) rather than assumed from the repo name:

- **Nothing is live.** `vibecodeleaderboard.com` has no A/AAAA record at all (only NS
  records at Spaceship and MX records for mail) — `www` and `api` subdomains return
  NXDOMAIN. There is no Cloudflare Pages `*.pages.dev` deployment either.
- **The only deploy pipeline (`.github/workflows/deploy.yml`, GitHub Actions → Cloudflare
  Pages) has failed on both of its two runs ever** (2026-07-06 and 2026-07-07): missing
  `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` repo secrets (`Input required and not
  supplied: apiToken`), and its optional "refresh leaderboard.json from the API" step also
  fails because `api.vibecodeleaderboard.com` doesn't resolve. This also means GitHub
  Actions is still enabled and firing on this repo, contrary to fleet policy (GH Actions are
  supposed to be disabled everywhere; Argo Workflows is the CI/CD system of record).
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
`main`. It currently tries to do this with a GitHub Actions workflow
(`.github/workflows/deploy.yml`, `cloudflare/pages-action@v1`) that has never once succeeded
— `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` secrets were never configured on either the
`ardenone/vibecodeleaderboard-frontend` or `jedarden/vibecodeleaderboard-frontend` GitHub
repos, so both runs failed at the deploy step.

Separately, this workspace has a fleet-wide, explicit policy: **GitHub Actions are disabled
across all repos; Argo Workflows (running in the `iad-ci` cluster) is the CI/CD system of
record.** This repo currently violates that policy — it is the only repo found during this
audit still running live (if failing) GitHub Actions workflows on every push.

This is not a green-field decision. `declarative-config` already has a working, generic
`website-build` `WorkflowTemplate` (`k8s/iad-ci/argo-workflows/website-build-workflowtemplate.yml`)
plus a matching Argo Events `Sensor`
(`k8s/iad-ci/argo-events/website-build-sensor.yml`) that together clone a repo, run an
arbitrary build command, and `wrangler pages deploy` the output — triggered by a GitHub push
webhook, no polling, no repo-local Actions config. Seven static sites already deploy this
way, including at least one (`artifacts.hardyrekshin.com`) with the exact same shape as this
repo: no build step at all (`build-command: "true"`), just a directory of static files.

### Decision

Deploy `vibecodeleaderboard-frontend` through the existing `website-build` WorkflowTemplate
instead of fixing/re-enabling GitHub Actions:

- Add a new dependency + trigger to `k8s/iad-ci/argo-events/website-build-sensor.yml` for
  `vibecodeleaderboard-frontend`, using `build-command: "true"` and `output-dir: "."`
  (mirroring the `artifacts-hardyrekshin-com-deploy` trigger, the closest existing analog).
- Create the `vibecodeleaderboard-frontend` Cloudflare Pages project (parallel to the
  `cf-project` values already used by the other six sites on this template).
- Delete `.github/workflows/deploy.yml` from this repo and disable GitHub Actions at the
  repo-settings level on both the `jedarden/...` and `ardenone/...` GitHub mirrors (deleting
  the workflow file alone does not stop a repo with Actions enabled from re-triggering on
  future pushes — a known gotcha in this fleet).
- Do **not** carry over the workflow's "fetch fresh `leaderboard.json` from the API during
  deploy" step — the API has no DNS and the backend is scaled to zero. Ship the
  currently-committed `leaderboard.json` as-is (it is test fixture data; replacing it with
  real or clearly-labeled placeholder data is tracked separately, see beads below) until the
  data-source decision is made.

Implementation is cross-repo (this repo + `declarative-config`) and is tracked as beads
rather than done inline in this audit pass, consistent with this workspace's rule that
`declarative-config` changes are commit-and-let-ArgoCD-sync, never a live mutation performed
ad hoc.

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

- Every push to `main` will auto-deploy via Argo (identical mechanism to `jedarden.com` and
  the six other sites on this template) — no more manual deploys, no more silently-failing
  Actions runs on every commit.
- One-time setup cost: a `declarative-config` sensor entry + Cloudflare Pages project
  creation, plus disabling GitHub Actions on the two GitHub mirrors. Tracked as beads.
- The site will go live serving synthetic `testuserNNN` data until the placeholder-data bead
  is resolved — must not be treated as a real public launch until then.
- The still-dead backend (`api.<hostname>`) means "Generate Report" and the profile page's
  live-API fallback will fail (or hang) for any visitor as soon as the site is reachable —
  tracked separately as a graceful-degradation bead so a live-but-broken feature isn't the
  first thing a real visitor hits.
