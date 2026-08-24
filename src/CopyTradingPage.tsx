import React, { useState, useEffect, useRef } from 'react';
import { CopyFeedEvent, CopyPosition, CopyStatusResponse, CopyTradeRecord, CopyTraderConfig, TrackedWalletPublic } from './types';
import { apiFetch } from './apiClient';

const isOnChainTxid = (txid?: string): boolean => Boolean(txid && !txid.startsWith('sim_'));

const qty = (n?: number): string => {
  if (!n || !isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(n < 10 ? 2 : 0);
};

const fmtAgo = (ts: number | null): string => {
  if (!ts) return 'never';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
};

function ExecBadge({ txid, fillVerified }: { txid?: string; fillVerified?: boolean }) {
  if (!isOnChainTxid(txid)) {
    return (
      <span className="status-badge" title="Paper fill — simulated at the leader's observed price, never sent to the chain">
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
      style={{ color: fillVerified ? '#00e676' : '#fbbf24', borderColor: fillVerified ? '#00e676' : '#fbbf24', textDecoration: 'none' }}
      title={fillVerified
        ? 'Confirmed on-chain — quantities read back from the actual fill. Click for Solscan.'
        : 'Submitted and confirmed on-chain — fill details estimated. Click for Solscan.'}
    >
      {fillVerified ? 'ON-CHAIN ✓' : 'ON-CHAIN ↗'}
    </a>
  );
}

export function CopyTradingPage({ apiBase }: { apiBase: string }) {
  const [status, setStatus] = useState<CopyStatusResponse | null>(null);
  const [streamLive, setStreamLive] = useState<boolean>(false);

  // Add-wallet form
  const [addrInput, setAddrInput] = useState<string>('');
  const [nickInput, setNickInput] = useState<string>('');
  const [addError, setAddError] = useState<string>('');

  // Settings modal
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [configForm, setConfigForm] = useState<Partial<CopyTraderConfig>>({});
  const [settingsError, setSettingsError] = useState<string>('');
  const showSettingsRef = useRef(false);
  useEffect(() => { showSettingsRef.current = showSettings; }, [showSettings]);

  const feedEndRef = useRef<HTMLDivElement>(null);

  // Same transport strategy as the sniper page: SSE first, tight polling as
  // the degraded path.
  useEffect(() => {
    let closed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let es: EventSource | null = null;

    const apply = (data: CopyStatusResponse) => {
      if (closed) return;
      setStatus(data);
      if (data.config && !showSettingsRef.current) {
        setConfigForm(data.config);
      }
    };

    const startPolling = () => {
      if (pollTimer) return;
      setStreamLive(false);
      const fetchStatus = async () => {
        try {
          const res = await fetch(`${apiBase}/api/copy/status`);
          if (res.ok) apply(await res.json());
        } catch { /* offline on this port */ }
      };
      fetchStatus();
      pollTimer = setInterval(fetchStatus, 1000);
    };

    let sseFailures = 0;
    try {
      es = new EventSource(`${apiBase}/api/copy/stream`);
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
  }, [apiBase]);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [status?.feed?.length]);

  const post = async (url: string, body?: object): Promise<any> => {
    try {
      const res = await apiFetch(`${apiBase}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return await res.json().catch(() => ({}));
    } catch {
      return { success: false, error: 'Backend unreachable.' };
    }
  };

  const toggleEngine = async () => {
    const data = await post('/api/copy/toggle', { enabled: !status?.enabled });
    if (data?.error) setSettingsError(data.error);
  };

  const addWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError('');
    const data = await post('/api/copy/wallets', { address: addrInput.trim(), nickname: nickInput.trim() });
    if (data?.success) {
      setAddrInput('');
      setNickInput('');
    } else {
      setAddError(data?.error || 'Could not add wallet.');
    }
  };

  const removeWallet = async (address: string) => {
    if (!window.confirm('Stop tracking this wallet? Open copy positions from it are kept.')) return;
    await post('/api/copy/wallets/remove', { address });
  };

  const toggleWallet = async (w: TrackedWalletPublic) => {
    await post('/api/copy/wallets/update', { address: w.address, enabled: !w.enabled });
  };

  const forceSell = async (positionId: string) => {
    await post('/api/copy/sell', { positionId });
  };

  const clearHistory = async () => {
    if (!window.confirm('Clear the copy feed and receipts? Open positions are kept.')) return;
    await post('/api/copy/clear-history');
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsError('');
    const data = await post('/api/copy/config', configForm);
    if (data?.success) {
      setShowSettings(false);
    } else {
      setSettingsError(data?.error || 'Could not save settings.');
    }
  };

  const enabled = status?.enabled || false;
  const mode = status?.tradingMode || 'paper';
  const wallets = status?.wallets || [];
  const positions: CopyPosition[] = status?.positions || [];
  const history: CopyTradeRecord[] = status?.history || [];
  const feed: CopyFeedEvent[] = status?.feed || [];
  const stats = status?.stats;
  const engineWallet = status?.wallet;
  const sellsLabel = status?.config?.copySells ? (status.config.sellMode === 'full' ? 'FULL' : 'MIRROR') : 'OFF';
  const autoClearMin = status?.config?.feedAutoClearMinutes ?? 0;

  const feedColor = (ev: CopyFeedEvent): string => {
    if (ev.action === 'failed') return 'log-level-error';
    if (ev.action === 'pending') return 'log-level-warn';
    if (ev.action === 'skipped') return 'log-level-gate0';
    return ev.side === 'buy' ? 'log-level-snipe' : 'log-level-sell';
  };

  return (
    <>
      {/* Stat strip — mirrors the sniper page's 5-card anatomy */}
      <section className="stats-grid">
        <div className="stat-card" style={{ border: enabled ? '1px solid rgba(0,230,118,0.4)' : undefined }}>
          <div className="stat-label">
            Copy Engine
            <span style={{ float: 'right', fontSize: '9px', color: streamLive ? '#00e676' : '#fbbf24' }}>
              {streamLive ? '● LIVE' : '○ POLLING'}
            </span>
          </div>
          <div className="stat-value-mono" style={{ color: enabled ? '#00e676' : undefined }}>
            {enabled ? 'ACTIVE' : 'STOPPED'}
          </div>
          <div
            style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}
            title="ON-CHAIN is the Helius wallet watcher — it sees every buy and sell on any venue. PUMP.FUN is the PumpPortal fast lane for pump.fun trades. SELLS is the copy-sells setting — OFF means leader sells are shown but the position is held."
          >
            {mode.toUpperCase()} · ON-CHAIN {status?.heliusConnected ? 'OK' : '—'} · PUMP.FUN {status?.streamConnected ? 'OK' : '—'} · SELLS {sellsLabel}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Tracked Wallets</div>
          <div className="stat-value-mono">
            {wallets.filter(w => w.enabled).length} / {wallets.length}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {stats ? `${stats.signalsSeen} SIGNALS SEEN` : 'ENABLED / TOTAL'}
          </div>
        </div>

        {/* Hero anchor — realized copy P&L */}
        <div className="stat-card hero-anchor">
          <div className="stat-label" style={{ color: 'var(--ink-primary)', fontWeight: 700 }}>
            Copy P&amp;L Realized
          </div>
          <div className={`hero-fraunces-number ${(stats?.realizedPnlUsd ?? 0) >= 0 ? 'delta-positive' : 'delta-negative'}`}>
            {(stats?.realizedPnlUsd ?? 0) >= 0 ? '+' : ''}${(stats?.realizedPnlUsd ?? 0).toFixed(2)}
          </div>
          <div style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--ink-secondary)', marginTop: '2px' }}>
            {(stats?.unrealizedPnlUsd ?? 0) >= 0 ? '+' : ''}${(stats?.unrealizedPnlUsd ?? 0).toFixed(2)} UNREALIZED
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Copies Executed</div>
          <div className="stat-value-mono">
            {(stats?.copiedBuys ?? 0)}B / {(stats?.copiedSells ?? 0)}S
          </div>
          <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {stats ? `${stats.skippedSignals} SKIPPED · WIN ${stats.winRatePct}%` : '—'}
          </div>
        </div>

        <div className="stat-card" style={{ border: engineWallet?.linked ? '1px solid rgba(0,230,118,0.4)' : undefined }}>
          <div className="stat-label">Photon Wallet</div>
          <div className="stat-value-mono" style={{ color: engineWallet?.linked ? '#00e676' : undefined }}>
            {engineWallet?.linked ? `${engineWallet.solBalance} SOL` : 'NOT LINKED'}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {engineWallet?.linked
              ? `${engineWallet.shortAddress} · $${engineWallet.usdBalance} · SOL $${status?.solPriceUsd ?? '—'}`
              : 'PAPER COPIES ONLY — LINK IN SNIPER SETTINGS'}
          </div>
        </div>
      </section>

      {/* Main split view */}
      <div className="main-viewport-grid">
        {/* Left: wallets, positions, receipts */}
        <div className="viewport-column">
          <div className="section-header">
            <div className="section-title">Leader Wallets Under Surveillance</div>
            <div className="section-count">{wallets.length} TRACKED</div>
          </div>

          {/* Add wallet form — one compact row */}
          <form onSubmit={addWallet} style={{ display: 'flex', gap: '6px', marginBottom: '6px', flexShrink: 0 }}>
            <input
              type="text"
              className="form-input"
              style={{ flex: 2.2 }}
              placeholder="Leader wallet address (base58)"
              value={addrInput}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAddrInput(e.target.value)}
            />
            <input
              type="text"
              className="form-input"
              style={{ flex: 1 }}
              placeholder="Nickname (optional)"
              value={nickInput}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNickInput(e.target.value)}
            />
            <button type="submit" className="btn-terminal" disabled={!addrInput.trim()}>
              + TRACK WALLET
            </button>
          </form>
          {addError && (
            <div style={{ fontSize: '9.5px', color: '#ff1744', fontFamily: 'var(--font-mono)', marginBottom: '6px', flexShrink: 0 }}>
              ⛔ {addError}
            </div>
          )}

          <div className="matrix-container" style={{ maxHeight: '32%', overflowY: 'auto' }}>
            {wallets.length === 0 ? (
              <div className="empty-state">
                No leader wallets yet. Paste any wallet address above — every buy and sell it makes,
                on any venue, is mirrored while the copy engine runs.
              </div>
            ) : (
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th>Leader</th>
                    <th className="num-col">Signals B/S</th>
                    <th className="num-col">Copied B/S</th>
                    <th className="num-col">Realized P&amp;L</th>
                    <th>Last Seen</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {wallets.map(w => (
                    <tr key={w.address}>
                      <td>
                        <span className="cell-symbol">{w.nickname}</span>
                        <span className="cell-name" title={w.address}>{w.shortAddress}</span>
                      </td>
                      <td className="num-col">{w.buysSeen} / {w.sellsSeen}</td>
                      <td className="num-col">{w.copiedBuys} / {w.copiedSells}</td>
                      <td className={`num-col ${w.realizedPnlUsd >= 0 ? 'delta-positive' : 'delta-negative'}`}>
                        {w.realizedPnlUsd >= 0 ? '+' : ''}${w.realizedPnlUsd.toFixed(2)}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', color: 'var(--ink-secondary)' }}>
                        {fmtAgo(w.lastSeenAt)}
                      </td>
                      <td>
                        <span className={`status-badge ${w.enabled ? 'positive' : ''}`}>
                          {w.enabled ? 'COPYING' : 'PAUSED'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '4px' }}>
                          <a
                            href={`https://solscan.io/account/${w.address}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-terminal-outline"
                            style={{ padding: '2px 6px', fontSize: '9px', textDecoration: 'none' }}
                          >
                            SOLSCAN
                          </a>
                          <button
                            className="btn-terminal-outline"
                            style={{ padding: '2px 6px', fontSize: '9px' }}
                            onClick={() => toggleWallet(w)}
                          >
                            {w.enabled ? 'PAUSE' : 'RESUME'}
                          </button>
                          <button className="btn-cell-action" onClick={() => removeWallet(w.address)}>
                            UNTRACK
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="section-header" style={{ marginTop: '8px' }}>
            <div className="section-title">Open Copy Positions</div>
            <div className="section-count">{positions.length} OPEN</div>
          </div>

          <div className="matrix-container flex-matrix">
            {positions.length === 0 ? (
              <div className="empty-state">
                {enabled
                  ? 'Watching for leader buys. Copied positions appear here the moment one lands.'
                  : 'Copy engine is stopped. Press START COPY ENGINE to begin mirroring leader trades.'}
              </div>
            ) : (
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Copied From</th>
                    <th className="num-col">Invested</th>
                    <th className="num-col">Tokens</th>
                    <th className="num-col">Unrealized PNL</th>
                    <th>Execution</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map(pos => (
                    <tr key={pos.id}>
                      <td>
                        <span className="cell-symbol">${pos.tokenSymbol}</span>
                        <span className="cell-name">{pos.tokenName}</span>
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px' }} title={pos.leaderWallet}>
                        {pos.leaderNickname}
                      </td>
                      <td className="num-col">{pos.investedSol} SOL (${pos.investedUsd})</td>
                      <td className="num-col">{qty(pos.tokensHeld)}</td>
                      <td className={`num-col ${pos.pnlUsd >= 0 ? 'delta-positive' : 'delta-negative'}`}>
                        {pos.pnlUsd >= 0 ? '+' : ''}${pos.pnlUsd.toFixed(2)} ({pos.pnlPct >= 0 ? '+' : ''}{pos.pnlPct}%)
                      </td>
                      <td>
                        <div style={{ display: 'inline-flex', flexDirection: 'column', gap: '3px' }}>
                          {pos.status === 'PARTIAL' && <span className="status-badge" style={{ color: '#fbbf24', borderColor: '#fbbf24' }}>PARTIAL</span>}
                          <ExecBadge txid={pos.buyTxid} fillVerified={pos.fillVerified} />
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '4px' }}>
                          <a
                            href={`https://photon-sol.tinyastro.io/en/lp/${pos.mint}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-terminal-outline"
                            style={{ padding: '2px 6px', fontSize: '9px', textDecoration: 'none' }}
                          >
                            PHOTON
                          </a>
                          <button className="btn-cell-action" onClick={() => forceSell(pos.id)}>
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

          <div className="section-header" style={{ marginTop: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div className="section-title">Copy Receipts — Closed Legs</div>
              <div className="section-count">
                {history.filter(h => isOnChainTxid(h.txid)).length} ON-CHAIN / {history.length} TOTAL
              </div>
            </div>
            {history.length > 0 && (
              <button
                className="btn-terminal-outline"
                onClick={clearHistory}
                style={{ fontSize: '10px', padding: '2px 8px', color: '#ff1744', borderColor: '#ff1744' }}
              >
                🗑️ CLEAR
              </button>
            )}
          </div>
          <div className="matrix-container flex-matrix">
            {history.length === 0 ? (
              <div className="empty-state">
                No copy trades recorded yet. Every mirrored buy and sell lands here with its execution proof.
              </div>
            ) : (
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Asset</th>
                    <th>Side</th>
                    <th className="num-col">SOL</th>
                    <th className="num-col">P&amp;L</th>
                    <th>Execution</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {history.slice(0, 14).map(h => (
                    <tr key={h.id}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
                        {new Date(h.timestamp).toLocaleTimeString()}
                      </td>
                      <td><span className="cell-symbol">${h.tokenSymbol}</span></td>
                      <td>
                        <span className="status-badge" style={h.side === 'buy'
                          ? { color: 'var(--accent-olive)', borderColor: 'var(--accent-olive)' }
                          : { color: 'var(--accent-bronze)', borderColor: 'var(--accent-bronze)' }}>
                          {h.side.toUpperCase()}
                        </span>
                      </td>
                      <td className="num-col">{h.solAmount}</td>
                      <td className={`num-col ${h.pnlUsd >= 0 ? 'delta-positive' : 'delta-negative'}`}>
                        {h.side === 'buy' ? '—' : `${h.pnlUsd >= 0 ? '+' : ''}$${h.pnlUsd.toFixed(2)} (${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct}%)`}
                      </td>
                      <td><ExecBadge txid={h.txid} fillVerified={h.fillVerified} /></td>
                      <td style={{ fontSize: '10px', color: 'var(--ink-muted)', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.exitReason}>
                        {h.side === 'buy' ? `from ${h.leaderNickname}` : h.exitReason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right: live signal feed */}
        <div className="viewport-column">
          <div className="section-header">
            <div className="section-title">Leader Signal Feed — Live Copy Decisions</div>
            <div className="section-count">
              {feed.length} EVENTS{autoClearMin > 0 ? ` · AUTO-CLEAR ${autoClearMin}M` : ''}
            </div>
          </div>

          <div className="console-container">
            {feed.length === 0 ? (
              <div style={{ color: 'var(--ink-muted)' }}>
                Every leader buy/sell appears here with the copy verdict: COPIED, SKIPPED (with the reason), or FAILED.
              </div>
            ) : (
              [...feed].reverse().map(ev => (
                <div key={ev.id} className="log-line">
                  <span className="log-time">[{new Date(ev.timestamp).toLocaleTimeString()}]</span>
                  <span className={feedColor(ev)}>
                    {ev.action === 'copied' ? '✅' : ev.action === 'failed' ? '❌' : ev.action === 'pending' ? '⏳' : '⏭️'}
                    {ev.via ? ` [${ev.via === 'helius' ? 'CHAIN' : ev.via === 'manual' ? 'MANUAL' : 'PUMP'}]` : ''}{' '}
                    {ev.leaderNickname} {ev.side.toUpperCase()} ${ev.tokenSymbol}
                    {ev.leaderSolAmount > 0 ? ` (${ev.leaderSolAmount} SOL)` : ''} — {ev.detail}
                  </span>
                </div>
              ))
            )}
            <div ref={feedEndRef} />
          </div>
        </div>
      </div>

      {/* Copy Settings Modal */}
      {showSettings && (
        <div className="modal-overlay">
          <div className="modal-card" style={{ maxWidth: '560px', width: '92%' }}>
            <div className="modal-title">Copy Trading Parameters</div>

            <form onSubmit={saveSettings}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-group">
                  <label className="form-label">Execution Environment Mode</label>
                  <select
                    className="form-select"
                    value={configForm.tradingMode || 'paper'}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setConfigForm({ ...configForm, tradingMode: e.target.value as 'paper' | 'real' })}
                  >
                    <option value="paper">Paper Simulation (Risk-Free Testbed)</option>
                    <option value="real">Real Photon Mainnet Wallet Execution</option>
                  </select>
                  <div className="form-help" style={{ fontSize: '8px' }}>
                    Real mode signs with the same Photon wallet linked in Sniper settings.
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Buy Sizing Mode</label>
                  <select
                    className="form-select"
                    value={configForm.buySizeMode || 'fixed'}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setConfigForm({ ...configForm, buySizeMode: e.target.value as 'fixed' | 'proportional' })}
                  >
                    <option value="fixed">Fixed SOL per copy</option>
                    <option value="proportional">% of leader's buy size</option>
                  </select>
                </div>

                {configForm.buySizeMode === 'proportional' ? (
                  <div className="form-group">
                    <label className="form-label">Copy % of Leader Size</label>
                    <input
                      type="number" step="1" className="form-input"
                      value={configForm.proportionalPct ?? 10}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, proportionalPct: Number(e.target.value) })}
                    />
                  </div>
                ) : (
                  <div className="form-group">
                    <label className="form-label">Fixed Buy Size (SOL)</label>
                    <input
                      type="number" step="0.001" className="form-input"
                      value={configForm.fixedBuySol ?? 0.05}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, fixedBuySol: Number(e.target.value) })}
                    />
                  </div>
                )}

                <div className="form-group">
                  <label className="form-label">Max Buy Ceiling (SOL)</label>
                  <input
                    type="number" step="0.01" className="form-input"
                    value={configForm.maxBuySol ?? 0.5}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, maxBuySol: Number(e.target.value) })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Min Leader Buy to Copy (SOL)</label>
                  <input
                    type="number" step="0.01" className="form-input"
                    value={configForm.minLeaderBuySol ?? 0}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, minLeaderBuySol: Number(e.target.value) })}
                  />
                  <div className="form-help" style={{ fontSize: '8px' }}>
                    0 = copy EVERY buy the leader makes. Raise to ignore their dust.
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Max Open Copy Positions</label>
                  <input
                    type="number" className="form-input"
                    value={configForm.maxOpenPositions ?? 3}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, maxOpenPositions: Number(e.target.value) })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Max Slippage (%)</label>
                  <input
                    type="number" className="form-input"
                    value={configForm.maxSlippagePct ?? 25}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, maxSlippagePct: Number(e.target.value) })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Per-Wallet Cooldown (sec, 0 = off)</label>
                  <input
                    type="number" className="form-input"
                    value={configForm.perWalletCooldownSec ?? 0}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, perWalletCooldownSec: Number(e.target.value) })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Auto-Clear Feed (min, 0 = keep)</label>
                  <input
                    type="number" className="form-input"
                    value={configForm.feedAutoClearMinutes ?? 2}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, feedAutoClearMinutes: Number(e.target.value) })}
                  />
                  <div className="form-help" style={{ fontSize: '8px' }}>
                    Feed lines older than this drop off on their own. Receipts are never auto-cleared.
                  </div>
                </div>
              </div>

              {/* Exits. Auto-sells were removed 2026-08-12 and restored as a toggle
                  on 2026-08-13 — but the control never reached this form, so
                  upgraded installs (where the migration switches copySells OFF)
                  had no way to turn it back on and never sold. */}
              <div style={{ marginTop: '10px', padding: '8px', border: '1px solid rgba(148,163,184,0.35)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: '#e2e8f0' }}>
                  <input
                    type="checkbox"
                    checked={configForm.copySells === true}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, copySells: e.target.checked })}
                  />
                  Copy sells — when a tracked leader sells, sell too
                </label>
                {configForm.copySells === true && (
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">When the leader sells</label>
                    <select
                      className="form-select"
                      value={configForm.sellMode || 'mirror'}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setConfigForm({ ...configForm, sellMode: e.target.value as 'mirror' | 'full' })}
                    >
                      <option value="mirror">Mirror — sell the same fraction of our bag that they sold of theirs</option>
                      <option value="full">Full — any leader sell closes our whole position</option>
                    </select>
                  </div>
                )}
                <div className="form-help" style={{ fontSize: '8px' }}>
                  {configForm.copySells === true
                    ? 'Fires on the leader\'s exit only — never on price. A sell that fails is retried (up to 6 attempts, alternating venue); one arriving while another is in flight is queued, not dropped. No take-profit, no stop-loss. The SELL button always works.'
                    : 'OFF — leader sells show in the feed and the position is HELD. The SELL button on each position is the only exit.'}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: '#94a3b8' }}>
                  <input
                    type="checkbox"
                    checked={configForm.blockRepeatBuys === true}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, blockRepeatBuys: e.target.checked })}
                  />
                  Block repeat buys (off = a leader re-buy ADDS to the copy position, like their DCA)
                </label>
              </div>

              {settingsError && (
                <div style={{ fontSize: '9.5px', marginTop: '8px', padding: '4px 6px', fontFamily: 'var(--font-mono)', color: '#ef4444', border: '1px solid #ef4444', background: 'rgba(239,68,68,0.08)' }}>
                  ⛔ {settingsError}
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
                <button type="button" className="btn-terminal-outline" style={{ flex: 1 }} onClick={() => { setShowSettings(false); setSettingsError(''); }}>
                  DISCARD
                </button>
                <button type="submit" className="btn-terminal" style={{ flex: 1 }}>
                  APPLY PARAMETERS
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Header controls are rendered by App via this exported hook-free API */}
      <CopyHeaderControls
        enabled={enabled}
        mode={mode}
        onToggle={toggleEngine}
        onSettings={() => setShowSettings(true)}
        error={!showSettings ? settingsError : ''}
        onDismissError={() => setSettingsError('')}
      />
    </>
  );
}

/**
 * Floating action strip for the copy page. Rendered inside the page (fixed to
 * the top-right under the shared header) so App.tsx's header stays untouched
 * apart from the page switcher.
 */
function CopyHeaderControls({ enabled, mode, onToggle, onSettings, error, onDismissError }: {
  enabled: boolean;
  mode: 'paper' | 'real';
  onToggle: () => void;
  onSettings: () => void;
  error: string;
  onDismissError: () => void;
}) {
  return (
    <div style={{ position: 'fixed', top: '8px', right: '18px', display: 'flex', gap: '8px', alignItems: 'center', zIndex: 500 }}>
      {error && (
        <div
          style={{ fontSize: '9.5px', padding: '4px 6px', fontFamily: 'var(--font-mono)', color: '#ef4444', border: '1px solid #ef4444', background: 'rgba(14,16,19,0.95)', cursor: 'pointer' }}
          title="Click to dismiss"
          onClick={onDismissError}
        >
          ⛔ {error}
        </div>
      )}
      <span
        className="status-badge"
        style={mode === 'real'
          ? { color: '#ff1744', borderColor: '#ff1744', background: 'rgba(255,23,68,0.12)' }
          : { color: 'var(--accent-olive)', borderColor: 'var(--accent-olive)' }}
        title={mode === 'real' ? 'Copies execute with real SOL from the linked Photon wallet' : 'Copies are simulated — no SOL moves'}
      >
        {mode === 'real' ? '⚠ REAL MONEY' : 'PAPER'}
      </span>
      <button className="btn-terminal-outline" onClick={onSettings}>
        COPY SETTINGS
      </button>
      <button
        className="btn-terminal"
        onClick={onToggle}
        style={{
          background: enabled ? '#d32f2f' : 'var(--accent-olive)',
          borderColor: enabled ? '#d32f2f' : 'var(--accent-olive)',
          color: '#ffffff',
          fontWeight: 700,
        }}
      >
        {enabled ? '⏹ STOP COPY ENGINE' : '▶ START COPY ENGINE'}
      </button>
    </div>
  );
}
