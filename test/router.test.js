'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createRouter } = require('../shell/router');

const ROOT = path.join(__dirname, '..');
const req = (url, init) => new Request(url, init);

function setup(handle) {
  const calls = [];
  const picks = [];
  const oauth = { marker: true };
  const route = createRouter({
    root: ROOT,
    getServer: () => ({ handle: async (action, ctx) => { calls.push({ action, ctx }); return handle ? handle(action, ctx) : { ok: true, action }; } }),
    oauth,
    pickFolder: async p => { picks.push(p); return { ok: true, path: 'D:\\picked' }; },
  });
  return { route, calls, picks, oauth };
}

test('serves only the allowlisted page files, with the CSP', async () => {
  const { route } = setup();
  const r = await route(req('filebridge://app/index.html?_surface=window'));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await route(req('filebridge://app/app.js'))).status, 200);
  for (const p of ['server.js', 'main.js', 'shell/oauth.js', '../package.json', '%2e%2e/package.json', 'oauth.json']) {
    assert.equal((await route(req('filebridge://app/' + p))).status, 404, p);
  }
  assert.equal((await route(req('filebridge://evil/index.html'))).status, 404);
});

test('routes /app-api/<action> to handle() with query, body and the oauth bridge', async () => {
  const { route, calls, oauth } = setup();
  const r = await route(req('filebridge://app/app-api/result?id=j1'));
  assert.deepEqual(await r.json(), { ok: true, action: 'result' });
  assert.equal(calls[0].ctx.query.id, 'j1');
  assert.equal(calls[0].ctx.body, null);
  assert.equal(calls[0].ctx.oauth, oauth);

  await route(req('filebridge://app/app-api/save', { method: 'POST', body: JSON.stringify({ job: { name: 'x' } }) }));
  assert.deepEqual(JSON.parse(calls[1].ctx.body.toString('utf8')), { job: { name: 'x' } });

  assert.equal((await route(req('filebridge://app/app-api/bad.action'))).status, 404);
  assert.equal((await route(req('filebridge://app/app-api/a/b'))).status, 404);
});

test('a throwing action returns a JSON error, not a crash', async () => {
  const { route } = setup(() => { throw new Error('boom'); });
  const r = await route(req('filebridge://app/app-api/list'));
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { ok: false, error: 'boom' });
});

test('pick-folder hands the default path to the native picker', async () => {
  const { route, picks } = setup();
  const r = await route(req('filebridge://app/app-host/pick-folder', { method: 'POST', body: JSON.stringify({ defaultPath: 'C:\\src' }) }));
  assert.deepEqual(await r.json(), { ok: true, path: 'D:\\picked' });
  assert.deepEqual(picks, ['C:\\src']);
  assert.equal((await route(req('filebridge://app/app-host/pick-folder'))).status, 404); // GET is not a pick
});
