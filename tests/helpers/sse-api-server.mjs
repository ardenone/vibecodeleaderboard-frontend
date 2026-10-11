import http from 'node:http';

// A live, local SSE socket lets the browser observe every progress state. The
// test releases one event at a time, so assertions do not depend on a delay
// between server writes or on browser rendering speed.
export async function createSseApiServer() {
  let pendingEvents;
  let activeStream;
  let lastStream;
  let streamReady;
  let resolveStreamReady;
  let triggerReady;
  let resolveTriggerReady;

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, HEAD, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (pathname === '/health') {
      res.writeHead(200, cors);
      res.end();
      return;
    }
    if (req.method === 'POST' && /^\/report\/[^/]+$/.test(pathname)) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end('{}');
      resolveTriggerReady?.(pathname);
      return;
    }
    if (req.method === 'GET' && /^\/report\/[^/]+\/stream$/.test(pathname)) {
      if (!pendingEvents || activeStream) {
        res.writeHead(409, cors);
        res.end('unexpected stream');
        return;
      }

      res.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      res.flushHeaders();

      let resolveClosed;
      const closed = new Promise((resolve) => { resolveClosed = resolve; });
      const stream = { res, events: pendingEvents, closed };
      pendingEvents = undefined;
      activeStream = lastStream = stream;
      res.on('close', () => {
        if (activeStream === stream) activeStream = undefined;
        resolveClosed();
      });
      resolveStreamReady();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  function withinTenSeconds(promise, action) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${action}`)), 10_000);
      promise.then(
        (value) => { clearTimeout(timeout); resolve(value); },
        (error) => { clearTimeout(timeout); reject(error); },
      );
    });
  }

  return {
    origin: `http://localhost:${server.address().port}`,
    play(events) {
      if (pendingEvents || activeStream) throw new Error('An SSE script is already active');
      pendingEvents = [...events];
      streamReady = new Promise((resolve) => { resolveStreamReady = resolve; });
      triggerReady = new Promise((resolve) => { resolveTriggerReady = resolve; });
    },
    waitForTrigger() {
      if (!triggerReady) throw new Error('Call play() before waiting for a report trigger');
      return withinTenSeconds(triggerReady, 'the report POST');
    },
    waitForStream() {
      if (!streamReady) throw new Error('Call play() before waiting for a stream');
      return withinTenSeconds(streamReady, 'the report stream');
    },
    sendNext() {
      if (!activeStream) throw new Error('No active report stream');
      const next = activeStream.events.shift();
      if (!next) throw new Error('No scripted SSE events remain');
      activeStream.res.write(`event: ${next.event}\ndata: ${JSON.stringify(next.data)}\n\n`);
    },
    waitForDisconnect() {
      if (!lastStream) throw new Error('No report stream has connected');
      return withinTenSeconds(lastStream.closed, 'the browser to close the report stream');
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
