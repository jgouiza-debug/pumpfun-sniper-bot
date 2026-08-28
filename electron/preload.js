// Preload: a minimal, safe bridge between the dashboard (renderer) and the
// Electron main process. contextIsolation is on and nodeIntegration is off, so
// the renderer only ever sees this curated surface — never Node or the full
// Electron API.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sniperDesktop', {
  /** True when running inside the packaged desktop app (vs a plain browser). */
  isDesktop: true,
  /** Whether secrets are OS-keychain-encrypted at rest, and where data lives. */
  secureStoreStatus: () => ipcRenderer.invoke('secure-store:status'),
});
