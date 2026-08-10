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
import { reportService } from './services/reportService';
import { featureFlags, FeatureFlagSet } from './services/featureFlags';
import { latencyTimeline, LatencyTimelineLogger } from './services/latencyTimeline';
import { entryGateV2 } from './services/entryGateV2';
import { localTxBuilder } from './services/localTxBuilder';
// ─── Hardened crash guards ──────────────────────────────────────────────────
// @solana/web3.js retries 429 / timeout errors internally then re-throws.
// Without these guards that unhandled rejection kills the process instantly.
process.on('uncaughtException', (err: Error) => {
  const msg = err?.message || String(err);
  if (/429|timeout|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(msg)) return;
  console.warn('⚠️ [Uncaught Exception — server kept alive]:', msg);
});

process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message || String(reason);
  if (/429|timeout|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(msg)) return;
  console.warn('⚠️ [Unhandled Rejection — server kept alive]:', msg);
});


/**
 * Load a .env sitting NEXT TO the executable.
 *
 * `npm run dev` gets this from node's --env-file-if-exists flag, but a pkg-built
 * exe is launched by double-click with no flags — so without this an end user
 * has no file-based way to supply a key. The .env is deliberately NOT bundled
 * into the binary (see the note in package.json "pkg"), because that would bake
 * the builder's own Helius key into every copy handed out.
 *
 * Precedence: a real environment variable always wins over the file, and the
 * key entered in the UI wins over both (it is applied at runtime).
 */
function loadEnvBesideExecutable(): void {
  // process.execPath is the exe itself when packaged; cwd otherwise.
  const isPackaged = Boolean((process as any).pkg);
  const baseDir = isPackaged ? path.dirname(process.execPath) : process.cwd();
  const envPath = path.join(baseDir, '.env');
  try {
    if (!fs.existsSync(envPath)) return;
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Never clobber a variable the user set in their shell.
      if (process.env[key] === undefined) process.env[key] = value;
    }
    console.log(`🔑 Loaded settings from ${envPath}`);
  } catch {
    // A malformed .env must not stop the bot from starting — the UI can still
    // supply the key.
  }
}
loadEnvBesideExecutable();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001;

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

if (validDistDir) {
  app.use(express.static(validDistDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(validDistDir!, 'index.html'));
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
const SSE_MIN_GAP_MS = 100;
const SSE_HEARTBEAT_MS = 1000;

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
