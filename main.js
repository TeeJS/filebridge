'use strict';
// FileBridge standalone — Electron main process.
// Owns the window, tray, and lifecycle; supplies what the Bedrock Panel host used to:
//   filebridge://app/  page + /app-api + folder picker (shell/router.js, in-process, no socket)
//   ctx.oauth          Google Drive sign-in (shell/oauth.js)
//   boot load          server.js at startup, so schedules arm with the window closed
// Closing the window hides it to the tray; the scheduler keeps running until Quit.

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, protocol, shell } = require('electron');
const path = require('path');

// Data folder first: %APPDATA%\FileBridge holds only FileBridge's own files (jobs, rules,
// results, oauth.json, status). Chromium's cache/cookies go to %LOCALAPPDATA%\FileBridge\session.
// server.js reads FILEBRIDGE_DATA_DIR at load, so this must run before it is required.
app.setPath('userData', path.join(app.getPath('appData'), 'FileBridge'));
app.setPath('sessionData', path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'FileBridge', 'session'));
process.env.FILEBRIDGE_DATA_DIR = app.getPath('userData');

protocol.registerSchemesAsPrivileged([
  { scheme: 'filebridge', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const { DriveAuth } = require('./shell/oauth');
const { createRouter } = require('./shell/router');

const START_HIDDEN = process.argv.includes('--hidden');
const ICON = path.join(__dirname, 'assets', 'icon.png');
const log = m => console.log(m);

let win = null;
let tray = null;
let server = null;
let quitting = false;

const driveAuth = new DriveAuth({
  file: path.join(app.getPath('userData'), 'oauth.json'),
  openExternal: async url => { await shell.openExternal(url); return true; },
  log,
});
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
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
  // The page links out (Drive folders, docs) — send those to the browser, never a new app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('filebridge://app/')) e.preventDefault(); });
  win.loadURL('filebridge://app/index.html?_surface=window');
}

// "Start with Windows" only means something for the installed app: in development it would
// register electron.exe itself.
const loginArgs = ['--hidden'];
const startsWithWindows = () => app.getLoginItemSettings({ args: loginArgs }).openAtLogin;

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open FileBridge', click: showWindow },
    { type: 'separator' },
    {
      label: app.isPackaged ? 'Start with Windows' : 'Start with Windows (installed app only)',
      type: 'checkbox', enabled: app.isPackaged, checked: app.isPackaged && startsWithWindows(),
      click: item => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: loginArgs });
        tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    { label: 'Quit FileBridge', click: () => { quitting = true; app.quit(); } },
  ]);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    protocol.handle('filebridge', createRouter({ root: __dirname, getServer, oauth, pickFolder, log }));

    // Load the engine now so cron schedules arm without the window, and hand it the Drive
    // sign-in up front (server.js captures ctx.oauth on any handle() call).
    getServer().handle('status', { oauth }).catch(e => log('[boot] ' + (e && e.message || e)));

    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('FileBridge');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', showWindow);

    if (!START_HIDDEN) showWindow();
  });

  // The tray keeps the app (and its schedules) alive with no window open.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true;
    try { if (server && server._shutdown) server._shutdown(); } catch {}
    driveAuth.stop();
  });
}
