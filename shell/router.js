'use strict';
// filebridge://app/ request router, registered with protocol.handle in main.js. Replaces the
// Bedrock Panel host's loopback HTTP server, in-process and with no socket:
//   /index.html, /app.js          the page (allowlisted files only)
//   /app-api/<action>             server.js handle(action, {query, body, oauth})
//   /app-host/pick-folder         native folder picker ({ok, path} | {ok:false, canceled})
// Only the default session has the scheme, so web-drop sign-in windows (their own partitions)
// can never reach the API.

const fs = require('fs');
const path = require('path');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
const STATIC = {
  '/index.html': 'text/html; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

function createRouter({ root, getServer, oauth, pickFolder, log = () => {} }) {
  return async function route(request) {
    let url;
    try { url = new URL(request.url); } catch { return new Response('Not found', { status: 404 }); }
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const p = url.pathname;

    if (STATIC[p]) {
      const body = await fs.promises.readFile(path.join(root, p.slice(1)));
      return new Response(body, { headers: { 'Content-Type': STATIC[p], 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP } });
    }

    const body = request.method === 'POST' ? Buffer.from(await request.arrayBuffer()) : null;

    const m = /^\/app-api\/([A-Za-z0-9_]{1,40})$/.exec(p);
    if (m) {
      try {
        const query = Object.fromEntries(url.searchParams);
        return json(await getServer().handle(m[1], { query, body, oauth }));
      } catch (e) {
        log('[api] ' + m[1] + ' failed: ' + (e && e.stack || e));
        return json({ ok: false, error: (e && e.message) || String(e) }, 500);
      }
    }

    if (p === '/app-host/pick-folder' && request.method === 'POST') {
      let defaultPath = '';
      try { defaultPath = String(JSON.parse(body.toString('utf8') || '{}').defaultPath || ''); } catch {}
      try { return json(await pickFolder(defaultPath)); }
      catch (e) { return json({ ok: false, error: (e && e.message) || String(e) }); }
    }

    return new Response('Not found', { status: 404 });
  };
}

module.exports = { createRouter, CSP };
