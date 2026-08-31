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
import { runDiagnostics, worstLevel } from './services/diagnostics';
import { rpcHealth } from './services/rpcHealth';
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
import { autoUpdateEnabled, updaterService } from './services/updaterService';
import { apiToken, isLoopbackOrigin, originGuard, requireApiToken } from './services/apiAuth';
import { flushGovernorState, loadGovernorState, setGovernorWalletProvider } from './services/tradeGovernor';
import { flushWalletLedger, loadWalletLedger, walletLedger, WalletLedger } from './services/walletLedger';
import { entryProfile, flushEntryProfile, loadEntryProfile, MIN_ENTERED_SAMPLES, MIN_SEPARATION, MIN_SKIPPED_SAMPLES } from './services/entryProfile';
import { PROFILE_MIN_RULES, PROFILE_MIN_SCORE } from './services/playbookRouter';
import {
  getLastScoutReport, loadScoutReport, runScoutOnce, startScoutSchedule,
  MAX_IDLE_HOURS, MAX_COPYABLE_BUY_SOL, MIN_HOLD_SECONDS, MIN_CLOSED_TRADES,
} from './services/traderScout';
import { backfillFromWallets } from './services/entryBackfill';
import { smartMoneyDetector } from './services/smartMoneySignal';
// Reinstate a spend-governor halt from a previous session BEFORE anything can
// trade. A restart is the natural response to a runaway, and it must not be the
// thing that clears the breaker that stopped it.
//
// The latch is bound to a wallet: someone who funds a NEW wallet after an
// incident must not inherit the old one's halt.
setGovernorWalletProvider(() => sniperEngine.getWalletStatus().address ?? null);
loadGovernorState();
// The smart-money roster is EARNED from chain evidence over days, so losing it
// on a restart would mean starting the research over every time the bot is
// relaunched — and a restart is a routine thing an operator does.
{
  const restored = loadWalletLedger();
  if (restored > 0) {
    const promoted = walletLedger.promotedAddresses().length;
    console.log(`🧠 Wallet ledger restored: ${restored} wallet(s) known, ${promoted} promoted.`);
  }
}
// The entry profile is slower to earn than the roster: it needs 40 tokens the
// proven wallets actually took and 200 they passed on. At a handful of smart
// entries a day that is weeks of observation, so dropping it on every restart
// would mean the profile never becomes usable at all.
// The scout's last answer, so a restart does not present an empty panel while
// the first scheduled run is still an hour away.
{
  const r = loadScoutReport();
  if (r) {
    const age = Math.round((Date.now() - r.ranAt) / 60_000);
    console.log(r.best
      ? `🔎 Trader scout: last run ${age}m ago — best copyable wallet ${r.best.wallet.slice(0, 4)}…${r.best.wallet.slice(-4)} (${r.best.realizedSol} SOL realized).`
      : `🔎 Trader scout: last run ${age}m ago found nobody copyable out of ${r.considered} candidate(s).`);
  }
}
{
  const restored = loadEntryProfile();
  if (restored > 0) {
    const p = entryProfile.profile();
    console.log(p.usable
      ? `🔬 Entry profile restored: ${restored} snapshot(s), ${p.rules.length} rule(s) learned.`
      : `🔬 Entry profile restored: ${restored} snapshot(s) — ${p.notReady}`);
  }
}
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
//
// SCOPED TO /api. It used to be app.use(cors(...)) — every route, including the
// one that serves index.html with this instance's bearer token injected into it.
// Reflecting every loopback origin on that document meant any page served from
// ANY other local port (a vite dev server, a docs site, another tool's
// dashboard, a local game) could do
//
//     fetch('http://localhost:3001/').then(r => r.text())
//
// read the response, pull __SNIPER_API_TOKEN__ out of it, and then drive the
// trading endpoints with full authority. The token gate was not a gate.
//
// The document is same-origin-only now; the API keeps the loopback CORS the
// instance switcher needs.
app.use('/api', cors({
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
  // Defense-in-depth (sec-keys-3): a packaged build serves its own UI with the
  // token already injected into index.html, so nothing legitimate fetches this
  // endpoint there — only a third-party page served from another loopback port
  // would. Disable it in the packaged app so that exposure is gone; dev keeps it
  // for the vite server on another port. The instance switcher in a packaged
  // build takes the target token explicitly instead of reading it here.
  // Packaged = the pkg exe ((process as any).pkg) OR the packaged Electron app
  // (SNIPER_PACKAGED, set by electron/main.js when app.isPackaged).
  // OPT-IN, and off everywhere by default.
  //
  // This used to be disabled only for PACKAGED builds, on the reasoning that
  // nothing legitimate fetches it there. But the project's own documented
  // launcher (`run bot real.cmd`) runs `node dist/server.js`, which is not a
  // packaged build — so on the supported path the endpoint was live, and it is
  // an unauthenticated GET that hands out the bearer token authorizing every
  // trading endpoint. Any other local server, notebook, or Electron app on the
  // machine (or a page one of them serves that pulled a compromised
  // dependency) could take it and then arm real mode, widen slippage and place
  // orders.
  //
  // It exists solely for the vite dev server on another port, so it is now
  // gated on an explicit opt-in that only a developer sets.
  if (process.env.SNIPER_DEV_TOKEN_ENDPOINT !== '1') {
    res.status(404).json({ error: 'session-token is disabled. The UI is served with its token embedded; set SNIPER_DEV_TOKEN_ENDPOINT=1 only for the vite dev server.' });
    return;
  }
  res.json({ token: apiToken() });
});

// The instance switcher's legitimate need, met WITHOUT an open endpoint.
//
// Disabling /api/session-token closed a real hole — an unauthenticated GET that
// handed out the key to every trading endpoint — but it also broke the switcher:
// the UI on :3001 could still READ :3002's status (GETs are open) while every
// POST to it came back 401, so a second instance could be watched and never
// armed. The endpoints are the point of the switcher.
//
// This one requires THIS instance's token to hand over its own, so a caller
// must already be trusted here to learn it. Instances in one install share the
// token file, so in practice the switcher already holds the right value and
// this is a fallback for the case where it does not.
app.get('/api/instance-token', (req, res) => {
  requireApiToken(req, res, () => {
    res.json({ token: apiToken() });
  });
});

// Every state-changing API call needs the token. Applied by method rather than
// per-route so an endpoint added later is protected by default instead of by
// remembering. GETs stay open behind the origin guard — they are status reads.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  // The heartbeat is a liveness ping with no authority and is left open so a
  // page that has lost its token cannot make the server think every UI is gone.
  //
  // /server/shutdown is NOT exempt any more. Killing the process while it holds
  // open positions abandons them mid-flight — there is no more destructive call
  // in this API — and it was reachable, unauthenticated, from any local page or
  // any process on the machine.
  if (req.path === '/heartbeat') return next();
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

// ---- SPEND GOVERNOR ---------------------------------------------------------
//
// The ceiling that both engines pass through (see services/tradeGovernor.ts).
// It is surfaced as its own endpoint rather than buried in a status blob so the
// operator can always answer two questions directly: how close am I to a limit,
// and if trading stopped, WHY. A breaker whose state is invisible reads as the
// bot breaking again, which is the trust problem this whole change addresses.

// GET where the wallet stands against every ceiling.
// ---------------- SMART MONEY ----------------
//
// The roster is EARNED from chain evidence rather than configured, which makes
// it the one part of the bot an operator cannot inspect by reading their own
// settings. These endpoints are how they see who the bot decided to follow and
// why — and how they overrule it.

app.get('/api/smart-money', (req, res) => {
  res.json(sniperEngine.getSmartMoneyStatus());
});

/** Every wallet the ledger knows, not just the promoted ones — for auditing a decision. */
app.get('/api/smart-money/wallets', (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  const all = walletLedger.all()
    .filter(w => !state || w.state === state)
    .map(w => ({ ...WalletLedger.scoreOf(w), state: w.state, stateReason: w.stateReason, lastSeenAt: w.lastSeenAt, pinned: w.pinned ?? null }))
    .sort((a, b) => (b.conviction ?? -1) - (a.conviction ?? -1))
    .slice(0, limit);
  res.json({ wallets: all, total: walletLedger.size() });
});

/**
 * Pin a wallet on or off, overruling the ladder in either direction.
 *
 * Token-gated like every other mutation: this decides whose transactions our
 * money follows, which is not something an open tab should be able to change.
 */
app.post('/api/smart-money/pin', requireApiToken, (req, res) => {
  const { address, mode } = req.body || {};
  if (typeof address !== 'string' || !address) {
    return res.status(400).json({ ok: false, error: 'address is required' });
  }
  if (mode !== 'always' && mode !== 'never' && mode !== null) {
    return res.status(400).json({ ok: false, error: "mode must be 'always', 'never' or null" });
  }
  const ok = walletLedger.pin(address, mode);
  if (!ok) return res.status(404).json({ ok: false, error: 'no such wallet in the ledger' });
  flushWalletLedger();
  res.json({ ok: true, smartMoney: sniperEngine.getSmartMoneyStatus() });
});

/** Adjust the promotion bar and the confluence rule. */
app.post('/api/smart-money/config', requireApiToken, (req, res) => {
  const { thresholds, confluence } = req.body || {};
  const applied = {
    thresholds: thresholds ? walletLedger.setThresholds(thresholds) : walletLedger.getThresholds(),
    confluence: confluence ? smartMoneyDetector.setConfig(confluence) : smartMoneyDetector.getConfig(),
  };
  // Re-run the ladder immediately: a raised bar that only takes effect on the
  // next timer tick leaves wallets promoted that no longer qualify.
  walletLedger.reevaluate();
  flushWalletLedger();
  res.json({ ok: true, ...applied });
});

/**
 * WHAT THE BOT THINKS THE STRATEGY IS.
 *
 * The roster endpoint answers "whose trades are we watching". This one answers
 * the question the operator actually asked for: what do those traders LOOK FOR,
 * expressed as numbers, so the sniper can find the same tokens on its own
 * instead of waiting for someone else to buy first.
 *
 * Everything here is derived, never configured. `notReady` is returned verbatim
 * rather than hidden, because "the profile is not driving anything yet and here
 * is exactly how far off it is" is the honest state for most of the first
 * fortnight, and a panel that showed plausible-looking rules built on nine
 * samples would be worse than one that showed nothing.
 */
app.get('/api/entry-profile', (req, res) => {
  const p = entryProfile.profile();
  const counts = entryProfile.counts();
  res.json({
    enabled: featureFlags.get('smartMoneySniper'),
    usable: p.usable,
    notReady: p.notReady ?? null,
    builtAt: p.builtAt,
    enteredSamples: p.enteredSamples,
    skippedSamples: p.skippedSamples,
    needEntered: MIN_ENTERED_SAMPLES,
    needSkipped: MIN_SKIPPED_SAMPLES,
    minSeparation: MIN_SEPARATION,
    // The bar a live token has to clear to be bought on the profile alone.
    // Surfaced beside the rules so a 62%-on-4-rules candidate in the log reads
    // as "close, and correctly refused" rather than as the bot ignoring itself.
    minScore: PROFILE_MIN_SCORE,
    minRules: PROFILE_MIN_RULES,
    stored: counts,
    rules: p.rules.map(r => ({
      feature: r.feature,
      label: r.label,
      low: r.low,
      high: r.high,
      median: r.median,
      // The contrast is the point: their median beside the median of what they
      // walked past is what makes a band read as a choice rather than a range.
      skippedMedian: r.skippedMedian,
      separation: r.separation,
      samples: r.samples,
    })),
    sentences: entryProfile.describe(),
  });
});

/**
 * One dependency bundle for every scout entry point.
 *
 * The keys are read at CALL time, not captured: an operator who pastes a
 * Solana Tracker key into Settings expects the next run to use it, not the
 * next restart.
 */
function scoutDeps() {
  const cfg = sniperEngine.getConfig();
  return {
    ...sniperEngine.researchDeps(),
    fetch: globalThis.fetch,
    log: (level: 'info' | 'warn', msg: string) => console.log(msg),
    getKeys: () => ({
      solanaTracker: (cfg.solanaTrackerApiKey || process.env.SOLANA_TRACKER_API_KEY || '').trim() || undefined,
      birdeye: (cfg.birdeyeApiKey || process.env.BIRDEYE_API_KEY || '').trim() || undefined,
    }),
  };
}

// ---------------- TRADER SCOUT ----------------
//
// "Find the most profitable trader active right now and tell me who to copy."
// The lists that claim to answer that are gameable and sometimes simply wrong,
// so they supply ADDRESSES ONLY — every number reported here is re-measured
// from chain data by this bot. That distinction is surfaced in the payload
// rather than left in a comment, because a recommendation whose provenance the
// operator cannot see is a recommendation they have to take on faith.

app.get('/api/scout', (req, res) => {
  const r = getLastScoutReport();
  res.json({
    report: r,
    bars: {
      maxIdleHours: MAX_IDLE_HOURS,
      maxCopyableBuySol: MAX_COPYABLE_BUY_SOL,
      minHoldSeconds: MIN_HOLD_SECONDS,
      minClosedTrades: MIN_CLOSED_TRADES,
    },
    keysSet: {
      solanaTracker: Boolean(sniperEngine.getConfig().solanaTrackerApiKey),
      birdeye: Boolean(sniperEngine.getConfig().birdeyeApiKey),
    },
  });
});

/**
 * Run the scout now.
 *
 * Token-gated even though it only reads: it spends the same RPC budget the
 * trading path uses, so an open tab must not be able to start one.
 */
app.post('/api/scout/run', requireApiToken, async (req, res) => {
  const report = await runScoutOnce(scoutDeps());
  res.json({ ok: true, report });
});

/**
 * Follow one of the scouted wallets.
 *
 * DELIBERATELY NOT AUTOMATIC. The scout can be confident and still be wrong —
 * it measures six hours of pump.fun history, not a career — and adding a copy
 * target is the decision that starts spending money on a stranger. The bot
 * finds and ranks; a person chooses.
 */
app.post('/api/scout/follow', requireApiToken, (req, res) => {
  const address = String(req.body?.address || '').trim();
  if (!address) return res.status(400).json({ ok: false, error: 'address is required' });
  const r = getLastScoutReport();
  const known = r && [...r.top, ...r.rejected].find(t => t.wallet === address);
  if (!known) {
    return res.status(400).json({ ok: false, error: 'that address is not in the latest scout report — re-run the scout first' });
  }
  if (known.disqualifiers.length > 0) {
    return res.status(400).json({ ok: false, error: `the scout disqualified that wallet: ${known.disqualifiers[0]}` });
  }
  const added = copyTrader.addWallet(address, known.label || `scout ${new Date(r!.ranAt).toISOString().slice(0, 10)}`);
  if (!added.ok) return res.status(400).json({ ok: false, error: added.error });
  res.json({ ok: true });
});

/**
 * Rebuild the entry profile from the scouted wallets' own chain history.
 *
 * This is what removes the weeks-long wait before the sniper can screen on a
 * learned profile: the trades already happened, so the evidence is recoverable
 * in minutes instead of accumulated in fortnights.
 */
app.post('/api/scout/backfill', requireApiToken, async (req, res) => {
  const r = getLastScoutReport();
  const fromBody: string[] = Array.isArray(req.body?.wallets) ? req.body.wallets.map(String) : [];
  const wallets = fromBody.length ? fromBody : (r?.top ?? []).map(t => t.wallet);
  if (!wallets.length) {
    return res.status(400).json({ ok: false, error: 'no verified wallets to learn from — run the scout first' });
  }
  const result = await backfillFromWallets(wallets, {
    ...sniperEngine.researchDeps(),
    log: (lvl: 'info' | 'warn', msg: string) => console.log(msg),
  }, {});
  flushEntryProfile();
  res.json({ ok: true, result, profile: entryProfile.profile() });
});

app.get('/api/governor', (req, res) => {
  res.json(sniperEngine.getGovernorSnapshot());
});

// POST clear a latched halt. Deliberately an explicit operator action: a halt
// that cleared itself would put the bot straight back into whatever emptied it.
app.post('/api/governor/clear-halt', (req, res) => {
  sniperEngine.clearGovernorHalt();
  res.json({ success: true, governor: sniperEngine.getGovernorSnapshot() });
});

// POST clear the halt AND the rolling/session spend totals — a fresh session.
app.post('/api/governor/reset', (req, res) => {
  sniperEngine.resetGovernorSession();
  res.json({ success: true, governor: sniperEngine.getGovernorSnapshot() });
});

// POST adjust the ceilings.
//
// A limit the operator cannot raise is not a safety feature, it is an outage
// waiting to happen: the shipped defaults are chosen for a small wallet, and
// someone trading a larger one would otherwise watch the bot stop for no reason
// they can act on — which is the same "it broke again" experience this whole
// change exists to end. Every refusal names the ceiling that bound and its
// value, and this is where they change it.
//
// Non-finite and negative values are rejected inside setLimits, which keeps the
// previous ceiling rather than letting a blank field mean "unlimited".
app.post('/api/governor/limits', (req, res) => {
  const before = sniperEngine.getGovernorSnapshot().limits;
  sniperEngine.setGovernorLimits(req.body || {});
  const after = sniperEngine.getGovernorSnapshot().limits;
  const changed = Object.keys(after).filter(k => (after as any)[k] !== (before as any)[k]);
  res.json({ success: true, changed, governor: sniperEngine.getGovernorSnapshot() });
});

// POST Update Bot Strategy Config
app.post('/api/bot/config', (req, res) => {
  const before = sniperEngine.getConfig();
  const keysBefore = `${before.heliusApiKey ?? ''}|${before.pumpPortalApiKey ?? ''}`;
  sniperEngine.updateConfig(req.body);
  const after = sniperEngine.getConfig();
  // A key saved from Settings has to reach the copy trader's feeds too. It
  // resolves the key when its watcher starts and never again, so a key added
  // after boot left the on-chain lane down for the whole session.
  if (`${after.heliusApiKey ?? ''}|${after.pumpPortalApiKey ?? ''}` !== keysBefore) {
    copyTrader.onApiKeysChanged();
  }
  // getPublicConfig(), not getConfig(): the latter carries the raw Helius and
  // PumpPortal keys, and this response is readable by any loopback-origin page.
  res.json({ success: true, config: sniperEngine.getPublicConfig() });
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
  console.log('🛑 Server shutdown requested via UI. Terminating process...');
  // Record a clean shutdown and surface any open positions before exiting.
  setTimeout(() => gracefulShutdown('shutdown endpoint'), 500);
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

// GET the bot's own answer to "why is it not trading?" — every known silent
// failure (rejected key, dead watcher, zero-stake sizing, guard refusals, an
// inactive switch) as a list the UI can show, instead of a log nobody reads.
app.get('/api/diagnostics', (req, res) => {
  const engineStatus = sniperEngine.getStatus();
  const copyStatus = copyTrader.getStatus();
  const health = rpcHealth();
  const findings = runDiagnostics({
    engine: {
      isBotActive: engineStatus.isBotActive,
      tradingMode: engineStatus.tradingMode,
      walletAddress: engineStatus.wallet?.address,
      solBalance: engineStatus.wallet?.solBalance,
      deployableSol: engineStatus.wallet?.deployableSol,
      rpcHealthy: engineStatus.wallet?.rpcHealthy,
      logs: engineStatus.logs,
    },
    copy: {
      enabled: copyStatus.enabled,
      tradingMode: copyStatus.tradingMode,
      streamConnected: copyStatus.streamConnected,
      heliusConnected: copyStatus.heliusConnected,
      config: copyStatus.config,
      wallets: copyStatus.wallets ?? [],
      openPositions: copyStatus.positions?.length ?? 0,
    },
    rpc: {
      credentialRejected: health.credentialRejected,
      consecutiveFailures: health.consecutiveFailures,
      lastError: health.lastError,
    },
    heliusKeySet: Boolean((engineStatus.config as any)?.heliusApiKeySet),
    priorityFeeSol: sniperEngine.getSizingPriorityFeeSol(),
    now: Date.now(),
  });
  res.json({ level: worstLevel(findings), findings });
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
app.post('/api/copy/positions/close', async (req, res) => {
  const { positionId } = req.body || {};
  if (!positionId) return res.status(400).json({ error: 'positionId is required' });
  const success = await copyTrader.forceClosePosition(String(positionId));
  res.status(success ? 200 : 404).json({ success });
});

/**
 * Tab heartbeat + auto-shutdown failsafe, from the v1.1.0 lineage — kept, but
 * made safe.
 *
 * Main's version called process.exit(0) unconditionally 12s after the last
 * heartbeat. That kills the engine mid-trade: open positions are abandoned with
 * no exits running, and a closed/refreshed/backgrounded tab is indistinguishable
 * from a closed app. Here it routes through gracefulShutdown (which records a
 * clean shutdown and logs what was open) and REFUSES to exit while any position
 * is open — an unattended browser tab must never be able to strand a bag.
 *
 * The packaged Electron app does not rely on this at all: closing its window
 * already runs the same gracefulShutdown path.
 */
let lastTabHeartbeatAt = Date.now();
let receivedFirstTabHeartbeat = false;
let warnedHeartbeatHeldOpen = false;

app.post('/api/heartbeat', (req, res) => {
  lastTabHeartbeatAt = Date.now();
  receivedFirstTabHeartbeat = true;
  res.json({ success: true });
});

// Under Electron the window IS the lifecycle: `window-all-closed` and
// `before-quit` already run the shutdown path, and the renderer's cross-process
// heartbeat is exactly what macOS throttles when the window is minimized or the
// machine sleeps. Running this guard there does nothing but race the renderer
// and kill a live window — measured 2026-08-29, the packaged app shut its own
// server down ~12s after launch and showed a blank window. So it is browser-tab
// only. (process.versions.electron is set in the same process the main script
// requires the server into.)
const UNDER_ELECTRON = Boolean((process as any).versions?.electron) || process.env.SNIPER_PACKAGED === '1';
let lastHeartbeatTick = Date.now();

setInterval(() => {
  // If the process itself was suspended (laptop asleep, app backgrounded), the
  // gap between two 3s ticks blows past the interval. That is not a dead UI —
  // it is a frozen process. Treat the wall-clock jump as a fresh heartbeat and
  // skip this tick rather than shutting down a session that was only asleep.
  const sinceLastTick = Date.now() - lastHeartbeatTick;
  lastHeartbeatTick = Date.now();
  if (sinceLastTick > 10_000) { lastTabHeartbeatAt = Date.now(); return; }

  if (UNDER_ELECTRON) return;
  if (!receivedFirstTabHeartbeat || Date.now() - lastTabHeartbeatAt <= 12_000) return;
  const engineStatus = sniperEngine.getStatus();
  const copyStatus = copyTrader.getStatus();
  const openPositions = (engineStatus.activePositions?.length ?? 0)
    + (copyStatus.positions?.length ?? 0);
  // "No open positions" is NOT "nothing is running". A live copy-trading or
  // sniping session is flat most of the time — between one exit and the next
  // entry there is nothing open, and this check used to fire in exactly that
  // gap. Measured 2026-08-29: a minimized Electron window throttled the
  // renderer's heartbeat timer, 12s passed while the bot was flat, and an
  // ACTIVE real-money session shut itself down mid-trading. A session counts
  // as active while the copy trader is enabled with leaders to follow, or the
  // sniper engine is armed.
  const sessionActive = (copyStatus.enabled && (copyStatus.wallets?.length ?? 0) > 0)
    || engineStatus.isBotActive === true;
  if (openPositions > 0 || sessionActive) {
    if (!warnedHeartbeatHeldOpen) {
      warnedHeartbeatHeldOpen = true;
      console.warn(openPositions > 0
        ? `⚠️ UI tabs are closed but ${openPositions} position(s) are still open — staying up so exits keep running. Use the shutdown button (or close them) to stop.`
        : '⚠️ UI tabs are closed but the session is still ACTIVE (copy trading enabled or bot armed) — staying up. Use the shutdown button to stop.');
    }
    return;
  }
  console.log('🛑 All UI tabs closed (heartbeat timeout), nothing active and no open positions — shutting down.');
  gracefulShutdown('UI heartbeat timeout');
}, 3000).unref();

// POST reconcile open copy positions against real on-chain balances (v1.1.0
// lineage's sync-balances). Closes bags that are genuinely gone and corrects
// drifted quantities; an unreadable balance never closes anything.
app.post('/api/copy/sync-balances', async (req, res) => {
  const result = await copyTrader.syncPositionsWithOnChainBalances();
  res.json({ success: true, ...result, status: copyTrader.getStatus() });
});

// POST discard a stuck copy position (v1.1.0 lineage's DISCARD). Routed through
// forceClosePosition so the on-chain "you still hold this" check still applies.
app.post('/api/copy/discard', async (req, res) => {
  const { positionId } = req.body || {};
  if (!positionId) return res.status(400).json({ error: 'positionId is required' });
  const success = await copyTrader.discardPosition(String(positionId));
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
// The sniper and copy trader share one wallet. Let the sniper subtract the copy
// trader's in-flight buy reservations when sizing, so the two never overdraft
// the wallet together (copy-correctness-5). Wired here to avoid an import cycle.
sniperEngine.setCopyInFlightReservedProvider(() => copyTrader.getInFlightBuyReservedSol());
// The research harvester shares the Helius key with the copy trader, so it has
// to yield to BOTH engines — not just to the sniper's own entries. Wired here
// because the engine cannot import the copy service without a cycle, the same
// reason the reserved-SOL provider above lives here.
sniperEngine.setCopyBusyProvider(() => copyTrader.isBusyTrading());
// Adopt any positions left open by a previous run, verified against the chain
// first. Deferred rather than awaited at construction: it reads token balances,
// and the engine must be constructible without a working RPC.
setTimeout(() => { void sniperEngine.adoptRestoredPositions(); }, 3000).unref();
// Shared-mint refusal, in BOTH directions: a percentage sell moves the wallet's
// whole balance of a mint, so neither engine may open one the other holds.
sniperEngine.setCopyHeldMintsProvider(() => copyTrader.getHeldMints());

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

/**
 * Background auto-update for the standalone binary (pumpfun-sniper-bot.exe and
 * the macOS builds), so it keeps itself current instead of the user hunting for
 * a fresh download. The Electron app is excluded — electron-updater owns that
 * path — and so is a dev checkout, which has no binary to swap.
 *
 * applyUpdate() goes through the restart guard above, so an update is only ever
 * installed while the engine is idle; with anything open or trading it is left
 * for the UI's manual banner and retried on the next tick. Set
 * SNIPER_NO_AUTO_UPDATE=1 to opt out.
 */
if (autoUpdateEnabled()) {
  const autoUpdate = async () => {
    try {
      const check = await updaterService.checkForUpdates();
      if (!check.hasUpdate || !check.canSelfUpdate) return;
      const result = await updaterService.applyUpdate();
      if (!result.ok) {
        console.log(`ℹ️ v${check.latestVersion} is available but was not installed: ${result.error} — it will retry, or use Check for Updates in the UI.`);
      }
    } catch { /* offline or GitHub rate-limited — the next tick retries */ }
  };
  setTimeout(autoUpdate, 15_000).unref();
  setInterval(autoUpdate, 6 * 60 * 60 * 1000).unref();
}

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
    const spawnedAt = Date.now();
    child.on('exit', () => {
      // A Chromium that finds a live instance on the same profile HANDS OFF
      // and exits immediately — the window is open, but this child is gone.
      // Measured 2026-08-29: 142ms from spawn to exit, and the bot shut itself
      // down one second after starting. An exit that fast is a handoff or a
      // crash, never the user closing a window they had barely seen.
      if (Date.now() - spawnedAt < 5_000) {
        console.warn('⚠️ App window process exited immediately (another window instance likely took over). Staying up — use the shutdown button or Ctrl+C to stop.');
        return;
      }
      // Closing the window with real money in flight must behave like the
      // heartbeat path: exits keep running, and the operator is told.
      const openNow = (sniperEngine.getStatus().activePositions?.length ?? 0)
        + (copyTrader.getStatus().positions?.length ?? 0);
      if (openNow > 0 && sniperEngine.getStatus().tradingMode !== 'paper') {
        console.warn(`⚠️ App window closed but ${openNow} REAL position(s) are open — staying up so exits keep running. Use the shutdown button after they close.`);
        return;
      }
      console.log('\n🛑 App window closed — shutting the bot down.');
      gracefulShutdown('window closed', server);
    });

    console.log('🪟 Opened as a desktop app window (close it to stop the bot).');
  } catch {
    console.warn('⚠️ Could not open the app window — open ' + url + ' manually.');
  }
}

/**
 * One deliberate-exit path for every trigger (window close, SIGINT/SIGTERM,
 * /api/server/shutdown). Records a clean shutdown so the next boot does not cry
 * crash (sniper-correctness-6), and logs any open positions being left behind so
 * the durable bot.log names what was abandoned mid-trade (server-updater-3).
 */
let shuttingDown = false;
function gracefulShutdown(reason: string, server?: http.Server): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const open = sniperEngine.getStatus().activePositions ?? [];
    if (open.length > 0) {
      console.warn(`⚠️ Shutting down (${reason}) with ${open.length} open position(s): ${open.map((p: any) => `$${p.tokenSymbol}`).join(', ')}. They are persisted and will be restored on the next start; no exits run while the process is down.`);
    }
    try { sniperEngine.toggleBot(false); } catch { /* already stopped */ }
    // STOP THE COPY TRADER TOO. Shutdown disarmed the sniper and flushed the
    // copy trader's state, but never actually stopped it: its signal feeds
    // stayed live right up to process.exit, so a leader signal arriving in the
    // last moments started a NEW buy that got signed and sent while the process
    // was on its way out.
    //
    // HONEST LIMIT: this stops new signals from starting anything. It does NOT
    // stop a buy already inside its settlement poll — that transaction is
    // already signed and on the wire, and this process is about to be gone. The
    // in-flight count is reported below for exactly that reason, and the buy is
    // recoverable afterwards through the on-chain balance check rather than
    // through anything shutdown can do.
    try { copyTrader.setEnabled(false); } catch { /* already stopped */ }
    const inFlight = copyTrader.getInFlightBuyCount();
    if (inFlight > 0) {
      console.warn(`⚠️ Shutting down with ${inFlight} copy buy(s) still in flight. They may land after this process is gone — `
        + 'check the wallet for untracked bags before arming again.');
    }
    // Flushed LAST, after both engines have stopped, so the file on disk is the
    // final state rather than a snapshot taken before the last mutation.
    try { copyTrader.flushStateSync(); } catch { /* best effort */ }
    // The governor's write is debounced off the order hot path; flush whatever
    // is pending so a halt or a spend total is never lost on the way out.
    try { flushGovernorState(); } catch { /* best effort */ }
    try { flushWalletLedger(); } catch { /* best effort */ }
    try { flushEntryProfile(); } catch { /* best effort */ }
    sniperEngine.markCleanShutdown();
  } catch { /* best effort on the way out */ }
  const done = () => process.exit(0);
  if (server) server.close(done); else done();
  // Never hang on a lingering keep-alive socket.
  setTimeout(done, 3000).unref();
}

process.on('SIGINT', () => { console.log('\n🛑 SIGINT — shutting down.'); gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { console.log('\n🛑 SIGTERM — shutting down.'); gracefulShutdown('SIGTERM'); });

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

    // Started only once the server is up, so the first run never competes with
    // position restore. It yields to the trading path on every read and holds
    // its own RPC budget, so the worst case is a scout run that gives up.
    startScoutSchedule(scoutDeps());

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
