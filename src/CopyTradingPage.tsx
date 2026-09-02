import React, { useState, useEffect, useRef } from 'react';
import { CopyFeedEvent, CopyPosition, CopyStatusResponse, CopyTradeRecord, CopyTraderConfig, TrackedWalletPublic } from './types';
import { stripEmoji } from './App';
import { apiFetch } from './apiClient';
import { useBuyAlert } from './useBuyAlert';
import { ResizablePanel, useColumnSplit } from './components/ResizablePanel';
import { InfoTip } from './components/InfoTip';

const LOG_WIPE_INTERVAL_MS = 5_000;

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
      <span className="status-badge" title="Paper fill — simulated at the leader's observed price, never sent to the chain"> SIMULATED
      </span>
    );
  }
  // BOTH states used to read "ON-CHAIN", and the unverified tooltip actually
  // said "Submitted and confirmed on-chain". That text was rendered for buys
  // that had never been confirmed at all — the operator was told a trade was on
  // chain while it was not, which is the single line that broke their trust in
  // this bot.
  //
  // Nothing unproven can reach this badge any more: a real position is only
  // opened from a transaction that demonstrably landed. What remains is a
  // genuine distinction worth showing — whether the COST BASIS was read from
  // the transaction, or the quantity came from the wallet with the cost taken
  // from the order size — and the two now say different words.
  return (
    <a
      href={`https://solscan.io/tx/${txid}`}
      target="_blank"
      rel="noopener noreferrer"
      className="status-badge"
      style={{ color: fillVerified ? 'var(--ok)' : 'var(--warn)', borderColor: fillVerified ? 'var(--ok)' : 'var(--warn)', textDecoration: 'none' }}
      title={fillVerified
        ? 'Landed on-chain — quantity AND cost read back from the transaction itself. Click for Solscan.'
        : 'Landed on-chain — the quantity is the wallet\'s real balance, but the transaction could not be parsed, so the cost basis is the size that was ordered rather than the amount actually taken. P&L on this leg is approximate. Click for Solscan.'}
    >
      {fillVerified ? 'ON-CHAIN ✓' : 'COST EST. ~'}
    </a>
  );
}

export function CopyTradingPage({ apiBase }: { apiBase: string }) {
  // Same split, same storage key as the sniper page — one drag position for
  // how this app is divided, not one per page.
  const columnSplit = useColumnSplit();
  const [status, setStatus] = useState<CopyStatusResponse | null>(null);
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

  // Add-wallet form
  const [addrInput, setAddrInput] = useState<string>('');
  const [nickInput, setNickInput] = useState<string>('');
  const [addError, setAddError] = useState<string>('');

  // Settings modal
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [configForm, setConfigForm] = useState<Partial<CopyTraderConfig>>({});
  const [settingsError, setSettingsError] = useState<string>('');
  const showSettingsRef = useRef(false);
  useEffect(() => { showSettingsRef.current = showSettings; }, [showSettings]);

  const feedEndRef = useRef<HTMLDivElement>(null);

  // ── Buy-alert sound ──────────────────────────────────────────────────────
  // A loud blast whenever a leader BUY is copied. The WebAudio plumbing lives
  // in useBuyAlert (shared with the sniper page); this page only decides WHEN:
  // feed ids we have not seen, skipping the first status frame so restoring
  // history does not blast on load. The shipped clip is already bass-boosted,
  // so no extra low-shelf here.
  const { playBuyAlert, testBuyAlert } = useBuyAlert({ bassDb: 0 });
  const seenBuyAlertIds = useRef<Set<string>>(new Set());

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
      pollTimer = setInterval(fetchStatus, 250);
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
  }, [status?.feed?.length, logClearedAt]);

  // Blast the buy-alert on every NEW copied buy. Seed the seen-set from the
  // first frame so restoring existing feed history on load stays silent.
  useEffect(() => {
    const feedNow = status?.feed;
    if (!feedNow) return;
    const first = seenBuyAlertIds.current.size === 0;
    for (const ev of feedNow) {
      if (seenBuyAlertIds.current.has(ev.id)) continue;
      seenBuyAlertIds.current.add(ev.id);
      if (!first && ev.action === 'copied' && ev.side === 'buy') playBuyAlert();
    }
  }, [status?.feed]);

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

  const dismissPosition = async (positionId: string, symbol: string) => {
    if (!window.confirm(`Remove $${symbol} from open copy positions? (Use this if you already liquidated it on Photon or Dex)`)) return;
    await post('/api/copy/positions/close', { positionId });
  };

  const clearHistory = async () => {
    if (!window.confirm('Clear the copy feed and receipts? Open positions are kept.')) return;
    await post('/api/copy/clear-history');
  };

  // From the v1.1.0 lineage: reconcile open positions against the real on-chain
  // balances, so a bag sold manually on Photon/Dex stops showing as open.
  const [syncing, setSyncing] = useState<boolean>(false);
  const syncBalances = async () => {
    setSyncing(true);
    const r = await post('/api/copy/sync-balances');
    setSyncing(false);
    if (r?.success) {
      window.alert(`Checked ${r.checked} position(s): ${r.closed} closed as already exited, ${r.corrected} quantity-corrected.`);
    }
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
  const visibleFeed = feed.filter(ev => ev.timestamp >= logClearedAt);
  const secondsToWipe = Math.max(0, Math.ceil((logClearedAt + LOG_WIPE_INTERVAL_MS - wipeTick) / 1000));
  const stats = status?.stats;
  const engineWallet = status?.wallet;
  const sellsLabel = status?.config?.copySells ? (status.config.sellMode === 'full' ? 'FULL' : 'MIRROR') : 'OFF';
  const autoClearMin = status?.config?.feedAutoClearMinutes ?? 0;

  // configForm holds only the fields the operator has EDITED this session, so
  // reading it directly makes an untouched field read `undefined` — the select
  // would fall back for display while every `=== 'split'` branch stayed false.
  // Resolve edit -> live config -> default once, and use these everywhere.
  const sizeMode = configForm.buySizeMode ?? status?.config?.buySizeMode ?? 'split';
  const slotCount = configForm.maxOpenPositions ?? status?.config?.maxOpenPositions ?? 5;

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
        <div className="stat-card" style={{ border: enabled ? '1px solid var(--ok-bg)' : undefined }}>
          <div className="stat-label"> Copy Engine
            <span style={{ float: 'right', fontSize: '11px', color: streamLive ? 'var(--ok)' : 'var(--warn)' }}>
              {streamLive ? '● LIVE' : '○ POLLING'}
            </span>
          </div>
          <div className="stat-value-mono" style={{ color: enabled ? 'var(--ok)' : undefined }}>
            {enabled ? 'ACTIVE' : 'STOPPED'}
          </div>
          <div
            style={{ fontSize: '11px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}
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
          <div style={{ fontSize: '11px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {stats ? `${stats.signalsSeen} SIGNALS SEEN` : 'ENABLED / TOTAL'}
          </div>
        </div>

        {/* Hero anchor — realized copy P&L */}
        <div className="stat-card hero-anchor">
          <div className="stat-label" style={{ color: 'var(--ink-primary)', fontWeight: 700 }}> Copy P&amp;L Realized
          </div>
          <div className={`hero-fraunces-number ${(stats?.realizedPnlUsd ?? 0) >= 0 ? 'delta-positive' : 'delta-negative'}`}>
            {(stats?.realizedPnlUsd ?? 0) >= 0 ? '+' : ''}${(stats?.realizedPnlUsd ?? 0).toFixed(2)}
          </div>
          <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--ink-secondary)', marginTop: '2px' }}>
            {(stats?.unrealizedPnlUsd ?? 0) >= 0 ? '+' : ''}${(stats?.unrealizedPnlUsd ?? 0).toFixed(2)} UNREALIZED
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Copies Executed</div>
          <div className="stat-value-mono">
            {(stats?.copiedBuys ?? 0)}B / {(stats?.copiedSells ?? 0)}S
          </div>
          <div style={{ fontSize: '11px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {stats ? `${stats.skippedSignals} SKIPPED · WIN ${stats.winRatePct}%` : '—'}
          </div>
        </div>

        <div className="stat-card" style={{ border: engineWallet?.linked ? '1px solid var(--ok-bg)' : undefined }}>
          <div className="stat-label">Photon Wallet</div>
          <div className="stat-value-mono" style={{ color: engineWallet?.linked ? 'var(--ok)' : undefined }}>
            {engineWallet?.linked ? `${engineWallet.solBalance} SOL` : 'NOT LINKED'}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {engineWallet?.linked
              ? `${engineWallet.shortAddress} · $${engineWallet.usdBalance} · SOL $${status?.solPriceUsd ?? '—'}`
              : 'PAPER COPIES ONLY — LINK IN SNIPER SETTINGS'}
          </div>
        </div>
      </section>

      {/* Main split view */}
      <div
        className="main-viewport-grid"
        style={{ gridTemplateColumns: `${columnSplit.leftPct}% var(--sp-3) 1fr` }}
      >
        {/* Left: wallets, positions, receipts */}
        <div className="viewport-column">
          <ResizablePanel id="copy-wallets" resize="both" minHeight={140}>
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
            <div style={{ fontSize: '11px', color: 'var(--bad)', fontFamily: 'var(--font-mono)', marginBottom: '6px', flexShrink: 0 }}>
              {addError}
            </div>
          )}

          <div className="matrix-container" style={{ maxHeight: '32%', overflowY: 'auto' }}>
            {wallets.length === 0 ? (
              <div className="empty-state"> No leader wallets yet. Paste any wallet address above — every buy and sell it makes,
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
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--ink-secondary)' }}>
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
                            style={{ padding: '2px 6px', fontSize: '11px', textDecoration: 'none' }}
                          > SOLSCAN
                          </a>
                          <button
                            className="btn-terminal-outline"
                            style={{ padding: '2px 6px', fontSize: '11px' }}
                            onClick={() => toggleWallet(w)}
                          >
                            {w.enabled ? 'PAUSE' : 'RESUME'}
                          </button>
                          <button className="btn-cell-action" onClick={() => removeWallet(w.address)}> UNTRACK
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          </ResizablePanel>

          <ResizablePanel id="copy-positions" resize="both" minHeight={160}>
          <div className="section-header" style={{ marginTop: '8px' }}>
            <div className="section-title">Open Copy Positions</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {positions.length > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <button
                    className="btn-terminal-outline"
                    onClick={syncBalances}
                    disabled={syncing}
                    title="Re-read on-chain balances"
                    style={{ fontSize: '11px', padding: '2px 8px' }}
                  >
                    {syncing ? 'SYNCING…' : '⟳ SYNC BALANCES'}
                  </button>
                  <InfoTip>Re-reads the wallet's real on-chain balances: closes bags already sold elsewhere and corrects drifted quantities.</InfoTip>
                </span>
              )}
              <div className="section-count">{positions.length} OPEN</div>
            </div>
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
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }} title={pos.leaderWallet}>
                        {pos.leaderNickname}
                      </td>
                      <td className="num-col">{pos.investedSol} SOL (${pos.investedUsd})</td>
                      <td className="num-col">{qty(pos.tokensHeld)}</td>
                      <td className={`num-col ${pos.pnlUsd >= 0 ? 'delta-positive' : 'delta-negative'}`}>
                        <div>{pos.pnlUsd >= 0 ? '+' : ''}${pos.pnlUsd.toFixed(2)} ({pos.pnlPct >= 0 ? '+' : ''}{pos.pnlPct}%)</div>
                        <div style={{ fontSize: '11px', opacity: 0.8, fontFamily: 'var(--font-mono)' }}>
                          {pos.pnlSol >= 0 ? '+' : ''}{pos.pnlSol.toFixed(4)} SOL
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'inline-flex', flexDirection: 'column', gap: '3px' }}>
                          {pos.status === 'PARTIAL' && <span className="status-badge" style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}>PARTIAL</span>}
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
                            style={{ padding: '2px 6px', fontSize: '11px', textDecoration: 'none' }}
                          > PHOTON
                          </a>
                          <button className="btn-cell-action" onClick={() => forceSell(pos.id)}> LIQUIDATE
                          </button>
                          <button
                            className="btn-terminal-outline"
                            style={{ padding: '2px 6px', fontSize: '11px', color: 'var(--ink-muted)' }}
                            title="Remove/dismiss from open positions if already liquidated on Photon"
                            onClick={() => dismissPosition(pos.id, pos.tokenSymbol)}
                          >
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          </ResizablePanel>

          <ResizablePanel id="copy-receipts" resize="both" minHeight={140}>
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
                style={{ fontSize: '11px', padding: '2px 8px', color: 'var(--bad)', borderColor: 'var(--bad)' }}
              > CLEAR
              </button>
            )}
          </div>
          <div className="matrix-container flex-matrix">
            {history.length === 0 ? (
              <div className="empty-state"> No copy trades recorded yet. Every mirrored buy and sell lands here with its execution proof.
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
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
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
                      <td style={{ fontSize: '11px', color: 'var(--ink-muted)', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.exitReason}>
                        {h.side === 'buy' ? `from ${h.leaderNickname}` : h.exitReason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          </ResizablePanel>
        </div>

        {/* Drag to resize the left/right split. */}
        <div
          className="column-split-handle"
          onPointerDown={columnSplit.onHandlePointerDown}
          onDoubleClick={columnSplit.reset}
          title="Drag to resize — double-click to reset"
        />

        {/* Right: live signal feed */}
        <div className="viewport-column">
          <ResizablePanel id="copy-feed" resize="both" minHeight={200} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="section-header">
            <div className="section-title">Leader Signal Feed — Live Copy Decisions</div>
            <div className="section-count">
              {visibleFeed.length} EVENTS · AUTO-CLEAR {secondsToWipe}S
            </div>
          </div>

          <div className="console-container">
            {visibleFeed.length === 0 ? (
              <div style={{ color: 'var(--ink-muted)' }}> Every leader buy/sell appears here with the copy verdict: COPIED, SKIPPED (with the reason), or FAILED.
              </div>
            ) : (
              [...visibleFeed].reverse().map(ev => (
                <div key={ev.id} className="log-line">
                  <span className="log-time">[{new Date(ev.timestamp).toLocaleTimeString()}]</span>
                  <span className={feedColor(ev)}>
                    {ev.action === 'copied' ? '' : ev.action === 'failed' ? '' : ev.action === 'pending' ? '' : '»'}
                    {ev.via ? ` [${ev.via === 'helius' ? 'CHAIN' : ev.via === 'manual' ? 'MANUAL' : 'PUMP'}]` : ''}{' '}
                    {ev.leaderNickname} {ev.side.toUpperCase()} ${ev.tokenSymbol}
                    {ev.leaderSolAmount > 0 ? ` (${ev.leaderSolAmount} SOL)` : ''} — {stripEmoji(ev.detail)}
                  </span>
                  {/* The leader's own transaction — the evidence for the line.
                      A fast-lane line is a claim until the chain settles it, so
                      it says so rather than reading as fact. */}
                  {ev.leaderSignature && (
                    <span style={{ marginLeft: 6 }}>
                      <a
                        href={`https://solscan.io/tx/${ev.leaderSignature}`}
                        target="_blank"
                        rel="noreferrer"
                        title="the leader's transaction on Solscan"
                        style={{ color: 'var(--ink-muted)' }}
                      >tx</a>
                      {ev.leaderStatus === 'pending' && (
                        <span style={{ color: 'var(--warn)' }} title="seen at processed commitment; not yet confirmed on chain"> unconfirmed</span>
                      )}
                      {ev.leaderStatus === 'dropped' && (
                        <span style={{ color: 'var(--bad)' }} title="never reached a confirmed status — this trade did not happen"> DROPPED</span>
                      )}
                      {ev.leaderStatus === 'failed' && (
                        <span style={{ color: 'var(--bad)' }} title="the leader's transaction failed on chain"> LEADER TX FAILED</span>
                      )}
                    </span>
                  )}
                </div>
              ))
            )}
            <div ref={feedEndRef} />
          </div>
          </ResizablePanel>
        </div>
      </div>

      {/* Copy Settings Modal */}
      {showSettings && (
        <div className="modal-overlay">
          <div className="modal-card" style={{ maxWidth: '560px', width: '92%' }}>
            <div className="modal-title">Copy Trading Parameters</div>

            <form onSubmit={saveSettings}>
              {/* ─── The 4 things that matter ─────────────────────────── */}
              <div className="form-group">
                <label className="form-label">Trading mode</label>
                <select
                  className="form-select"
                  value={configForm.tradingMode || 'paper'}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setConfigForm({ ...configForm, tradingMode: e.target.value as 'paper' | 'real' })}
                >
                  <option value="paper">Paper — practice, no real money</option>
                  <option value="real">Real — spends SOL from your linked wallet</option>
                </select>
              </div>

              {/* SIZING — the panel now states which mode is ACTUALLY active.
                  Before this, the "SOL per copy trade" box showed fixedBuySol
                  and only switched the mode to 'fixed' when the input was
                  EDITED. On the shipped default (buySizeMode 'split') the
                  number displayed here was inert: the operator read "0.05 SOL
                  per trade ... about 20 buys worth", concluded their downside
                  per trade was 0.05, and the engine sized every buy from a
                  completely different rule. Telling someone their risk is a
                  number the engine ignores is how a UI loses trust. */}
              <div className="form-group">
                <label className="form-label">How each copy is sized</label>
                <select
                  className="form-select"
                  value={configForm.buySizeMode || 'split'}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setConfigForm({ ...configForm, buySizeMode: e.target.value as 'split' | 'fixed' | 'proportional' })}
                >
                  <option value="split">Split my wallet — each copy gets one slice</option>
                  <option value="fixed">Fixed amount — the same SOL every time</option>
                  <option value="proportional">Match the leader — a percentage of what they spent</option>
                </select>
              </div>

              {(configForm.buySizeMode || 'split') === 'fixed' && (
                <div className="form-group">
                  <label className="form-label">SOL per copy trade</label>
                  <input
                    type="number" step="0.005" min="0" className="form-input"
                    value={configForm.fixedBuySol ?? 0.02}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, fixedBuySol: Number(e.target.value) })}
                  />
                  <div className="form-help"> How much SOL to spend each time you copy one of the leader's buys.
                    {engineWallet?.deployableSol ? (
                      <> Your wallet holds {engineWallet.deployableSol.toFixed(3)} SOL — about{' '}
                        <strong>{Math.max(0, Math.floor(engineWallet.deployableSol / Math.max(0.001, configForm.fixedBuySol ?? 0.02)))} buys</strong> worth.</>
                    ) : null}
                  </div>
                </div>
              )}

              {(configForm.buySizeMode || 'split') === 'proportional' && (
                <div className="form-group">
                  <label className="form-label">Percentage of the leader's buy</label>
                  <input
                    type="number" step="1" min="1" max="100" className="form-input"
                    value={configForm.proportionalPct ?? 10}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, proportionalPct: Number(e.target.value) })}
                  />
                  <div className="form-help"> They buy 1 SOL, you buy {((configForm.proportionalPct ?? 10) / 100).toFixed(2)} SOL — capped by the maximum below.
                  </div>
                </div>
              )}

              <div className="form-group">
                <label className="form-label"> Max positions at once
                  {(configForm.buySizeMode || 'split') === 'split' ? ' — also the wallet divisor' : ''}
                </label>
                <input
                  type="number" min="1" className="form-input"
                  value={configForm.maxOpenPositions ?? 5}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, maxOpenPositions: Number(e.target.value) })}
                />
                <div className="form-help"> Once this many copies are open, new leader buys wait until one closes.
                  {(configForm.buySizeMode || 'split') === 'split' && (
                    <>
                      {' '}<strong>This number also decides the size of every buy:</strong> the wallet is cut this
                      many ways. Lowering it does NOT trade less — it makes each trade BIGGER. Setting it to 1
                      stakes the whole wallet on a single copy.
                      {engineWallet?.deployableSol ? (
                        <> At {engineWallet.deployableSol.toFixed(3)} SOL deployable that is roughly{' '}
                          <strong>
                            {(engineWallet.deployableSol / Math.max(1, configForm.maxOpenPositions ?? 5)).toFixed(4)} SOL
                          </strong>{' '}per copy.</>
                      ) : null}
                    </>
                  )}
                </div>
              </div>

              {/* Sells */}
              <div className="form-group" style={{ border: '1px solid var(--line)', padding: '8px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: 'var(--fg)' }}>
                  <input
                    type="checkbox"
                    checked={configForm.copySells === true}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, copySells: e.target.checked })}
                  /> Sell when the leader sells
                </label>
                {configForm.copySells === true && (
                  <div className="form-group" style={{ marginTop: 6, marginBottom: 0 }}>
                    <select
                      className="form-select"
                      value={configForm.sellMode || 'mirror'}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setConfigForm({ ...configForm, sellMode: e.target.value as 'mirror' | 'full' })}
                    >
                      <option value="mirror">Match their sell — they sell 50%, you sell 50%</option>
                      <option value="full">Sell everything — any leader sell closes your whole position</option>
                    </select>
                  </div>
                )}
                <div className="form-help">
                  {configForm.copySells === true
                    ? 'Fires only when the leader exits, never on price. No take-profit or stop-loss. The SELL button on each position always works.'
                    : 'Off — the leader\'s sells are shown but your position is held. You exit with the SELL button.'}
                </div>
              </div>

              {/* ─── Advanced (hidden by default) ─────────────────────── */}
              <button
                type="button"
                onClick={() => setShowAdvanced(a => !a)}
                style={{ all: 'unset', cursor: 'pointer', display: 'block', margin: '12px 0 6px', fontSize: '0.75rem', color: 'var(--fg-dim)', fontWeight: 700 }}
              >
                {showAdvanced ? '▾' : '▸'} Advanced settings
              </button>

              {showAdvanced && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', borderTop: '1px solid var(--line)', paddingTop: '10px' }}>
                  <div className="form-group">
                    <label className="form-label">Sizing method</label>
                    <select
                      className="form-select"
                      value={sizeMode}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setConfigForm({ ...configForm, buySizeMode: e.target.value as 'fixed' | 'proportional' | 'split' })}
                    >
                      <option value="fixed">Fixed SOL per copy (simple)</option>
                      <option value="split">Split wallet across slots</option>
                      <option value="proportional">% of the leader's buy</option>
                    </select>
                    <div className="form-help">Fixed is recommended for a small wallet — split can size trades down to dust.</div>
                  </div>

                  {sizeMode === 'proportional' && (
                    <div className="form-group">
                      <label className="form-label">Copy % of leader size</label>
                      <input type="number" step="1" className="form-input"
                        value={configForm.proportionalPct ?? 10}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, proportionalPct: Number(e.target.value) })} />
                    </div>
                  )}

                  <div className="form-group">
                    <label className="form-label">Never spend more than (SOL)</label>
                    <input type="number" step="0.01" className="form-input"
                      value={configForm.maxBuySol ?? 0.5}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, maxBuySol: Number(e.target.value) })} />
                    <div className="form-help">Hard ceiling on any single copy buy.</div>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Ignore leader buys under (SOL)</label>
                    <input type="number" step="0.01" className="form-input"
                      value={configForm.minLeaderBuySol ?? 0}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, minLeaderBuySol: Number(e.target.value) })} />
                    <div className="form-help">0 = copy every buy. Raise to skip the leader's tiny buys.</div>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Skip our buys under (SOL)</label>
                    <input type="number" step="0.005" className="form-input"
                      value={configForm.minCopyBuySol ?? 0.01}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, minCopyBuySol: Number(e.target.value) })} />
                    <div className="form-help">No dust: skip if our size would be smaller than this (loses the fee).</div>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Max slippage (%)</label>
                    <input type="number" className="form-input"
                      value={configForm.maxSlippagePct ?? 25}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, maxSlippagePct: Number(e.target.value) })} />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Wait between copies (sec)</label>
                    <input type="number" className="form-input"
                      value={configForm.perWalletCooldownSec ?? 0}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, perWalletCooldownSec: Number(e.target.value) })} />
                    <div className="form-help">0 = no wait. Throttles a fast-flipping leader.</div>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Clear feed after (min)</label>
                    <input type="number" className="form-input"
                      value={configForm.feedAutoClearMinutes ?? 5}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, feedAutoClearMinutes: Number(e.target.value) })} />
                    <div className="form-help">0 = keep. Receipts are never auto-cleared.</div>
                  </div>

                  <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: 'var(--fg)' }}>
                      <input type="checkbox"
                        checked={configForm.blockRepeatBuys !== true}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, blockRepeatBuys: !e.target.checked })} /> Add to a position when the leader buys the same coin again
                    </label>
                    <div className="form-help">On = follow the leader's adds (DCA). Off = one buy per coin, ignore their re-buys.</div>
                  </div>

                  {configForm.copySells === true && (
                    <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: 'var(--fg)' }}>
                        <input type="checkbox"
                          checked={configForm.mirrorLeaderTokenMoves !== false}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, mirrorLeaderTokenMoves: e.target.checked })} /> Count the leader moving a coin out as a sell
                      </label>
                    </div>
                  )}
                </div>
              )}

              {settingsError && (
                <div style={{ fontSize: '11px', marginTop: '8px', padding: '4px 6px', fontFamily: 'var(--font-mono)', color: 'var(--bad)', border: '1px solid var(--bad)', background: 'var(--bad-bg)' }}>
                  {settingsError}
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
                <button type="button" className="btn-terminal-outline" style={{ flex: 1 }} onClick={() => { setShowSettings(false); setSettingsError(''); }}> DISCARD
                </button>
                <button type="submit" className="btn-terminal" style={{ flex: 1 }}> APPLY PARAMETERS
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
        onTestAlert={testBuyAlert}
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
function CopyHeaderControls({ enabled, mode, onToggle, onSettings, onTestAlert, error, onDismissError }: {
  enabled: boolean;
  mode: 'paper' | 'real';
  onToggle: () => void;
  onSettings: () => void;
  onTestAlert: () => void;
  error: string;
  onDismissError: () => void;
}) {
  return (
    <div style={{ position: 'fixed', top: '8px', right: '18px', display: 'flex', gap: '8px', alignItems: 'center', zIndex: 500 }}>
      {error && (
        <div
          style={{ fontSize: '11px', padding: '4px 6px', fontFamily: 'var(--font-mono)', color: 'var(--bad)', border: '1px solid var(--bad)', background: 'rgba(4, 6, 10, 0.92)', cursor: 'pointer' }}
          title="Click to dismiss"
          onClick={onDismissError}
        >
          {error}
        </div>
      )}
      <span
        className="status-badge"
        style={mode === 'real'
          ? { color: 'var(--bad)', borderColor: 'var(--bad)', background: 'var(--bad-bg)' }
          : { color: 'var(--accent-olive)', borderColor: 'var(--accent-olive)' }}
        title={mode === 'real' ? 'Copies execute with real SOL from the linked Photon wallet' : 'Copies are simulated — no SOL moves'}
      >
        {mode === 'real' ? 'REAL MONEY' : 'PAPER'}
      </span>
      <button className="btn-terminal-outline" onClick={onTestAlert} title="Play the buy-alert sound to test it"> TEST SOUND
      </button>
      <button className="btn-terminal-outline" onClick={onSettings}> COPY SETTINGS
      </button>
      <button
        className="btn-terminal"
        onClick={onToggle}
        style={{
          background: enabled ? 'var(--bad)' : 'var(--accent-olive)',
          borderColor: enabled ? 'var(--bad)' : 'var(--accent-olive)',
          color: 'var(--fg)',
          fontWeight: 700,
        }}
      >
        {enabled ? '■ STOP COPY ENGINE' : '▶ START COPY ENGINE'}
      </button>
    </div>
  );
}
