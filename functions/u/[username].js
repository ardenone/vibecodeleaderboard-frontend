const SITE_NAME = 'Vibe Code Leaderboard';
const DEFAULT_IMAGE_PATH = '/og-image.png';

// Cloudflare Pages Function for /u/<username> profile pages. The HTML is
// rendered here because link-preview crawlers do not run js/profile.js.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const username = getRouteUsername(context, url);

  if (!username) {
    return new Response('User profile not found', { status: 404 });
  }

  try {
    const userData = await loadUserData(context, username);
    const templateResponse = await fetchAsset(context, '/user.html');

    if (!templateResponse.ok) {
      return new Response('Profile template not found', {
        status: templateResponse.status || 404,
      });
    }

    const metadata = generateOGMetaTags(username, userData, url);
    const html = injectOGTags(await templateResponse.text(), metadata);

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=UTF-8',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
      },
    });
  } catch (error) {
    console.error('Error rendering user profile:', error);

    // Keep the page usable if the leaderboard or HTML transform fails. The
    // unmodified template still lets the browser-side profile code recover.
    try {
      const fallback = await fetchAsset(context, '/user.html');
      return new Response(fallback.body, {
        status: fallback.status,
        headers: {
          'Content-Type': 'text/html; charset=UTF-8',
          'Cache-Control': 'public, max-age=60, s-maxage=60',
        },
      });
    } catch (fallbackError) {
      console.error('Error loading profile fallback:', fallbackError);
      return new Response('Error loading profile', { status: 500 });
    }
  }
}

// ASSETS is the Pages-provided binding for reading static files from the
// deployment. The context.next fallback keeps the function easy to exercise
// with a minimal test context and works with Pages' asset server as well.
export async function fetchAsset(context, path) {
  const assetUrl = new URL(path, context.request.url);

  if (context.env?.ASSETS?.fetch) {
    return context.env.ASSETS.fetch(assetUrl);
  }

  if (typeof context.next === 'function') {
    return context.next(new Request(assetUrl, context.request));
  }

  throw new Error('Cloudflare Pages ASSETS binding is unavailable');
}

export function getRouteUsername(context, url = new URL(context.request.url)) {
  const routeUsername = context.params?.username;
  const pathUsername = url.pathname.match(/^\/u\/([^/]+)\/?$/)?.[1];
  const encodedUsername = routeUsername || pathUsername || '';

  try {
    return decodeURIComponent(encodedUsername).trim();
  } catch {
    return '';
  }
}

export async function loadUserData(context, username) {
  try {
    const response = await fetchAsset(context, '/leaderboard.json');
    if (!response.ok) return null;

    const leaderboard = await response.json();
    if (!Array.isArray(leaderboard?.rankings)) return null;

    return leaderboard.rankings.find(
      user => typeof user?.username === 'string' &&
        user.username.toLowerCase() === username.toLowerCase()
    ) || null;
  } catch (error) {
    console.error('Error loading leaderboard data:', error);
    return null;
  }
}

export function generateOGMetaTags(username, userData, url) {
  const profileUrl = url.href;

  if (!userData) {
    return {
      title: `${username} - ${SITE_NAME}`,
      description: `${username} is not yet on the ${SITE_NAME}. Check the full leaderboard to see top AI-assisted developers.`,
      image: new URL(DEFAULT_IMAGE_PATH, url).href,
      imageType: 'image/png',
      imageAlt: SITE_NAME,
      url: profileUrl,
    };
  }

  const displayUsername = String(userData.username);
  const description = `${displayUsername} has ${formatNumber(userData.commit_count)} AI-assisted commits across ${formatNumber(userData.unique_repos)} repos. Ranked #${userData.rank} on the ${SITE_NAME}.`;

  return {
    title: `#${userData.rank} ${displayUsername} - ${SITE_NAME}`,
    description,
    image: generateOGImageUrl(userData, url),
    imageType: 'image/svg+xml',
    imageAlt: `${displayUsername}'s ${SITE_NAME} profile`,
    url: profileUrl,
  };
}

export function generateOGImageUrl(userData, url) {
  if (!userData?.username) {
    return new URL(DEFAULT_IMAGE_PATH, url).href;
  }

  return new URL(`/og/${encodeURIComponent(userData.username)}`, url).href;
}

export function injectOGTags(html, ogTags) {
  const tags = [
    ['property', 'og:title', ogTags.title],
    ['property', 'og:description', ogTags.description],
    ['property', 'og:image', ogTags.image],
    ['property', 'og:image:type', ogTags.imageType],
    ['property', 'og:image:alt', ogTags.imageAlt],
    ['property', 'og:image:width', '1200'],
    ['property', 'og:image:height', '630'],
    ['property', 'og:url', ogTags.url],
    ['name', 'description', ogTags.description],
    ['name', 'twitter:title', ogTags.title],
    ['name', 'twitter:description', ogTags.description],
    ['name', 'twitter:image', ogTags.image],
    ['name', 'twitter:image:alt', ogTags.imageAlt],
  ];

  let output = html.replace(
    /<title>.*?<\/title>/is,
    `<title>${escapeHtml(ogTags.title)}</title>`
  );

  for (const [attribute, value, content] of tags) {
    output = replaceOrAddMeta(output, attribute, value, content);
  }

  const canonical = `<link rel="canonical" href="${escapeHtml(ogTags.url)}">`;
  const canonicalPattern = /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i;
  if (canonicalPattern.test(output)) {
    output = output.replace(canonicalPattern, canonical);
  } else {
    output = insertBeforeHeadClose(output, canonical);
  }

  return output;
}

function replaceOrAddMeta(html, attribute, value, content) {
  const escapedValue = escapeHtml(value);
  const escapedContent = escapeHtml(content);
  const pattern = new RegExp(
    `<meta\\b[^>]*\\b${attribute}\\s*=\\s*["']${escapeRegExp(value)}["'][^>]*>`,
    'i'
  );
  const replacement = `<meta ${attribute}="${escapedValue}" content="${escapedContent}">`;

  if (pattern.test(html)) {
    return html.replace(pattern, replacement);
  }

  return insertBeforeHeadClose(html, replacement);
}

function insertBeforeHeadClose(html, value) {
  return html.replace(/<\/head\s*>/i, `${value}\n    $&`);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-US') : '0';
}
