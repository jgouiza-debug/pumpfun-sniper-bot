# Running `pumpfun-sniper-bot.exe`

A single Windows executable. No Node.js, no `npm install`, no separate UI server —
double-click it and the dashboard opens in your browser.

## Build it

```bash
npm run build:exe
```

Output: `dist-exe/pumpfun-sniper-bot.exe` (~176 MB — it contains the Node runtime
and the compiled UI).

## Run it

Double-click the exe. It opens as a **desktop app window** — no address bar, no
tab strip, its own taskbar icon. **Closing the window stops the bot.**

Under the hood it still runs a local server on `http://localhost:3001` (loopback
only — nothing on your network can reach it) and renders the UI in a frameless
Chromium window via `--app=`. That is what makes it a window rather than a tab.

It looks for Edge first (present on every supported Windows install), then
Chrome, then Brave. If none is found it falls back to your default browser so
you still get a UI.

To use a different port:

```bash
set PORT=3055 && pumpfun-sniper-bot.exe
```

To run headless — no window, server only, keeps running until you kill it:

```bash
set SNIPER_NO_WINDOW=1 && pumpfun-sniper-bot.exe
```

## Supplying your Helius API key

Three ways, highest precedence first:

| # | Method | Persists? | Notes |
|---|---|---|---|
| 1 | **UI → Settings → Helius API Key** | until restart | Easiest. Applied immediately; the RPC connection is rebuilt on save. |
| 2 | Environment variable `HELIUS_API_KEY` | yes | `set HELIUS_API_KEY=your-key` before launching. |
| 3 | A `.env` file **next to the exe** | yes | One line: `HELIUS_API_KEY=your-key` |

A real environment variable always beats the `.env` file. The key entered in the
UI wins over both, because it is applied at runtime.

**The `.env` is never bundled into the binary.** If it were, whoever built the
exe would have their own key baked into every copy handed out. That is why
method 3 reads a file sitting *beside* the exe rather than inside it.

## Feature flags in a packaged build

The exe ships with `PACKAGED_DEFAULTS` (see `src/services/featureFlags.ts`):

| Flag | Shipped | Why |
|---|---|---|
| `honeypotChecks` | ON | Mint/freeze authority + Token-2022 hooks + post-fill sell simulation |
| `devSellStop` | ON | Creator / insider / cluster sell exits |
| `enforceTradeEconomics` | ON | Refuses trades whose round-trip cost exceeds `maxBreakevenPct` |
| `killSwitch` | ON | Hourly, daily and consecutive-loss breakers |
| `honestPaper` | ON | Paper fills priced off the real pool with the real fee stack |
| `playbookRouting` | ON | Measured curve-phase routing |
| `shadowGateV2`, `strictMigrationDetect` | ON | Logging / correct migration detection |
| `allInSizing` | **OFF** | 100% of wallet per trade is opt-in, never a default |
| `entryGateV2`, `localTxBuild`, `dynamicPriorityFee` | OFF | Need shadow validation before they change execution |

`flags.json` is **deliberately not bundled**, so a toggle on the build machine
cannot leak into a distributed copy. To override, drop a `flags.json` next to the
exe — toggling a flag in the UI writes that file for you.

> Measured 2026-08-10: before this was fixed, the exe run from a clean directory
> reported `Enabled: allInSizing` — all-in sizing on with every guard off. That is
> the worst combination this codebase can produce. A test now asserts the shipped
> set, so it cannot regress silently.

## First run checklist

1. Enter your Helius key (Settings).
2. Link a Photon wallet (Settings → Photon Wallet). The key is POSTed once and
   never read back through the API.
3. Leave **PAPER** mode selected and press START. Paper prices fills off the real
   pool and charges the real fees, so it shows you what the wallet would actually
   do.
4. Only switch to REAL when the preflight passes. If the wallet is too small it
   refuses to arm and tells you the minimum — it will not screen for an hour and
   silently trade nothing.

## Files the exe writes next to itself

| File | Purpose |
|---|---|
| `flags.json` | Written when you toggle a feature flag in the UI |
| `reports/` | Run reports (`.json` + `.md`) and candidate timelines |
| `.photon-wallet.json` | Only if you tick "persist" when linking a wallet |

## Known limits

- The app window is a frameless Chromium window, not a fully native shell. It
  needs Edge, Chrome or Brave installed — Edge always is on Windows. A truly
  self-contained window (custom icon, native menus, no installed-browser
  dependency) means switching the packaging to Electron or Tauri, which roughly
  doubles the binary and is a separate piece of work.
- **Windows x64 only.** `--targets host` builds for the machine doing the build.
- The binary bundles the compiled UI; `npm run build:exe` runs `vite build` first,
  so the UI is always current with the source at build time.
- Antivirus may flag any unsigned pkg-built binary. It is unsigned; sign it if you
  intend to distribute it widely.
