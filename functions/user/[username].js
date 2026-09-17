// GET /user/{username} — profile-page fallback lookup for users missing
// from the baked-in leaderboard.json. Served from the deployment's own
// leaderboard artifact (the "cache"); 404 keeps its distinct "User Not
// Found" meaning per the contract, 503 means the data itself is unreadable.

import { apiRoute, jsonResponse, usernameFromRequest } from '../_lib/api.js';
import { findByUsername, loadLeaderboard, toUserPayload } from '../_lib/leaderboard.js';

export const onRequest = apiRoute(async (context, url) => {
    if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
        return jsonResponse({ detail: 'Method not allowed' }, 405, context.request, context.env);
    }

    const username = usernameFromRequest(context, url);
    if (!username) {
        return jsonResponse({ detail: 'valid username required' }, 400, context.request, context.env);
    }

    const leaderboardData = await loadLeaderboard(context);
    if (!leaderboardData) {
        return jsonResponse({ detail: 'leaderboard cache unavailable' }, 503, context.request, context.env);
    }

    const entry = findByUsername(leaderboardData.rankings, username);
    if (!entry) {
        return jsonResponse(
            { detail: `User '${username}' not found` },
            404,
            context.request,
            context.env
        );
    }

    return jsonResponse(
        toUserPayload(entry, leaderboardData.rankings.length, leaderboardData.generated_at),
        200,
        context.request,
        context.env
    );
});
