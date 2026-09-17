// Shared request handling for the API Pages Functions.
//
// Hostname gate: the API endpoints live at root paths (/health, /user/*,
// /report/*, /leaderboard.json) because the frontend's `js/config.js`
// derives the API origin as `https://api.<frontend-hostname>` and calls
// those paths directly. The same Pages project serves both the static site
// and the API (the `api.` subdomain is a custom domain on the project), so
// each API function decides per request whether it is talking to the API
// hostname or to a site hostname:
//
//   api.* hostnames            -> API behavior
//   localhost / 127.0.0.1 / [::1] -> API behavior (wrangler pages dev,
//                                    matching js/config.js's local carve-out)
//   anything else (apex, www)  -> fall through to static serving via
//                                 context.next(), leaving the site's behavior
//                                 byte-for-byte identical to a deployment
//                                 without functions on those paths.

import { corsHeaders, preflightResponse } from './cors.js';

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

export function isApiHostname(url) {
    const host = url.hostname.toLowerCase();
    return host.startsWith('api.') ||
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '[::1]';
}

export function jsonResponse(data, status, request, env, extraHeaders = {}) {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...corsHeaders(request, env),
        ...extraHeaders,
    };
    return new Response(JSON.stringify(data), { status, headers });
}

// Wraps an API handler with the hostname gate, CORS preflight, method
// filtering, HEAD body-stripping, and a last-resort 500 so a handler bug can
// never take down static paths.
export function apiRoute(handler) {
    return async (context) => {
        let apiRequest = false;
        try {
            apiRequest = isApiHostname(new URL(context.request.url));
        } catch {
            apiRequest = false;
        }

        if (!apiRequest) {
            return typeof context.next === 'function'
                ? context.next()
                : new Response('Not Found', { status: 404 });
        }

        const method = context.request.method;

        if (method === 'OPTIONS') {
            return preflightResponse(context.request, context.env);
        }

        if (!ALLOWED_METHODS.has(method)) {
            return jsonResponse(
                { detail: 'Method not allowed' },
                405,
                context.request,
                context.env,
                { Allow: 'GET, HEAD, POST, OPTIONS' }
            );
        }

        try {
            const response = await handler(context, new URL(context.request.url));
            if (method === 'HEAD') {
                return new Response(null, { status: response.status, headers: response.headers });
            }
            return response;
        } catch (error) {
            console.error('API handler error:', error?.stack || error);
            return jsonResponse({ detail: 'Internal server error' }, 500, context.request, context.env);
        }
    };
}

// Reads a static asset from the deployment via the Pages ASSETS binding.
// Kept separate from functions/u/[username].js's fetchAsset on purpose —
// that module is tracked, working code and this API has slightly different
// fallback needs.
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

// GitHub usernames: alphanumeric and hyphens, at most 39 chars. Validated
// before a username is used in a GitHub API path.
const USERNAME_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

export function normalizeUsername(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!USERNAME_PATTERN.test(value)) return null;
    return value;
}

// Route param first (what Pages provides), path fallback so the functions
// also work when invoked without routed params — same pattern as
// functions/u/[username].js's getRouteUsername.
export function usernameFromRequest(context, url = new URL(context.request.url)) {
    const fromRoute = context.params?.username;
    if (typeof fromRoute === 'string' && fromRoute.length > 0) {
        return normalizeUsername(fromRoute);
    }
    const fromPath = url.pathname.match(/^\/(?:user|report)\/([^/]+?)(?:\/stream)?\/?$/)?.[1] ?? '';
    return normalizeUsername(fromPath);
}
