// GET /leaderboard.json — the leaderboard payload from the API origin
// (scripts/refresh-leaderboard.sh fetches this URL). Same artifact the
// static site serves, plus CORS so the frontend origins can read it.

import { apiRoute, fetchAsset, jsonResponse } from './_lib/api.js';
import { corsHeaders } from './_lib/cors.js';

export const onRequest = apiRoute(async (context) => {
    const response = await fetchAsset(context, '/leaderboard.json');
    if (!response.ok) {
        return jsonResponse({ detail: 'leaderboard data unavailable' }, 503, context.request, context.env);
    }

    return new Response(response.body, {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=60, s-maxage=60',
            ...corsHeaders(context.request, context.env),
        },
    });
});
