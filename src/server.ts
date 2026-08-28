// MUST STAY FIRST. This import populates process.env from a .env beside the
// exe, and every service imported below reads its credentials at construction
// time — the SniperEngine singleton included. See services/loadEnv.ts.
import './services/loadEnv';
// SECOND, before any service constructs: tee console.log/warn/error into
// bot.log beside the exe. The 2026-08-23 stranded-position session was almost
// undiagnosable because every log lived only in memory.
import './services/installFileLog';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import WebSocket from 'ws';
import { RugCheckService } from './services/rugcheckService';
import { RiskFilter } from './filters/riskFilter';
import { DexScreenerService } from './services/dexscreenerService';
import { FilterResult, PumpTokenLaunch } from './types';
import { sniperEngine } from './services/sniperEngine';
import { copyTrader } from './services/copyTraderService';
import { reportService } from './services/reportService';
import { featureFlags, FeatureFlagSet } from './services/featureFlags';
import { latencyTimeline, LatencyTimelineLogger } from './services/latencyTimeline';
import { entryGateV2 } from './services/entryGateV2';
import { localTxBuilder } from './services/localTxBuilder';
import { updaterService } from './services/updaterService';
import { apiToken, isLoopbackOrigin, originGuard, requireApiToken } from './services/apiAuth';
// ─── Hardened crash guards ──────────────────────────────────────────────────
// @solana/web3.js retries 429 / timeout errors internally then re-throws.
// Without these guards that unhandled rejection kills the process instantly.
//
// Staying alive is the point; staying SILENT was a bug. These used to `return`
// on anything network-shaped, so a storm of RPC failures — the exact condition
// under which a position stops being priced and an exit stops being evaluated —
// left no trace anywhere. A trading process must never hide its own faults, so
// every one is logged; only the log level differs.
function reportProcessFault(kind: 'Uncaught Exception' | 'Unhandled Rejection', err: any): void {
  const msg = err?.message || String(err);
  const expected = /429|timeout|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(msg);
  if (expected) {
    // Routine transport noise: one line, no stack, still visible and countable.
    console.warn(`⚠️ [${kind} — transport, server kept alive]: ${msg}`);
    return;
  }
  console.error(`❌ [${kind} — UNEXPECTED, server kept alive]: ${msg}`);
  if (err?.stack) console.error(err.stack);
}

process.on('uncaughtException', (err: Error) => reportProcessFault('Uncaught Exception', err));
process.on('unhandledRejection', (reason: any) => reportProcessFault('Unhandled Rejection', reason));


const app = express();

// Refuse non-loopback origins before any handler runs. This is the control that
// actually stops a random browser tab from POSTing to the trading endpoints —
// `cors()` alone never did, because it only gates whether the caller may READ
// the response, not whether the handler executes. See services/apiAuth.ts.
app.use(originGuard);

// CORS headers still matter for the instance switcher: the UI served by :3001
// reads responses from the API on :3002. Loopback only, mirroring the guard.
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || isLoopbackOrigin(origin)),
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Sniper-Token'],
}));
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001;

// Hand the token to the local UI. Reachable only from a loopback origin (the
// guard above), which is the same bar the mutating endpoints sit behind — so
// this exposes nothing a same-machine browser page could not already reach. It
// exists for the vite dev server on :3010 and for cross-instance calls, where
// the token injected into the served HTML is not the target instance's.
app.get('/api/session-token', (req, res) => {
  res.json({ token: apiToken() });
});

// Every state-changing API call needs the token. Applied by method rather than
// per-route so an endpoint added later is protected by default instead of by
// remembering. GETs stay open behind the origin guard — they are status reads.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  return requireApiToken(req, res, next);
});

// Serve the built UI from this same process, so http://localhost:3001 is the
// whole app — no separate vite window to keep alive. `npm run build` refreshes
// dist/; `npm run ui` still gives the hot-reload dev server on 3010.
const candidateDirs = [
  path.resolve(process.cwd(), 'dist'),
  path.resolve(__dirname, 'dist'),
  path.resolve(__dirname, '../dist'),
  path.resolve(__dirname, '../../dist')
];

let validDistDir: string | null = null;
for (const dir of candidateDirs) {
  if (fs.existsSync(path.join(dir, 'index.html'))) {
    validDistDir = dir;
    break;
  }
}

/**
 * Serve index.html with this instance's API token embedded.
 *
 * A cross-origin page cannot read this HTML (no CORS on the document), so the
 * token reaches our own UI and nothing else. `index: false` on the static
 * middleware is load-bearing — otherwise it would serve the raw file for `/`
 * and the UI would boot without a token.
 */
function indexHtmlWithToken(distDir: string): string {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const inject = `<script>window.__SNIPER_API_TOKEN__=${JSON.stringify(apiToken())};</script>`;
  return html.includes('</head>')
    ? html.replace('</head>', `${inject}</head>`)
    : inject + html;
}

if (validDistDir) {
  app.use(express.static(validDistDir, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    try {
      res.type('html').send(indexHtmlWithToken(validDistDir!));
    } catch {
      res.sendFile(path.join(validDistDir!, 'index.html'));
    }
  });
  console.log(`🖥️  Serving UI from ${validDistDir} — open http://localhost:${PORT}`);
} else {
  console.warn('⚠️ dist/ not found — run `npm run build` to serve the UI from this port.');
}

const rugCheckService = new RugCheckService({
  maxRetries: 2,
  retryDelayMs: 300,
  rateLimitMs: 200,
});

const riskFilter = new RiskFilter();

let cachedResults: FilterResult[] = [];
let isScanning = false;

// Collect live Pump.fun tokens directly from PumpPortal WebSocket stream
function collectLiveFreshLaunches(targetCount: number = 6, maxWaitMs: number = 10000): Promise<PumpTokenLaunch[]> {
  return new Promise((resolve) => {
    const launches: PumpTokenLaunch[] = [];
    const seen = new Set<string>();

    console.log('📡 Subscribing to live Pump.fun launches via wss://pumpportal.fun/api/data ...');
    const ws = new WebSocket('wss://pumpportal.fun/api/data');

    let timeoutTimer: NodeJS.Timeout;

    const cleanupAndResolve = () => {
      clearTimeout(timeoutTimer);
      try { ws.close(); } catch (e) {}
      console.log(`✅ Collected ${launches.length} fresh real-time Pump.fun launches.`);
      resolve(launches);
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const payload = JSON.parse(data.toString());
        if (payload.mint && !seen.has(payload.mint)) {
          seen.add(payload.mint);
          // Pass the raw stream fields straight through. Market metrics are
          // resolved from live data downstream rather than stubbed here.
          launches.push({
            mint: payload.mint,
            name: payload.name || 'Fresh Pump Token',
            symbol: payload.symbol || 'FRESH',
            creator: payload.traderPublicKey || 'Unknown',
            timestamp: Date.now(),
            marketCapSol: payload.marketCapSol,
            bondingProgress: payload.bondingProgress,
            vSolInBondingCurve: payload.vSolInBondingCurve,
            vTokensInBondingCurve: payload.vTokensInBondingCurve,
          });

          console.log(`✨ [LIVE STREAM] Fresh token captured: $${payload.symbol} (${payload.mint})`);

          if (launches.length >= targetCount) {
            cleanupAndResolve();
          }
        }
      } catch (e) {
        // ignore
      }
    });

    ws.on('error', (err) => {
      console.warn('WS Stream notice:', err.message);
    });

    timeoutTimer = setTimeout(() => {
      cleanupAndResolve();
    }, maxWaitMs);
  });
}

// ---------------- API ENDPOINTS ----------------

// GET Bot Status & Active Positions & Stats & Logs
app.get('/api/bot/status', (req, res) => {
  res.json(sniperEngine.getStatus());
});

// POST Toggle Bot ON / OFF
app.post('/api/bot/toggle', (req, res) => {
  const active = sniperEngine.toggleBot(req.body?.active);
  res.json({ success: true, isBotActive: active });
});

// POST Update Bot Strategy Config
app.post('/api/bot/config', (req, res) => {
  sniperEngine.updateConfig(req.body);
  res.json({ success: true, config: sniperEngine.getConfig() });
});

// POST Manual Sell Position Override
app.post('/api/bot/sell-position', async (req, res) => {
  const { positionId } = req.body;
  if (!positionId) return res.status(400).json({ error: 'positionId is required' });

  const success = await sniperEngine.manualSellPosition(positionId);
  res.json({ success, message: success ? 'Position sold successfully' : 'Position not found' });
});

// POST Clear Trade History
app.post('/api/bot/clear-history', (req, res) => {
  sniperEngine.clearTradeHistory();
  res.json({ success: true });
});

// POST Screening Endpoint
app.post('/api/screen', async (req, res) => {
  if (isScanning) {
    return res.status(429).json({ error: 'Scan already in progress. Please wait.' });
  }

  isScanning = true;
  try {
    const rawFilterConfig = req.body?.config;
    if (rawFilterConfig) {
      riskFilter.updateConfig(rawFilterConfig);
    }

    const launches = await collectLiveFreshLaunches(6, 10000);
    const results: FilterResult[] = [];

    for (const launch of launches) {
      const filterResult = await sniperEngine.processIncomingToken(launch);
      if (filterResult) {
        results.push(filterResult);
      }
    }

    cachedResults = results;
    res.json({
      timestamp: Date.now(),
      total: results.length,
      safeCount: results.filter((r) => r.isSafe).length,
      riskyCount: results.filter((r) => !r.isSafe).length,
      tokens: results,
      botStatus: sniperEngine.getStatus(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  } finally {
    isScanning = false;
  }
});

// GET Latest Results
app.get('/api/results', (req, res) => {
  res.json({
    timestamp: Date.now(),
    isScanning,
    tokens: cachedResults,
    botStatus: sniperEngine.getStatus(),
  });
});

// ---------------- FEATURE FLAGS / SAFETY / TELEMETRY ----------------

// GET all feature flags (audit fixes ship dark; everything here defaults OFF)
app.get('/api/flags', (req, res) => {
  res.json({
    flags: featureFlags.all(),
    gateV2Config: entryGateV2.getConfig(),
    localBuildParity: localTxBuilder.getParityStatus(),
  });
});

// POST toggle one flag: { "flag": "shadowGateV2", "value": true }
app.post('/api/flags', (req, res) => {
  const { flag, value } = req.body || {};
  if (typeof flag !== 'string' || typeof value !== 'boolean') {
    return res.status(400).json({ error: 'Body must be { flag: string, value: boolean }' });
  }
  try {
    const all = featureFlags.set(flag as keyof FeatureFlagSet, value);
    res.json({ success: true, flags: all });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST immediate manual stop — pause entries, retain open positions
app.post('/api/bot/kill', (req, res) => {
  res.json(sniperEngine.emergencyStop());
});

// POST shutdown dev server process completely
app.post('/api/server/shutdown', (req, res) => {
  res.json({ success: true, message: 'Dev server process is shutting down.' });
  console.log('🛑 Dev server shutdown requested via UI. Terminating process...');
  setTimeout(() => {
    process.exit(0);
  }, 500);
});

// GET recent T0-T7 candidate timelines with per-stage durations
app.get('/api/timelines', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const items = latencyTimeline.getRecent(limit).map(t => ({
    ...t,
    payload: undefined, // trim raw payloads from the API view; the JSONL keeps them
    launchData: undefined,
    rug: undefined,
    durations: LatencyTimelineLogger.stageDurations(t),
  }));
  res.json({ count: items.length, items });
});

// ---------------- REAL-TIME STREAM ----------------

// Server-Sent Events push of the full bot status. SSE rides plain HTTP, so the
// loopback-only binding and CORS middleware apply unchanged.
//
// Event-driven, not timer-driven: the engine notifies on every state change
// (order submitted, fill confirmed, position opened/closed, price moved) and
// the frame goes out immediately. A fixed 1s timer meant a buy or a sell could
// sit invisible for up to a second after it had already happened.
//
// Bursts are coalesced to one frame per SSE_MIN_GAP_MS so a busy screening
// stream cannot flood the socket, and a slow heartbeat still refreshes
// time-derived fields (runtime clock, log ageing) when nothing is happening.
const SSE_MIN_GAP_MS = 25;
const SSE_HEARTBEAT_MS = 250;

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let alive = true;
  let lastPushAt = 0;
  let coalesceTimer: NodeJS.Timeout | null = null;

  const push = () => {
    if (!alive) return;
    lastPushAt = Date.now();
    try {
      res.write(`data: ${JSON.stringify(sniperEngine.getStatus())}\n\n`);
    } catch {
      alive = false;
    }
  };

  /** Push now if we are outside the quiet window, otherwise at the end of it. */
  const schedulePush = () => {
    if (!alive || coalesceTimer) return;
    const sinceLast = Date.now() - lastPushAt;
    if (sinceLast >= SSE_MIN_GAP_MS) {
      push();
      return;
    }
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null;
      push();
    }, SSE_MIN_GAP_MS - sinceLast);
  };

  push(); // snapshot on connect — no blank dashboard while waiting for the first event
  const unsubscribe = sniperEngine.onChange(schedulePush);
  const heartbeat = setInterval(push, SSE_HEARTBEAT_MS);

  req.on('close', () => {
    alive = false;
    unsubscribe();
    clearInterval(heartbeat);
    if (coalesceTimer) clearTimeout(coalesceTimer);
  });
});

// ---------------- COPY TRADING ----------------

// GET full copy-trader state: config, wallets, positions, feed, stats
app.get('/api/copy/status', (req, res) => {
  res.json(copyTrader.getStatus());
});

// POST master switch: { enabled: boolean }
app.post('/api/copy/toggle', (req, res) => {
  const result = copyTrader.setEnabled(req.body?.enabled === true);
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  res.json({ success: true, status: copyTrader.getStatus() });
});

// POST partial config update — unknown keys dropped, numerics clamped
app.post('/api/copy/config', (req, res) => {
  const result = copyTrader.updateConfig(req.body || {});
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  res.json({ success: true, config: copyTrader.getStatus().config });
});

// POST track a new leader wallet: { address, nickname? }
app.post('/api/copy/wallets', (req, res) => {
  const { address, nickname } = req.body || {};
  const result = copyTrader.addWallet(String(address || ''), nickname);
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  res.json({ success: true });
});

// POST stop tracking: { address }
app.post('/api/copy/wallets/remove', (req, res) => {
  const removed = copyTrader.removeWallet(String(req.body?.address || ''));
  res.status(removed ? 200 : 404).json({ success: removed });
});

// POST per-wallet patch: { address, enabled?, nickname? }
app.post('/api/copy/wallets/update', (req, res) => {
  const { address, enabled, nickname } = req.body || {};
  const updated = copyTrader.updateWallet(String(address || ''), { enabled, nickname });
  res.status(updated ? 200 : 404).json({ success: updated });
});

// POST force-sell one copy position: { positionId }
app.post('/api/copy/sell', async (req, res) => {
  const { positionId } = req.body || {};
  if (!positionId) return res.status(400).json({ error: 'positionId is required' });
  const success = await copyTrader.manualSellPosition(String(positionId));
  res.json({ success });
});

// POST force-close / dismiss one copy position: { positionId }
app.post('/api/copy/positions/close', (req, res) => {
  const { positionId } = req.body || {};
  if (!positionId) return res.status(400).json({ error: 'positionId is required' });
  const success = copyTrader.forceClosePosition(String(positionId));
  res.status(success ? 200 : 404).json({ success });
});

// POST wipe feed + receipts (open positions are kept)
app.post('/api/copy/clear-history', (req, res) => {
  copyTrader.clearHistory();
  res.json({ success: true });
});

// GET auto-updater status check against GitHub API
app.get('/api/updater/check', async (req, res) => {
  try {
    const status = await updaterService.checkForUpdates();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to check for updates' });
  }
});

// GET download/verify progress for an in-flight self-update
app.get('/api/updater/progress', (req, res) => {
  res.json(updaterService.getProgress());
});

// POST download, verify and install the published release, then restart.
// Token-gated like every other mutating route: this one replaces the binary.
app.post('/api/updater/apply', async (req, res) => {
  const result = await updaterService.applyUpdate();
  res.status(result.ok ? 200 : 400).json(result);
});

/**
 * Refuse to restart mid-trade.
 *
 * An update swaps the exe and relaunches it. With a position open that would
 * strand the bag between two processes, and the real-mode lock would be held by
 * a PID that is about to vanish. Wired here rather than inside the updater so
 * that module stays free of engine imports.
 */
updaterService.setRestartGuard(() => {
  const status = sniperEngine.getStatus();
  if (status.activePositions?.length) {
    return { ok: false, reason: `${status.activePositions.length} position(s) still open — close them before updating.` };
  }
  if (status.isBotActive) {
    return { ok: false, reason: 'Stop the bot before updating.' };
  }
  const copy = copyTrader.getStatus();
  if (copy.positions?.length) {
    return { ok: false, reason: `${copy.positions.length} copy position(s) still open — close them before updating.` };
  }
  if (copy.enabled) {
    return { ok: false, reason: 'Stop copy trading before updating.' };
  }
  return { ok: true };
});

// SSE push of the copy-trader state — same contract as /api/stream.
app.get('/api/copy/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let alive = true;
  let lastPushAt = 0;
  let coalesceTimer: NodeJS.Timeout | null = null;

  const push = () => {
    if (!alive) return;
    lastPushAt = Date.now();
    try {
      res.write(`data: ${JSON.stringify(copyTrader.getStatus())}\n\n`);
    } catch {
      alive = false;
    }
  };

  const schedulePush = () => {
    if (!alive || coalesceTimer) return;
    const sinceLast = Date.now() - lastPushAt;
    if (sinceLast >= SSE_MIN_GAP_MS) {
      push();
      return;
    }
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null;
      push();
    }, SSE_MIN_GAP_MS - sinceLast);
  };

  push();
  const unsubscribe = copyTrader.onChange(schedulePush);
  const heartbeat = setInterval(push, SSE_HEARTBEAT_MS);

  req.on('close', () => {
    alive = false;
    unsubscribe();
    clearInterval(heartbeat);
    if (coalesceTimer) clearTimeout(coalesceTimer);
  });
});

// ---------------- PHOTON WALLET ----------------

// GET wallet status (address + balance only — never key material)
app.get('/api/wallet', (req, res) => {
  res.json(sniperEngine.getWalletStatus());
});

// POST link a Photon wallet for live execution
app.post('/api/wallet/link', async (req, res) => {
  const { privateKey, persist } = req.body || {};
  if (!privateKey || typeof privateKey !== 'string') {
    return res.status(400).json({ ok: false, error: 'privateKey is required' });
  }

  const result = await sniperEngine.linkWallet(privateKey, persist === true);
  res.status(result.ok ? 200 : 400).json(result);
});

// POST refresh the on-chain balance
app.post('/api/wallet/refresh', async (req, res) => {
  await sniperEngine.refreshWallet();
  res.json(sniperEngine.getWalletStatus());
});

// POST unlink (optionally deleting the persisted key file)
app.post('/api/wallet/unlink', (req, res) => {
  const status = sniperEngine.unlinkWallet(req.body?.deleteFile === true);
  res.json({ ok: true, status });
});

// ---------------- RUN REPORTS ----------------

// GET the live run summary plus the last completed report
app.get('/api/report', (req, res) => {
  res.json({
    live: sniperEngine.getLiveRunSummary(),
    last: sniperEngine.getLastRunReport(),
    saved: reportService.listSavedReports(20),
  });
});

// GET the most recently completed run report
app.get('/api/report/last', (req, res) => {
  const report = sniperEngine.getLastRunReport();
  if (!report) return res.status(404).json({ error: 'No completed run yet.' });
  res.json(report);
});

// Bind to loopback only. This process holds a signing key and exposes trading
// endpoints; binding all interfaces would put both on the local network.
//
// Bind BOTH loopback addresses. On Windows `localhost` usually resolves to the
// IPv6 loopback (::1) first, so an IPv4-only bind leaves the browser connecting
// to a port nothing is listening on — which surfaces as "backend offline".
/**
 * Opens the dashboard as a DESKTOP APP WINDOW, not a browser tab.
 *
 * The previous behaviour shelled out to `start "" <url>`, which hands the URL to
 * whatever browser the user has open — so the bot appeared as one more tab
 * alongside their email, with an address bar showing localhost. It looked like a
 * web page because it was being opened as one.
 *
 * Chromium's `--app=` flag gives a frameless standalone window: no address bar,
 * no tab strip, its own taskbar entry and icon, and its own process. Paired with
 * a dedicated `--user-data-dir` it does not join the user's existing browser
 * session, which is both why it gets a separate taskbar identity and why closing
 * it cannot close their other tabs.
 *
 * Edge ships on every supported Windows install, so this path is reliable there;
 * Chrome and Brave are tried too. If none is found we fall back to the default
 * browser rather than failing to show a UI at all.
 *
 * Closing the window shuts the bot down, which is what makes it behave like an
 * application instead of a background service. Set SNIPER_NO_WINDOW=1 to keep
 * the old headless-server behaviour.
 */
function launchAppWindow(url: string, server: http.Server): void {
  if (parseBoolish(process.env.SNIPER_NO_WINDOW)) {
    console.log('🖥️  SNIPER_NO_WINDOW set — running headless. Open the URL above yourself.');
    return;
  }

  const { spawn, exec } = require('child_process') as typeof import('child_process');
  const os = require('os') as typeof import('os');

  // A per-install profile dir. Without one, Chromium reuses the user's default
  // profile and may fold the window into an existing session instead of opening
  // a standalone app window.
  const profileDir = path.join(os.tmpdir(), 'pumpfun-sniper-app-profile');

  const candidates: string[] = process.platform === 'win32'
    ? [
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];

  const runtime = candidates.find(p => { try { return p && fs.existsSync(p); } catch { return false; } });

  if (!runtime) {
    console.warn('⚠️ No Chromium-based runtime found — falling back to your default browser.');
    try {
      if (process.platform === 'win32') exec(`cmd /c start "" "${url}"`);
      else if (process.platform === 'darwin') exec(`open "${url}"`);
      else exec(`xdg-open "${url}"`);
    } catch { /* best effort */ }
    return;
  }

  try {
    const child = spawn(runtime, [
      `--app=${url}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1440,920',
      '--no-first-run',
      '--no-default-browser-check',
      // The dashboard is a local trading console; a translate bar or profile
      // pop-up over it is noise.
      '--disable-features=Translate,AutofillServerCommunication',
    ], { detached: false, stdio: 'ignore' });

    child.on('error', () => {
      console.warn('⚠️ App window failed to start — open ' + url + ' manually.');
    });

    // Closing the window ends the session. Without this the bot would keep
    // trading headlessly after the user thinks they shut it down.
    child.on('exit', () => {
      console.log('\n🛑 App window closed — shutting the bot down.');
      try { sniperEngine.toggleBot(false); } catch { /* already stopped */ }
      server.close(() => process.exit(0));
      // Never hang on a lingering keep-alive socket.
      setTimeout(() => process.exit(0), 3000).unref();
    });

    console.log('🪟 Opened as a desktop app window (close it to stop the bot).');
  } catch {
    console.warn('⚠️ Could not open the app window — open ' + url + ' manually.');
  }
}

/** Shared truthy-string parse for the env switches this file reads. */
function parseBoolish(v: string | undefined): boolean {
  return v !== undefined && ['1', 'true', 'on', 'yes'].includes(v.toLowerCase());
}

function startListening(retriesLeft = 5): void {
  // `app.listen(PORT)` with no host binds 0.0.0.0 — the opposite of the
  // comment above. Bind IPv4 loopback as the primary listener, plus a
  // best-effort IPv6 loopback listener so `localhost` resolving to ::1 on
  // Windows still reaches the API. Nothing on the LAN can.
  const server = app.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n========================================================`);
    console.log(`🚀 PUMPFUN SNIPER BOT ONLINE — LOCALHOST ACTIVE`);
    console.log(`========================================================`);
    console.log(`🖥️  UI Server listening at ${url}`);
    console.log(`🔑 Enter your Photon Wallet & Helius API key in UI Settings`);
    console.log(`========================================================\n`);

    launchAppWindow(url, server);
  });
  try {
    const v6 = app.listen(PORT, '::1');
    v6.on('error', () => { /* IPv6 loopback unavailable or in use — IPv4 covers it */ });
  } catch { /* same */ }

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
      console.warn(`⚠️ Port ${PORT} is currently busy, retrying in 1s (${retriesLeft} attempts left)...`);
      setTimeout(() => startListening(retriesLeft - 1), 1000);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use — another instance owns it. Exiting.`);
      process.exit(1);
    }
    console.error(`❌ Listen error on port ${PORT} — ${err.message}`);
    process.exit(1);
  });
}

startListening();
