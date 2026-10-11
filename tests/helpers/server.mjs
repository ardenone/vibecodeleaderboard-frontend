import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
};

async function serveAsset(res, rootRelativePath) {
  const absolute = path.join(REPO_ROOT, rootRelativePath);
  if (!absolute.startsWith(REPO_ROOT + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const body = await readFile(absolute);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(absolute)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

// Serves the site the way production routes it: the app shell at /,
// /u/<username> rewritten to user.html (mirroring the _redirects fallback
// for the Pages Function), the leaderboard payload from the fixture under
// test, and static assets from the repo root. Assets are also served
// beneath /u/ because user.html links them relatively, so a profile at
// /u/alice resolves css/style.css to /u/css/style.css.
export async function createSiteServer({ leaderboard }) {
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');

      if (pathname === '/leaderboard.json') {
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
        res.end(JSON.stringify(leaderboard));
        return;
      }
      if (pathname === '/' || pathname === '/index.html') {
        await serveAsset(res, 'index.html');
        return;
      }
      if (/^\/u\/[^/]+\/?$/.test(pathname)) {
        await serveAsset(res, 'user.html');
        return;
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      const underProfile = pathname.match(/^\/u(\/(?:css|js)\/.+)$/);
      const assetPath = underProfile ? underProfile[1] : pathname;
      if (assetPath.startsWith('/js/') || assetPath.startsWith('/css/') || assetPath === '/og-image.png') {
        await serveAsset(res, assetPath.slice(1));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  return {
    port,
    url: `http://localhost:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
