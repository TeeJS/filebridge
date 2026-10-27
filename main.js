'use strict';
// FileBridge standalone — Electron main process.
// Owns the window, tray, and lifecycle; supplies what the Bedrock Panel host used to:
//   filebridge://app/  page + /app-api + folder picker (shell/router.js, in-process, no socket)
//   ctx.oauth          Google Drive sign-in (shell/oauth.js)
//   boot load          server.js at startup, so schedules arm with the window closed
// Closing the window hides it to the tray; the scheduler keeps running until Quit.

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, protocol, shell } = require('electron');
const path = require('path');

// Data folder first: the OS's per-user app-data folder + FileBridge (%APPDATA% on Windows,
// ~/Library/Application Support on macOS, ~/.config on Linux) holds only FileBridge's own files
// (jobs, rules, results, oauth.json, status). Chromium's cache/cookies go to the OS cache folder.
// server.js reads FILEBRIDGE_DATA_DIR at load, so this must run before it is required.
// A development run (`npm start`) uses FileBridge-dev, so it can never schedule the installed
// app's real jobs (nor share its single-instance lock).
const DATA_NAME = app.isPackaged ? 'FileBridge' : 'FileBridge-dev';
app.setPath('userData', path.join(app.getPath('appData'), DATA_NAME));
// Web-drop sign-ins live in this session folder, so it must survive reboots: never a temp folder
// (macOS purges its per-user temp dir; most Linux distros wipe /tmp at boot).
function sessionDir() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || app.getPath('appData'), DATA_NAME, 'session');
  if (process.platform === 'darwin') return path.join(app.getPath('home'), 'Library', 'Caches', DATA_NAME, 'session');
  return path.join(process.env.XDG_CACHE_HOME || path.join(app.getPath('home'), '.cache'), DATA_NAME, 'session');
}
app.setPath('sessionData', sessionDir());
process.env.FILEBRIDGE_DATA_DIR = app.getPath('userData');
process.env.FILEBRIDGE_VERSION = app.getVersion(); // stamped into status.json

protocol.registerSchemesAsPrivileged([
  { scheme: 'filebridge', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const { DriveAuth } = require('./shell/oauth');
const { createRouter } = require('./shell/router');

// The login item passes --hidden on Windows and Linux. macOS ignores setLoginItemSettings' args, so
// there a login launch carries no flag; whenReady asks the OS (wasOpenedAtLogin) instead.
let START_HIDDEN = process.argv.includes('--hidden');
const ICON = path.join(__dirname, 'assets', 'icon.png');
const log = m => console.log(m);

let win = null;
let tray = null;
let server = null;
let quitting = false;

let driveAuth = null; // created at ready, beside jobs.json in the data folder
const oauth = {
  status: () => driveAuth.status(),
  connect: (scopes, creds) => driveAuth.connect(scopes, creds),
  disconnect: () => driveAuth.disconnect(),
  getAccessToken: scopes => driveAuth.getAccessToken(scopes),
};

function getServer() {
  if (!server) server = require('./server');
  return server;
}

async function pickFolder(defaultPath) {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: 'Choose a folder',
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || !r.filePaths.length ? { ok: false, canceled: true } : { ok: true, path: r.filePaths[0] };
}

function showWindow() {
  // macOS: a --hidden start drops the Dock icon (see whenReady). Opening the window is the
  // point at which FileBridge stops being a background agent, so put it back.
  if (process.platform === 'darwin' && app.dock) app.dock.show();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 700, minHeight: 480,
    autoHideMenuBar: true, backgroundColor: '#0d1117', title: 'FileBridge', icon: ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Close keeps FileBridge running: hidden to the tray where there is one, minimized where there
  // isn't (a desktop with no tray would leave an invisible, unreachable app).
  win.on('close', e => { if (!quitting) { e.preventDefault(); if (hideToTray) win.hide(); else win.minimize(); } });
  win.on('closed', () => { win = null; });
  // Windows sign-out / restart / shutdown: Electron emits no before-quit then, so unwind here
  // (stop the run cleanly, write running:false) and let the window close.
  win.on('session-end', () => { quitting = true; shutdown(); });
  // The page links out (Drive folders, docs) — send those to the browser, never a new app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('filebridge://app/')) e.preventDefault(); });
  win.loadURL('filebridge://app/index.html');
}

// ── Start at login, per OS ─────────────────────────────────────────────────────
// Only meaningful for a packaged build: in development it would register electron itself.
// Windows and macOS use Electron's login items. The portable Windows exe unpacks to %TEMP% and
// runs from there, so it registers the exe the user actually launched (PORTABLE_EXECUTABLE_FILE),
// not the temporary copy, whose path changes.
const loginArgs = ['--hidden'];
const loginItem = () => {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  return portable ? { path: portable, args: loginArgs } : { args: loginArgs };
};
const startAtLogin = {
  label: process.platform === 'win32' ? 'Start with Windows' : process.platform === 'darwin' ? 'Open at Login' : 'Start at login',
  get: () => app.getLoginItemSettings(loginItem()).openAtLogin,
  set: on => app.setLoginItemSettings(Object.assign({ openAtLogin: on }, loginItem())),
};
// Electron has no login items on Linux: there it is an XDG autostart .desktop entry pointing at
// $APPIMAGE or the installed binary (shell/autostart-linux.js).
if (process.platform === 'linux') {
  const xdg = require('./shell/autostart-linux').createAutostart({ args: loginArgs });
  startAtLogin.get = xdg.get;
  startAtLogin.set = xdg.set;
  startAtLogin.refresh = xdg.refresh;
}

// ── tray ───────────────────────────────────────────────────────────────────────
// Whether closing the window can hide to a tray. Decided once at startup (see whenReady).
let hideToTray = true;
// On Linux a tray needs a StatusNotifierWatcher on the session bus (KDE always, GNOME only with
// the AppIndicator extension); shell/tray-detect.js asks. Elsewhere it is always true.
const canHideToTray = () => require('./shell/tray-detect').trayAvailable();
// The menu bar tints a template image itself, so macOS gets a black-on-transparent glyph
// (assets/trayTemplate.png, with the @2x beside it picked up automatically) instead of the
// colour app icon squeezed to 16px. Without this it does not invert against a light menu bar
// or under the tinted modes, and the downscale is soft on Retina.
const trayImage = () => {
  if (process.platform !== 'darwin') return nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  img.setTemplateImage(true);
  return img;
};

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open FileBridge', click: showWindow },
    { type: 'separator' },
    {
      label: app.isPackaged ? startAtLogin.label : startAtLogin.label + ' (installed app only)',
      type: 'checkbox', enabled: app.isPackaged, checked: app.isPackaged && startAtLogin.get(),
      click: item => {
        startAtLogin.set(item.checked);
        tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    { label: 'Quit FileBridge', click: () => { quitting = true; app.quit(); } },
  ]);
}

let shutDown = false;
function shutdown() {
  if (shutDown) return;
  shutDown = true;
  try { if (server && server._shutdown) server._shutdown(); } catch {}
  if (driveAuth) driveAuth.stop();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch (double-click, Start menu) shows this instance's window — once it is ready.
  app.on('second-instance', () => { app.whenReady().then(showWindow); });

  // macOS: a running app does not relaunch. Clicking its Dock icon or picking it in the app
  // switcher fires 'activate' instead, so without this, closing the window (which hides it)
  // left the Dock icon dead and only the menu bar could bring FileBridge back.
  app.on('activate', () => { app.whenReady().then(showWindow); });

  app.whenReady().then(async () => {
    hideToTray = await canHideToTray().catch(() => false);
    // A moved AppImage leaves its autostart entry pointing at the old path; repoint it while on.
    if (app.isPackaged && startAtLogin.refresh) { try { startAtLogin.refresh(); } catch {} }
    driveAuth = new DriveAuth({
      file: path.join(process.env.FILEBRIDGE_DATA_DIR, 'oauth.json'),
      openExternal: async url => { await shell.openExternal(url); return true; },
      log,
    });
    protocol.handle('filebridge', createRouter({ root: __dirname, getServer, oauth, pickFolder, log }));

    // Load the engine now so cron schedules arm without the window, and hand it the Drive
    // sign-in up front (server.js captures ctx.oauth on any handle() call).
    getServer().handle('status', { oauth }).catch(e => log('[boot] ' + (e && e.message || e)));

    tray = new Tray(trayImage());
    tray.setToolTip('FileBridge');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', showWindow);

    if (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin) START_HIDDEN = true;

    // macOS: started at login, FileBridge is a background agent — a Dock icon and
    // an app menu for a window that does not exist are noise. showWindow() puts the Dock icon
    // back the moment the user opens it from the menu bar. (mac always has a menu bar, so the
    // no-tray branch below never runs there and cannot fight this.)
    if (process.platform === 'darwin' && START_HIDDEN && app.dock) app.dock.hide();

    // Started hidden at login with no tray to reopen from: start minimized instead, so the app
    // is still reachable from the taskbar.
    if (!START_HIDDEN) showWindow();
    else if (!hideToTray) { showWindow(); win.minimize(); }
  }).catch(e => {
    // Never linger as an invisible process holding the single-instance lock.
    dialog.showErrorBox('FileBridge could not start', String((e && e.stack) || e));
    app.exit(1);
  });

  // The tray keeps the app (and its schedules) alive with no window open.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; shutdown(); });
}
