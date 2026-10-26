'use strict';
// Google Drive sign-in for FileBridge: Bedrock Panel's PKCE flow (src/auth/oauth-handler.js +
// token-storage.js) cut down to the one provider FileBridge uses. Differences from the Panel:
// - The loopback callback listens on an OS-assigned port ("start an HTTP listener on a random
//   available port", Google's desktop-app guide) and only while a sign-in is pending; it closes
//   after the callback or SIGN_IN_TIMEOUT_MS. It is the app's only listening socket.
// - The client id/secret and tokens live in <data>\oauth.json; the secret and the token set are
//   DPAPI-protected (shell/dpapi.js). A copy on another machine/user simply reads as not connected.
// - Tokens refresh on demand when a run asks for one; no background timers.
// Exposes exactly the ctx.oauth shape server.js expects: status/connect/disconnect/getAccessToken.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const dpapi = require('./dpapi');

const GOOGLE = {
  name: 'Google Drive',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  skewMs: 5 * 60 * 1000,
};
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

const base64Url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const scopeList = s => (Array.isArray(s) ? s : String(s || '').split(/[,\s]+/)).map(x => String(x || '').trim()).filter(Boolean);
const comparable = s => !['offline_access', 'openid', 'profile'].includes(String(s).toLowerCase());

function formBody(obj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  return params;
}
const page = (color, text) => '<!doctype html><meta charset="utf-8"><title>FileBridge</title>'
  + '<body style="font:16px Segoe UI,sans-serif;background:#0d1117;color:' + color + '">' + text + '</body>';

class DriveAuth {
  constructor({ file, openExternal, log = () => {}, fetchImpl = fetch, now = Date.now, signInTimeoutMs = SIGN_IN_TIMEOUT_MS }) {
    this.file = file;
    this.signInTimeoutMs = signInTimeoutMs;
    this.openExternal = openExternal;
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.pending = new Map(); // state -> { verifier, scopes, redirectUri }
    this.server = null;
    this.serverTimer = null;
  }

  // ── storage ──────────────────────────────────────────────────────────────────
  read() {
    try { const o = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (o && typeof o === 'object') return o; } catch {}
    return {};
  }
  write(o) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
    fs.renameSync(tmp, this.file);
  }
  settings() {
    const o = this.read();
    return { clientId: String(o.clientId || ''), clientSecret: (o.clientSecret && dpapi.unprotectOne(o.clientSecret)) || '' };
  }
  tokens() {
    const plain = dpapi.unprotectOne(this.read().tokens);
    try { const t = plain ? JSON.parse(plain) : null; return t && typeof t === 'object' ? t : null; } catch { return null; }
  }
  setClient(clientId, clientSecret) {
    const secret = clientSecret ? dpapi.protectOne(clientSecret) : '';
    if (clientSecret && !secret) throw new Error('Google Drive settings could not be stored securely');
    const o = this.read();
    // Tokens belong to the client that issued them — a new client starts disconnected.
    if (o.clientId && o.clientId !== clientId) delete o.tokens;
    o.clientId = clientId;
    o.clientSecret = secret;
    this.write(o);
  }
  setTokens(t) {
    const blob = dpapi.protectOne(JSON.stringify(Object.assign({}, t, { updatedAt: this.now() })));
    if (!blob) throw new Error('Google Drive tokens could not be stored securely');
    const o = this.read();
    o.tokens = blob;
    this.write(o);
  }
  deleteTokens() {
    const o = this.read();
    delete o.tokens;
    this.write(o);
  }

  status() {
    const t = this.tokens();
    return {
      provider: 'google-drive',
      configured: !!this.settings().clientId,
      connected: !!(t && (t.accessToken || t.refreshToken)),
      expiresAt: (t && t.expiresAt) || null,
      updatedAt: (t && t.updatedAt) || null,
      scopes: t && t.scope ? scopeList(t.scope) : [],
    };
  }

  // ── sign-in ──────────────────────────────────────────────────────────────────
  async connect(scopes, creds) {
    if (creds && creds.clientId) this.setClient(String(creds.clientId), String(creds.clientSecret || ''));
    const { clientId } = this.settings();
    if (!clientId) throw new Error('Google Drive client ID is required');
    const port = await this.listen();
    const redirectUri = 'http://127.0.0.1:' + port + '/oauth/callback';
    const state = base64Url(crypto.randomBytes(24));
    const verifier = base64Url(crypto.randomBytes(48));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    const requested = scopeList(scopes);
    this.pending.set(state, { verifier, scopes: requested, redirectUri });
    const url = GOOGLE.authUrl + '?' + new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
      scope: requested.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    if (!await this.openExternal(url)) { this.pending.delete(state); this.closeIfIdle(); throw new Error('Could not open the Google sign-in page'); }
    return { ok: true };
  }

  listen() {
    if (this.server) { this.armTimeout(); return Promise.resolve(this.server.address().port); }
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (req.method !== 'GET' || url.pathname !== '/oauth/callback') { res.writeHead(404); res.end(); return; }
        this.handleCallback(url).then(() => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(page('#e6edf3', 'FileBridge is connected to Google Drive. You can close this window.'));
          this.log('[oauth] connected Google Drive');
        }).catch(e => {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(page('#f85149', 'Google Drive sign-in failed: ' + String(e.message || e).replace(/[<>&"]/g, '')));
          this.log('[oauth] callback failed: ' + (e.message || e));
        }).finally(() => this.closeIfIdle());
      });
      server.once('error', err => reject(new Error('Could not open the sign-in callback: ' + (err.message || err))));
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.armTimeout();
        resolve(server.address().port);
      });
    });
  }
  armTimeout() {
    clearTimeout(this.serverTimer);
    this.serverTimer = setTimeout(() => { this.pending.clear(); this.closeServer(); }, this.signInTimeoutMs);
  }
  closeIfIdle() { if (!this.pending.size) this.closeServer(); }
  closeServer() {
    clearTimeout(this.serverTimer);
    this.serverTimer = null;
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
  }

  async handleCallback(url) {
    const state = url.searchParams.get('state') || '';
    const pending = this.pending.get(state);
    if (!pending) throw new Error('the sign-in was not recognized (it may have timed out) — click Connect again');
    this.pending.delete(state);
    const err = url.searchParams.get('error');
    if (err) throw new Error(url.searchParams.get('error_description') || err);
    const code = url.searchParams.get('code');
    if (!code) throw new Error('Google returned no authorization code');
    const { clientId, clientSecret } = this.settings();
    const token = await this.fetchToken({
      grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret,
      code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier,
    });
    this.setTokens(this.normalize(token, pending.scopes));
  }

  async fetchToken(payload) {
    const res = await this.fetchImpl(GOOGLE.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: formBody(payload),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || res.statusText }; }
    if (!res.ok || data.error) throw new Error(data.error_description || data.error || ('Token request failed: HTTP ' + res.status));
    return data;
  }

  normalize(token, requested) {
    const expiresIn = token.expires_in == null ? null : Number(token.expires_in);
    return {
      tokenType: token.token_type || 'Bearer',
      accessToken: token.access_token || '',
      refreshToken: token.refresh_token || '',
      expiresAt: Number.isFinite(expiresIn) ? this.now() + Math.max(0, expiresIn) * 1000 : null,
      scope: token.scope || scopeList(requested).join(' '),
    };
  }

  // ── tokens for runs ──────────────────────────────────────────────────────────
  async getAccessToken(scopes) {
    const requested = scopeList(scopes);
    const t = this.tokens();
    if (!t) return null;
    const have = new Set(scopeList(t.scope).map(s => s.toLowerCase()));
    const missing = requested.filter(comparable).filter(s => !have.has(s.toLowerCase()));
    if (missing.length) {
      const e = new Error('Google Drive needs additional consent for: ' + missing.join(' '));
      e.code = 'consent_required';
      throw e;
    }
    let cur = t;
    if (!(t.accessToken && (!t.expiresAt || this.now() < Number(t.expiresAt) - GOOGLE.skewMs))) {
      if (!t.refreshToken) return null;
      const { clientId, clientSecret } = this.settings();
      // Google's refresh request takes no redirect_uri (the loopback port changes per sign-in).
      const next = await this.fetchToken({
        grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret,
        refresh_token: t.refreshToken, scope: requested.join(' '),
      });
      cur = this.normalize(Object.assign({}, next, {
        refresh_token: next.refresh_token || t.refreshToken,
        scope: next.scope || t.scope || '',
      }), requested);
      this.setTokens(cur);
    }
    return { tokenType: cur.tokenType || 'Bearer', accessToken: cur.accessToken, expiresAt: cur.expiresAt, scope: cur.scope || '', scopes: scopeList(cur.scope) };
  }

  async disconnect() {
    const t = this.tokens();
    if (t && (t.refreshToken || t.accessToken)) {
      try {
        await this.fetchImpl(GOOGLE.revokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formBody({ token: t.refreshToken || t.accessToken }),
        });
      } catch (e) { this.log('[oauth] revoke failed: ' + (e.message || e)); }
    }
    this.deleteTokens();
    return { ok: true };
  }

  stop() { this.pending.clear(); this.closeServer(); }
}

module.exports = { DriveAuth, GOOGLE, SIGN_IN_TIMEOUT_MS };
