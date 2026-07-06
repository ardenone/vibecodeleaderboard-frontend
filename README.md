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
    ├── js/app.js          - Leaderboard rendering, search, filtering
    └── js/report.js       - SSE client, report generation UX
```

The site includes `leaderboard.json` at build time for instant rendering. The API is only required for the on-demand report feature.

## Local Development

### Prerequisites

- A modern web browser
- (Optional) Local backend API server

### Running Locally

1. Clone the repo:
   ```bash
   git clone https://github.com/ardenone/vibecodeleaderboard-frontend.git
   cd vibecodeleaderboard-frontend
   ```

2. Serve the files with any static server:
   ```bash
   # Using Python 3
   python -m http.server 8080

   # Using Node.js
   npx serve .

   # Or open index.html directly in a browser
   ```

3. Open `http://localhost:8080` in your browser

### API Configuration

By default, the frontend uses the production API at `api.vibecodeleaderboard.com`. For local development with a local backend:

```javascript
// In js/app.js and js/report.js, modify:
const API_BASE = 'http://localhost:8080';  // Your local API server
```

## Deployment

### Cloudflare Pages (Recommended)

The site is automatically deployed to Cloudflare Pages via GitHub Actions when pushing to `main`.

Required GitHub repository secrets:
- `CLOUDFLARE_API_TOKEN` - Cloudflare API token with Pages edit permissions
- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID

To deploy manually:

```bash
# Install Wrangler
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Deploy
wrangler pages deploy . --project-name=vibecodeleaderboard-frontend
```

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
