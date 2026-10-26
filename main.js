'use strict';
// FileBridge standalone — Electron main process.
// Step 1 skeleton: single instance + one window. server.js is deliberately NOT loaded yet:
// until DATA_DIR moves off %APPDATA%\bedrock-panel\file-bridge, loading it would arm a second
// scheduler on the Panel drop-in's live jobs. The filebridge:// protocol, tray, folder picker,
// and OAuth arrive in step 2.

const { app, BrowserWindow } = require('electron');
const path = require('path');

let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    win = new BrowserWindow({
      width: 1180, height: 800, minWidth: 700, minHeight: 480,
      autoHideMenuBar: true, backgroundColor: '#0d1117', title: 'FileBridge',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.on('closed', () => { win = null; });
    win.loadFile(path.join(__dirname, 'index.html'), { query: { _surface: 'window' } });
  });

  app.on('window-all-closed', () => app.quit());
}
