'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { DriveAuth } = require('../shell/oauth');
const dpapi = require('../shell/dpapi');

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-oauth-'));
  const file = path.join(dir, 'oauth.json');
  const opened = [];
  const posts = [];
  let clock = 1_000_000;
  const responses = opts.responses || [];
  const auth = new DriveAuth({
    file,
    openExternal: async url => { opened.push(url); return true; },
    // A response is a token body, { status, body } for an HTTP error, or a function (may throw / await).
    fetchImpl: async (url, init) => {
      posts.push({ url, body: Object.fromEntries(new URLSearchParams(init.body.toString())) });
      let next = responses.shift() || { access_token: 'AT', expires_in: 3600, refresh_token: 'RT', scope: SCOPE };
      if (typeof next === 'function') next = await next();
      if (next && next.status) return { ok: false, status: next.status, statusText: 'ERR', text: async () => JSON.stringify(next.body || {}) };
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(next) };
    },
    now: () => clock,
    signInTimeoutMs: opts.signInTimeoutMs || 60000,
    retryDelaysMs: [10, 10],
  });
  return { auth, file, opened, posts, tick: ms => { clock += ms; } };
}

const get = url => new Promise((resolve, reject) => {
  http.get(url, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});
const listening = port => new Promise(resolve => {
  const s = http.get('http://127.0.0.1:' + port + '/nope', () => resolve(true));
  s.on('error', () => resolve(false));
});

test('the DPAPI binding is built', () => { assert.ok(dpapi.available(), 'run node build-dpapi.js'); });

test('connect needs a client ID', async () => {
  const { auth } = setup();
  await assert.rejects(() => auth.connect([SCOPE]), /client ID is required/);
});

test('full sign-in: ephemeral loopback port, PKCE, token stored encrypted, listener closed', async () => {
  const { auth, file, opened, posts } = setup();
  await auth.connect([SCOPE], { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' });
  const authUrl = new URL(opened[0]);
  const redirect = new URL(authUrl.searchParams.get('redirect_uri'));
  assert.equal(redirect.hostname, '127.0.0.1');
  assert.notEqual(redirect.port, '5173');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('scope'), SCOPE);
  assert.ok(await listening(redirect.port), 'callback listener is open during sign-in');

  const r = await get(redirect.href + '?state=' + encodeURIComponent(authUrl.searchParams.get('state')) + '&code=CODE');
  assert.equal(r.status, 200);
  assert.equal(posts[0].body.grant_type, 'authorization_code');
  assert.equal(posts[0].body.redirect_uri, redirect.href);
  assert.equal(posts[0].body.client_secret, 'GOCSPX-secret');
  assert.ok(posts[0].body.code_verifier);

  const st = auth.status();
  assert.equal(st.configured, true);
  assert.equal(st.connected, true);
  const raw = fs.readFileSync(file, 'utf8');
  for (const secret of ['GOCSPX-secret', 'AT', 'RT']) assert.ok(!raw.includes('"' + secret) && !raw.includes(secret + '"'), secret + ' is not stored in plain text');
  await new Promise(res => setTimeout(res, 50));
  assert.equal(await listening(redirect.port), false, 'listener closes after the callback');
});

test('an unknown state is refused', async () => {
  const { auth, opened } = setup();
  await auth.connect([SCOPE], { clientId: 'cid', clientSecret: 's' });
  const redirect = new URL(new URL(opened[0]).searchParams.get('redirect_uri'));
  const r = await get(redirect.href + '?state=forged&code=CODE');
  assert.equal(r.status, 400);
  assert.equal(auth.status().connected, false);
  auth.stop();
});

test('the listener closes when a sign-in times out', async () => {
  const { auth, opened } = setup({ signInTimeoutMs: 100 });
  await auth.connect([SCOPE], { clientId: 'cid', clientSecret: 's' });
  const port = new URL(new URL(opened[0]).searchParams.get('redirect_uri')).port;
  await new Promise(res => setTimeout(res, 250));
  assert.equal(await listening(port), false);
});

test('getAccessToken: cached while valid, refreshed when near expiry (no redirect_uri)', async () => {
  const { auth, posts, tick } = setup({ responses: [
    { access_token: 'AT1', expires_in: 3600, refresh_token: 'RT', scope: SCOPE },
    { access_token: 'AT2', expires_in: 3600, scope: SCOPE },
  ] });
  auth.setClient('cid', 'sec');
  auth.setTokens(auth.normalize(await auth.fetchToken({}), [SCOPE]));
  posts.length = 0;
  assert.equal((await auth.getAccessToken([SCOPE])).accessToken, 'AT1');
  assert.equal(posts.length, 0);
  tick(3600 * 1000);
  assert.equal((await auth.getAccessToken([SCOPE])).accessToken, 'AT2');
  assert.equal(posts[0].body.grant_type, 'refresh_token');
  assert.equal(posts[0].body.refresh_token, 'RT');
  assert.equal(posts[0].body.redirect_uri, undefined);
  assert.equal(auth.tokens().refreshToken, 'RT', 'keeps the refresh token Google did not resend');
});

test('a missing scope needs consent', async () => {
  const { auth } = setup();
  auth.setClient('cid', 'sec');
  auth.setTokens({ accessToken: 'A', refreshToken: 'R', expiresAt: null, scope: 'openid' });
  await assert.rejects(() => auth.getAccessToken([SCOPE]), e => e.code === 'consent_required');
});

test('a new client starts disconnected; disconnect revokes and forgets the tokens', async () => {
  const { auth, posts } = setup();
  auth.setClient('cid', 'sec');
  auth.setTokens({ accessToken: 'A', refreshToken: 'R', expiresAt: null, scope: SCOPE });
  auth.setClient('cid', 'sec2');
  assert.equal(auth.status().connected, true, 'same client keeps its tokens');
  auth.setClient('other-cid', 'sec3');
  assert.equal(auth.status().connected, false);

  auth.setTokens({ accessToken: 'A', refreshToken: 'R', expiresAt: null, scope: SCOPE });
  posts.length = 0;
  await auth.disconnect();
  assert.match(posts[0].url, /revoke/);
  assert.equal(posts[0].body.token, 'R');
  assert.equal(auth.status().connected, false);
  assert.equal(auth.status().configured, true, 'the client stays for the next Connect');
});

test('invalid_grant forgets the dead sign-in, so the chip says "not connected"', async () => {
  const { auth, tick } = setup({ responses: [{ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }] });
  auth.setClient('cid', 'sec');
  auth.setTokens({ accessToken: 'A', refreshToken: 'R', expiresAt: 1_000_000, scope: SCOPE });
  tick(1000);
  await assert.rejects(() => auth.getAccessToken([SCOPE]), e => e.code === 'reauth_required');
  assert.equal(auth.status().connected, false);
  assert.equal(auth.status().configured, true);
});

test('an expired access token with no refresh token is not "connected"', () => {
  const { auth, tick } = setup();
  auth.setClient('cid', 'sec');
  auth.setTokens({ accessToken: 'A', refreshToken: '', expiresAt: 1_000_000 + 60000, scope: SCOPE });
  assert.equal(auth.status().connected, true);
  tick(120000);
  assert.equal(auth.status().connected, false);
});

test('a network blip or 5xx during refresh is retried; a 4xx is not', async () => {
  const { auth, posts, tick } = setup({ responses: [
    () => { throw new TypeError('fetch failed'); },
    { status: 503 },
    { access_token: 'AT2', expires_in: 3600, scope: SCOPE },
  ] });
  auth.setClient('cid', 'sec');
  auth.setTokens({ accessToken: 'A', refreshToken: 'R', expiresAt: 1_000_000, scope: SCOPE });
  tick(1000);
  assert.equal((await auth.getAccessToken([SCOPE])).accessToken, 'AT2');
  assert.equal(posts.length, 3);

  const b = setup({ responses: [{ status: 401, body: { error: 'invalid_client' } }] });
  b.auth.setClient('cid', 'sec');
  b.auth.setTokens({ accessToken: 'A', refreshToken: 'R', expiresAt: 1_000_000, scope: SCOPE });
  b.tick(1000);
  await assert.rejects(() => b.auth.getAccessToken([SCOPE]));
  assert.equal(b.posts.length, 1);
});

test('parallel callers share one refresh', async () => {
  const { auth, posts, tick } = setup({ responses: [async () => { await new Promise(r => setTimeout(r, 30)); return { access_token: 'AT2', expires_in: 3600, scope: SCOPE }; }] });
  auth.setClient('cid', 'sec');
  auth.setTokens({ accessToken: 'A', refreshToken: 'R', expiresAt: 1_000_000, scope: SCOPE });
  tick(1000);
  const [a, b] = await Promise.all([auth.getAccessToken([SCOPE]), auth.getAccessToken([SCOPE])]);
  assert.equal(a.accessToken, 'AT2');
  assert.equal(b.accessToken, 'AT2');
  assert.equal(posts.length, 1);
});

test('a refresh that finishes after Disconnect does not bring the tokens back', async () => {
  let release;
  const { auth, tick } = setup({ responses: [
    () => new Promise(r => { release = () => r({ access_token: 'LATE', expires_in: 3600, scope: SCOPE }); }),
  ] });
  auth.setClient('cid', 'sec');
  auth.setTokens({ accessToken: 'A', refreshToken: 'R', expiresAt: 1_000_000, scope: SCOPE });
  tick(1000);
  const p = auth.getAccessToken([SCOPE]);
  await new Promise(r => setTimeout(r, 10));
  await auth.disconnect(); // revoke POST uses the default response
  release();
  await p;
  assert.equal(auth.status().connected, false);
});

test('two Connect clicks share one listener, and it closes', async () => {
  const { auth, opened } = setup();
  await Promise.all([
    auth.connect([SCOPE], { clientId: 'cid', clientSecret: 's' }),
    auth.connect([SCOPE], { clientId: 'cid', clientSecret: 's' }),
  ]);
  const ports = opened.map(u => new URL(new URL(u).searchParams.get('redirect_uri')).port);
  assert.equal(ports[0], ports[1], 'one port');
  auth.stop();
  await new Promise(res => setTimeout(res, 50));
  assert.equal(await listening(ports[0]), false);
});

test('a browser that cannot be opened closes the listener at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-oauth-'));
  const auth = new DriveAuth({ file: path.join(dir, 'oauth.json'), openExternal: async () => { throw new Error('no browser'); } });
  auth.setClient('cid', 's');
  await assert.rejects(() => auth.connect([SCOPE]), /Could not open/);
  assert.equal(auth.server, null);
});

test('re-entering the same client ID with a blank secret keeps the secret', () => {
  const { auth } = setup();
  auth.setClient('cid', 'sec');
  auth.setClient('cid', '');
  assert.equal(auth.settings().clientSecret, 'sec');
});

test('an unreadable oauth.json (other machine/user) reads as not connected', () => {
  const { auth, file } = setup();
  fs.writeFileSync(file, JSON.stringify({ clientId: 'cid', clientSecret: 'bm90LWEtYmxvYg==', tokens: 'bm90LWEtYmxvYg==' }));
  assert.deepEqual([auth.status().configured, auth.status().connected], [true, false]);
  assert.equal(auth.settings().clientSecret, '');
});
