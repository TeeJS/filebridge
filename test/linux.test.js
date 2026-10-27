'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAutostart, autostartDir, quoteArg, execTarget } = require('../shell/autostart-linux');
const { trayAvailable, WATCHER } = require('../shell/tray-detect');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fb-linux-'));

// ── autostart ────────────────────────────────────────────────────────────────
test('autostart dir follows XDG_CONFIG_HOME, else ~/.config; a relative value is ignored', () => {
  assert.equal(autostartDir({ XDG_CONFIG_HOME: '/x/cfg' }), path.join('/x/cfg', 'autostart'));
  assert.equal(autostartDir({}), path.join(os.homedir(), '.config', 'autostart'));
  assert.equal(autostartDir({ XDG_CONFIG_HOME: 'rel' }), path.join(os.homedir(), '.config', 'autostart'));
});

test('Exec quoting escapes the Desktop Entry reserved characters', () => {
  assert.equal(quoteArg('/opt/File Bridge/filebridge'), '"/opt/File Bridge/filebridge"');
  assert.equal(quoteArg('a"b`c$d\\e'), '"a\\"b\\`c\\$d\\\\e"');
});

test('the AppImage registers $APPIMAGE, not its temporary mount', () => {
  assert.equal(execTarget({ APPIMAGE: '/home/u/Apps/filebridge.AppImage' }, '/tmp/.mount_abc/filebridge'), '/home/u/Apps/filebridge.AppImage');
  assert.equal(execTarget({}, '/opt/FileBridge/filebridge'), '/opt/FileBridge/filebridge');
});

test('set(true) writes the entry with --hidden; get() reads it; set(false) removes it', () => {
  const dir = tmp();
  const a = createAutostart({ dir, env: {}, execPath: '/opt/FileBridge/filebridge' });
  assert.equal(a.get(), false);
  a.set(true);
  const text = fs.readFileSync(a.file, 'utf8');
  assert.match(text, /^\[Desktop Entry\]$/m);
  assert.match(text, /^Exec="\/opt\/FileBridge\/filebridge" "--hidden"$/m);
  assert.equal(a.get(), true);
  assert.ok(!fs.existsSync(a.file + '.tmp'));
  a.set(false);
  assert.equal(fs.existsSync(a.file), false);
  assert.equal(a.get(), false);
  a.set(false); // already off: no throw
});

test('an entry the desktop disabled (Hidden / X-GNOME-Autostart-enabled=false) reads as off', () => {
  const dir = tmp();
  const a = createAutostart({ dir, env: {}, execPath: '/x' });
  a.set(true);
  fs.writeFileSync(a.file, fs.readFileSync(a.file, 'utf8').replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false'));
  assert.equal(a.get(), false);
  a.set(true);
  fs.appendFileSync(a.file, 'Hidden=true\n');
  assert.equal(a.get(), false);
});

test('refresh() repoints a moved AppImage only while autostart is on', () => {
  const dir = tmp();
  const env = { APPIMAGE: '/old/filebridge.AppImage' };
  const a = createAutostart({ dir, env });
  a.refresh();
  assert.equal(fs.existsSync(a.file), false); // off stays off
  a.set(true);
  env.APPIMAGE = '/new/filebridge.AppImage';
  a.refresh();
  assert.match(fs.readFileSync(a.file, 'utf8'), /^Exec="\/new\/filebridge\.AppImage" "--hidden"$/m);
});

// ── tray detection ───────────────────────────────────────────────────────────
function fakeBus(answer, log = {}) {
  return () => ({
    on() {},
    disconnect() { log.disconnected = true; },
    async getProxyObject(name, objPath) {
      log.asked = [name, objPath];
      return { getInterface: () => ({ NameHasOwner: async n => { log.name = n; if (answer instanceof Error) throw answer; return answer; } }) };
    },
  });
}

test('tray: true off Linux without touching D-Bus', async () => {
  assert.equal(await trayAvailable({ platform: 'win32', sessionBus: () => { throw new Error('must not connect'); } }), true);
  assert.equal(await trayAvailable({ platform: 'darwin' }), true);
});

test('tray: asks the bus for the StatusNotifierWatcher owner and disconnects', async () => {
  const log = {};
  assert.equal(await trayAvailable({ platform: 'linux', sessionBus: fakeBus(true, log) }), true);
  assert.deepEqual(log.asked, ['org.freedesktop.DBus', '/org/freedesktop/DBus']);
  assert.equal(log.name, WATCHER);
  assert.equal(log.disconnected, true);
  assert.equal(await trayAvailable({ platform: 'linux', sessionBus: fakeBus(false) }), false);
});

test('tray: no session bus, a bus error, or a hung bus all mean "no tray"', async () => {
  assert.equal(await trayAvailable({ platform: 'linux', env: {} }), false);
  assert.equal(await trayAvailable({ platform: 'linux', sessionBus: fakeBus(new Error('boom')) }), false);
  assert.equal(await trayAvailable({ platform: 'linux', sessionBus: () => { throw new Error('no bus'); } }), false);
  const t0 = Date.now();
  const log = {};
  assert.equal(await trayAvailable({ platform: 'linux', timeoutMs: 50, sessionBus: fakeBus(new Promise(() => {}), log) }), false);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(log.disconnected, true);
});
