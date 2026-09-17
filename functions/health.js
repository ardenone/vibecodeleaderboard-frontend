// HEAD/GET /health — reachability pre-check. The client gives the API 2
// seconds (AbortController) before declaring the feature unavailable, so
// this answers instantly and touches nothing.

import { apiRoute, jsonResponse } from './_lib/api.js';

export const onRequest = apiRoute(async (context) => {
    return jsonResponse(
        { status: 'ok', service: 'vibecodeleaderboard-api' },
        200,
        context.request,
        context.env
    );
});
