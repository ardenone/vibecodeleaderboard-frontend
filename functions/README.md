# Cloudflare Pages Functions

This directory contains Cloudflare Pages Functions that enable server-side processing for the Vibe Code Leaderboard site.

## User Profile Function (`u/[username].js`)

### Purpose
Intercepts requests to `/u/[username]` paths and injects server-side Open Graph (OG) meta tags for social media crawlers. This ensures that when someone shares a user profile link on platforms like Twitter, Slack, Discord, or iMessage, the unfurl preview shows the actual user's rank and stats rather than generic placeholder text.

### How It Works
1. **Request Interception**: The function runs before static file serving for any `/u/[username]` path
2. **Data Loading**: Fetches `leaderboard.json` to find the requested user's data
3. **Template Processing**: Loads the `user.html` template
4. **Tag Injection**: Replaces static OG meta tags with dynamic user-specific content
5. **Response**: Returns the modified HTML with proper caching headers

### Why This Is Needed
- **Client-side JavaScript isn't enough**: Social media crawlers (Twitter Card, Slack unfurl, etc.) fetch raw HTML without executing JavaScript
- **Existing client-side code remains**: `js/profile.js` still handles the interactive page functionality and provides a fallback
- **Server-side first impression**: Crawlers see proper OG tags immediately, improving share appearance

### Features
- **Personalized OG title**: Shows rank and username (e.g., "#123 johndoe - Vibe Code Leaderboard")
- **Dynamic description**: Includes commit count, repos, and rank
- **Fallback handling**: Gracefully handles missing users or data errors
- **Caching**: 5-minute cache for user profiles, 1-minute for error states
- **URL consistency**: Updates canonical URLs and OG URLs to match the request

### OG Tag Examples

**For an existing user:**
```html
<meta property="og:title" content="#123 johndoe - Vibe Code Leaderboard">
<meta property="og:description" content="johndoe has 5,432 AI-assisted commits across 12 repos. Ranked #123 on the Vibe Code Leaderboard.">
<meta property="og:image" content="https://vibecodeleaderboard.com/og-image.png">
<meta property="og:url" content="https://vibecodeleaderboard.com/u/johndoe">
```

**For a non-existent user:**
```html
<meta property="og:title" content="unknownuser - Vibe Code Leaderboard">
<meta property="og:description" content="unknownuser is not yet on the Vibe Code Leaderboard. Check the full leaderboard to see top AI-assisted developers.">
```

### Deployment
This function automatically deploys with the Cloudflare Pages project via the `website-build` WorkflowTemplate (see `docs/plan/plan.md` ADR-001).

### Local Testing
To test locally with Wrangler:
```bash
npm install -g wrangler
wrangler pages dev . --compatibility-flag=nodejs_compat
```

Then visit `http://localhost:8788/u/testuser090` to verify the function works.

### Future Enhancements
- **Dynamic OG image generation**: Create user-specific preview cards with stats, avatars, and rank
- **API integration**: Fall back to live API if user not found in cached leaderboard.json
- **Advanced caching**: Implement per-user cache invalidation when leaderboard updates