// /report/{username} — trigger generation (POST) and fetch a cached report
// (GET). The POST's response body is never read by the client (results
// arrive on the stream), so it stays cheap: it validates the username,
// makes sure a job exists, and returns immediately.

import { apiRoute, jsonResponse, usernameFromRequest } from '../_lib/api.js';
import { getCachedReport, getJob, getOrCreateReportJob } from '../_lib/jobs.js';

export const onRequest = apiRoute(async (context, url) => {
    const username = usernameFromRequest(context, url);
    if (!username) {
        return jsonResponse({ detail: 'valid username required' }, 400, context.request, context.env);
    }

    if (context.request.method === 'POST') {
        const job = await getOrCreateReportJob(context, username);
        return jsonResponse(
            { status: job.isTerminal() ? job.status : 'queued', username },
            202,
            context.request,
            context.env
        );
    }

    // GET — cached report if one exists, progress indicator if a job is
    // running, otherwise a plain 404.
    const report = await getCachedReport(username, context.env);
    if (report) {
        return jsonResponse(report, 200, context.request, context.env);
    }

    const job = getJob(username);
    if (job && !job.isTerminal()) {
        return jsonResponse({ status: 'running', username }, 202, context.request, context.env);
    }

    return jsonResponse(
        { detail: `Report for '${username}' not found - POST to this endpoint to generate it` },
        404,
        context.request,
        context.env
    );
});
