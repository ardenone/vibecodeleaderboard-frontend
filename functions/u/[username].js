// Cloudflare Pages Function for user profile pages with server-side Open Graph tags
// This function intercepts /u/[username] requests and injects proper OG tags for social media crawlers

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const username = url.pathname.split('/').pop();

  try {
    // Try to load leaderboard data to find user information
    let userData = null;
    try {
      // In Cloudflare Pages, we can access files from the project root
      const leaderboardUrl = new URL('/leaderboard.json', url.origin);
      const leaderboardResponse = await fetch(leaderboardUrl.toString());

      if (leaderboardResponse.ok) {
        const leaderboardData = await leaderboardResponse.json();
        userData = leaderboardData.rankings.find(
          user => user.username.toLowerCase() === username.toLowerCase()
        );
      }
    } catch (error) {
      console.error('Error loading leaderboard data:', error);
      // Continue with default tags if leaderboard data fails to load
    }

    // Load the user.html template
    const templateUrl = new URL('/user.html', url.origin);
    const templateResponse = await fetch(templateUrl.toString());

    if (!templateResponse.ok) {
      return new Response('Template not found', { status: 404 });
    }

    let html = await templateResponse.text();

    // Generate OG meta tags based on user data
    const ogTags = generateOGMetaTags(username, userData, url);

    // Replace the static OG tags in the HTML template
    html = injectOGTags(html, ogTags, userData, url);

    // Return the modified HTML with proper content type
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
      }
    });

  } catch (error) {
    console.error('Error in user profile function:', error);

    // On error, serve the original template (which has client-side fallback)
    try {
      const templateUrl = new URL('/user.html', url.origin);
      const templateResponse = await fetch(templateUrl.toString());
      const html = await templateResponse.text();

      return new Response(html, {
        headers: {
          'Content-Type': 'text/html;charset=UTF-8',
          'Cache-Control': 'public, max-age=60'
        }
      });
    } catch (fallbackError) {
      return new Response('Error loading profile', { status: 500 });
    }
  }
}

function generateOGMetaTags(username, userData, url) {
  if (!userData) {
    // User not found or data unavailable - use generic tags
    return {
      title: `${username} - Vibe Code Leaderboard`,
      description: `${username} is not yet on the Vibe Code Leaderboard. Check the full leaderboard to see top AI-assisted developers.`,
      image: 'https://vibecodeleaderboard.com/og-image.png',
      url: url.href
    };
  }

  // User found - generate personalized tags
  const description = `${userData.username} has ${userData.commit_count.toLocaleString()} AI-assisted commits across ${userData.unique_repos} repos. Ranked #${userData.rank} on the Vibe Code Leaderboard.`;

  return {
    title: `#${userData.rank} ${userData.username} - Vibe Code Leaderboard`,
    description: description,
    image: generateOGImageUrl(userData),
    url: url.href
  };
}

function injectOGTags(html, ogTags, userData, url) {
  // Helper function to replace or add meta tags
  const replaceOrAddMeta = (content, property, name, contentValue) => {
    const regex = new RegExp(`<meta[^>]*property=["']${property}["'][^>]*>`, 'i');
    const regexName = new RegExp(`<meta[^>]*name=["']${name}["'][^>]*>`, 'i');

    const replacement = property
      ? `<meta property="${property}" content="${contentValue}">`
      : `<meta name="${name}" content="${contentValue}">`;

    // Try to replace existing property tag
    if (property && regex.test(content)) {
      return content.replace(regex, replacement);
    }
    // Try to replace existing name tag
    else if (name && regexName.test(content)) {
      return content.replace(regexName, replacement);
    }
    // If neither exists, add after the existing meta tags
    else {
      const metaInsertionPoint = content.indexOf('</head>');
      if (metaInsertionPoint !== -1) {
        return content.slice(0, metaInsertionPoint) + replacement + '\n    ' + content.slice(metaInsertionPoint);
      }
      return content;
    }
  };

  // Replace title
  html = html.replace(
    /<title>.*?<\/title>/i,
    `<title>${ogTags.title}</title>`
  );

  // Replace OG meta tags
  html = replaceOrAddMeta(html, 'og:title', null, ogTags.title);
  html = replaceOrAddMeta(html, 'og:description', null, ogTags.description);
  html = replaceOrAddMeta(html, 'og:image', null, ogTags.image);
  html = replaceOrAddMeta(html, 'og:url', null, ogTags.url);

  // Replace Twitter meta tags
  html = replaceOrAddMeta(html, null, 'twitter:title', ogTags.title);
  html = replaceOrAddMeta(html, null, 'twitter:description', ogTags.description);
  html = replaceOrAddMeta(html, null, 'twitter:image', ogTags.image);

  // Replace canonical link
  const canonicalRegex = /<link[^>]*rel=["']canonical["'][^>]*>/i;
  if (canonicalRegex.test(html)) {
    html = html.replace(
      canonicalRegex,
      `<link rel="canonical" href="${ogTags.url}">`
    );
  } else {
    const metaInsertionPoint = html.indexOf('</head>');
    if (metaInsertionPoint !== -1) {
      html = html.slice(0, metaInsertionPoint) + `    <link rel="canonical" href="${ogTags.url}">\n    ` + html.slice(metaInsertionPoint);
    }
  }

  return html;
}

function generateOGImageUrl(userData) {
  // For now, return the default OG image
  // In the future, this could generate dynamic images or use a service
  // https://api.vibecodeleaderboard.com/og/${userData.username}.png
  return 'https://vibecodeleaderboard.com/og-image.png';
}