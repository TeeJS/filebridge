'use strict';
/*
 * tray-detect.js — can a tray icon actually be shown on this Linux session? Electron's Tray
 * there is a StatusNotifierItem, which only appears when something owns the session-bus name
 * org.kde.StatusNotifierWatcher: always on KDE, and on GNOME only with the AppIndicator
 * extension. Electron has no "is the tray visible" API, so main.js asks this before choosing
 * to hide the window on close (otherwise the app would vanish with no way back).
 *
 * One D-Bus call through dbus-next (pure JS: no child process, no shell), lazy-required so
 * Windows and mac never load it. Any failure or a slow bus counts as "no tray".
 */
const WATCHER = 'org.kde.StatusNotifierWatcher';

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// sessionBus: injectable for tests; defaults to dbus-next's session bus.
async function trayAvailable(opts = {}) {
  if ((opts.platform || process.platform) !== 'linux') return true;
  const env = opts.env || process.env;
  if (!opts.sessionBus && !env.DBUS_SESSION_BUS_ADDRESS) return false;
  let bus = null;
  const ask = (async () => {
    bus = opts.sessionBus ? opts.sessionBus() : require('dbus-next').sessionBus();
    // A broken bus reports through 'error' events; never let one crash the main process.
    if (typeof bus.on === 'function') bus.on('error', () => {});
    const proxy = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
    const dbus = proxy.getInterface('org.freedesktop.DBus');
    return (await dbus.NameHasOwner(WATCHER)) === true;
  })().catch(() => false);
  try { return await withTimeout(ask, opts.timeoutMs || 1000); }
  finally { try { if (bus) bus.disconnect(); } catch {} }
}

module.exports = { trayAvailable, WATCHER };
