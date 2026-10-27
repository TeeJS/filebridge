'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveIdentity, resolveNotary } = require('../build/mac-build');
const { credentialState, builtForMac, findApps } = require('../build/verify-mac-build');
const { notarytoolAuth, dmgsIn } = require('../build/notarize-dmg');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fb-mac-'));

// ── credential discovery ─────────────────────────────────────────────────────
// A partial set is the dangerous case: it is what a half-configured machine looks like, and
// it must not read as "no credentials, carry on".
test('a complete credential set is accepted; a partial one is named, not ignored', () => {
  assert.deepEqual(credentialState({ APPLE_KEYCHAIN_PROFILE: 'p' }), { ok: true, using: 'APPLE_KEYCHAIN_PROFILE' });
  assert.deepEqual(credentialState({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }),
    { ok: true, using: 'APPLE_ID' });

  const partial = credentialState({ APPLE_ID: 'a' });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.missing, ['APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']);

  assert.deepEqual(credentialState({}), { ok: false });
  // Whitespace is not a credential.
  assert.deepEqual(credentialState({ APPLE_KEYCHAIN_PROFILE: '   ' }), { ok: false });
});

test('notarytool arguments match the credential set, and are null when there is none', () => {
  assert.deepEqual(notarytoolAuth({ APPLE_KEYCHAIN_PROFILE: 'fb' }), ['--keychain-profile', 'fb']);
  assert.deepEqual(notarytoolAuth({ APPLE_KEYCHAIN_PROFILE: 'fb', APPLE_KEYCHAIN: '/k.db' }),
    ['--keychain-profile', 'fb', '--keychain', '/k.db']);
  assert.deepEqual(notarytoolAuth({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }),
    ['--apple-id', 'a', '--team-id', 'c', '--password', 'b']);
  assert.equal(notarytoolAuth({}), null);
  assert.equal(notarytoolAuth({ APPLE_ID: 'a' }), null);
});

test('the notary profile resolves in order: environment, then .signing, then a credential set', () => {
  const root = tmp();                                   // no .signing at all
  const configured = tmp();
  fs.mkdirSync(path.join(configured, '.signing'));
  fs.writeFileSync(path.join(configured, '.signing', 'notary-profile'), 'fb-notary\n');

  // APPLE_KEYCHAIN_PROFILE wins, so a one-off build can override the machine's default.
  assert.equal(resolveNotary({ APPLE_KEYCHAIN_PROFILE: 'env-profile' }, configured).from, 'APPLE_KEYCHAIN_PROFILE');

  // Then the gitignored file, which is how this build Mac is set up. The profile name is
  // passed on as an env var; the Apple ID and password inside it are never read here.
  const fromFile = resolveNotary({}, configured);
  assert.equal(fromFile.from, '.signing/notary-profile (fb-notary)');
  assert.deepEqual(fromFile.env, { APPLE_KEYCHAIN_PROFILE: 'fb-notary' });

  // Then the environment credential sets.
  assert.equal(resolveNotary({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }, root).from,
    'APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID');
  assert.equal(resolveNotary({ APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 's' }, root).from,
    'App Store Connect API key');

  // Nothing anywhere is null, not an empty object: build/mac-build.js reports
  // "notarization: off" from it rather than claiming a source it does not have.
  assert.equal(resolveNotary({}, root), null);

  for (const d of [root, configured]) fs.rmSync(d, { recursive: true, force: true });
});

test('the signing identity prefers the environment, then .signing, and never invents one', () => {
  const root = tmp();
  const configured = tmp();
  fs.mkdirSync(path.join(configured, '.signing'));
  fs.writeFileSync(path.join(configured, '.signing', 'mac-identity'), 'Developer ID Application: Someone (TEAM123)\n');

  assert.deepEqual(resolveIdentity({ FILEBRIDGE_MAC_IDENTITY: 'Developer ID Application: Env (E1)' }, configured),
    { identity: 'Developer ID Application: Env (E1)', from: 'FILEBRIDGE_MAC_IDENTITY' });
  assert.deepEqual(resolveIdentity({}, configured),
    { identity: 'Developer ID Application: Someone (TEAM123)', from: '.signing/mac-identity' });

  // With neither, it falls through to the login keychain. On a machine with no Developer ID
  // that is '-' (ad-hoc), which mac-build.js warns about and the guard refuses to ship.
  const found = resolveIdentity({}, root);
  assert.ok(found.identity === '-' || /^Developer ID Application:/.test(found.identity));
  assert.ok(found.from === 'none found' || found.from === 'login keychain');

  for (const d of [root, configured]) fs.rmSync(d, { recursive: true, force: true });
});

// ── the guard ────────────────────────────────────────────────────────────────
// "Not a macOS build, correctly do nothing" and "this IS a macOS build and the app is
// missing" must not collapse into the same silent return — that is how a guard becomes a
// no-op while still reporting success.
test('builtForMac reads the hook context, and falls back to the artifact names', () => {
  assert.equal(builtForMac({ platformToTargets: new Map([[{ name: 'mac' }, {}]]) }), true);
  assert.equal(builtForMac({ platformToTargets: new Map([[{ name: 'windows' }, {}]]) }), false);
  assert.equal(builtForMac({ artifactPaths: ['/out/filebridge-2.0.1-mac-arm64.dmg'] }), true);
  assert.equal(builtForMac({ artifactPaths: ['/out/filebridge-setup-2.0.1.exe'] }), false);
  assert.equal(builtForMac({}), false);
  assert.equal(builtForMac(null), false);
});

test('findApps scans rather than assuming the product name or the arch folder', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'mac-arm64', 'FileBridge.app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Renamed.app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'filebridge-2.0.1-mac-arm64.dmg'), '');

  const found = findApps(dir).map(p => path.basename(p)).sort();
  assert.deepEqual(found, ['FileBridge.app', 'Renamed.app']);
  assert.deepEqual(findApps(path.join(dir, 'nope')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every .dmg is found, from the hook context or by reading the output folder', () => {
  assert.deepEqual(dmgsIn(['/o/a.dmg', '/o/a.zip'], '/o'), ['/o/a.dmg']);

  // The outDir fallback exists so a change in the hook contract cannot silently leave
  // every disk image unsigned.
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'one.dmg'), '');
  fs.writeFileSync(path.join(dir, 'two.DMG'), '');
  fs.writeFileSync(path.join(dir, 'skip.zip'), '');
  assert.deepEqual(dmgsIn([], dir).map(p => path.basename(p)).sort(), ['one.dmg', 'two.DMG']);
  assert.deepEqual(dmgsIn(null, path.join(dir, 'nope')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── the shipped assets ───────────────────────────────────────────────────────
// Just enough PNG to read our own 8-bit RGBA, non-interlaced assets. Electron's nativeImage
// would be the obvious reader, but `require('electron')` outside an Electron run returns the
// path to the binary rather than the API, and these tests run under plain node.
function readRgba(file) {
  const zlib = require('zlib');
  const b = fs.readFileSync(file);
  assert.equal(b.readUInt32BE(0), 0x89504e47, `${file} is not a PNG`);
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
  assert.equal(b[24], 8, 'expected 8-bit samples');
  assert.equal(b[25], 6, 'expected RGBA (colour type 6)');
  assert.equal(b[28], 0, 'expected a non-interlaced PNG');

  const idat = [];
  for (let p = 8; p + 8 <= b.length;) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
    if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));

  // Undo the per-row filters (PNG spec 9.2): each row is prefixed with its filter type.
  const stride = width * 4, out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const ul = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - ul, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

// A template image macOS will not tint is the whole failure mode: it has to be pure black
// plus alpha, and the @2x has to be beside it or Retina picks the 16px one and softens it.
test('the menu-bar icons are a black-on-transparent template pair', () => {
  const assets = path.join(__dirname, '..', 'assets');
  for (const [name, size] of [['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]]) {
    const file = path.join(assets, name);
    assert.ok(fs.existsSync(file), `${name} is missing`);
    const img = readRgba(file);
    assert.deepEqual([img.width, img.height], [size, size], `${name} is the wrong size`);

    let coloured = 0, visible = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3] === 0) continue;
      visible++;
      if (img.data[i] > 8 || img.data[i + 1] > 8 || img.data[i + 2] > 8) coloured++;
    }
    assert.ok(visible > 0, `${name} is blank`);
    assert.equal(coloured, 0, `${name} must be black on transparent for macOS to tint it`);
  }
});
