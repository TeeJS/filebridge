'use strict';
/*
 * autostart-linux.js — "Start at login" on Linux. Electron's setLoginItemSettings does nothing
 * there, so this writes the XDG autostart entry ($XDG_CONFIG_HOME/autostart/filebridge.desktop)
 * that every freedesktop session (KDE, GNOME, XFCE, ...) runs at login.
 *
 * The AppImage runs from a temporary /tmp/.mount_* copy whose path changes each launch, so the
 * entry points at $APPIMAGE (the file the user actually has), the same trap as Windows'
 * PORTABLE_EXECUTABLE_FILE. A deb install runs from a fixed path, so execPath is right there.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE_NAME = 'filebridge.desktop';

function autostartDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), '.config');
  return path.join(base, 'autostart');
}

// Desktop Entry spec: an Exec argument with reserved characters is double-quoted, and inside the
// quotes " ` $ \ are backslash-escaped. Always quoting is valid and covers spaces in the path.
function quoteArg(s) {
  return '"' + String(s).replace(/["`$\\]/g, '\\$&') + '"';
}

function execTarget(env = process.env, execPath = process.execPath) {
  return env.APPIMAGE || execPath;
}

function entry(target, args) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=FileBridge',
    'Comment=Keep FileBridge schedules running after login',
    'Exec=' + [target].concat(args || []).map(quoteArg).join(' '),
    'Icon=filebridge',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function createAutostart(opts = {}) {
  const env = opts.env || process.env;
  const args = opts.args || ['--hidden'];
  const file = path.join(opts.dir || autostartDir(env), FILE_NAME);
  const target = () => execTarget(env, opts.execPath || process.execPath);

  // On when our entry exists and the session hasn't disabled it (GNOME's Startup Applications
  // and KDE's Autostart settings flip these keys instead of deleting the file).
  function get() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
    return !/^Hidden\s*=\s*true\s*$/mi.test(text) && !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/mi.test(text);
  }

  function set(on) {
    if (!on) { try { fs.rmSync(file, { force: true }); } catch {} return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, entry(target(), args));
    fs.renameSync(tmp, file);
  }

  // A moved AppImage leaves an entry pointing at the old path; rewrite it at startup while on.
  function refresh() {
    if (!get()) return;
    try { if (fs.readFileSync(file, 'utf8') !== entry(target(), args)) set(true); } catch {}
  }

  return { file, get, set, refresh };
}

module.exports = { createAutostart, autostartDir, quoteArg, execTarget, entry };
