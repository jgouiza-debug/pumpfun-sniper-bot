import React, { useState, useEffect, useRef } from 'react';
import { BotConfig, BotInstanceInfo, BotStatusResponse, FilterResult, LeniencyMode, Position, TradeHistoryRecord } from './types';

// A txid proves execution only when it's a real signature — paper fills carry
// a sim_ prefix and never touched the chain.
const isOnChainTxid = (txid?: string): boolean => Boolean(txid && !txid.startsWith('sim_'));

// The console wipes completely on this cycle, so a fast screening stream stays
// readable instead of scrolling into a wall of text.
const LOG_WIPE_INTERVAL_MS = 5_000;

// Below this share, an exit did not close the position — it left a remainder.
const FULL_EXIT_THRESHOLD = 0.95;

const qty = (n?: number): string => {
  if (!n || !isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(n < 10 ? 2 : 0);
};

/**
 * What this exit actually did on-chain. A "sell everything" that only moved a
 * sliver used to render identically to a clean close — which is exactly how a
 * 4.5% fill got reported as a closed position at -96.8%.
 */
function ExitFillBadge({ trade }: { trade: TradeHistoryRecord }) {
  const fraction = trade.fractionSold;
  if (fraction === undefined) {
    return <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>{qty(trade.tokensSold)}</span>;
  }
  const pct = fraction * 100;
  const partial = fraction < FULL_EXIT_THRESHOLD;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
        {qty(trade.tokensSold)} ({pct < 10 ? pct.toFixed(1) : Math.round(pct)}%)
      </span>
      {partial && (
        <span
          className="status-badge"
          style={{ color: '#fbbf24', borderColor: '#fbbf24' }}
          title={`Only ${pct.toFixed(1)}% of the position was sold. The rest was still held after this order.`}
        >
          PARTIAL FILL
        </span>
      )}
    </div>
  );
}

function TxProofBadge({ txid, verified }: { txid?: string; verified?: boolean }) {
  if (!isOnChainTxid(txid)) {
    return (
      <span className="status-badge" title="Paper fill — this trade was simulated and never sent to the chain">
        SIMULATED
      </span>
    );
  }
  return (
    <a
      href={`https://solscan.io/tx/${txid}`}
      target="_blank"
      rel="noopener noreferrer"
      className="status-badge"
      style={{ color: verified ? '#00e676' : '#fbbf24', borderColor: verified ? '#00e676' : '#fbbf24', textDecoration: 'none' }}
      title={verified
        ? 'Confirmed on-chain — quantities read back from the actual fill. Click to view on Solscan.'
        : 'Submitted and confirmed on-chain — fill details are estimated. Click to view on Solscan.'}
    >
      {verified ? 'ON-CHAIN ✓' : 'ON-CHAIN ↗'}
    </a>
  );
}

export function App() {
  // Multi-Instance State
  const [instances, setInstances] = useState<BotInstanceInfo[]>([
    { id: 'bot-1', name: 'Bot #1 (Main)', port: 3001, status: 'active', tradingMode: 'paper', leniencyMode: 'strict' },
    { id: 'bot-2', name: 'Bot #2 (Alpha)', port: 3002, status: 'paused', tradingMode: 'paper', leniencyMode: 'strict' },
  ]);
  const [selectedPort, setSelectedPort] = useState<number>(3001);

  // Every call targets the instance currently selected, not a fixed port.
  const API_BASE = `http://localhost:${selectedPort}`;

  // Bot Status State for Selected Instance
  const [botStatus, setBotStatus] = useState<BotStatusResponse | null>(null);
  const [showConfigModal, setShowConfigModal] = useState<boolean>(false);
  const [showInstanceModal, setShowInstanceModal] = useState<boolean>(false);
  const [newInstanceName, setNewInstanceName] = useState<string>('');
  const [newInstancePort, setNewInstancePort] = useState<number>(3002);

  // Form config state
  const [configForm, setConfigForm] = useState<Partial<BotConfig>>({
    // These mirror the engine defaults and are replaced by the server's real
    // config on the first status fetch. They must NOT diverge: the form posts
    // whatever is in it, so a stale 0.05 here silently reconfigured the bot to a
    // stake whose round-trip breakeven is 19.1% — above maxBreakevenPct, which
    // blocks every entry at any wallet size.
    // A FULL unit; the router halves it until a candidate clears the full-unit
    // score band, so the real per-trade stake is 0.3 SOL.
    buyAmountSol: 0.6,
    // On by default: the stake is one slot of the run budget, not this number.
    walletSplitSizing: true,
    takeProfitPct: 100,
    takeProfitRung2Pct: 400,
    // No stopLossPct: this bot has no price stop-loss by design.
    trailingArmMultiple: 3.0,
    useTrailingStop: true,
    trailingStopPct: 30,
    maxHoldSeconds: 1800,
    // All-in at the current wallet size — see the engine defaults for why.
    maxActivePositions: 1,
    activePlaybook: 'ALL',
    tradingMode: 'paper',
    leniencyMode: 'strict',
    privateKey: '',
    // No baked-in key: the server supplies its configured key via /api/bot/status.
    heliusApiKey: '',
  });

  // Photon wallet linking state. The key only ever lives in this input until
  // it is POSTed once; it is never stored in config or read back from status.
  const [walletKeyInput, setWalletKeyInput] = useState<string>('');
  const [walletPersist, setWalletPersist] = useState<boolean>(false);
  const [walletError, setWalletError] = useState<string>('');
  const [lastReport, setLastReport] = useState<any>(null);

  // Feature Flags State
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({
    devSellStop: true,
    honestPaper: true,
    playbookRouting: true,
    killSwitch: true,
    dynamicPriorityFee: false,
    localTxBuild: false,
    honeypotChecks: true,
    enforceTradeEconomics: false,
  });

  const fetchFlags = async (port: number) => {
    try {
      const res = await fetch(`http://localhost:${port}/api/flags`);
      if (res.ok) {
        const data = await res.json();
        if (data.flags) setFeatureFlags(data.flags);
      }
    } catch { /* offline on this port */ }
  };

  const handleToggleFlag = async (flagKey: string, newValue: boolean) => {
    setFeatureFlags(prev => ({ ...prev, [flagKey]: newValue }));
    try {
      const res = await fetch(`http://localhost:${selectedPort}/api/flags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flag: flagKey, value: newValue }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.flags) setFeatureFlags(data.flags);
      }
    } catch (err) {
      console.error('Failed to toggle flag:', err);
    }
  };

  const wallet = botStatus?.wallet;
  const run = botStatus?.run;
  const sizing = botStatus?.sizing;

  // Runtime clock: derived from the server's run start timestamp but ticked
  // locally every second, so it counts smoothly even between status frames.
  // Server and browser share the same machine clock on localhost.
  const [clockNow, setClockNow] = useState<number>(Date.now());
  useEffect(() => {
    if (!run?.startedAt) return;
    const iv = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [run?.startedAt]);

  const fmtClock = (totalSec: number): string => {
    const s = Math.max(0, Math.floor(totalSec));
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
  };

  const runElapsedSec: number | null = run?.startedAt
    ? Math.max(0, (clockNow - run.startedAt) / 1000)
    : null;

  const linkWallet = async () => {
    setWalletError('');
    let res: Response;

    try {
      res = await fetch(`${API_BASE}/api/wallet/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey: walletKeyInput, persist: walletPersist }),
      });
    } catch {
      // Only a genuine transport failure lands here.
      setWalletError(`Cannot reach the API at ${API_BASE}. Start it with: npm run server`);
      return;
    }

    // A stale server that predates the wallet endpoints answers 404 with HTML,
    // which used to blow up in res.json() and get misreported as "offline".
    if (res.status === 404) {
      setWalletError('This server build has no /api/wallet/link endpoint. Restart the backend to pick up the new code.');
      return;
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      setWalletError(`Server returned a non-JSON response (HTTP ${res.status}). Restart the backend and try again.`);
      return;
    }

    if (!res.ok || !data.ok) {
      setWalletError(data?.error || `Link failed (HTTP ${res.status}).`);
      return;
    }

    setWalletKeyInput('');
  };

  const refreshWallet = async () => {
    try {
      await fetch(`${API_BASE}/api/wallet/refresh`, { method: 'POST' });
    } catch { /* status poll will show staleness */ }
  };

  const unlinkWallet = async () => {
    try {
      await fetch(`${API_BASE}/api/wallet/unlink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteFile: true }),
      });
      setWalletError('');
    } catch { /* ignore */ }
  };

  // Pull the last completed run report whenever the bot transitions to stopped.
  useEffect(() => {
    if (botStatus?.isBotActive) return;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/report/last`);
        if (res.ok) setLastReport(await res.json());
      } catch { /* no report yet */ }
    })();
  }, [botStatus?.isBotActive]);

  const terminalEndRef = useRef<HTMLDivElement>(null);

  // The settings form must never be overwritten by a status update while the
  // modal is open — that's what made "Real money" snap back to paper before
  // the user could press save. A ref so the stream handler sees the live value.
  const showConfigModalRef = useRef(false);
  useEffect(() => {
    showConfigModalRef.current = showConfigModal;
  }, [showConfigModal]);

  // True while the SSE stream is delivering — drives the LIVE indicator.
  const [streamLive, setStreamLive] = useState<boolean>(false);

  // Console wipe cycle. `logClearedAt` is the cutoff every rendered line must
  // beat; `wipeTick` just drives the countdown display.
  const [logClearedAt, setLogClearedAt] = useState<number>(() => Date.now());
  const [wipeTick, setWipeTick] = useState<number>(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => {
      const now = Date.now();
      setWipeTick(now);
      setLogClearedAt(prev => (now - prev >= LOG_WIPE_INTERVAL_MS ? now : prev));
    }, 500);
    return () => clearInterval(iv);
  }, []);

  // Real-time status: the server pushes over SSE the moment anything changes
  // (order submitted, fill confirmed, price moved), coalesced to at most one
  // frame per 100ms. If the stream can't be established (old server build,
  // transient outage) fall back to polling.
  useEffect(() => {
    let closed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let es: EventSource | null = null;

    const apply = (data: BotStatusResponse) => {
      if (closed) return;
      setBotStatus(data);
      if (data.config && !showConfigModalRef.current) {
        setConfigForm(data.config);
      }
    };

    const startPolling = () => {
      if (pollTimer) return;
      setStreamLive(false);
      const fetchStatus = async () => {
        try {
          const res = await fetch(`http://localhost:${selectedPort}/api/bot/status`);
          if (res.ok) apply(await res.json());
        } catch { /* offline on this port */ }
      };
      fetchStatus();
      // Polling is the degraded path; keep it tight enough that a fill is still
      // visible within a fraction of a second when SSE is unavailable.
      pollTimer = setInterval(fetchStatus, 600);
    };

    // EventSource auto-reconnects through transient drops on its own. Only
    // abandon it for polling when it closes for good (endpoint missing on an
    // old build) or keeps failing without ever delivering a frame.
    let sseFailures = 0;
    try {
      es = new EventSource(`http://localhost:${selectedPort}/api/stream`);
      es.onmessage = (ev) => {
        sseFailures = 0;
        setStreamLive(true);
        try { apply(JSON.parse(ev.data)); } catch { /* malformed frame */ }
      };
      es.onerror = () => {
        sseFailures++;
        setStreamLive(false);
        const fatal = es?.readyState === EventSource.CLOSED;
        if (fatal || sseFailures >= 4) {
          es?.close();
          es = null;
          startPolling();
        }
        // Otherwise: let EventSource retry — it reconnects automatically.
      };
    } catch {
      startPolling();
    }

    return () => {
      closed = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
      setStreamLive(false);
    };
    fetchFlags(selectedPort);
  }, [selectedPort]);

  // Auto-scroll terminal log
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [botStatus?.logs]);

  // Auto-open Photon & Solscan pages when a real trade occurs
  const autoOpenedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (botStatus?.tradingMode === 'real') {
      botStatus.activePositions?.forEach(pos => {
        const key = `${pos.mint}_${pos.buyTxid || 'nobuy'}`;
        if (pos.mint && !autoOpenedRef.current.has(key)) {
          autoOpenedRef.current.add(key);
          window.open(`https://photon-sol.tinyastro.io/en/lp/${pos.mint}`, '_blank');
          if (pos.buyTxid && !pos.buyTxid.startsWith('sim_')) {
            window.open(`https://solscan.io/tx/${pos.buyTxid}`, '_blank');
          }
        }
      });
      botStatus.tradeHistory?.forEach(t => {
        const key = `trade_${t.id}_${t.sellTxid || 'nosell'}`;
        if (t.sellTxid && !t.sellTxid.startsWith('sim_') && !autoOpenedRef.current.has(key)) {
          autoOpenedRef.current.add(key);
          window.open(`https://solscan.io/tx/${t.sellTxid}`, '_blank');
        }
      });
    }
  }, [botStatus?.activePositions, botStatus?.tradeHistory, botStatus?.tradingMode]);

  // Toggle Bot Power ON / OFF
  const toggleBotPower = async () => {
    const targetState = !botStatus?.isBotActive;
    try {
      const res = await fetch('/api/bot/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: targetState })
      });
      const data = await res.json();
      if (data.success && botStatus) {
        setBotStatus({ ...botStatus, isBotActive: data.isBotActive });
      }
    } catch (err) {
      try {
        const res = await fetch(`http://localhost:${selectedPort}/api/bot/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: targetState })
        });
        const data = await res.json();
        if (data.success && botStatus) {
          setBotStatus({ ...botStatus, isBotActive: data.isBotActive });
        }
      } catch (e) {
        console.error("Toggle bot error:", e);
      }
    }
  };

  // Emergency Cease / Stop Bot
  const handleEmergencyStop = async () => {
    try {
      await fetch('/api/bot/kill', { method: 'POST' }).catch(() => {});
      await fetch('/api/bot/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false })
      }).catch(() => {});
      if (botStatus) {
        setBotStatus({ ...botStatus, isBotActive: false });
      }
    } catch (err) {
      console.error("Emergency stop error:", err);
    }
  };

  // Close & Kill Dev Server Process Completely
  const handleShutdownServer = async () => {
    if (!window.confirm("Are you sure you want to CLOSE and KILL the dev server process?")) return;
    try {
      await fetch('/api/server/shutdown', { method: 'POST' });
    } catch (err) {
      // Ignored - process exits
    }
    alert("Dev server process has been shut down.");
  };

  // Clear Execution Receipts & Trade History
  const handleClearHistory = async () => {
    if (!window.confirm("Are you sure you want to clear all execution receipts and closed trade history?")) return;
    try {
      const res = await fetch('/api/bot/clear-history', { method: 'POST' });
      const data = await res.json();
      if (data.success && botStatus) {
        setBotStatus({ ...botStatus, tradeHistory: [] });
      }
    } catch (err) {
      try {
        const res = await fetch(`http://localhost:${selectedPort}/api/bot/clear-history`, { method: 'POST' });
        const data = await res.json();
        if (data.success && botStatus) {
          setBotStatus({ ...botStatus, tradeHistory: [] });
        }
      } catch (e) {
        console.error("Clear receipts error:", e);
      }
    }
  };

  // Save Modal Config
  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`http://localhost:${selectedPort}/api/bot/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configForm)
      });
      const data = await res.json();
      if (data.success) {
        setShowConfigModal(false);
      }
    } catch (err) {
      console.error("Save config error:", err);
    }
  };

  // Spawn New Bot Instance
  const handleAddInstance = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newInstancePort) return;

    const newInst: BotInstanceInfo = {
      id: `bot-${Date.now()}`,
      name: newInstanceName.trim() || `Bot #${instances.length + 1} (Port ${newInstancePort})`,
      port: newInstancePort,
      status: 'active',
      tradingMode: 'paper',
      leniencyMode: 'strict'
    };

    setInstances([...instances, newInst]);
    setSelectedPort(newInstancePort);
    setShowInstanceModal(false);
    setNewInstanceName('');
    setNewInstancePort(newInstancePort + 1);
  };

  // Manual Force Sell Override
  const forceSellPosition = async (positionId: string) => {
    try {
      await fetch(`http://localhost:${selectedPort}/api/bot/sell-position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId })
      });
    } catch (err) {
      console.error("Force sell error:", err);
    }
  };

  const isBotActive = botStatus?.isBotActive || false;
  const currentLeniency = botStatus?.config?.leniencyMode || 'strict';
  const activePositions = botStatus?.activePositions || [];
  const tradeHistory: TradeHistoryRecord[] = botStatus?.tradeHistory || [];
  const logs = botStatus?.logs || [];

  // Only lines produced since the last wipe are rendered. The server keeps a
  // longer buffer and re-sends it on every frame, so filtering by the wipe
  // timestamp is what actually clears the view — clearing local state alone
  // would be undone by the next status push a fraction of a second later.
  const visibleLogs = logs.filter(l => l.timestamp >= logClearedAt);
  const secondsToWipe = Math.max(0, Math.ceil((logClearedAt + LOG_WIPE_INTERVAL_MS - wipeTick) / 1000));
  const stats = botStatus?.stats || { totalTrades: 0, winCount: 0, lossCount: 0, winRatePct: 0, totalNetPnlUsd: 0, totalNetPnlSol: 0 };

  return (
    <div>
      {/* Editorial Bloomberg Header */}
      <header className="header">
        <div>
          <div className="brand-title">PUMPPORTAL TERMINAL — MULTI-INSTANCE ALGORITHMIC SNIPER</div>
          <div className="brand-subtitle">PORT {selectedPort} / HELIUS RPC / PHOTON MAINNET SIGNER / PLAYBOOK V1.0</div>
        </div>

        {/* Multi-Instance Switcher Bar */}
        <div className="instance-bar">
          <span style={{ fontSize: '9px', textTransform: 'uppercase', color: 'var(--ink-secondary)', fontWeight: 700, marginRight: '4px' }}>
            BOT INSTANCES:
          </span>
          {instances.map(inst => (
            <button
              key={inst.id}
              className={`btn-instance ${selectedPort === inst.port ? 'active' : ''}`}
              onClick={() => setSelectedPort(inst.port)}
            >
              {inst.name} ({inst.port})
            </button>
          ))}
          <button
            className="btn-instance"
            style={{ borderColor: 'var(--accent-bronze)', color: 'var(--accent-bronze)' }}
            onClick={() => setShowInstanceModal(true)}
          >
            + NEW INSTANCE
          </button>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button className="btn-terminal-outline" onClick={() => setShowConfigModal(true)}>
            SETTINGS
          </button>

          <button className="btn-terminal-outline" onClick={handleClearHistory} style={{ borderColor: 'var(--ink-secondary)' }}>
            🗑️ CLEAR RECEIPTS
          </button>

          <button 
            className="btn-terminal" 
            onClick={isBotActive ? handleEmergencyStop : toggleBotPower}
            style={{
              background: isBotActive ? '#d32f2f' : 'var(--accent-olive)',
              borderColor: isBotActive ? '#d32f2f' : 'var(--accent-olive)',
              color: '#ffffff',
              fontWeight: 700
            }}
          >
            {isBotActive ? '⏹ CEASE / STOP BOT' : '▶ START BOT'}
          </button>

          <button 
            className="btn-terminal" 
            onClick={handleShutdownServer}
            style={{
              background: '#8b0000',
              borderColor: '#ff1744',
              color: '#ffffff',
              fontWeight: 700
            }}
          >
            💀 KILL DEV SERVER
          </button>
        </div>
      </header>

      {/* Top 5-Card Metric Strip — Visual Anchor: Cumulative Performance */}
      <section className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Strategic Environment</div>
          <div className="stat-value-mono">
            {botStatus?.marketRegime || 'RISK_ON'}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', textTransform: 'uppercase', fontFamily: 'var(--font-sans)', letterSpacing: '0.06em' }}>
            {botStatus?.tradingMode.toUpperCase() || 'PAPER'} ({currentLeniency.toUpperCase()})
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Capital Allocation</div>
          <div className="stat-value-mono">
            ${botStatus?.bankrollUsd.toFixed(2) || '100.00'}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            PORT {selectedPort} EQUALITY
          </div>
        </div>

        {/* Hero Anchor Card — Cumulative Performance in Large Italic Fraunces */}
        <div className="stat-card hero-anchor">
          <div className="stat-label" style={{ color: 'var(--ink-primary)', fontWeight: 700 }}>
            Cumulative Performance
          </div>
          <div className={`hero-fraunces-number ${stats.totalNetPnlUsd >= 0 ? 'delta-positive' : 'delta-negative'}`}>
            {stats.totalNetPnlUsd >= 0 ? '+' : ''}${stats.totalNetPnlUsd.toFixed(2)}
          </div>
          <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--ink-secondary)', marginTop: '2px' }}>
            {stats.totalNetPnlSol >= 0 ? '+' : ''}{stats.totalNetPnlSol} SOL REALIZED
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Success Metrics</div>
          <div className="stat-value-mono">
            {stats.winRatePct}%
          </div>
          <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {stats.winCount}W / {stats.lossCount}L ({stats.totalTrades} TOTAL)
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Active Engagements</div>
          <div className="stat-value-mono">
            {activePositions.length} / {botStatus?.config.maxActivePositions ?? '—'}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-sans)', letterSpacing: '0.06em' }}>
            CONCURRENT LIMIT
          </div>
        </div>

        {/* Runtime clock — ticks every second while a run is live */}
        <div className="stat-card" style={{ border: runElapsedSec !== null ? '1px solid rgba(0,230,118,0.4)' : undefined }}>
          <div className="stat-label">Runtime</div>
          <div className="stat-value-mono" style={{ color: runElapsedSec !== null ? '#00e676' : undefined }}>
            {runElapsedSec !== null
              ? fmtClock(runElapsedSec)
              : lastReport
                ? fmtClock(lastReport.durationSeconds)
                : '00:00:00'}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {runElapsedSec !== null && run?.startedAt
              ? `RUNNING · STARTED ${new Date(run.startedAt).toLocaleTimeString()}`
              : lastReport
                ? 'LAST RUN TOTAL · BOT IDLE'
                : 'BOT IDLE'}
          </div>
        </div>

        {/* Live run funnel — how many tokens the filter saw vs. actually bought */}
        <div className="stat-card">
          <div className="stat-label">{run ? 'Run In Progress' : 'Last Run'}</div>
          <div className="stat-value-mono">
            {run
              ? `${run.tokensSeen ?? 0} → ${run.positionsOpened ?? 0}`
              : lastReport
                ? `${lastReport.tokensSeen} → ${lastReport.positionsOpened}`
                : '—'}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {run
              ? 'SEEN → BOUGHT THIS RUN'
              : lastReport
                ? `ROI ${lastReport.roiPct >= 0 ? '+' : ''}${lastReport.roiPct}% · SAVED TO reports/`
                : 'NO RUNS YET'}
          </div>
        </div>

        {/* Wallet state — the difference between paper and real money */}
        <div className="stat-card" style={{ border: wallet?.linked ? '1px solid rgba(0,230,118,0.4)' : undefined }}>
          <div className="stat-label">
            Photon Wallet
            <span style={{ float: 'right', fontSize: '9px', color: streamLive ? '#00e676' : '#fbbf24' }}>
              {streamLive ? '● LIVE' : '○ POLLING'}
            </span>
          </div>
          <div className="stat-value-mono" style={{ color: wallet?.linked ? '#00e676' : undefined }}>
            {wallet?.linked ? `${wallet.solBalance} SOL` : 'NOT LINKED'}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {wallet?.linked
              ? `${wallet.shortAddress} · $${wallet.usdBalance} · ${wallet.rpcHealthy ? 'RPC OK' : 'RPC DOWN'} · SOL $${botStatus?.config?.solPriceUsd ?? '—'}`
              : 'PAPER MODE ONLY'}
          </div>
        </div>

        {/* Next order size — recomputed from the live balance every frame, by
            the same maths the buy path uses. */}
        <div className="stat-card">
          <div className="stat-label">
            {botStatus?.config?.walletSplitSizing ? `Slot Size (1 of ${botStatus?.config?.maxActivePositions ?? 3})` : 'Next Entry Size'}
          </div>
          <div className="stat-value-mono">
            {sizing ? `${sizing.nextBuySol} SOL` : '—'}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {sizing
              ? `≈ $${sizing.nextBuyUsd} × ${sizing.tradesAffordable} TRADE${sizing.tradesAffordable === 1 ? '' : 'S'} FROM ${sizing.deployableSol} SOL`
              : 'AWAITING STATUS'}
          </div>
          {/* The whole point of splitting: name what one dead slot actually
              costs, in the currency the owner thinks in. */}
          {sizing && botStatus?.config?.walletSplitSizing && sizing.nextBuySol > 0 && (
            <div style={{ fontSize: '10px', marginTop: '3px', fontFamily: 'var(--font-mono)', color: 'var(--ink-muted)' }}>
              MAX LOSS PER SLOT ≈ ${sizing.nextBuyUsd} ({Math.round(100 / (sizing.slots || botStatus?.config?.maxActivePositions || 3))}% OF RUN)
            </div>
          )}
          {/* The balance can fund N orders while every one of them would be
              refused by the economics gate. Say so here rather than letting the
              bot look armed and buy nothing. */}
          {sizing && sizing.economicsOk === false && sizing.blockedReason && (
            <div style={{ fontSize: '9.5px', marginTop: '4px', padding: '4px 6px', fontFamily: 'var(--font-mono)', color: '#ef4444', border: '1px solid #ef4444', background: 'rgba(239,68,68,0.08)' }}>
              ⛔ NO TRADES POSSIBLE — {sizing.blockedReason}
            </div>
          )}
          {sizing && sizing.slotsReducedForEconomics && (
            <div style={{ fontSize: '9.5px', marginTop: '4px', fontFamily: 'var(--font-mono)', color: '#fbbf24' }}>
              ⚠️ {sizing.requestedSlots} SLOTS REQUESTED → {sizing.slots} FUNDABLE. ONE DEAD POSITION NOW COSTS {Math.round(100 / (sizing.slots || 1))}% OF THE RUN.
            </div>
          )}
          {/* Fee drag is the number that decides whether small stakes can work
              at all — show it next to the stake, not buried in a report. */}
          {sizing && sizing.breakevenPct > 0 && (
            <div style={{
              fontSize: '10px',
              marginTop: '3px',
              fontFamily: 'var(--font-mono)',
              color: sizing.breakevenPct > 10 ? '#ef4444' : sizing.breakevenPct > 6 ? '#fbbf24' : '#00e676',
            }}>
              NEEDS +{sizing.breakevenPct}% TO BREAK EVEN
            </div>
          )}
        </div>
      </section>

      {/* Main Single-Screen Split Grid (Zero Forced Page Scrolling) */}
      <div className="main-viewport-grid">
        {/* Left Column: Leniency Matrix + Positions Matrix */}
        <div className="viewport-column">
          {/* Filter profile — locked to STRICT (server coerces any other value) */}
          <div className="section-header">
            <div className="section-title">Filter Profile Specification</div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <span
                className="btn-terminal-outline"
                style={{
                  padding: '2px 8px',
                  fontSize: '9px',
                  background: 'var(--ink-primary)',
                  color: 'var(--bg-dark)',
                  cursor: 'default',
                }}
              >
                STRICT — LOCKED
              </span>
            </div>
          </div>

          <div className="matrix-container">
            <table className="matrix-table">
              <thead>
                <tr>
                  <th>Filter Parameter</th>
                  <th className="num-col" style={{ color: 'var(--accent-olive)' }}>Strict (Active)</th>
                  <th className="num-col">Normal</th>
                  <th className="num-col">Lenient</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Minimum Score to Trade</td>
                  <td className="num-col">62</td>
                  <td className="num-col">50</td>
                  <td className="num-col" style={{ color: 'var(--accent-olive)', fontWeight: 600 }}>30</td>
                </tr>
                <tr>
                  <td>Minimum Liquidity (USD)</td>
                  <td className="num-col">$8,000</td>
                  <td className="num-col">$3,500</td>
                  <td className="num-col" style={{ color: 'var(--accent-olive)', fontWeight: 600 }}>$1,500</td>
                </tr>
                <tr>
                  <td>Top 10 Holder Cap / Single Holder</td>
                  <td className="num-col">30% / 12%</td>
                  <td className="num-col">45% / 20%</td>
                  <td className="num-col">65% / 40%</td>
                </tr>
                <tr>
                  <td>Bundled Supply / Dev Cap</td>
                  <td className="num-col">25% / 8%</td>
                  <td className="num-col">35% / 12%</td>
                  <td className="num-col">55% / 25%</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Positions Matrix Table */}
          <div className="section-header">
            <div className="section-title">Positions Matrix — Bot Instance Port {selectedPort}</div>
            <div className="section-count">{activePositions.length} OPEN ENGAGEMENTS</div>
          </div>

          <div className="matrix-container flex-matrix">
            {activePositions.length === 0 ? (
              <div className="empty-state">
                {isBotActive ? (
                  <div>Listening on port <strong>{selectedPort}</strong> in <strong>{currentLeniency.toUpperCase()}</strong> mode.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                    <div>No active positions on Bot Instance Port {selectedPort}.</div>
                    <button className="btn-terminal" onClick={toggleBotPower}>
                      START BOT
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Playbook</th>
                    <th className="num-col">Capital (SOL)</th>
                    <th className="num-col">Tokens Held</th>
                    <th className="num-col">Entry Price</th>
                    <th className="num-col">Current Price</th>
                    <th className="num-col">Unrealized PNL</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {activePositions.map((pos: Position) => (
                    <tr key={pos.id}>
                      <td>
                        <span className="cell-symbol">${pos.tokenSymbol}</span>
                        <span className="cell-name">{pos.tokenName}</span>
                      </td>
                      <td>
                        <span className="status-badge">
                          {pos.playbook}
                        </span>
                      </td>
                      <td className="num-col">{pos.investedSol} SOL (${pos.investedUsd})</td>
                      <td className="num-col" title={`${pos.tokensHeld} tokens still held on-chain`}>
                        {qty(pos.tokensHeld)}
                      </td>
                      <td className="num-col">${pos.buyPriceUsd.toFixed(6)}</td>
                      <td className="num-col">${pos.currentPriceUsd.toFixed(6)}</td>
                      <td className={`num-col ${pos.pnlUsd >= 0 ? 'delta-positive' : 'delta-negative'}`}>
                        {pos.pnlUsd >= 0 ? '+' : ''}${pos.pnlUsd.toFixed(2)} ({pos.pnlPct >= 0 ? '+' : ''}{pos.pnlPct}%)
                      </td>
                      <td>
                        <div style={{ display: 'inline-flex', flexDirection: 'column', gap: '3px' }}>
                          {pos.principalRecovered ? (
                            <span className="status-badge positive">RECOVERED</span>
                          ) : (
                            <span className="status-badge">ACTIVE</span>
                          )}
                          <TxProofBadge txid={pos.buyTxid} verified={pos.fillVerified} />
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '4px' }}>
                          {isOnChainTxid(pos.buyTxid) && (
                            <a
                              href={`https://solscan.io/tx/${pos.buyTxid}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="btn-terminal-outline"
                              style={{ padding: '2px 6px', fontSize: '9px' }}
                            >
                              SOLSCAN
                            </a>
                          )}
                          <a
                            href={`https://photon-sol.tinyastro.io/en/lp/${pos.mint}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-terminal-outline"
                            style={{ padding: '2px 6px', fontSize: '9px' }}
                          >
                            PHOTON
                          </a>
                          <button className="btn-cell-action" onClick={() => forceSellPosition(pos.id)}>
                            LIQUIDATE
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Execution receipts — permanent record of every closed leg. The
              Execution column is the ground truth the 10-second log feed can't
              give: a real fill links to its Solscan tx, a paper fill says so. */}
          <div className="section-header" style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div className="section-title">Execution Receipts — Closed Trades</div>
              <div className="section-count">
                {tradeHistory.filter(t => isOnChainTxid(t.sellTxid)).length} ON-CHAIN / {tradeHistory.length} TOTAL
              </div>
            </div>
            {tradeHistory.length > 0 && (
              <button 
                className="btn-terminal-outline" 
                onClick={handleClearHistory}
                style={{ fontSize: '10px', padding: '2px 8px', color: '#ff1744', borderColor: '#ff1744' }}
              >
                🗑️ CLEAR RECEIPTS
              </button>
            )}
          </div>
          <div className="matrix-container flex-matrix">
            {tradeHistory.length === 0 ? (
              <div className="empty-state">
                No closed trades yet. Real fills appear here with an ON-CHAIN ✓ link to their Solscan
                transaction; paper fills are labeled SIMULATED.
              </div>
            ) : (
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th>Closed</th>
                    <th>Asset</th>
                    <th className="num-col">P&amp;L</th>
                    <th className="num-col">Sold</th>
                    <th>Execution</th>
                    <th>Exit Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeHistory.slice(0, 12).map((t, i) => (
                    <tr key={`${t.id}_${t.exitTime}_${i}`}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
                        {new Date(t.exitTime).toLocaleTimeString()}
                      </td>
                      <td>
                        <span className="cell-symbol">${t.tokenSymbol}</span>
                      </td>
                      <td className={`num-col ${t.pnlUsd >= 0 ? 'delta-positive' : 'delta-negative'}`}>
                        {t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd.toFixed(2)} ({t.pnlPct >= 0 ? '+' : ''}{t.pnlPct}%)
                      </td>
                      <td className="num-col">
                        <ExitFillBadge trade={t} />
                      </td>
                      <td>
                        <TxProofBadge txid={t.sellTxid} verified={t.fillVerified} />
                      </td>
                      <td style={{ fontSize: '10px', color: 'var(--ink-muted)', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.exitReason}>
                        {t.exitReason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right Column: System Logs Console Feed (Full Height Auto-Scroll) */}
        <div className="viewport-column">
          <div className="section-header">
            <div className="section-title">System Logs & Event Stream — Port {selectedPort}</div>
            <div className="section-count">
              {visibleLogs.length} LINE{visibleLogs.length === 1 ? '' : 'S'} · WIPES IN {secondsToWipe}s
            </div>
          </div>

          <div className="console-container">
            {visibleLogs.length === 0 ? (
              <div style={{ color: 'var(--ink-muted)' }}>
                Console cleared. Screening activity appears here as it happens.
              </div>
            ) : (
              visibleLogs.map(log => (
                <div key={log.id} className="log-line">
                  <span className="log-time">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                  <span className={`log-level-${log.level}`}>
                    {log.message}
                  </span>
                </div>
              ))
            )}
            <div ref={terminalEndRef} />
          </div>
        </div>
      </div>

      {/* Spawn Instance Modal */}
      {showInstanceModal && (
        <div className="modal-overlay">
          <div className="modal-card">
            <div className="modal-title">Spawn New Independent Sniper Bot Instance</div>
            <form onSubmit={handleAddInstance}>
              <div className="form-group">
                <label className="form-label">Instance Name</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. Bot #2 (Alpha Strategy)"
                  value={newInstanceName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewInstanceName(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Backend API Server Port</label>
                <input
                  type="number"
                  className="form-input"
                  value={newInstancePort}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewInstancePort(Number(e.target.value))}
                />
                <div className="form-help">Launch backend process using command: PORT={newInstancePort} npm run server</div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                <button
                  type="button"
                  className="btn-terminal-outline"
                  style={{ flex: 1 }}
                  onClick={() => setShowInstanceModal(false)}
                >
                  DISCARD
                </button>
                <button
                  type="submit"
                  className="btn-terminal"
                  style={{ flex: 1 }}
                >
                  SPAWN INSTANCE
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Parameters & Keys Modal */}
      {showConfigModal && (
        <div className="modal-overlay">
          <div className="modal-card" style={{ maxWidth: '580px', width: '92%' }}>
            <div className="modal-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>System Parameters &amp; Feature Flags — Port {selectedPort}</span>
              {sizing && (
                <span className="status-badge">
                  {sizing.nextBuySol} SOL × {sizing.tradesAffordable}
                </span>
              )}
            </div>

            <form onSubmit={handleSaveConfig}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-group">
                  <label className="form-label">Execution Environment Mode</label>
                  <select
                    className="form-select"
                    value={configForm.tradingMode}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setConfigForm({ ...configForm, tradingMode: e.target.value as 'paper' | 'real' })}
                  >
                    <option value="paper">Paper Simulation (Risk-Free Testbed)</option>
                    <option value="real">Real Photon Mainnet Wallet Execution</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Filter Profile</label>
                  <input
                    className="form-input"
                    value="STRICT (High Safety, Score ≥ 62)"
                    disabled
                    readOnly
                  />
                </div>
              </div>

              {/* Helius Dedicated RPC API Key Input */}
              <div className="form-group" style={{ marginTop: '6px' }}>
                <label className="form-label">Helius Dedicated RPC Key</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Helius API Key"
                  value={configForm.heliusApiKey || ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, heliusApiKey: e.target.value })}
                />
                <div className="form-help">Dedicated RPC node for mainnet transaction landing speed.</div>
              </div>

              {/* Photon Wallet Link — real on-chain execution */}
              <div className="form-group" style={{ border: '1px solid rgba(255,255,255,0.14)', padding: 12, marginTop: '6px' }}>
                <label className="form-label">
                  Photon Wallet {wallet?.linked ? '— LINKED' : '— not linked'}
                </label>

                {wallet?.linked ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontFamily: 'monospace', fontSize: '0.8rem', wordBreak: 'break-all', color: '#00e676' }}>
                      {wallet.address}
                    </div>
                    <div style={{ display: 'flex', gap: 14, fontSize: '0.85rem', flexWrap: 'wrap' }}>
                      <span><strong>{wallet.solBalance}</strong> SOL</span>
                      <span style={{ color: '#94a3b8' }}>${wallet.usdBalance}</span>
                      <span style={{ color: '#00e676' }}>{wallet.deployableSol} deployable</span>
                      <span style={{ color: wallet.rpcHealthy ? '#00e676' : '#ff1744' }}>
                        RPC {wallet.rpcHealthy ? 'OK' : 'DOWN'}
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" className="btn-terminal-outline" style={{ flex: 1 }} onClick={refreshWallet}>
                        REFRESH BALANCE
                      </button>
                      <button type="button" className="btn-terminal-outline" style={{ flex: 1 }} onClick={unlinkWallet}>
                        UNLINK
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <input
                      type="password"
                      className="form-input"
                      placeholder="Paste Photon private key (base58)"
                      value={walletKeyInput}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWalletKeyInput(e.target.value)}
                    />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: '#94a3b8' }}>
                      <input
                        type="checkbox"
                        checked={walletPersist}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWalletPersist(e.target.checked)}
                      />
                      Save to .photon-wallet.json so it reloads on restart
                    </label>
                    <button type="button" className="btn-terminal" onClick={linkWallet} disabled={!walletKeyInput.trim()}>
                      LINK WALLET
                    </button>
                  </div>
                )}
              </div>

              {/* Strategy Parameters Grid */}
              <div style={{ marginTop: '10px' }}>
                <div style={{ fontSize: '8.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-secondary)', marginBottom: '6px' }}>
                  Strategy Parameters
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <div className="form-group">
                    <label className="form-label">Position Size (SOL)</label>
                    <input
                      type="number"
                      step="0.001"
                      className="form-input"
                      value={configForm.buyAmountSol}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, buyAmountSol: Number(e.target.value) })}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Take Profit Target (%)</label>
                    <input
                      type="number"
                      className="form-input"
                      value={configForm.takeProfitPct}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, takeProfitPct: Number(e.target.value) })}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Trailing Arm (x peak)</label>
                    <input
                      type="number"
                      step="0.1"
                      className="form-input"
                      value={configForm.trailingArmMultiple}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, trailingArmMultiple: Number(e.target.value) })}
                    />
                    <div style={{ fontSize: '7.5px', color: 'var(--ink-muted)', marginTop: '3px' }}>
                      No price stop-loss. The trailing stop is a moonbag ratchet — it
                      arms only above this multiple, then gives back {configForm.trailingStopPct}%.
                      Losses are cut by structural exits, not by a price floor.
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Max Concurrent Positions</label>
                    <input
                      type="number"
                      className="form-input"
                      value={configForm.maxActivePositions}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, maxActivePositions: Number(e.target.value) })}
                    />
                  </div>
                </div>

                {/* Wallet-split sizing: the run budget is carved into equal
                    slots at START, so one dead trade costs 1/N of the run. */}
                <div style={{ marginTop: '8px', padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                  <div>
                    <div style={{ fontSize: '8.5px', fontWeight: 700 }}>💰 Split Wallet Across Slots</div>
                    <div style={{ fontSize: '7.5px', color: 'var(--ink-muted)' }}>
                      At START, divide the deployable balance into {configForm.maxActivePositions ?? 3} equal
                      slots and stake one per trade. Fixed for the run, so a position going to zero costs
                      1/{configForm.maxActivePositions ?? 3} and never shrinks the others. Overrides Position Size.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={!!configForm.walletSplitSizing}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, walletSplitSizing: e.target.checked })}
                  />
                </div>
              </div>

              {/* Feature Flags Matrix */}
              <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border-hairline)' }}>
                <div style={{ fontSize: '8.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-secondary)', marginBottom: '6px' }}>
                  Engine Feature Flags &amp; Guards
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                  <div style={{ padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '8.5px', fontWeight: 700 }}>🛑 Dev Sell Stop</div>
                      <div style={{ fontSize: '7.5px', color: 'var(--ink-muted)' }}>Exit on creator / cluster sells</div>
                    </div>
                    <input type="checkbox" checked={!!featureFlags.devSellStop} onChange={e => handleToggleFlag('devSellStop', e.target.checked)} />
                  </div>

                  <div style={{ padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '8.5px', fontWeight: 700 }}>🧪 Honest Paper</div>
                      <div style={{ fontSize: '7.5px', color: 'var(--ink-muted)' }}>Real curve fills &amp; fee drag</div>
                    </div>
                    <input type="checkbox" checked={!!featureFlags.honestPaper} onChange={e => handleToggleFlag('honestPaper', e.target.checked)} />
                  </div>

                  <div style={{ padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '8.5px', fontWeight: 700 }}>🎯 Playbook Router</div>
                      <div style={{ fontSize: '7.5px', color: 'var(--ink-muted)' }}>Measured curve routing</div>
                    </div>
                    <input type="checkbox" checked={!!featureFlags.playbookRouting} onChange={e => handleToggleFlag('playbookRouting', e.target.checked)} />
                  </div>

                  <div style={{ padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '8.5px', fontWeight: 700 }}>⚡ Kill Switch</div>
                      <div style={{ fontSize: '7.5px', color: 'var(--ink-muted)' }}>Auto-pause on hourly loss</div>
                    </div>
                    <input type="checkbox" checked={!!featureFlags.killSwitch} onChange={e => handleToggleFlag('killSwitch', e.target.checked)} />
                  </div>

                  <div style={{ padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '8.5px', fontWeight: 700 }}>⛽ Dynamic Priority Fee</div>
                      <div style={{ fontSize: '7.5px', color: 'var(--ink-muted)' }}>P75 network fee scaling</div>
                    </div>
                    <input type="checkbox" checked={!!featureFlags.dynamicPriorityFee} onChange={e => handleToggleFlag('dynamicPriorityFee', e.target.checked)} />
                  </div>

                  <div style={{ padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '8.5px', fontWeight: 700 }}>🔒 Honeypot Audit</div>
                      <div style={{ fontSize: '7.5px', color: 'var(--ink-muted)' }}>Freeze &amp; transfer hook check</div>
                    </div>
                    <input type="checkbox" checked={!!featureFlags.honeypotChecks} onChange={e => handleToggleFlag('honeypotChecks', e.target.checked)} />
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
                <button
                  type="button"
                  className="btn-terminal-outline"
                  style={{ flex: 1 }}
                  onClick={() => setShowConfigModal(false)}
                >
                  DISCARD
                </button>
                <button
                  type="submit"
                  className="btn-terminal"
                  style={{ flex: 1 }}
                >
                  APPLY PARAMETERS
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
