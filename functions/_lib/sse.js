// Server-Sent Events writer for the report-generation stream.
//
// Framing rules come from docs/notes/report-sse-api-contract.md:
//   - every application event carries a named `event:` field
//   - each `data:` payload is exactly one JSON object on one line
//   - heartbeat is an SSE comment (`: ping`)
//
// Writes are serialized through a promise chain so the scan loop and the
// heartbeat timer can never interleave half-written frames.

export function createSseWriter() {
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    let closed = false;
    let chain = Promise.resolve();

    function enqueue(text) {
        if (closed) return Promise.resolve();
        chain = chain
            .then(() => (closed ? undefined : writer.write(encoder.encode(text))))
            .catch(() => {
                // A failed write means the client went away; the writer's
                // close() below settles the stream. Swallow so the scan loop
                // (running under waitUntil) is not taken down by a disconnect.
            });
        return chain;
    }

    return {
        readable: stream.readable,

        event(name, data) {
            // JSON.stringify never emits raw newlines, so the payload is
            // always a single `data:` line — a contract requirement.
            return enqueue(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        },

        comment(text) {
            return enqueue(`: ${text}\n\n`);
        },

        async close() {
            if (closed) return;
            // Flush first, then mark closed: marking early would make the
            // pending-write guard in enqueue() drop the final frame — the
            // terminal event must reach the wire.
            await chain;
            closed = true;
            try {
                await writer.close();
            } catch {
                // already detached
            }
        },

        isClosed() {
            return closed;
        },
    };
}

// Emits `: ping` comments on an interval so proxies keep the stream alive
// while the scanner is between application events. Returns a stop() function
// that must be called when the stream terminates.
export function startHeartbeat(writer, intervalMs) {
    let timer = null;

    function tick() {
        if (writer.isClosed()) return;
        writer.comment('ping');
        timer = setTimeout(tick, intervalMs);
    }

    timer = setTimeout(tick, intervalMs);

    return function stop() {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
}
