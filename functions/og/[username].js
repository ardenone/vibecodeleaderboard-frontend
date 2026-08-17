import {
  escapeHtml,
  fetchAsset,
  getRouteUsername,
  loadUserData,
} from '../u/[username].js';

// Generates a lightweight, cacheable per-user image for og:image. Keeping the
// image self-contained avoids a dependency on the not-yet-live API service.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const username = getRouteUsername({
    ...context,
    params: { username: context.params?.username },
  }, url);

  if (!username) {
    return new Response('Image not found', { status: 404 });
  }

  const userData = await loadUserData(context, username);
  const svg = renderOGImage(username, userData);

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=UTF-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}

export function renderOGImage(username, userData) {
  const displayUsername = userData?.username || username;
  const rank = userData ? `#${userData.rank}` : 'Not ranked';
  const stats = userData
    ? `${formatNumber(userData.commit_count)} AI-assisted commits  •  ${formatNumber(userData.unique_repos)} repos`
    : 'Check the Vibe Code Leaderboard to see the current rankings';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title description">
  <title id="title">${escapeHtml(displayUsername)} - Vibe Code Leaderboard</title>
  <desc id="description">${escapeHtml(stats)}</desc>
  <rect width="1200" height="630" fill="#0f172a"/>
  <circle cx="1080" cy="80" r="250" fill="#312e81" opacity="0.7"/>
  <circle cx="80" cy="590" r="220" fill="#164e63" opacity="0.65"/>
  <text x="90" y="125" fill="#a5b4fc" font-family="Arial, sans-serif" font-size="32" font-weight="700">VIBE CODE LEADERBOARD</text>
  <text x="90" y="285" fill="#f8fafc" font-family="Arial, sans-serif" font-size="76" font-weight="700">${escapeHtml(displayUsername)}</text>
  <text x="90" y="375" fill="#c4b5fd" font-family="Arial, sans-serif" font-size="56" font-weight="700">${escapeHtml(rank)}</text>
  <text x="90" y="475" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="32">${escapeHtml(stats)}</text>
</svg>`;
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-US') : '0';
}
