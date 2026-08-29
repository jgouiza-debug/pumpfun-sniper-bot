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
const { autoUpdater } = require('electron-updater');
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

/**
 * Background auto-update for the installed desktop app.
 *
 * electron-updater reads the release's latest*.yml (published by
 * .github/workflows/desktop.yml) and downloads the new installer in the
 * background, so the user never re-downloads by hand. It is applied on quit,
 * NOT mid-session: swapping the app out from under a running engine would
 * strand open positions, and quit already runs the clean-shutdown path.
 *
 * Only a packaged build has a release to update from — a source checkout run
 * via `electron .` would just error against its own dev version.
 */
function wireAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Offline, rate-limited, or a release without this platform's asset. The
  // periodic check retries; a failed update must never take the window down.
  autoUpdater.on('error', () => {});
  // Checks, downloads, and shows a native "update ready" notification.
  const check = () => { autoUpdater.checkForUpdatesAndNotify().catch(() => {}); };
  check();
  setInterval(check, 6 * 60 * 60 * 1000).unref();
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
    clearOwnQuarantine();
    startEngine();
    createWindow();
    wireAutoUpdate();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  /**
   * Clear macOS's download-quarantine flag from our OWN bundle, at every start.
   *
   * This app is ad-hoc signed but not notarized (notarizing needs a paid Apple
   * Developer ID). macOS attaches com.apple.quarantine to anything downloaded,
   * and for a non-notarized app that flag makes the NEXT launch fail with
   * "Apple could not verify ... is free of malware". auto-update re-downloads
   * the app, so the flag comes back on every single update and the user is
   * blocked again — they had to re-clear it by hand after 2.0.6, 2.0.7, 2.0.9
   * and 2.0.10, which is most of why the bot kept being "broken".
   *
   * Doing it here is safe and self-healing: we only reach this line because
   * Gatekeeper already admitted THIS launch, and we only touch our own bundle.
   * It fixes the launch after the next update rather than the current one.
   */
  function clearOwnQuarantine() {
    if (process.platform !== 'darwin') return;
    try {
      // .../Pumpfun Sniper Bot.app/Contents/MacOS/<exe> -> the .app bundle
      const bundle = path.resolve(path.dirname(process.execPath), '..', '..');
      if (!bundle.endsWith('.app')) return;
      require('child_process').execFile('xattr', ['-dr', 'com.apple.quarantine', bundle], () => {});
    } catch { /* never block startup on this */ }
  }

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
