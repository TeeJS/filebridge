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
    fetchImpl: async (url, init) => {
      posts.push({ url, body: Object.fromEntries(new URLSearchParams(init.body.toString())) });
      const next = responses.shift() || { access_token: 'AT', expires_in: 3600, refresh_token: 'RT', scope: SCOPE };
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(next) };
    },
    now: () => clock,
    signInTimeoutMs: opts.signInTimeoutMs || 60000,
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

test('an unreadable oauth.json (other machine/user) reads as not connected', () => {
  const { auth, file } = setup();
  fs.writeFileSync(file, JSON.stringify({ clientId: 'cid', clientSecret: 'bm90LWEtYmxvYg==', tokens: 'bm90LWEtYmxvYg==' }));
  assert.deepEqual([auth.status().configured, auth.status().connected], [true, false]);
  assert.equal(auth.settings().clientSecret, '');
});
