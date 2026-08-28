# Phase 4 — Desktop packaging notes

The app now ships as a **real native desktop application** (Electron), not "run `npm start` and open localhost." All work is on branch `audit/phase3-hardening`.

## Architecture decision: Electron (owner-chosen)

The engine is a Node/Express server with a React UI it already serves. Electron's main process **is** Node, so the engine runs **in-process** and the dashboard loads in a native `BrowserWindow`. This replaced the previous hack (a Chromium `--app=` window pointed at localhost).

| | Electron (chosen) | Tauri (considered) |
|---|---|---|
| Fit for a Node/Express engine | Runs it directly in the main process — smallest bridge | Engine must run as a bundled sidecar the Rust shell manages — more restructuring |
| Binary size | Larger (~190 MB unpacked) | Smaller |
| Secret storage | `safeStorage` built in (OS keychain), no native module | Would need a Rust-side keychain plugin |
| Auto-update | `electron-updater` + electron-builder, mature | `tauri-updater`, also fine |
| Effort here | Lowest — the engine was already the app | Highest |

**In-process vs sidecar:** the engine runs in Electron's main process. The trade is that an engine crash takes the window with it; acceptable for a single-operator console, and the crash is logged. A sidecar (spawn the engine as a child) is a clean future hardening if isolation becomes important.

## What was built

- `electron/main.js` — starts the engine (it self-starts on `require`), opens a frameless native window, single-instance lock (two windows would fight over the port and the live-mode wallet lock), routes external links (solscan/photon) to the real browser, and sets three env switches the engine honors: `SNIPER_NO_WINDOW` (Electron owns the window), `SNIPER_DATA_DIR` (per-user app-data dir), `SNIPER_PACKAGED` (drop dev-only surfaces). Quit routes through the engine's `gracefulShutdown` (records a clean shutdown, logs open positions).
- `electron/preload.js` — a contextIsolated bridge exposing only a secure-store status probe. No Node in the renderer.
- `build/icon.png` — app icon; electron-builder derives `.ico`/`.icns` per platform.
- `package.json` `build` block — appId, productName, per-platform targets (**Windows NSIS**, **macOS dmg**, **Linux AppImage + deb**), icon, and GitHub `publish` for electron-updater.
- Scripts: `build:win` / `build:mac` / `build:linux` (electron-builder), `electron` (build + run), `dist` (all three).

## Secret storage — OS keychain (owner-chosen)

Secrets are encrypted at rest with **Electron `safeStorage`**, which encrypts using a key held in the OS credential store: **Windows DPAPI, macOS Keychain, Linux libsecret**. No plaintext key file, and no native module to package (unlike keytar).

- `src/services/secureStore.ts` wraps safeStorage behind `encryptSecret`/`decryptSecret`. A guarded `require('electron')` means it degrades to a transparent plaintext passthrough under plain Node / the pkg exe, so the same code runs everywhere.
- `keyStore.ts` (API keys) and `walletService.ts` (wallet private key) route their reads/writes through it. Under the packaged app the `.api-keys.json` and `.photon-wallet.json` hold `ssb1:`-prefixed ciphertext; existing plaintext files still load and re-encrypt on the next write (fixes sec-keys-4's plaintext-key-on-disk exposure for the desktop build).

**Verified under real Electron:** `safeStorage.isEncryptionAvailable() === true`, `encryptSecret` produces `ssb1:…` ciphertext, and `decryptSecret` round-trips it back. (macOS/Linux keychains need an unlocked login session / a running keyring; where unavailable, secureStore passes through to plaintext — the same behavior as before, never a crash.)

## Versioning & auto-update

- Version stays in `package.json` (`1.0.8`); electron-builder stamps it into the installer and the update feed.
- `electron-updater` consumes GitHub releases (the `build.publish` config). It supersedes the pkg-exe updater and is the place real **code signing** lands (Phase 1 H6's provenance gap): Windows Authenticode + macOS Developer ID/notarization, wired via the CI secrets below. Until certs exist the builds are unsigned (fine for local testing; a signed release is required before distributing to others).

## Build & verification status (honest)

**Verified working locally (this Windows box):**
- `electron-builder --dir` produces a complete, runnable unpacked app: `release-app/win-unpacked/Pumpfun Sniper Bot.exe` (190 MB) + `app.asar` (35 MB, engine + production deps).
- Launched the packaged app: the engine boots inside it, serves the dashboard, reports paper/disabled with a live SOL price. `session-token` returns **404** in the packaged build. safeStorage round-trip confirmed.

**One code fix the packaging surfaced:** Electron bundles Node, and `@solana/web3.js → rpc-websockets` pulled `uuid@14` (ESM-only), which Electron's Node cannot `require()` (`ERR_REQUIRE_ESM`; dev's Node 24 tolerates it). Pinned `uuid@9.0.1` (has a CJS entry) via `overrides` — this also clears the sec-deps-2 advisory. The engine then starts cleanly under Electron's Node.

**Not producible on this box (environment, not config):**
- The **wrapped NSIS installer** needs symlink-creation privilege (Windows Developer Mode or admin) to unpack electron-builder's code-sign toolkit, and Defender repeatedly locks the freshly-written `app.asar`. Neither is available here.
- A **macOS `.dmg`** can only be built on a mac.

Both are exactly what CI is for. `.github/workflows/desktop.yml` builds all three platforms' installers on their native runners (`windows-latest`, `macos-latest`, `ubuntu-latest`), runs the full test suite first, and publishes to the GitHub release on a `v*` tag. Signing is opt-in via repo secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, and the Apple vars) so a fork without certs still builds unsigned artifacts.

## Owner action items for a distributable, signed release

1. Provide signing certs as repo secrets (Windows `.pfx` → `CSC_LINK`/`CSC_KEY_PASSWORD`; Apple Developer ID + notarization vars) — required before handing the app to anyone else, and the real fix for the updater-provenance gap (H6).
2. Decide the release channel vs. the pkg-exe lineage (the pkg `build:exe` + its updater still exist for the legacy Windows exe; the Electron path is the forward one). Retiring the divergent v1.0.9–v1.1.0 tags (Phase 1 C1) still applies.
3. Run the `desktop.yml` workflow (tag a release) to produce the actual `.exe`/`.dmg`/`.AppImage`/`.deb`.
