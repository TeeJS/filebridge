'use strict';

// `npm run dist:mac` — resolve the signing identity and the notarization credentials, then hand
// off to electron-builder. Nothing here handles a secret: the certificate lives in the login
// keychain and the Apple ID + app-specific password live inside a notarytool credential profile,
// so both are referenced by name and neither is ever read, printed or stored by this script.
//
// This mirrors Bedrock Panel's build-mac.js, which is how that project has shipped signed,
// notarized, stapled releases from this same Mac. See bedrock-panel/docs/mac-signing.md.
//
// Resolution order, first match wins:
//   identity   FILEBRIDGE_MAC_IDENTITY → .signing/mac-identity → the Developer ID in the
//              keychain → '-' (ad-hoc)
//   notarize   APPLE_KEYCHAIN_PROFILE → .signing/notary-profile → APPLE_ID + APPLE_APP_SPECIFIC_
//              PASSWORD + APPLE_TEAM_ID → APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER
//
// .signing/ is gitignored, so it is per machine and never travels with the repo.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// root is a parameter so the tests can point at a fixture instead of this machine's own
// .signing folder, whose presence would otherwise decide what the resolution order looks like.
const readSigning = (name, root) => {
  try { return fs.readFileSync(path.join(root, '.signing', name), 'utf8').trim() || null; }
  catch { return null; }
};

function resolveIdentity(env, root = ROOT) {
  if (env.FILEBRIDGE_MAC_IDENTITY && env.FILEBRIDGE_MAC_IDENTITY.trim()) {
    return { identity: env.FILEBRIDGE_MAC_IDENTITY.trim(), from: 'FILEBRIDGE_MAC_IDENTITY' };
  }
  const file = readSigning('mac-identity', root);
  if (file) return { identity: file, from: '.signing/mac-identity' };
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
    const m = /"(Developer ID Application:[^"]+)"/.exec(out);
    if (m) return { identity: m[1], from: 'login keychain' };
  } catch {}
  return { identity: '-', from: 'none found' };
}

function resolveNotary(env, root = ROOT) {
  const has = k => !!(env[k] && String(env[k]).trim());
  if (has('APPLE_KEYCHAIN_PROFILE')) return { env: {}, from: 'APPLE_KEYCHAIN_PROFILE' };
  const profile = readSigning('notary-profile', root);
  if (profile) return { env: { APPLE_KEYCHAIN_PROFILE: profile }, from: `.signing/notary-profile (${profile})` };
  if (has('APPLE_ID') && has('APPLE_APP_SPECIFIC_PASSWORD') && has('APPLE_TEAM_ID')) {
    return { env: {}, from: 'APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID' };
  }
  if (has('APPLE_API_KEY') && has('APPLE_API_KEY_ID') && has('APPLE_API_ISSUER')) {
    return { env: {}, from: 'App Store Connect API key' };
  }
  return null;
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('[build:mac] macOS builds must be produced on macOS — see build/verify-mac-build.js');
    process.exit(1);
  }

  const { identity, from } = resolveIdentity(process.env);
  const notary = resolveNotary(process.env);
  const adhoc = identity === '-';

  console.log(`[build:mac] signing identity: ${adhoc ? 'ad-hoc' : `"${identity}"`} [${from}]`);
  console.log(`[build:mac] notarization: ${notary && !adhoc ? 'on, via ' + notary.from : 'off'}`);

  // An ad-hoc signature is different on every build, so macOS treats each build as a new app and
  // every privacy grant the user made goes stale. Fine for a throwaway local run, never for a
  // release — which is why this only warns here and verify-mac-build.js is what refuses to ship.
  if (adhoc) console.warn('[build:mac] WARNING: no Developer ID found. This build cannot be released.');

  const env = Object.assign({}, process.env, notary ? notary.env : {});
  if (!adhoc) env.CSC_NAME = identity;

  const args = ['electron-builder', '--mac', ...process.argv.slice(2)];
  const r = spawnSync('npx', args, { stdio: 'inherit', cwd: ROOT, env });
  process.exit(r.status == null ? 1 : r.status);
}

if (require.main === module) main();
module.exports = { resolveIdentity, resolveNotary };
