import React, { useState, useEffect, useRef } from 'react';
import { BotConfig, BotInstanceInfo, BotStatusResponse, FilterResult, LeniencyMode, Position } from './types';

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
    buyAmountSol: 0.05,       // strict default ~$10 @ $200/SOL
    takeProfitPct: 100,
    takeProfitRung2Pct: 400,
    stopLossPct: 35,
    useTrailingStop: true,
    trailingStopPct: 20,
    maxHoldSeconds: 1800,
    maxActivePositions: 99999,
    activePlaybook: 'ALL',
    tradingMode: 'paper',
    leniencyMode: 'strict',
    privateKey: '',
    heliusApiKey: 'dfc72823-152b-468b-936e-57935ae27b08',
  });

  // Photon wallet linking state. The key only ever lives in this input until
  // it is POSTed once; it is never stored in config or read back from status.
  const [walletKeyInput, setWalletKeyInput] = useState<string>('');
  const [walletPersist, setWalletPersist] = useState<boolean>(false);
  const [walletError, setWalletError] = useState<string>('');
  const [lastReport, setLastReport] = useState<any>(null);

  const wallet = botStatus?.wallet;
  const run = botStatus?.run;

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

  // Real-time status: the server pushes over SSE (~1/s). If the stream can't
  // be established (old server build, transient outage) fall back to polling.
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
      pollTimer = setInterval(fetchStatus, 1500);
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
  }, [selectedPort]);

  // Auto-scroll terminal log
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [botStatus?.logs]);

  // Toggle Bot Power ON / OFF
  const toggleBotPower = async () => {
    try {
      const res = await fetch(`http://localhost:${selectedPort}/api/bot/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !botStatus?.isBotActive })
      });
      const data = await res.json();
      if (data.success && botStatus) {
        setBotStatus({ ...botStatus, isBotActive: data.isBotActive });
      }
    } catch (err) {
      console.error("Toggle bot error:", err);
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
  const logs = botStatus?.logs || [];
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

        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn-terminal-outline" onClick={() => setShowConfigModal(true)}>
            SETTINGS
          </button>

          <button 
            className="btn-terminal" 
            onClick={toggleBotPower}
            style={{
              background: isBotActive ? 'var(--accent-olive)' : 'var(--ink-primary)',
              borderColor: isBotActive ? 'var(--accent-olive)' : 'var(--ink-primary)'
            }}
          >
            {isBotActive ? 'CEASE BOT' : 'START BOT'}
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
            {activePositions.length} / {(botStatus?.config.maxActivePositions || 99999) >= 99999 ? 'UNLIMITED' : botStatus?.config.maxActivePositions}
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
                      <td className="num-col">${pos.buyPriceUsd.toFixed(6)}</td>
                      <td className="num-col">${pos.currentPriceUsd.toFixed(6)}</td>
                      <td className={`num-col ${pos.pnlUsd >= 0 ? 'delta-positive' : 'delta-negative'}`}>
                        {pos.pnlUsd >= 0 ? '+' : ''}${pos.pnlUsd.toFixed(2)} ({pos.pnlPct >= 0 ? '+' : ''}{pos.pnlPct}%)
                      </td>
                      <td>
                        {pos.principalRecovered ? (
                          <span className="status-badge positive">RECOVERED</span>
                        ) : (
                          <span className="status-badge">ACTIVE</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '4px' }}>
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
        </div>

        {/* Right Column: System Logs Console Feed (Full Height Auto-Scroll) */}
        <div className="viewport-column">
          <div className="section-header">
            <div className="section-title">System Logs & Event Stream — Port {selectedPort}</div>
            <div className="section-count">REALTIME AUDIT FEED</div>
          </div>

          <div className="console-container">
            {logs.filter(l => l.level !== 'gate0' && (Date.now() - l.timestamp) <= 10000).length === 0 ? (
              <div style={{ color: 'var(--ink-muted)' }}>Console initialized on Port {selectedPort}. Awaiting system events...</div>
            ) : (
              logs.filter(l => l.level !== 'gate0' && (Date.now() - l.timestamp) <= 10000).map(log => (
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
          <div className="modal-card">
            <div className="modal-title">System Parameters — Port {selectedPort}</div>

            <form onSubmit={handleSaveConfig}>
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
                  value="STRICT (High Safety, Score ≥ 62) — locked"
                  disabled
                  readOnly
                />
                <div className="form-help">This bot only trades the strict profile. The server rejects any other value.</div>
              </div>

              {/* Helius Dedicated RPC API Key Input */}
              <div className="form-group">
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
              <div className="form-group" style={{ border: '1px solid rgba(255,255,255,0.14)', borderRadius: 10, padding: 14 }}>
                <label className="form-label">
                  Photon Wallet {wallet?.linked ? '— LINKED' : '— not linked'}
                </label>

                {wallet?.linked ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontFamily: 'monospace', fontSize: '0.8rem', wordBreak: 'break-all', color: '#00e676' }}>
                      {wallet.address}
                    </div>
                    <div style={{ display: 'flex', gap: 16, fontSize: '0.85rem', flexWrap: 'wrap' }}>
                      <span><strong>{wallet.solBalance}</strong> SOL</span>
                      <span style={{ color: '#94a3b8' }}>${wallet.usdBalance}</span>
                      <span style={{ color: '#94a3b8' }}>{wallet.deployableSol} deployable</span>
                      <span style={{ color: wallet.rpcHealthy ? '#00e676' : '#ff1744' }}>
                        RPC {wallet.rpcHealthy ? 'OK' : 'DOWN'}
                      </span>
                      <span style={{ color: '#64748b' }}>via {wallet.source}</span>
                    </div>

                    {wallet.blockers.length > 0 && (
                      <div style={{ color: '#fbbf24', fontSize: '0.8rem' }}>
                        ⚠️ {wallet.blockers.join(' ')}
                      </div>
                    )}

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
                    <div className="form-help">
                      Signs locally and never leaves this machine. Prefer setting <code>PHOTON_PRIVATE_KEY</code> in
                      your environment — then it loads at startup and never touches the browser at all.
                    </div>
                  </div>
                )}

                {walletError && (
                  <div style={{ color: '#ff1744', fontSize: '0.8rem', marginTop: 8 }}>{walletError}</div>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">Position Allocation Size (SOL)</label>
                <input
                  type="number"
                  step="0.01"
                  className="form-input"
                  value={configForm.buyAmountSol}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, buyAmountSol: Number(e.target.value) })}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Take Profit 1 Target (%)</label>
                <input
                  type="number"
                  className="form-input"
                  value={configForm.takeProfitPct}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, takeProfitPct: Number(e.target.value) })}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Soft Support Limit (%)</label>
                <input
                  type="number"
                  className="form-input"
                  value={configForm.stopLossPct}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, stopLossPct: Number(e.target.value) })}
                />
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

              <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
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
