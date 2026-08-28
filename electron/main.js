// Electron main process — the desktop shell for the sniper/copy-trade bot.
//
// It runs the existing Express engine IN-PROCESS (the server self-starts when
// required) and shows the dashboard in a native BrowserWindow instead of the
// old Chromium `--app` hack. The engine's per-install files (wallet key, API
// keys, state, reports) resolve to the OS per-user app-data directory via
// SNIPER_DATA_DIR, and secrets are encrypted at rest with the OS keychain
// (see src/services/secureStore.ts, which uses Electron's safeStorage — the
// same process, so it is available to the engine).
//
// In-process (not a sidecar) is deliberate: the engine is Node/Express and
// Electron's main IS Node, so this is the smallest reliable bridge. The trade
// is that an engine crash takes the window with it — acceptable for a
// single-operator trading console, and the crash is logged either way.

const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require('electron');
const path = require('path');

const PORT = Number(process.env.PORT) || 3001;
const APP_TITLE = 'Pumpfun Sniper Bot';
let engineStarted = false;

function startEngine() {
  if (engineStarted) return;
  engineStarted = true;

  // Electron owns the window; tell the server not to open its own.
  process.env.SNIPER_NO_WINDOW = '1';
  // Per-install files go to the real per-user app-data dir, never Program Files.
  process.env.SNIPER_DATA_DIR = app.getPath('userData');
  // Mark a real packaged build so the engine can drop dev-only surfaces (e.g.
  // the session-token endpoint). Not set for `electron .` on a source checkout.
  if (app.isPackaged) process.env.SNIPER_PACKAGED = '1';

  try {
    // The compiled server self-starts on require (calls startListening()).
    require(path.join(__dirname, '..', 'dist', 'server.js'));
  } catch (err) {
    dialog.showErrorBox(
      'Engine failed to start',
      `The trading engine could not start:\n\n${err && err.stack ? err.stack : String(err)}\n\n` +
      `If you launched a source checkout, run "npm run build" first.`
    );
    app.quit();
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: APP_TITLE,
    backgroundColor: '#0b0e14',
    icon: path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setMenuBarVisibility(false);

  // Open external links (solscan, photon) in the real browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'deny' };
  });

  // The engine takes a moment to bind the port; retry the load until it is up.
  const url = `http://localhost:${PORT}`;
  const tryLoad = () => {
    win.loadURL(url).catch(() => setTimeout(tryLoad, 400));
  };
  tryLoad();
  return win;
}

// Single instance: two windows would fight over the port and (in real mode) the
// wallet lock. Focus the existing window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    startEngine();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Quitting ends the engine (same process). The server's SIGTERM/exit path
    // records a clean shutdown and logs any open positions.
    app.quit();
  });
}

// ---- Secrets IPC (renderer -> main), OS-keychain status for the UI. ----
ipcMain.handle('secure-store:status', () => {
  let available = false;
  try { available = safeStorage.isEncryptionAvailable(); } catch { /* unavailable */ }
  return { available, platform: process.platform, dataDir: app.getPath('userData') };
});
