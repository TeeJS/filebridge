'use strict';
/*
 * electron-builder custom Windows sign hook -> Azure Trusted Signing (Artifact Signing).
 * Copied from faction-wars-editor (same approach as Bedrock Panel's sign.js): SignTool + the
 * Trusted Signing dlib. In CI (.github/workflows/release.yml) the login is GitHub's OIDC token;
 * on a PC it is the local `Connect-AzAccount` session. electron-builder calls this once per
 * file it signs: the app exe, the NSIS installer and uninstaller, and (win.signExts) the
 * DPAPI .node module.
 *
 * Machine setup (otherwise the hook warns and leaves files UNSIGNED, so a plain checkout
 * still builds):
 *   - .signing/dlib-x64/Azure.CodeSigning.Dlib.dll  (copy another repo's .signing folder)
 *   - .signing/metadata.json                         (endpoint/account/profile, BOM-less UTF-8)
 *   - SignTool (Windows SDK), .NET 8 runtime, per-user PowerShell 7 at %LOCALAPPDATA%\pwsh7
 *   - a current `Connect-AzAccount` session with the certificate-profile-signer role
 * .signing/ is gitignored.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SIGNING_DIR = path.join(__dirname, '.signing');
const DLIB = path.join(SIGNING_DIR, 'dlib-x64', 'Azure.CodeSigning.Dlib.dll');
const META = path.join(SIGNING_DIR, 'metadata.json');
// The Default Directory tenant (not a secret; the same value the other repos pin).
const TENANT = process.env.AZURE_TENANT_ID || 'a4ae2122-9515-4f85-abc8-71c29ccc261f';
const PWSH_DIR = path.join(process.env.LOCALAPPDATA || '', 'pwsh7');
const TIMESTAMP = 'http://timestamp.acs.microsoft.com';

function findSignTool() {
  const base = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  try {
    const versions = fs.readdirSync(base).filter(d => /^10\./.test(d)).sort().reverse();
    for (const v of versions) {
      const p = path.join(base, v, 'x64', 'signtool.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  const direct = path.join(base, 'x64', 'signtool.exe');
  return fs.existsSync(direct) ? direct : null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitUnlocked(file, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { fs.closeSync(fs.openSync(file, 'r+')); return; } catch {}
    await sleep(500);
  }
}

exports.default = async function (configuration) {
  const file = configuration.path;
  if (!file) return;
  const signtool = findSignTool();
  if (!signtool || !fs.existsSync(DLIB) || !fs.existsSync(META)) {
    console.warn('  ! Trusted Signing setup missing (.signing/ or SignTool) - leaving UNSIGNED:', file);
    return;
  }
  console.log('  - Trusted Signing ->', file);
  const env = Object.assign({}, process.env, {
    AZURE_TENANT_ID: TENANT,
    PATH: PWSH_DIR + path.delimiter + (process.env.PATH || ''),
  });
  await waitUnlocked(file);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync(signtool, ['sign', '/v', '/fd', 'SHA256', '/tr', TIMESTAMP, '/td', 'SHA256', '/dlib', DLIB, '/dmdf', META, file], { stdio: 'inherit', env });
      return;
    } catch (e) {
      if (attempt === 3) throw e;
      console.warn(`  ! signtool failed (attempt ${attempt}), retrying in 2s...`);
      await sleep(2000);
    }
  }
};
