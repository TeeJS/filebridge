'use strict';
/*
 * dpapi.js — raw Windows DPAPI (CryptProtectData/CryptUnprotectData, CurrentUser scope) through
 * the Node-API binding in native/dpapi (built by build-dpapi.js). Protects the Google client
 * secret and tokens at rest.
 *
 * Why not Electron safeStorage: Bedrock Panel found its Chromium key (kept in the profile's
 * Local State) did not survive across launches, silently orphaning every stored secret
 * (diagnosed 2026-07-03). Raw DPAPI has no key file: each value is protected by the user's
 * Windows credentials directly.
 */
let binding = null;
if (process.platform === 'win32') {
  try { binding = require('./native/filebridge_dpapi.node'); } catch (e) {}
}

function decodeBlob(blob) {
  if (typeof blob !== 'string' || blob === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob) || blob.length % 4 !== 0) return null;
  const bytes = Buffer.from(blob, 'base64');
  return bytes.length && bytes.toString('base64') === blob ? bytes : null;
}

/** Encrypt one utf8 string -> DPAPI blob (base64), or null on failure. */
function protectOne(plain) {
  if (!binding || typeof plain !== 'string') return null;
  try { return binding.protect(Buffer.from(plain, 'utf8')).toString('base64'); }
  catch (e) { return null; }
}

/** Decrypt one DPAPI blob (base64) -> utf8 string, or null on failure. */
function unprotectOne(blob) {
  const bytes = decodeBlob(blob);
  if (!binding || !bytes) return null;
  try { return binding.unprotect(bytes).toString('utf8'); }
  catch (e) { return null; }
}

function available() { return !!binding; }

module.exports = { protectOne, unprotectOne, available };
