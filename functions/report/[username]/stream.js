// GET /report/{username}/stream — SSE progress stream for report generation.
//
// The stream is a passive view over a job that runs under waitUntil: it
// replays the job's event log, then follows live events to the terminal
// `complete`/`error`. Because the snapshot below and the subscribe happen
// in the same synchronous block, no event can be lost or duplicated between
// them; events arriving while the snapshot is being written are buffered by
// the relay and flushed in order afterwards.

import { apiRoute, jsonResponse, usernameFromRequest } from '../../_lib/api.js';
import { corsHeaders } from '../../_lib/cors.js';
import { getOrCreateReportJob } from '../../_lib/jobs.js';
import { createSseWriter, startHeartbeat } from '../../_lib/sse.js';

const PING_INTERVAL_MS_DEFAULT = 5000;

export const onRequest = apiRoute(async (context, url) => {
    if (context.request.method !== 'GET') {
        return jsonResponse({ detail: 'Method not allowed' }, 405, context.request, context.env);
    }

    const username = usernameFromRequest(context, url);
    if (!username) {
        return jsonResponse({ detail: 'valid username required' }, 400, context.request, context.env);
    }

    const job = await getOrCreateReportJob(context, username);

    const writer = createSseWriter();
    const pingIntervalMs = Number(context.env?.REPORT_PING_INTERVAL_MS) || PING_INTERVAL_MS_DEFAULT;
    const stopHeartbeat = startHeartbeat(writer, pingIntervalMs);

    let live = false;
    let sawTerminal = false;
    let cleanupDone = false;
    const pending = [];

    function finish() {
        if (cleanupDone) return;
        cleanupDone = true;
        stopHeartbeat();
        job.unsubscribe(relay);
        writer.close();
    }

    function relay(name, data) {
        if (cleanupDone) return;
        if (!live) {
            pending.push([name, data]);
            return;
        }
        writer.event(name, data);
        if (isTerminalEvent(name)) finish();
    }

    // Contract: `complete`/`error` are terminal — the client closes on
    // receiving either, and so does this server.
    function isTerminalEvent(name) {
        return name === 'complete' || name === 'error';
    }

    const snapshot = job.events.slice();
    job.subscribe(relay);

    for (const event of snapshot) {
        writer.event(event.name, event.data);
        if (isTerminalEvent(event.name)) sawTerminal = true;
    }

    if (sawTerminal || job.isTerminal()) {
        finish();
    } else {
        live = true;
        for (const [name, data] of pending) {
            writer.event(name, data);
            if (isTerminalEvent(name)) {
                finish();
                break;
            }
        }
    }

    context.request.signal?.addEventListener('abort', finish);

    return new Response(writer.readable, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
            ...corsHeaders(context.request, context.env),
        },
    });
});
