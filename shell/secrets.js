'use strict';
// Encryption at rest for the Google Drive sign-in, per OS:
// - Windows: raw DPAPI (shell/dpapi.js). Bedrock Panel found Electron safeStorage's key did not
//   survive across launches there (diagnosed 2026-07-03), so Windows never uses it.
// - macOS:   Electron safeStorage → the login Keychain.
// - Linux:   Electron safeStorage → libsecret (GNOME) or KWallet (KDE). With no keyring running,
//   safeStorage falls back to 'basic_text', which is effectively plain text — refused here, with a
//   message naming what is missing, rather than claiming the sign-in is "stored securely".
// A blob that can't be decrypted (another machine or user, a re-signed mac app whose Keychain item
// no longer matches) reads as null, which DriveAuth treats as "not connected — sign in again".
//
// Interface (injectable, so tests run on any OS and on headless CI):
//   available() -> bool, reason() -> string, protect(str) -> base64|null, unprotect(base64) -> str|null

function createSecrets({ platform = process.platform, safeStorage, dpapi } = {}) {
  if (platform === 'win32') {
    const d = dpapi || require('./dpapi');
    return {
      available: () => d.available(),
      reason: () => (d.available() ? '' : 'the Windows encryption module is missing from this build'),
      protect: s => d.protectOne(s),
      unprotect: b => d.unprotectOne(b),
    };
  }

  const ss = () => safeStorage || require('electron').safeStorage;
  // getSelectedStorageBackend exists on Linux only (it throws or is absent on macOS).
  const backend = () => {
    if (platform !== 'linux') return '';
    try { return typeof ss().getSelectedStorageBackend === 'function' ? ss().getSelectedStorageBackend() : ''; } catch { return ''; }
  };
  const available = () => {
    try { if (!ss().isEncryptionAvailable()) return false; } catch { return false; }
    const b = backend();
    return !(platform === 'linux' && (b === 'basic_text' || b === 'unknown'));
  };
  return {
    available,
    reason: () => {
      if (available()) return '';
      if (platform === 'darwin') return 'the macOS Keychain is not available';
      return 'no keyring is running — FileBridge needs GNOME Keyring (libsecret) or KWallet to store the Google Drive sign-in';
    },
    protect: s => {
      if (typeof s !== 'string' || !available()) return null;
      try { return ss().encryptString(s).toString('base64'); } catch { return null; }
    },
    unprotect: b => {
      if (typeof b !== 'string' || !b) return null;
      try { return ss().decryptString(Buffer.from(b, 'base64')); } catch { return null; }
    },
  };
}

module.exports = { createSecrets };
