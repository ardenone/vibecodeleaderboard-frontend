/**
 * Runtime-free tests for the Pages Function's metadata transformation.
 * Run with: node --experimental-default-type=module functions/test-og-injection.js
 */

import assert from 'node:assert/strict';
import {
  generateOGMetaTags,
  generateOGImageUrl,
  injectOGTags,
  onRequest,
} from './u/[username].js';

const template = `<!DOCTYPE html>
<html><head>
  <title>Loading... - Vibe Code Leaderboard</title>
  <meta name="description" content="generic">
  <meta property="og:title" content="Vibe Code Leaderboard">
  <meta property="og:description" content="generic">
  <meta property="og:image" content="https://vibecodeleaderboard.com/og-image.png">
  <meta property="og:url" content="">
  <meta name="twitter:title" content="generic">
  <meta name="twitter:description" content="generic">
  <meta name="twitter:image" content="https://vibecodeleaderboard.com/og-image.png">
  <link rel="canonical" href="">
</head><body></body></html>`;

const user = {
  rank: 1,
  username: 'testuser090',
  commit_count: 497,
  unique_repos: 5,
};

function assetContext(username) {
  return {
    request: new Request(`https://vibecodeleaderboard.com/u/${username}`),
    params: { username },
    env: {
      ASSETS: {
        fetch(input) {
          const path = new URL(input).pathname;
          if (path === '/leaderboard.json') {
            return Promise.resolve(new Response(JSON.stringify({ rankings: [user] })));
          }
          if (path === '/user.html') {
            return Promise.resolve(new Response(template));
          }
          return Promise.resolve(new Response('Not found', { status: 404 }));
        },
      },
    },
  };
}

async function runTests() {
  const url = new URL('https://vibecodeleaderboard.com/u/testuser090');
  const metadata = generateOGMetaTags('testuser090', user, url);
  assert.equal(metadata.title, '#1 testuser090 - Vibe Code Leaderboard');
  assert.match(metadata.description, /497 AI-assisted commits across 5 repos/);
  assert.equal(metadata.image, 'https://vibecodeleaderboard.com/og/testuser090');
  assert.notEqual(generateOGImageUrl(user, url), 'https://vibecodeleaderboard.com/og-image.png');

  const rendered = injectOGTags(template, metadata);
  assert.match(rendered, /<title>#1 testuser090 - Vibe Code Leaderboard<\/title>/);
  assert.match(rendered, /property="og:title" content="#1 testuser090 - Vibe Code Leaderboard"/);
  assert.match(rendered, /property="og:image" content="https:\/\/vibecodeleaderboard\.com\/og\/testuser090"/);
  assert.match(rendered, /name="description" content="testuser090 has 497 AI-assisted commits/);
  assert.match(rendered, /rel="canonical" href="https:\/\/vibecodeleaderboard\.com\/u\/testuser090"/);

  const escaped = injectOGTags(template, generateOGMetaTags('a&b', {
    ...user,
    username: 'a&b',
  }, new URL('https://vibecodeleaderboard.com/u/a%26b')));
  assert.match(escaped, /a&amp;b/);
  assert.doesNotMatch(escaped, /content="[^"]*a&b/);

  const fallback = generateOGMetaTags('unknownuser', null, url);
  assert.equal(fallback.image, 'https://vibecodeleaderboard.com/og-image.png');
  assert.equal(fallback.imageType, 'image/png');

  const response = await onRequest(assetContext('testuser090'));
  const responseHtml = await response.text();
  assert.equal(response.status, 200);
  assert.match(responseHtml, /og:title" content="#1 testuser090/);
  assert.match(response.headers.get('content-type'), /text\/html/i);

  console.log('Open Graph injection tests passed.');
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
