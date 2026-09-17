// Cross-origin configuration for the API surface.
//
// The static frontend is served from vibecodeleaderboard.com / www while the
// API answers on api.vibecodeleaderboard.com, so every API response the
// browser touches (HEAD /health, the SSE stream, the report trigger POST,
// profile fallbacks) is cross-origin and needs these headers. The report
// POST sends `Content-Type: application/json`, which is not a
// CORS-safelisted content type, so preflight OPTIONS is answered too.

const DEFAULT_ALLOWED_ORIGINS = [
    'https://vibecodeleaderboard.com',
    'https://www.vibecodeleaderboard.com',
    // Local development frontends (static server and `wrangler pages dev`).
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:8788',
    'http://127.0.0.1:8788',
];

export function allowedOrigins(env) {
    const configured = typeof env?.ALLOWED_ORIGINS === 'string' ? env.ALLOWED_ORIGINS : '';
    const parsed = configured
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
    return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_ORIGINS;
}

export function corsHeaders(request, env) {
    const headers = {
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    };

    const requested = request.headers.get('access-control-request-headers');
    if (requested) {
        const merged = new Set(['Content-Type', ...requested.split(',').map((h) => h.trim()).filter(Boolean)]);
        headers['Access-Control-Allow-Headers'] = [...merged].join(', ');
    }

    const origin = request.headers.get('Origin');
    if (origin && allowedOrigins(env).includes(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
    }

    return headers;
}

export function preflightResponse(request, env) {
    return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
    });
}
