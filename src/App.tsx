import React, { useState, useEffect, useRef } from 'react';
import { BotConfig, BotInstanceInfo, BotStatusResponse, FilterResult, LeniencyMode, Position, TradeHistoryRecord } from './types';

/**
 * Strip pictographic emoji from text the SERVER produced.
 *
 * The engine's log lines are peppered with them, and an emoji is the one thing
 * on screen that renders in full colour whatever the scheme says — which makes
 * it the loudest element in a monochrome console and defeats the point of
 * having a scheme at all.
 *
 * Done at render, deliberately, rather than by editing the log strings: those
 * strings are asserted on by the test suite and read by anyone tailing
 * bot.log, where the glyphs are a harmless scanning aid. This changes what the
 * TERMINAL shows, which is the only place the look matters.
 *
 * The ranges are pictographs and dingbats only. Box-drawing, arrows and the
 * mathematical marks a console legitimately prints are untouched.
 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;
export function stripEmoji(text: string): string {
  return text.replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();
}

import { previewWalletAddress } from './services/clientWallet';
import { apiFetch } from './apiClient';
import { CopyTradingPage } from './CopyTradingPage';
import { useBuyAlert } from './useBuyAlert';
import { ResizablePanel, useColumnSplit } from './components/ResizablePanel';
import { InfoTip } from './components/InfoTip';

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
    return <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>{qty(trade.tokensSold)}</span>;
  }
  const pct = fraction * 100;
  const partial = fraction < FULL_EXIT_THRESHOLD;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
        {qty(trade.tokensSold)} ({pct < 10 ? pct.toFixed(1) : Math.round(pct)}%)
      </span>
      {partial && (
        <span
          className="status-badge"
          style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}
          title={`Only ${pct.toFixed(1)}% of the position was sold. The rest was still held after this order.`}
        > PARTIAL FILL
        </span>
      )}
    </div>
  );
}

function TxProofBadge({ txid, verified }: { txid?: string; verified?: boolean }) {
  if (!isOnChainTxid(txid)) {
    return (
      <span className="status-badge" title="Paper fill — this trade was simulated and never sent to the chain"> SIMULATED
      </span>
    );
  }
  return (
    <a
      href={`https://solscan.io/tx/${txid}`}
      target="_blank"
      rel="noopener noreferrer"
      className="status-badge"
      style={{ color: verified ? 'var(--ok)' : 'var(--warn)', borderColor: verified ? 'var(--ok)' : 'var(--warn)', textDecoration: 'none' }}
      title={verified
        ? 'Landed on-chain — quantity AND cost read back from the transaction itself. Click to view on Solscan.'
        : 'Landed on-chain — the quantity is the wallet\'s real balance, but the transaction could not be parsed, so the cost basis is the size that was ordered rather than the amount actually taken. P&L on this leg is approximate. Click to view on Solscan.'}
    >
      {/* See CopyTradingPage.ExecBadge: both states used to read "ON-CHAIN",
          and the unverified one was rendered for buys that had never been
          confirmed. Unproven trades no longer open positions at all, so this
          badge now distinguishes only how the COST BASIS was established. */}
      {verified ? 'ON-CHAIN ✓' : 'COST EST. ~'}
    </a>
  );
}

/**
 * "Why is it not trading?" — the backend's own diagnosis, on screen.
 *
 * Every silent failure in this bot's history (a rejected Helius key answering
 * 401 forever, the pre-sign guard refusing every real buy, split sizing
 * staking 0 SOL so every leader signal was skipped, copy trading simply
 * switched off) was visible in a log and invisible in the UI. The operator saw
 * a healthy-looking screen and a bot that did nothing. This polls
 * /api/diagnostics and puts the reason where they are already looking.
 */
/**
 * THE ROSTER THE BOT CHOSE FOR ITSELF.
 *
 * Every other setting in this app is something the operator typed. This one is
 * not: the smart-money lane earns its wallet list from chain evidence, which
 * makes it the only part of the bot whose behaviour cannot be understood by
 * reading your own configuration. So it gets a panel — who is promoted, on what
 * record, and what the research is doing — and a way to overrule it.
 *
 * Hidden entirely when the lane is off, rather than showing an empty table that
 * reads like a broken feature.
 */
interface SmartMoneyWallet {
  address: string;
  winRate: number | null;
  realizedPnlSol: number;
  closedTrades: number;
  earlyHitRate: number | null;
  earlyOnWinners: number;
  conviction: number | null;
  state: string;
  stateReason: string;
  pinned: 'always' | 'never' | null;
}
interface SmartMoneyStatus {
  enabled: boolean;
  roster: SmartMoneyWallet[];
  walletsSeen: number;
  confluence: { minWallets: number; windowMs: number; minBuySol: number };
  pendingSignals: Array<{ mint: string; wallets: number; needed: number }>;
  research: { queued: number; dudCandidates: number; readBudgetRemaining: number };
}

function SmartMoneyPanel() {
  const [sm, setSm] = useState<SmartMoneyStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const r = await apiFetch('/api/smart-money');
        if (r.ok && alive) setSm(await r.json());
      } catch { /* backend unreachable — the RPC pill already says so */ }
    };
    pull();
    const iv = setInterval(pull, 15_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const pin = async (address: string, mode: 'always' | 'never' | null) => {
    try {
      const r = await apiFetch('/api/smart-money/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, mode }),
      });
      if (r.ok) setSm((await r.json()).smartMoney);
    } catch { /* the next poll will show whether it took */ }
  };

  if (!sm || !sm.enabled) return null;

  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

  return (
    <div style={{ marginTop: '12px', padding: '10px', background: 'transparent', border: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--learn)' }}> Smart Money — wallets the bot proved, not a pasted list
        </div>
        <div style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>
          {sm.roster.length} promoted / {sm.walletsSeen} seen · research queue {sm.research.queued} · reads left {sm.research.readBudgetRemaining}
        </div>
      </div>

      {sm.roster.length === 0 ? (
        <div style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>
          No wallet promoted yet{sm.research.dudCandidates > 0 ? ` — ${sm.research.dudCandidates} being tracked` : ''}.
          <InfoTip>This is expected on a new install and is not a fault: the roster is built from chain
            history the bot gathers itself, so it needs days of graduations and duds before anyone clears
            the bar. Until then this lane produces nothing.</InfoTip>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--fg-dim)', textAlign: 'left' }}>
                <th style={{ padding: '3px 6px' }}>Wallet</th>
                <th style={{ padding: '3px 6px' }}>Conviction</th>
                <th style={{ padding: '3px 6px' }}>Win rate</th>
                <th style={{ padding: '3px 6px' }}>Trades</th>
                <th style={{ padding: '3px 6px' }}>Realized SOL</th>
                <th style={{ padding: '3px 6px' }}>Early hits</th>
                <th style={{ padding: '3px 6px' }}>Why</th>
                <th style={{ padding: '3px 6px' }}></th>
              </tr>
            </thead>
            <tbody>
              {sm.roster.map(w => (
                <tr key={w.address} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '3px 6px', fontFamily: 'monospace' }}>
                    <a href={`https://solscan.io/account/${w.address}`} target="_blank" rel="noreferrer" style={{ color: 'var(--learn)' }}>
                      {w.address.slice(0, 4)}…{w.address.slice(-4)}
                    </a>
                    {w.pinned === 'always' && <span title="pinned on by you" style={{ marginLeft: 4 }}>*</span>}
                  </td>
                  <td style={{ padding: '3px 6px' }}>{pct(w.conviction)}</td>
                  <td style={{ padding: '3px 6px' }}>{pct(w.winRate)}</td>
                  <td style={{ padding: '3px 6px' }}>{w.closedTrades}</td>
                  <td style={{ padding: '3px 6px', color: w.realizedPnlSol >= 0 ? 'var(--ok)' : 'var(--bad)' }}>
                    {w.realizedPnlSol >= 0 ? '+' : ''}{w.realizedPnlSol.toFixed(3)}
                  </td>
                  <td style={{ padding: '3px 6px' }}>{w.earlyOnWinners} ({pct(w.earlyHitRate)})</td>
                  <td style={{ padding: '3px 6px', color: 'var(--fg-dim)' }}>{w.stateReason}</td>
                  <td style={{ padding: '3px 6px' }}>
                    <button
                      onClick={() => pin(w.address, w.pinned === 'never' ? null : 'never')}
                      title="Stop following this wallet"
                      style={{ fontSize: '11px', padding: '1px 5px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--bad-bg)', color: 'var(--bad)', borderRadius: 3 }}
                    >
                      {w.pinned === 'never' ? 'unblock' : 'drop'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ fontSize: '11px', color: 'var(--fg-dim)', marginTop: '8px' }}>
        Needs <strong>{sm.confluence.minWallets}</strong> wallets buying the same token within <strong>{sm.confluence.windowMs / 1000}s</strong>
        {sm.pendingSignals.length > 0 && ` — watching ${sm.pendingSignals.length} part-way (best ${sm.pendingSignals[0].wallets}/${sm.pendingSignals[0].needed})`}.
        <InfoTip>Each wallet must risk at least {sm.confluence.minBuySol} SOL. Every entry from this lane still
          passes the same rug, honeypot and spend-governor checks as any other.</InfoTip>
      </div>

      <EntryProfileSection />
    </div>
  );
}

/**
 * WHO TO COPY RIGHT NOW.
 *
 * The answer to "find me the most profitable trader trading memecoins at this
 * moment". Three of them, best first, with the evidence — and, just as
 * important, the wallets that were checked and rejected, because "this one
 * looked great and here is why it is uncopyable" is the part that stops an
 * operator pasting a leaderboard address in by hand.
 *
 * Nothing here is automatic. The scout ranks; a person presses Follow. Adding a
 * copy target is the decision that starts spending money on a stranger, and six
 * hours of pump.fun history is not enough evidence to make it unattended.
 */
interface ScoutTrader {
  wallet: string;
  label?: string;
  sources: string[];
  claimedRealizedSol?: number;
  realizedSol: number;
  closedTrades: number;
  winRate: number;
  medianHoldSeconds: number;
  medianBuySol: number;
  topMintProfitShare: number;
  idleHours: number;
  frontOfQueueShare?: number;
  openPositions: number;
  stalePositions: number;
  staleShare: number;
  medianEntryVSol: number;
  expectedFillDragPct?: number;
  realizedExBestSol: number;
  tradesLast2h: number;
  tradesLast6h: number;
  disqualifiers: string[];
  score: number;
}
interface ScoutPayload {
  report: {
    ranAt: number;
    best: ScoutTrader | null;
    top: ScoutTrader[];
    rejected: ScoutTrader[];
    considered: number;
    reads: number;
    notes: string[];
    sourceOutcomes: Array<{ name: string; ok: boolean; detail?: string; seenKeys?: string[] }>;
    /** Set when the run was cut short (trading path busy, read budget spent) — results are partial. */
    stoppedEarly?: string;
  } | null;
  bars: { maxIdleHours: number; maxCopyableBuySol: number; minHoldSeconds: number; minClosedTrades: number; maxFillDragPct: number; staleBagHours: number };
  keysSet: { solanaTracker: boolean; birdeye: boolean };
}

function TraderScoutPanel() {
  const [sc, setSc] = useState<ScoutPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const pull = async () => {
    try {
      const r = await apiFetch('/api/scout');
      if (r.ok) setSc(await r.json());
    } catch { /* the RPC pill already says the backend is unreachable */ }
  };
  useEffect(() => {
    pull();
    const iv = setInterval(pull, 60_000);
    return () => clearInterval(iv);
  }, []);

  const post = async (path: string, body: any, label: string) => {
    setBusy(label); setMsg(null);
    try {
      const r = await apiFetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      setMsg(r.ok ? `${label} done.` : `${label} failed: ${j?.error ?? r.status}`);
      await pull();
    } catch (e: any) {
      setMsg(`${label} failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  const rep = sc?.report ?? null;
  const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
  const hold = (s: number) => (s >= 3600 ? `${Math.round(s / 360) / 10}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`);

  return (
    <div style={{ marginTop: '12px', padding: '10px', background: 'transparent', border: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--info)' }}> Who to copy — found, then checked against the chain
        </div>
        <button
          onClick={() => post('/api/scout/run', {}, 'Scout run')}
          disabled={busy !== null}
          style={{ fontSize: '11px', padding: '2px 8px', cursor: busy ? 'wait' : 'pointer', background: 'transparent', border: '1px solid var(--line-focus)', color: 'var(--info)' }}
        >
          {busy === 'Scout run' ? 'scanning…' : 'scan now'}
        </button>
      </div>

      {!sc?.keysSet.solanaTracker && (
        <div style={{ fontSize: '11px', color: 'var(--fg-dim)', marginBottom: '8px' }}>
          No Solana Tracker key set — using on-chain discovery only.
          <InfoTip>That key is the only free source that ranks Solana wallets by realized profit over a
            plain API call — the boards people usually quote (GMGN, Kolscan) sit behind Cloudflare and
            cannot be read from a server at all. Without it the scout falls back to its own chain
            research: it finds the pump.fun tokens running right now and reads who bought them first.
            That works with no key at all, but it only sees wallets that were early to something live in
            the last few minutes, so it surfaces fewer names. Paste a free key in Settings to widen it.</InfoTip>
        </div>
      )}

      {!rep ? (
        <div style={{ fontSize: '11px', color: 'var(--fg-dim)' }}> No scan yet — the first one runs a few minutes after startup, then hourly.
        </div>
      ) : (
        <>
          {rep.best ? (
            <div style={{ padding: '8px', background: 'var(--ok-bg)', border: '1px solid var(--ok-bg)', borderRadius: 3, marginBottom: '8px' }}>
              <div style={{ fontSize: '11px', color: 'var(--ok)', fontWeight: 700, marginBottom: 4 }}> BEST RIGHT NOW — {rep.best.label ? `${rep.best.label} · ` : ''}
                <a href={`https://solscan.io/account/${rep.best.wallet}`} target="_blank" rel="noreferrer" style={{ color: 'var(--ok)', fontFamily: 'monospace' }}>
                  {short(rep.best.wallet)}
                </a>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--fg-dim)', lineHeight: 1.6 }}>
                +{rep.best.realizedSol} SOL realized over {rep.best.closedTrades} closed trades ·
                {' '}{Math.round(rep.best.winRate * 100)}% win rate ·
                {' '}typical entry {rep.best.medianBuySol} SOL ·
                {' '}typical hold {hold(rep.best.medianHoldSeconds)} ·
                {' '}{rep.best.tradesLast6h} trades in 6h
              </div>
              <div style={{ fontSize: '11px', color: 'var(--fg-dim)', marginTop: 3 }}>
                ~<strong>{rep.best.expectedFillDragPct?.toFixed(1) ?? '?'}%</strong> worse fill copying them · still{' '}
                <strong style={{ color: rep.best.realizedExBestSol > 0 ? 'var(--ok)' : 'var(--bad)' }}>
                  {rep.best.realizedExBestSol > 0 ? '+' : ''}{rep.best.realizedExBestSol} SOL
                </strong> without their best token
                <InfoTip>Their {rep.best.medianBuySol} SOL entries land in a {rep.best.medianEntryVSol} SOL curve, and ours
                  lands after — that's the expected fill drag. The "without their best token" figure removes
                  their single biggest winner to check it isn't one lucky call carrying the whole record.
                  {rep.best.stalePositions > 0 && ` ${rep.best.stalePositions} bag(s) held over ${sc!.bars.staleBagHours}h are unresolved and were not scored either way.`}</InfoTip>
              </div>
              <button
                onClick={() => post('/api/scout/follow', { address: rep.best!.wallet }, 'Follow')}
                disabled={busy !== null}
                style={{ marginTop: 6, fontSize: '11px', padding: '3px 10px', cursor: 'pointer', background: 'var(--ok-bg)', border: '1px solid var(--ok-bg)', color: 'var(--ok)', borderRadius: 3 }}
              >
                {busy === 'Follow' ? 'adding…' : 'copy this wallet'}
              </button>
              <button
                onClick={() => post('/api/scout/backfill', {}, 'Backfill')}
                disabled={busy !== null}
                title="Learn from this wallet's trade history instead of waiting weeks"
                style={{ marginTop: 6, marginLeft: 6, fontSize: '11px', padding: '3px 10px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--line-focus)', color: 'var(--fg-dim)' }}
              >
                {busy === 'Backfill' ? 'learning…' : 'learn their strategy from history'}
              </button>
            </div>
          ) : (
            /* "0 checked, none copyable" is not a normal result — it means no
               source produced a lead and nothing was examined at all. Saying
               the two the same way made a structurally dead feature read as a
               working one having a quiet day. */
            rep.considered === 0 ? (
              <div style={{ fontSize: '11px', color: 'var(--warn)', marginBottom: '8px', border: '1px solid var(--warn)', padding: '6px' }}>
                NO CANDIDATE WALLETS WERE FOUND — nothing was checked.
                <InfoTip>This is not &ldquo;we looked and nobody qualified&rdquo;; no source produced an address to look at.</InfoTip>
                <div style={{ marginTop: 4, color: 'var(--fg-dim)' }}>
                  {rep.sourceOutcomes.filter(o => !o.ok).map(o => (
                    <div key={o.name}>· {o.name}: {o.detail ?? 'failed'}
                      {o.seenKeys?.length ? ` — fields actually returned: ${o.seenKeys.join(', ')}` : ''}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '11px', color: 'var(--fg-dim)', lineHeight: 1.6, marginBottom: '8px' }}>
                {rep.considered} wallet(s) checked, none copyable. That is a normal result, not a
                fault — most profitable-looking wallets fail one of the bars below.
              </div>
            )
          )}

          {/* A run cut short by a busy trading path or a spent read budget used
              to look identical to a complete one. Partial is partial. */}
          {rep.stoppedEarly && (
            <div style={{ fontSize: '11px', color: 'var(--warn)', lineHeight: 1.6, marginBottom: '8px' }}>
              RUN STOPPED EARLY — {rep.stoppedEarly}. These results are partial; the next run may find more.
            </div>
          )}

          {rep.top.length > 1 && (
            <div style={{ overflowX: 'auto', marginBottom: '8px' }}>
              <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--fg-dim)', textAlign: 'left' }}>
                    <th style={{ padding: '3px 6px' }}>#</th>
                    <th style={{ padding: '3px 6px' }}>Wallet</th>
                    <th style={{ padding: '3px 6px' }}>Realized</th>
                    <th style={{ padding: '3px 6px' }}>Win</th>
                    <th style={{ padding: '3px 6px' }}>Entry</th>
                    <th style={{ padding: '3px 6px' }}>Hold</th>
                    <th style={{ padding: '3px 6px' }}>Idle</th>
                    <th style={{ padding: '3px 6px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rep.top.map((t, i) => (
                    <tr key={t.wallet} style={{ borderTop: '1px solid var(--line)' }}>
                      <td style={{ padding: '3px 6px' }}>{i + 1}</td>
                      <td style={{ padding: '3px 6px', fontFamily: 'monospace' }}>
                        <a href={`https://solscan.io/account/${t.wallet}`} target="_blank" rel="noreferrer" style={{ color: 'var(--info)' }}>{short(t.wallet)}</a>
                        {t.label && <span style={{ color: 'var(--fg-dim)' }}> {t.label}</span>}
                      </td>
                      <td style={{ padding: '3px 6px', color: 'var(--ok)' }}>+{t.realizedSol}</td>
                      <td style={{ padding: '3px 6px' }}>{Math.round(t.winRate * 100)}%</td>
                      <td style={{ padding: '3px 6px' }}>{t.medianBuySol}</td>
                      <td style={{ padding: '3px 6px' }}>{hold(t.medianHoldSeconds)}</td>
                      <td style={{ padding: '3px 6px' }}>{Math.round(t.idleHours * 10) / 10}h</td>
                      <td style={{ padding: '3px 6px' }}>
                        <button
                          onClick={() => post('/api/scout/follow', { address: t.wallet }, 'Follow')}
                          disabled={busy !== null}
                          style={{ fontSize: '11px', padding: '1px 5px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--line-focus)', color: 'var(--info)' }}
                        >follow</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {rep.rejected.length > 0 && (
            <details style={{ fontSize: '11px', color: 'var(--fg-dim)', marginBottom: '6px' }}>
              <summary style={{ cursor: 'pointer' }}>
                {rep.rejected.length} checked and rejected — why
              </summary>
              <div style={{ marginTop: 4, lineHeight: 1.6 }}>
                {rep.rejected.slice(0, 10).map(t => (
                  <div key={t.wallet} style={{ marginBottom: 3 }}>
                    <span style={{ fontFamily: 'monospace', color: 'var(--fg-dim)' }}>{short(t.wallet)}</span>
                    {t.claimedRealizedSol !== undefined && (
                      <span style={{ color: 'var(--fg-faint)' }}> (board claimed {Math.round(t.claimedRealizedSol)})</span>
                    )}
                    {' — '}{t.disqualifiers[0]}
                  </div>
                ))}
              </div>
            </details>
          )}

          <div style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>
            {rep.notes.map((n, i) => <div key={i}>· {n}</div>)}
            <div>
              · Bars: trading now, {sc!.bars.minClosedTrades}+ closed trades, under {sc!.bars.maxFillDragPct}% fill drag, others
              <InfoTip>Trading now means not just seen inside {sc!.bars.maxIdleHours}h. Hold time must be over{' '}
                {sc!.bars.minHoldSeconds}s (shorter than we can follow). Must still be profitable with their
                best token removed, and have under half their positions as unresolved bags.</InfoTip>
            </div>
            <div style={{ marginTop: 3 }}> Sources: {rep.sourceOutcomes.map(o => `${o.name} ${o.ok ? '✓' : `✗ (${o.detail ?? 'failed'})`}`).join(' · ')}
            </div>
          </div>
        </>
      )}

      {msg && <div style={{ fontSize: '11px', color: msg.includes('failed') ? 'var(--bad)' : 'var(--ok)', marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

/**
 * WHAT THE BOT LEARNED THEY LOOK FOR.
 *
 * The roster above answers "who". This answers "what for" — and it is the part
 * that lets the sniper find a token BEFORE any of them buys it, instead of
 * following one of them into a candle they already moved.
 *
 * Every number here is derived from tokens the bot watched: the bands are the
 * middle of what the proven wallets took, and `separation` is the share of the
 * launches they PASSED ON that fall outside that band. A rule with low
 * separation describes tokens in general rather than their choices, which is why
 * the derivation throws those away rather than showing them here.
 *
 * The not-ready state is shown in full rather than hidden. For most of the first
 * fortnight that is the true state, and a table of confident-looking rules built
 * on nine samples would be a worse lie than an empty panel.
 */
interface EntryProfileRule {
  feature: string;
  label: string;
  low: number;
  high: number;
  median: number;
  skippedMedian: number;
  separation: number;
  samples: number;
}
interface EntryProfileStatus {
  enabled: boolean;
  usable: boolean;
  notReady: string | null;
  enteredSamples: number;
  skippedSamples: number;
  needEntered: number;
  needSkipped: number;
  minScore: number;
  minRules: number;
  rules: EntryProfileRule[];
}

function EntryProfileSection() {
  const [ep, setEp] = useState<EntryProfileStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const r = await apiFetch('/api/entry-profile');
        if (r.ok && alive) setEp(await r.json());
      } catch { /* backend unreachable — the RPC pill already says so */ }
    };
    pull();
    // Slower than the roster poll: the profile only changes when a token is
    // screened, and re-deriving fourteen percentile bands is not free.
    const iv = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  if (!ep || !ep.enabled) return null;

  const num = (n: number) => {
    if (!Number.isFinite(n)) return '—';
    if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
    if (Math.abs(n) >= 1) return String(Math.round(n * 10) / 10);
    return String(Math.round(n * 1000) / 1000);
  };

  return (
    <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--line)' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--learn)', marginBottom: '6px' }}> What they look for — learned, then applied to every launch
      </div>

      {!ep.usable ? (
        <div style={{ fontSize: '11px', color: 'var(--fg-dim)' }}> Not driving entries yet: {ep.notReady}.
          Evidence so far: <strong>{ep.enteredSamples}</strong>/{ep.needEntered} bought,{' '}
          <strong>{ep.skippedSamples}</strong>/{ep.needSkipped} passed on.
          <InfoTip>Both sides are needed — the tokens they skipped are what make the comparison say anything.</InfoTip>
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--fg-dim)', textAlign: 'left' }}>
                  <th style={{ padding: '3px 6px' }}>They buy when</th>
                  <th style={{ padding: '3px 6px' }}>Their band</th>
                  <th style={{ padding: '3px 6px' }}>Their median</th>
                  <th style={{ padding: '3px 6px' }}>Skipped median</th>
                  <th style={{ padding: '3px 6px' }} title="Share of the launches they passed on that fall outside this band">Separation</th>
                </tr>
              </thead>
              <tbody>
                {ep.rules.map(r => (
                  <tr key={r.feature} style={{ borderTop: '1px solid var(--line)' }}>
                    <td style={{ padding: '3px 6px' }}>{r.label}</td>
                    <td style={{ padding: '3px 6px', fontFamily: 'monospace' }}>{num(r.low)} – {num(r.high)}</td>
                    <td style={{ padding: '3px 6px' }}>{num(r.median)}</td>
                    <td style={{ padding: '3px 6px', color: 'var(--fg-dim)' }}>{num(r.skippedMedian)}</td>
                    <td style={{ padding: '3px 6px', color: r.separation >= 0.6 ? 'var(--ok)' : 'var(--warn)' }}>
                      {Math.round(r.separation * 100)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--fg-dim)', marginTop: '6px' }}>
            Built from {ep.enteredSamples} entries vs {ep.skippedSamples} skips. Buys alone at{' '}
            <strong>{Math.round(ep.minScore * 100)}%</strong> match on <strong>{ep.minRules}</strong>+ rules.
            <InfoTip>No wallet has to buy first — a fresh token is bought on this profile alone once it clears
              that bar. Rules that fail to separate their picks from the rest are dropped rather than shown.</InfoTip>
          </div>
        </>
      )}
    </div>
  );
}

function DiagnosticsPanel() {
  const [diag, setDiag] = useState<{ level: string; findings: Array<{ level: string; title: string; detail: string; fix: string }> } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const r = await apiFetch('/api/diagnostics');
        if (r.ok && alive) setDiag(await r.json());
      } catch { /* backend unreachable — the RPC pill already says so */ }
    };
    pull();
    const iv = setInterval(pull, 10_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  if (!diag || diag.level === 'ok' || !diag.findings.length) return null;
  const color = diag.level === 'critical' ? 'var(--bad)' : diag.level === 'warning' ? 'var(--warn)' : 'var(--info)';
  const icon = diag.level === 'critical' ? '\u26d4' : diag.level === 'warning' ? '\u26a0\ufe0f' : '\u2139\ufe0f';
  const worst = diag.findings.filter((f) => f.level === diag.level);

  return (
    <div style={{ borderBottom: `1px solid ${color}55`, background: `${color}14`, fontSize: '13px' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ all: 'unset', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', boxSizing: 'border-box', padding: '8px 20px', color }}
      >
        <span style={{ fontWeight: 700, minWidth: 0 }}>
          {icon} {worst.length === 1 ? worst[0].title : `${diag.findings.length} issues need attention`}
          {!open && worst.length === 1 && (
            <span style={{ fontWeight: 400, opacity: 0.9 }}> &mdash; {worst[0].detail.slice(0, 110)}</span>
          )}
        </span>
        <span style={{ opacity: 0.8, whiteSpace: 'nowrap' }}>{open ? 'hide' : `details (${diag.findings.length})`}</span>
      </button>
      {open && (
        <div style={{ padding: '0 20px 10px' }}>
          {diag.findings.map((f, i) => (
            <div key={i} style={{ padding: '6px 0', borderTop: i ? '1px solid var(--line)' : 'none' }}>
              <div style={{ color: f.level === 'critical' ? 'var(--bad)' : f.level === 'warning' ? 'var(--warn)' : 'var(--info)', fontWeight: 700 }}>{f.title}</div>
              <div style={{ color: 'var(--fg)' }}>{f.detail}</div>
              {f.fix && <div style={{ color: 'var(--info)' }}>&rarr; {f.fix}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function App() {
  // Page routing: the sniper terminal and the copy trading desk share the
  // backend instance but render as separate full-screen pages.
  const [activePage, setActivePage] = useState<'sniper' | 'copy'>('sniper');

  // The left/right column divider. Shared storage key with CopyTradingPage —
  // one drag position for "how this app is split", not one per page.
  const columnSplit = useColumnSplit();

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
    priorityFeeSol: 0.001,
    maxPriorityFeeSol: 0.01,
    // On by default: the stake is one slot of the run budget, not this number.
    walletSplitSizing: true,
    takeProfitPct: 100,
    takeProfitRung2Pct: 400,
    trailingArmMultiple: 3.0,
    useTrailingStop: true,
    trailingStopPct: 30,
    maxHoldSeconds: 1800,
    // Exit policy — mirrors the engine defaults so the switches show the truth
    // before the first status frame replaces this whole object. Act on evidence
    // and on time; never on price alone (exitOnPriceStop off).
    exitOnPoolDrain: true,
    exitOnSellFlowCollapse: true,
    exitOnDevSell: true,
    exitOnHoneypot: true,
    exitOnMaxHold: true,
    exitOnNoData: true,
    exitOnPriceStop: false,
    stopLossPct: 30,
    noDataExitSeconds: 180,
    poolDrainExitFraction: 0.5,
    sellFlowExitTicks: 3,
    // All-in at the current wallet size — see the engine defaults for why.
    maxActivePositions: 1,
    activePlaybook: 'ALL',
    tradingMode: 'paper',
    leniencyMode: 'strict',
    // Launch snipe (Play 1, flag launchSnipe) — mirror the engine defaults.
    launchSnipeMinSolInflow: 1,
    launchSnipeWindowSeconds: 60,
    launchSnipeMaxDevBuySol: 5,
    launchSnipeMinDevBuySol: 0,
    launchSnipeMinDistinctBuyers: 3,
    launchSnipeMinDistinctSlots: 2,
    launchSnipeMaxSingleBuyerPct: 60,
    privateKey: '',
    // Both key fields start blank and STAY blank on every status sync: the
    // server never sends a key back, only whether one is stored. Saving with a
    // blank field therefore keeps the stored key rather than clearing it.
    heliusApiKey: '',
    pumpPortalApiKey: '',
    solanaTrackerApiKey: '',
    birdeyeApiKey: '',
  });

  // Photon wallet linking state. The key only ever lives in this input until
  // it is POSTed once; it is never stored in config or read back from status.
  const [walletKeyInput, setWalletKeyInput] = useState<string>('');
  const [walletPersist, setWalletPersist] = useState<boolean>(false);
  const [walletError, setWalletError] = useState<string>('');
  const [lastReport, setLastReport] = useState<any>(null);

  // Auto-Updater State
  const [updateInfo, setUpdateInfo] = useState<any>(null);
  const [checkingUpdate, setCheckingUpdate] = useState<boolean>(false);
  const [applyingUpdate, setApplyingUpdate] = useState<boolean>(false);
  const [updateProgress, setUpdateProgress] = useState<any>(null);
  const [updateError, setUpdateError] = useState<string>('');

  // Feature Flags State
  // Initial values are a PLACEHOLDER until fetchFlags answers, and every one of
  // them is the SAFE side. allInSizing in particular used to start `true` here,
  // and because fetchFlags was unreachable (see the effect below) it stayed
  // true forever — so the dashboard reported "ALL-IN MODE: ON" on an install
  // where it was genuinely off, and handleSaveConfig POSTed that literal back
  // and turned it on for real.
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({
    allInSizing: false,
    devSellStop: true,
    honestPaper: true,
    playbookRouting: true,
    killSwitch: true,
    dynamicPriorityFee: false,
    localTxBuild: false,
    honeypotChecks: true,
    enforceTradeEconomics: false,
    launchSnipe: true,
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
      const res = await apiFetch(`http://localhost:${selectedPort}/api/flags`, {
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

  // The server is the single source of wallet truth. The browser holds no key
  // material and opens no RPC connection of its own: it POSTs the pasted key to
  // the loopback server once and reads address/balance back off /api/bot/status.
  const wallet = botStatus?.wallet;
  // Which endpoint is REALLY in use. A stale SOLANA_RPC_URL outranks the Helius
  // key silently, so "key set" plus "RPC DOWN" used to be unexplainable from
  // the UI alone. The host is safe to show; the credential is in the query
  // string and never leaves the server.
  const rpcInfo = botStatus?.health?.rpc;
  const rpcEndpointLabel = rpcInfo?.endpointHost
    ? `${rpcInfo.endpointHost} (${rpcInfo.endpointSource})`
    : null;
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
    const rawInput = walletKeyInput.trim();
    if (!rawInput) {
      setWalletError('Please enter a Photon/Phantom private key or byte array.');
      return;
    }

    // Offline format check only, so a typo fails instantly instead of after a
    // round trip. The browser keeps no copy: the key goes to the loopback
    // server, which is the only thing that signs, and the input is cleared.
    if (!previewWalletAddress(rawInput)) {
      setWalletError('Could not parse that key. Photon exports a base58 string; a JSON byte array or 128-char hex also work.');
      return;
    }

    let linked = false;
    let lastError = '';
    for (const port of [selectedPort, 3001, 3002]) {
      try {
        const res = await apiFetch(`http://localhost:${port}/api/wallet/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ privateKey: rawInput, persist: walletPersist }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.ok) {
          linked = true;
          break;
        }
        if (data?.error) lastError = data.error;
      } catch { /* try the next instance */ }
    }

    setWalletKeyInput('');
    if (!linked) {
      setWalletError(lastError || 'No bot instance accepted the wallet. Is the server running on this port?');
    }
  };

  const refreshWallet = async () => {
    try {
      await apiFetch(`${API_BASE}/api/wallet/refresh`, { method: 'POST' });
    } catch { /* status poll covers us */ }
  };

  const unlinkWallet = async () => {
    setWalletError('');
    for (const port of [selectedPort, 3001, 3002]) {
      try {
        await apiFetch(`http://localhost:${port}/api/wallet/unlink`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deleteFile: true }),
        });
      } catch { /* best effort */ }
    }
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

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const res = await fetch(`http://localhost:${selectedPort}/api/updater/check`);
      if (res.ok) {
        const data = await res.json();
        setUpdateInfo(data);
      }
    } catch {
      /* ignore offline */
    } finally {
      setCheckingUpdate(false);
    }
  };

  useEffect(() => {
    handleCheckUpdate();
    const interval = setInterval(handleCheckUpdate, 300000);
    return () => clearInterval(interval);
  }, [selectedPort]);

  /**
   * One-click self-update.
   *
   * The server downloads the release exe, verifies it against the published
   * SHA256, swaps it in and relaunches — so the browser's job is only to start
   * it, follow progress, and explain a refusal. It refuses while a position is
   * open or the bot is armed; that message comes back in the response.
   */
  const handleApplyUpdate = async () => {
    if (!window.confirm(
      `Install version ${updateInfo?.latestVersion}?\n\n` +
      'The bot will download the new build, verify its checksum, replace itself and restart. ' +
      'Any open position must be closed first.'
    )) return;

    setUpdateError('');
    setApplyingUpdate(true);

    // Poll progress independently: the apply request does not return until the
    // process is on its way out.
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:${selectedPort}/api/updater/progress`);
        if (res.ok) setUpdateProgress(await res.json());
      } catch { /* the server is mid-restart — expected near the end */ }
    }, 500);

    try {
      const res = await apiFetch(`http://localhost:${selectedPort}/api/updater/apply`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setUpdateError(data.error || 'The update could not be applied.');
        setApplyingUpdate(false);
      }
      // On success the process exits and this page loses its backend until the
      // new build binds the port again; the status poll reconnects on its own.
    } catch {
      // A dropped connection here usually means the swap succeeded and the old
      // process is gone, so say what is actually happening.
      setUpdateProgress({ stage: 'restarting', pct: 100, message: 'Restarting into the new version…' });
    } finally {
      setTimeout(() => clearInterval(poll), 15000);
    }
  };

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

    // Placed BEFORE the cleanup return. It used to sit after it, which made it
    // unreachable: the UI never once read the server's real feature flags, so
    // every flag rendered (and every flag posted back) was the hardcoded
    // initial state above.
    void fetchFlags(selectedPort);

    return () => {
      closed = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
      setStreamLive(false);
    };
  }, [selectedPort]);

  // Heartbeat only. No shutdown beacon on tab close: one stale tab closing or
  // refreshing must not kill a server other tabs (or the app window) still use.
  // The server's heartbeat failsafe + the Electron window-close path already
  // handle "everything closed" shutdown safely.
  useEffect(() => {
    const heartbeatUrl = `http://localhost:${selectedPort}/api/heartbeat`;

    const pingHeartbeat = () => {
      apiFetch(heartbeatUrl, { method: 'POST' }).catch(() => {});
    };
    pingHeartbeat();
    const heartbeatTimer = setInterval(pingHeartbeat, 3000);

    return () => {
      clearInterval(heartbeatTimer);
    };
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

  // Buy-alert sound on every NEW sniper position, paper or real — same clip and
  // same rule as the copy page. Seed the seen-set from the first frame so
  // restoring open positions on load stays silent. The clip shipped in
  // public/buy-alert.mp3 is already bass-boosted, so no extra low-shelf here.
  const { playBuyAlert, testBuyAlert } = useBuyAlert({ bassDb: 0 });
  const seenBuyAlertKeys = useRef<Set<string>>(new Set());
  const buyAlertSeededRef = useRef(false);
  useEffect(() => {
    const positions = botStatus?.activePositions;
    if (!positions) return;
    const seeding = !buyAlertSeededRef.current;
    for (const pos of positions) {
      if (!pos.mint) continue;
      const key = `${pos.mint}_${pos.buyTxid || 'nobuy'}`;
      if (seenBuyAlertKeys.current.has(key)) continue;
      seenBuyAlertKeys.current.add(key);
      if (!seeding) playBuyAlert();
    }
    buyAlertSeededRef.current = true;
  }, [botStatus?.activePositions]);

  // Toggle Bot Power ON / OFF
  const toggleBotPower = async () => {
    const targetState = !botStatus?.isBotActive;
    if (botStatus) setBotStatus(prev => prev ? { ...prev, isBotActive: targetState } : null);

    const portsToTry = [selectedPort, 3001, 3002];
    for (const port of portsToTry) {
      try {
        const res = await apiFetch(`http://localhost:${port}/api/bot/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: targetState })
        });
        const data = await res.json();
        if (data.success && botStatus) {
          setBotStatus(prev => prev ? { ...prev, isBotActive: data.isBotActive } : null);
          break;
        }
      } catch (e) { /* try next */ }
    }
  };

  // Emergency Cease / Stop Bot
  const handleEmergencyStop = async () => {
    if (botStatus) setBotStatus(prev => prev ? { ...prev, isBotActive: false } : null);

    const portsToTry = [selectedPort, 3001, 3002];
    for (const port of portsToTry) {
      try {
        await apiFetch(`http://localhost:${port}/api/bot/kill`, { method: 'POST' }).catch(() => {});
        await apiFetch(`http://localhost:${port}/api/bot/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: false })
        }).catch(() => {});
      } catch (err) { /* try next */ }
    }
  };

  // Close & Kill Dev Server Process Completely
  const handleShutdownServer = async () => {
    if (!window.confirm("Are you sure you want to CLOSE and KILL the dev server process?")) return;
    try {
      await apiFetch('/api/server/shutdown', { method: 'POST' });
    } catch (err) {
      // Ignored - process exits
    }
    alert("Dev server process has been shut down.");
  };

  // Clear Execution Receipts & Trade History
  const handleClearHistory = async () => {
    if (!window.confirm("Are you sure you want to clear all execution receipts and closed trade history?")) return;
    try {
      const res = await apiFetch('/api/bot/clear-history', { method: 'POST' });
      const data = await res.json();
      if (data.success && botStatus) {
        setBotStatus({ ...botStatus, tradeHistory: [] });
      }
    } catch (err) {
      try {
        const res = await apiFetch(`http://localhost:${selectedPort}/api/bot/clear-history`, { method: 'POST' });
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
      const res = await apiFetch(`http://localhost:${selectedPort}/api/bot/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // allInSizing is NOT sent from here. It is a feature flag with its own
        // endpoint and its own toggle; including it meant that saving ANY
        // unrelated setting also wrote this flag from whatever the client
        // happened to be holding — which, with fetchFlags dead, was a
        // hardcoded `true`. Saving a Helius key turned on 100%-of-wallet
        // sizing. The flag is changed only by its own control now.
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

  /**
   * Erase a credential saved from Settings.
   *
   * Needs its own call rather than clearing the input: a blank key field means
   * "keep the stored one" (the status endpoint never returns a key, so every
   * save posts it empty), so erasing has to be stated explicitly.
   */
  const handleForgetKey = async (field: 'heliusApiKey' | 'pumpPortalApiKey') => {
    if (!window.confirm(`Forget the saved ${field === 'heliusApiKey' ? 'Helius' : 'PumpPortal'} key?\n\nThe bot will fall back to the .env value, or to no key at all.`)) return;
    try {
      await apiFetch(`http://localhost:${selectedPort}/api/bot/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forgetStoredKeys: [field] })
      });
    } catch (err) {
      console.error('Forget key error:', err);
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
      await apiFetch(`http://localhost:${selectedPort}/api/bot/sell-position`, {
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

  // Shared page switcher — rendered in both headers so either desk is one
  // click away. Styled like the instance buttons for visual continuity.
  const pageTabs = (
    <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
      <button
        className={`btn-instance ${activePage === 'sniper' ? 'active' : ''}`}
        onClick={() => setActivePage('sniper')}
      > SNIPER TERMINAL
      </button>
      <button
        className={`btn-instance ${activePage === 'copy' ? 'active' : ''}`}
        onClick={() => setActivePage('copy')}
      > COPY TRADING
      </button>
    </div>
  );

  if (activePage === 'copy') {
    return (
      /* Same viewport shell as the sniper view — without it this page's grid
         has no height to fill and the panels sit in the top third. */
      <div className="app-shell">
        <DiagnosticsPanel />
        <header className="header">
          <div>
            <div className="brand-title">PUMPPORTAL TERMINAL — MEME COIN WALLET COPY TRADING DESK</div>
            <div className="brand-subtitle">PORT {selectedPort} / HELIUS ON-CHAIN WALLET WATCHER + PUMPPORTAL FAST LANE / PHOTON MAINNET SIGNER</div>
            {pageTabs}
          </div>
          {/* Right side deliberately empty: CopyTradingPage pins its START/STOP
              and settings controls to this corner. */}
          <div style={{ minWidth: '380px' }} />
        </header>
        <CopyTradingPage apiBase={API_BASE} />

        {/* The same bar as the sniper view, carrying only the facts this view
            actually owns. The copy engine's own counters live in its stat
            strip; duplicating them here would be a second source of truth for
            a number that is already on screen. */}
        <div className="status-bar">
          <div className={`status-seg mode${botStatus?.tradingMode === 'real' ? ' live' : ''}`}>
            {botStatus?.tradingMode === 'real' ? '● LIVE MONEY' : '◇ PAPER'}
          </div>
          <div className="status-seg">
            <span className="status-key">port</span>
            <span className="status-val">{selectedPort}</span>
          </div>
          <div className="status-seg">
            <span className="status-key">rpc</span>
            <span className={`status-val ${wallet?.rpcHealthy !== false ? 'ok' : 'bad'}`}>
              {wallet?.rpcHealthy !== false ? 'OK' : 'DOWN'}
            </span>
            {rpcEndpointLabel && <span className="status-key">{rpcEndpointLabel}</span>}
          </div>
          <div className="status-seg">
            <span className="status-key">wallet</span>
            <span className={`status-val ${wallet?.linked ? 'ok' : 'warn'}`}>
              {wallet?.linked ? `${wallet.solBalance} SOL` : 'NOT LINKED'}
            </span>
          </div>
          <div className="status-seg status-spacer" />
          <div className="status-seg">
            <span className="status-key">view</span>
            <span className="status-val">COPY TRADING</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    /* THE VIEWPORT SHELL. This was a bare <div>, which is why the whole layout
       sat in the top three-quarters of the screen with dead space beneath it:
       #root is a 100vh flex column, this div was its only child, and a flex
       child defaults to content height — so the 100vh grid inside it never
       received a height to fill. */
    <div className="app-shell">
      {/* Auto-Update banner. A packaged exe installs in place; a dev checkout
          is told to git pull instead of being offered a swap it cannot do. */}
      {updateInfo?.hasUpdate && (
        <div style={{ background: 'var(--ok)', color: 'var(--fg)', padding: '10px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', fontSize: '15px', fontWeight: 600, borderBottom: '1px solid var(--ok)' }}>
          <span style={{ minWidth: 0 }}> UPDATE AVAILABLE: {updateInfo.latestVersion} (you have {updateInfo.currentVersion})
            {updateError && <span style={{ display: 'block', fontWeight: 400, fontSize: '12px', color: 'var(--bad)' }}>{updateError}</span>}
            {applyingUpdate && updateProgress && (
              <span style={{ display: 'block', fontWeight: 400, fontSize: '12px' }}>
                {updateProgress.message}
                {updateProgress.stage === 'downloading' && updateProgress.totalBytes > 0 && ` — ${updateProgress.pct}%`}
              </span>
            )}
          </span>

          <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
            {updateInfo.canSelfUpdate ? (
              <button
                onClick={handleApplyUpdate}
                disabled={applyingUpdate}
                style={{ background: 'var(--fg)', color: 'var(--ok)', padding: '6px 14px', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: applyingUpdate ? 'wait' : 'pointer', opacity: applyingUpdate ? 0.7 : 1 }}
              >
                {applyingUpdate ? 'UPDATING…' : '⬇ UPDATE NOW'}
              </button>
            ) : updateInfo.installKind === 'electron' ? (
              // The desktop app is a DIRECTORY of files: swapping one exe would
              // corrupt it, so it never self-updates — it sends you to the installer.
              <a
                href={updateInfo.releaseUrl}
                target="_blank"
                rel="noreferrer"
                style={{ background: 'var(--fg)', color: 'var(--ok)', padding: '6px 14px', textDecoration: 'none', borderRadius: '4px', fontWeight: 700 }}
              >
                ⬇ GET THE INSTALLER
              </a>
            ) : (
              <span style={{ fontSize: '12px', fontWeight: 400 }}>Dev checkout — run <code>git pull</code></span>
            )}
            <a href={updateInfo.releaseUrl} target="_blank" rel="noreferrer" style={{ background: 'var(--line)', color: 'var(--fg)', padding: '6px 14px', textDecoration: 'none', borderRadius: '4px', fontWeight: 700 }}> NOTES
            </a>
          </div>
        </div>
      )}

      {/* Editorial Bloomberg Header */}
      <header className="header">
        <div>
          <div className="brand-title">PUMPPORTAL TERMINAL — MULTI-INSTANCE ALGORITHMIC SNIPER</div>
          <div className="brand-subtitle">PORT {selectedPort} / HELIUS RPC / PHOTON MAINNET SIGNER / PLAYBOOK V1.0</div>
          {pageTabs}
        </div>

        {/* Multi-Instance Switcher Bar */}
        <div className="instance-bar">
          <span style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--ink-secondary)', fontWeight: 700, marginRight: '4px' }}> BOT INSTANCES:
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

            onClick={() => setShowInstanceModal(true)}
          >
            + NEW INSTANCE
          </button>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          {/* The RPC pill used to live here. It is in the status bar now, which
              is where a persistent condition belongs — and carrying it in both
              places is what pushed this header onto three ragged rows whenever
              the chain was unreachable, i.e. exactly when it most needed to be
              readable. */}
          {/* The two RPC fault badges were here. Both are flags on the status
              bar's rpc segment now, with the full explanation in its tooltip.
              Carrying them here as well meant the header grew a row exactly
              when the chain was unreachable — and put two red blocks on a
              screen whose whole point is that colour is rationed. */}

          <button
            className="btn-terminal-outline"
            onClick={() => handleToggleFlag('allInSizing', !featureFlags.allInSizing)}
            style={{
              borderColor: featureFlags.allInSizing ? 'var(--ok)' : 'var(--ink-secondary)',
              color: featureFlags.allInSizing ? 'var(--ok)' : 'var(--ink-secondary)',
              fontWeight: 700,
              background: featureFlags.allInSizing ? 'var(--ok-bg)' : 'transparent',
            }}
            title="When active, every trade spends 100% of your available Photon wallet SOL balance"
          > ALL-IN MODE: {featureFlags.allInSizing ? 'ON' : 'OFF'}
          </button>

          <button className="btn-terminal-outline" onClick={() => setShowConfigModal(true)}> SETTINGS &amp; FLAGS
          </button>

          <button className="btn-terminal-outline" onClick={testBuyAlert} title="Play the buy-alert sound to test it"> TEST SOUND
          </button>

          <button className="btn-terminal-outline" onClick={handleClearHistory} style={{ borderColor: 'var(--ink-secondary)' }}> CLEAR RECEIPTS
          </button>

          <button 
            className="btn-terminal" 
            onClick={isBotActive ? handleEmergencyStop : toggleBotPower}
            style={{
              background: isBotActive ? 'var(--bad)' : 'var(--accent-olive)',
              borderColor: isBotActive ? 'var(--bad)' : 'var(--accent-olive)',
              color: 'var(--fg)',
              fontWeight: 700
            }}
          >
            {isBotActive ? '■ CEASE / STOP BOT' : '▶ START BOT'}
          </button>

          <button 
            className="btn-terminal" 
            onClick={handleShutdownServer}
            style={{
              background: 'var(--bad)',
              borderColor: 'var(--bad)',
              color: 'var(--fg)',
              fontWeight: 700
            }}
          > KILL DEV SERVER
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
          <div style={{ fontSize: '11px', color: 'var(--ink-muted)', marginTop: '2px', textTransform: 'uppercase', fontFamily: 'var(--font-sans)', letterSpacing: '0.06em' }}>
            {botStatus?.tradingMode.toUpperCase() || 'PAPER'} ({currentLeniency.toUpperCase()})
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Capital Allocation</div>
          <div className="stat-value-mono">
            ${botStatus?.bankrollUsd.toFixed(2) || '100.00'}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}> PORT {selectedPort} EQUALITY
          </div>
        </div>

        {/* Hero Anchor Card — Cumulative Performance in Large Italic Fraunces */}
        <div className="stat-card hero-anchor">
          <div className="stat-label" style={{ color: 'var(--ink-primary)', fontWeight: 700 }}> Cumulative Performance
          </div>
          <div className={`hero-fraunces-number ${stats.totalNetPnlUsd >= 0 ? 'delta-positive' : 'delta-negative'}`}>
            {stats.totalNetPnlUsd >= 0 ? '+' : ''}${stats.totalNetPnlUsd.toFixed(2)}
          </div>
          <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--ink-secondary)', marginTop: '2px' }}>
            {stats.totalNetPnlSol >= 0 ? '+' : ''}{stats.totalNetPnlSol} SOL REALIZED
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Success Metrics</div>
          <div className="stat-value-mono">
            {stats.winRatePct}%
          </div>
          <div style={{ fontSize: '11px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {stats.winCount}W / {stats.lossCount}L ({stats.totalTrades} TOTAL)
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Active Engagements</div>
          <div className="stat-value-mono">
            {activePositions.length} / {botStatus?.config.maxActivePositions ?? '—'}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-sans)', letterSpacing: '0.06em' }}> CONCURRENT LIMIT
          </div>
        </div>

        {/* Runtime clock — ticks every second while a run is live */}
        <div className="stat-card" style={{ border: runElapsedSec !== null ? '1px solid var(--ok-bg)' : undefined }}>
          <div className="stat-label">Runtime</div>
          <div className="stat-value-mono" style={{ color: runElapsedSec !== null ? 'var(--ok)' : undefined }}>
            {runElapsedSec !== null
              ? fmtClock(runElapsedSec)
              : lastReport
                ? fmtClock(lastReport.durationSeconds)
                : '00:00:00'}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
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
          <div style={{ fontSize: '11px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {run
              ? 'SEEN → BOUGHT THIS RUN'
              : lastReport
                ? `ROI ${lastReport.roiPct >= 0 ? '+' : ''}${lastReport.roiPct}% · SAVED TO reports/`
                : 'NO RUNS YET'}
          </div>
        </div>

        {/* Wallet state — the difference between paper and real money */}
        <div className="stat-card" style={{ border: wallet?.linked ? '1px solid var(--ok-bg)' : undefined }}>
          <div className="stat-label"> Photon Wallet
            <span style={{ float: 'right', fontSize: '11px', color: streamLive ? 'var(--ok)' : 'var(--warn)' }}>
              {streamLive ? '● LIVE' : '○ POLLING'}
            </span>
          </div>
          <div className="stat-value-mono" style={{ color: wallet?.linked ? 'var(--ok)' : undefined }}>
            {wallet?.linked ? `${wallet.solBalance} SOL` : 'NOT LINKED'}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {wallet?.linked
              ? `${wallet.shortAddress} · $${wallet.usdBalance} · ${wallet.rpcHealthy ? 'RPC OK' : 'RPC DOWN'} · SOL $${botStatus?.config?.solPriceUsd ?? '—'}`
              : 'PAPER MODE ONLY'}
          </div>
        </div>

        {/* Next order size — recomputed from the live balance every frame, by
            the same maths the buy path uses. */}
        <div className="stat-card" style={{ border: featureFlags.allInSizing ? '1px solid var(--ok-bg)' : undefined }}>
          <div className="stat-label">
            {featureFlags.allInSizing
              ? 'ALL-IN WALLET BUDGET'
              : botStatus?.config?.walletSplitSizing
                ? `Slot Size (1 of ${botStatus?.config?.maxActivePositions ?? 3})`
                : 'Next Entry Size'}
          </div>
          <div className="stat-value-mono" style={{ color: featureFlags.allInSizing ? 'var(--ok)' : undefined }}>
            {featureFlags.allInSizing
              ? (wallet?.linked ? `${wallet.deployableSol} SOL` : '100% WALLET')
              : sizing ? `${sizing.nextBuySol} SOL` : '—'}
          </div>
          <div style={{ fontSize: '11px', color: featureFlags.allInSizing ? 'var(--ok)' : 'var(--ink-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
            {featureFlags.allInSizing
              ? 'EVERY ENTRY SPENDS 100% WALLET SOL'
              : sizing
                ? `≈ $${sizing.nextBuyUsd} × ${sizing.tradesAffordable} TRADE${sizing.tradesAffordable === 1 ? '' : 'S'} FROM ${sizing.deployableSol} SOL`
                : 'AWAITING STATUS'}
          </div>
          {/* The whole point of splitting: name what one dead slot actually
              costs, in the currency the owner thinks in. */}
          {sizing && botStatus?.config?.walletSplitSizing && sizing.nextBuySol > 0 && (
            <div style={{ fontSize: '11px', marginTop: '3px', fontFamily: 'var(--font-mono)', color: 'var(--ink-muted)' }}> MAX LOSS PER SLOT ≈ ${sizing.nextBuyUsd} ({Math.round(100 / (sizing.slots || botStatus?.config?.maxActivePositions || 3))}% OF RUN)
            </div>
          )}
          {/* blockedReason now only means the balance physically cannot fund
              an order. Bad economics no longer block — every amount trades —
              so they get an advisory line, not a stop sign. */}
          {sizing && sizing.blockedReason && (
            <div style={{ fontSize: '11px', marginTop: '4px', padding: '4px 6px', fontFamily: 'var(--font-mono)', color: 'var(--bad)', border: '1px solid var(--bad)', background: 'var(--bad-bg)' }}> NO TRADES POSSIBLE — {sizing.blockedReason}
            </div>
          )}
          {sizing && !sizing.blockedReason && sizing.economicsOk === false && (
            <div style={{ fontSize: '11px', marginTop: '4px', padding: '4px 6px', fontFamily: 'var(--font-mono)', color: 'var(--warn)', border: '1px solid var(--warn)', background: 'var(--warn-bg)' }}> ROUND-TRIP COST {sizing.breakevenPct}% — EVERY ENTRY STARTS THAT FAR UNDERWATER. TRADING ANYWAY.
            </div>
          )}
          {sizing && sizing.slotsReducedForEconomics && (
            <div style={{ fontSize: '11px', marginTop: '4px', fontFamily: 'var(--font-mono)', color: 'var(--warn)' }}>
              {sizing.requestedSlots} SLOTS REQUESTED → {sizing.slots} FUNDABLE. ONE DEAD POSITION NOW COSTS {Math.round(100 / (sizing.slots || 1))}% OF THE RUN.
            </div>
          )}
          {/* Fee drag is the number that decides whether small stakes can work
              at all — show it next to the stake, not buried in a report. */}
          {sizing && sizing.breakevenPct > 0 && (
            <div style={{
              fontSize: '11px',
              marginTop: '3px',
              fontFamily: 'var(--font-mono)',
              color: sizing.breakevenPct > 10 ? 'var(--bad)' : sizing.breakevenPct > 6 ? 'var(--warn)' : 'var(--ok)',
            }}> NEEDS +{sizing.breakevenPct}% TO BREAK EVEN
            </div>
          )}
        </div>
      </section>

      {/* Main Single-Screen Split Grid (Zero Forced Page Scrolling) */}
      <div
        className="main-viewport-grid"
        style={{ gridTemplateColumns: `${columnSplit.leftPct}% var(--sp-3) 1fr` }}
      >
        {/* Left column: what to copy, what is open, what closed. */}
        <div className="viewport-column">
          <ResizablePanel id="sniper-scout" resize="both" minHeight={120}>
            <TraderScoutPanel />
          </ResizablePanel>
          <ResizablePanel id="sniper-smart-money" resize="both" minHeight={90}>
            <SmartMoneyPanel />
          </ResizablePanel>

          {/* Positions Matrix Table */}
          <ResizablePanel id="sniper-positions" resize="both" minHeight={160}>
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
                    <button className="btn-terminal" onClick={toggleBotPower}> START BOT
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
                              style={{ padding: '2px 6px', fontSize: '11px' }}
                            > SOLSCAN
                            </a>
                          )}
                          <a
                            href={`https://photon-sol.tinyastro.io/en/lp/${pos.mint}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-terminal-outline"
                            style={{ padding: '2px 6px', fontSize: '11px' }}
                          > PHOTON
                          </a>
                          <button className="btn-cell-action" onClick={() => forceSellPosition(pos.id)}> LIQUIDATE
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

          {/* Execution receipts — permanent record of every closed leg. The
              Execution column is the ground truth the 10-second log feed can't
              give: a real fill links to its Solscan tx, a paper fill says so. */}
          <ResizablePanel id="sniper-receipts" resize="both" minHeight={140}>
          <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
                style={{ fontSize: '11px', padding: '2px 8px', color: 'var(--bad)', borderColor: 'var(--bad)' }}
              > CLEAR RECEIPTS
              </button>
            )}
          </div>
          <div className="matrix-container flex-matrix">
            {tradeHistory.length === 0 ? (
              <div className="empty-state"> No closed trades yet. Real fills appear here with an ON-CHAIN ✓ link to their Solscan
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
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
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
                      <td style={{ fontSize: '11px', color: 'var(--ink-muted)', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.exitReason}>
                        {t.exitReason}
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

        {/* Right Column: System Logs Console Feed (Full Height Auto-Scroll) */}
        <div className="viewport-column">
          <ResizablePanel id="sniper-logs" resize="both" minHeight={200} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="section-header">
            <div className="section-title">System Logs & Event Stream — Port {selectedPort}</div>
            <div className="section-count">
              {visibleLogs.length} LINE{visibleLogs.length === 1 ? '' : 'S'} · WIPES IN {secondsToWipe}s
            </div>
          </div>

          <div className="console-container">
            {visibleLogs.length === 0 ? (
              <div style={{ color: 'var(--ink-muted)' }}> Console cleared. Screening activity appears here as it happens.
              </div>
            ) : (
              visibleLogs.map(log => (
                <div key={log.id} className="log-line">
                  <span className="log-time">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                  <span className={`log-level-${log.level}`}>
                    {stripEmoji(log.message)}
                  </span>
                </div>
              ))
            )}
            <div ref={terminalEndRef} />
          </div>
          </ResizablePanel>
        </div>
      </div>

      {/* STATUS BAR — the facts you check constantly, in one fixed strip.
          Everything here is already on screen somewhere; the point is that it
          is on screen ALWAYS, and in the same place, so none of it has to be
          hunted for among the panels. */}
      <div className="status-bar">
        <div className={`status-seg mode${botStatus?.tradingMode === 'real' ? ' live' : ''}`}>
          {botStatus?.tradingMode === 'real' ? '● LIVE MONEY' : '◇ PAPER'}
        </div>
        <div className="status-seg">
          <span className={`status-dot${isBotActive ? '' : ' bad'}`} />
          <span className="status-val">{isBotActive ? 'ARMED' : 'IDLE'}</span>
        </div>
        <div className="status-seg">
          <span className="status-key">port</span>
          <span className="status-val">{selectedPort}</span>
        </div>
        <div
          className="status-seg"
          title={[
            wallet?.rpcHealthy !== false ? 'RPC connection active' : 'RPC connection offline',
            rpcEndpointLabel ? `Endpoint: ${rpcEndpointLabel}` : null,
            rpcInfo?.keyOverridden
              ? 'SOLANA_RPC_URL is set in the .env beside the app and takes precedence, so your Helius key is NOT being used. Remove it for the key to take effect.'
              : null,
            rpcInfo?.credentialRejected ? (rpcInfo.lastError || 'The provider rejected the API key itself.') : null,
          ].filter(Boolean).join('\n')}
        >
          <span className="status-key">rpc</span>
          <span className={`status-val ${wallet?.rpcHealthy !== false ? 'ok' : 'bad'}`}>
            {wallet?.rpcHealthy !== false ? 'OK' : 'DOWN'}
          </span>
          {rpcEndpointLabel && <span className="status-key">{rpcEndpointLabel}</span>}
          {/* Two conditions that look identical from the outside — "RPC is
              down" — but have opposite fixes. They were badges in the header;
              they are flags here, and the segment's tooltip carries the whole
              explanation rather than a truncated one. */}
          {rpcInfo?.credentialRejected && <span className="status-val bad">KEY REJECTED</span>}
          {rpcInfo?.keyOverridden && <span className="status-val warn">KEY UNUSED · URL OVERRIDE</span>}
        </div>
        <div className="status-seg">
          <span className="status-key">wallet</span>
          <span className={`status-val ${wallet?.linked ? 'ok' : 'warn'}`}>
            {wallet?.linked ? `${wallet.solBalance} SOL` : 'NOT LINKED'}
          </span>
        </div>
        <div className="status-seg">
          <span className="status-key">open</span>
          <span className="status-val">{activePositions.length}/{botStatus?.config?.maxActivePositions ?? '—'}</span>
        </div>

        <div className="status-seg status-spacer" />

        <div className="status-seg">
          <span className="status-key">uptime</span>
          <span className="status-val">
            {runElapsedSec === null
              ? '--:--:--'
              : new Date(runElapsedSec * 1000).toISOString().substring(11, 19)}
          </span>
        </div>
        <div className="status-seg">
          <span className="status-key">log</span>
          <span className="status-val">{logs.length}</span>
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
                > DISCARD
                </button>
                <button
                  type="submit"
                  className="btn-terminal"
                  style={{ flex: 1 }}
                > SPAWN INSTANCE
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
                    value="STRICT — SCORE >= 62"
                    disabled
                    readOnly
                  />
                </div>
              </div>

              {/* Software update — ALWAYS VISIBLE.
                  Previously the only update UI was a banner gated on
                  hasUpdate, so with no published release the entire feature was
                  invisible and there was no way to tell it existed, let alone
                  whether it worked. A version and a Check button belong on
                  screen permanently; "nothing to see" is itself information. */}
              <div className="form-group" style={{ marginTop: '4px', padding: '10px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', borderRadius: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      ⬇ Software Update
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '3px', fontFamily: 'var(--font-mono)' }}> Installed: <strong>v{updateInfo?.currentVersion ?? '—'}</strong>
                      {updateInfo?.latestVersion && updateInfo.latestVersion !== updateInfo.currentVersion && (
                        <> · Available: <strong>{updateInfo.latestVersion}</strong></>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <button
                      type="button"
                      className="btn-instance"
                      onClick={handleCheckUpdate}
                      disabled={checkingUpdate || applyingUpdate}
                    >
                      {checkingUpdate ? 'CHECKING…' : 'CHECK NOW'}
                    </button>
                    {updateInfo?.hasUpdate && updateInfo?.canSelfUpdate && (
                      <button
                        type="button"
                        className="btn-instance"
                        style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}
                        onClick={handleApplyUpdate}
                        disabled={applyingUpdate}
                      >
                        {applyingUpdate ? 'UPDATING…' : 'UPDATE NOW'}
                      </button>
                    )}
                  </div>
                </div>

                <div style={{ fontSize: '10px', marginTop: '6px', lineHeight: 1.55, color: 'var(--ink-muted)' }}>
                  {updateError && <div style={{ color: 'var(--bad)' }}>{updateError}</div>}

                  {applyingUpdate && updateProgress && (
                    <div style={{ color: 'var(--ok)' }}>
                      {updateProgress.message}
                      {updateProgress.stage === 'downloading' && updateProgress.totalBytes > 0 && ` — ${updateProgress.pct}%`}
                    </div>
                  )}

                  {!applyingUpdate && updateInfo?.hasUpdate && (
                    <div style={{ color: 'var(--ok)' }}> A newer release is published.
                      {!updateInfo.canSelfUpdate && (updateInfo.installKind === 'electron'
                        ? ' This is the installed desktop app — download the new installer from the release page and run it. Your settings and positions are kept (they live in the app-data folder, not next to the app).'
                        : ' This is a dev checkout — run git pull instead of installing.')}
                    </div>
                  )}

                  {!applyingUpdate && updateInfo && !updateInfo.hasUpdate && !updateInfo.error && (
                    <div>You are on the latest published release.</div>
                  )}

                  {/* The state this repo is ACTUALLY in: the updater works, but
                      there is nothing on the other end to install yet. Say that
                      plainly rather than showing an empty panel. */}
                  {!applyingUpdate && updateInfo?.error && (
                    <div style={{ color: 'var(--warn)' }}>
                      {updateInfo.error}
                      {/No published release/.test(String(updateInfo.error)) && (
                        <> Tag a release (<code>git tag v1.1.0 &amp;&amp; git push --tags</code>) — the workflow builds the exe
                        and publishes it with a SHA256, and this button installs it from then on.</>
                      )}
                    </div>
                  )}

                  {updateInfo && !updateInfo.canSelfUpdate && !updateInfo.hasUpdate && (
                    <div style={{ marginTop: '2px' }}> Running from source, so in-place install is unavailable — only the packaged .exe can replace itself.
                    </div>
                  )}
                </div>
              </div>

              {/* API keys. Both are per-user and neither is ever sent back by
                  the status endpoint — the field stays blank and shows whether
                  a key is stored, so saving with it empty keeps the existing
                  one instead of wiping it. */}
              <div className="form-group" style={{ marginTop: '10px' }}>
                <label className="form-label"> Helius RPC Key{' '}
                  {botStatus?.config?.heliusApiKeySet
                    ? <span style={{ color: 'var(--ok)' }}>— set {botStatus.config.heliusApiKeyHint}</span>
                    : <span style={{ color: 'var(--bad)' }}>— NOT SET (the bot cannot reach the chain)</span>}
                </label>
                <input
                  type="password"
                  className="form-input"
                  placeholder={botStatus?.config?.heliusApiKeySet ? 'Leave blank to keep the stored key' : 'Paste your Helius API key'}
                  value={configForm.heliusApiKey || ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, heliusApiKey: e.target.value })}
                />
                <div className="form-help" style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px' }}> Free tier at helius.dev. Used for every RPC call, position pricing and transaction submission.
                  There is no built-in key — each user supplies their own.
                  {' '}Keys entered here are saved to <code>.api-keys.json</code> beside the app and reused on the next start.
                </div>
                {/* Which source won matters: a saved key outranks .env, so
                    editing .env and seeing no change needs an explanation. */}
                {botStatus?.config?.heliusApiKeySet && (
                  <div style={{ fontSize: '10px', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ color: 'var(--ink-muted)' }}>
                      source: {botStatus.config.heliusApiKeySource === 'stored'
                        ? 'saved in Settings (takes precedence over .env)'
                        : 'environment / .env'}
                    </span>
                    {botStatus.config.heliusApiKeySource === 'stored' && (
                      <button type="button" className="btn-ghost" style={{ fontSize: '10px', padding: '1px 5px' }}
                        onClick={() => void handleForgetKey('heliusApiKey')}> Forget saved key
                      </button>
                    )}
                  </div>
                )}
                {!botStatus?.config?.heliusApiKeySet && (
                  <div style={{ fontSize: '10px', marginTop: '3px', color: 'var(--warn)' }}> Running on the public RPC endpoint — heavily rate limited. Positions can still be priced and sold, but snipes will lose races.
                  </div>
                )}
              </div>

              <div className="form-group" style={{ marginTop: '10px' }}>
                <label className="form-label"> PumpPortal Data Key{' '}
                  {botStatus?.config?.pumpPortalApiKeySet
                    ? <span style={{ color: 'var(--ok)' }}>— set {botStatus.config.pumpPortalApiKeyHint}</span>
                    : <span style={{ color: 'var(--warn)' }}>— not set (free tier)</span>}
                </label>
                <input
                  type="password"
                  className="form-input"
                  placeholder={botStatus?.config?.pumpPortalApiKeySet ? 'Leave blank to keep the stored key' : 'Paste your PumpPortal API key (optional)'}
                  value={configForm.pumpPortalApiKey || ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, pumpPortalApiKey: e.target.value })}
                />
                <div className="form-help" style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', lineHeight: 1.5 }}>
                  <strong>Not needed to trade</strong> — buys and sells go through the free trade-local endpoint.
                  What it unlocks is PER-TRADE DATA, which requires a key funded with at least 0.02 SOL (~$1.50).
                  Without it <code>subscribeTokenTrade</code> returns nothing, so unique-buyer counts read 0,
                  Play 2 (mid-curve entry) can never trigger, the creator-dump exit can never fire, and copy
                  trading mirrors nothing. Get one at pumpportal.fun and fund it with your own SOL — it is never
                  shared between users.
                </div>
              </div>

              {/* Scout credentials. READ-ONLY and free — neither of these can
                  place an order, and neither is required to trade. They only
                  supply candidate wallet ADDRESSES; every number the scout
                  ranks on is re-measured from chain data by this bot. */}
              <div className="form-group" style={{ marginTop: '10px' }}>
                <label className="form-label"> Solana Tracker Key{' '}
                  {botStatus?.config?.solanaTrackerApiKeySet
                    ? <span style={{ color: 'var(--ok)' }}>— set {botStatus.config.solanaTrackerApiKeyHint}</span>
                    : <span style={{ color: 'var(--warn)' }}>— not set (the scout falls back to on-chain discovery)</span>}
                </label>
                <input
                  type="password"
                  className="form-input"
                  placeholder={botStatus?.config?.solanaTrackerApiKeySet ? 'Leave blank to keep the stored key' : 'Paste your free Solana Tracker key (optional)'}
                  value={configForm.solanaTrackerApiKey || ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, solanaTrackerApiKey: e.target.value })}
                />
                <div className="form-help" style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', lineHeight: 1.5 }}> Free tier at solanatracker.io. Feeds the <strong>Who to copy</strong> scout with candidate
                  wallets — both the profit leaderboard and the named-KOL board. It is the only free source
                  that ranks Solana wallets by realized profit over a plain API call: GMGN and Kolscan are
                  behind Cloudflare's TLS fingerprinting and cannot be read from a server at all.
                  <strong> Read-only</strong> — it cannot trade, and the scout ignores its PnL numbers,
                  re-deriving every figure from the chain before ranking anything.
                </div>
              </div>

              <div className="form-group" style={{ marginTop: '10px' }}>
                <label className="form-label"> Birdeye Key{' '}
                  {botStatus?.config?.birdeyeApiKeySet
                    ? <span style={{ color: 'var(--ok)' }}>— set {botStatus.config.birdeyeApiKeyHint}</span>
                    : <span style={{ color: 'var(--ink-muted)' }}>— not set (optional)</span>}
                </label>
                <input
                  type="password"
                  className="form-input"
                  placeholder={botStatus?.config?.birdeyeApiKeySet ? 'Leave blank to keep the stored key' : 'Paste your free Birdeye key (optional)'}
                  value={configForm.birdeyeApiKey || ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, birdeyeApiKey: e.target.value })}
                />
                <div className="form-help" style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px', lineHeight: 1.5 }}> Free tier at birdeye.so. A second opinion for the scout's candidate list — a wallet two
                  independent boards both name is worth checking first. Purely additive: the scout works
                  without it.
                </div>
              </div>

              {/* Photon Wallet Link — real on-chain execution */}
              <div className="form-group" style={{ border: '1px solid var(--line)', padding: 12, marginTop: '6px' }}>
                <label className="form-label"> Photon Wallet {wallet?.linked ? '— LINKED' : '— not linked'}
                </label>

                {wallet?.linked ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontFamily: 'monospace', fontSize: '0.8rem', wordBreak: 'break-all', color: 'var(--ok)' }}>
                      {wallet.address}
                    </div>
                    <div style={{ display: 'flex', gap: 14, fontSize: '0.85rem', flexWrap: 'wrap' }}>
                      <span><strong>{wallet.solBalance}</strong> SOL</span>
                      <span style={{ color: 'var(--fg-dim)' }}>${wallet.usdBalance}</span>
                      <span style={{ color: 'var(--ok)' }}>{wallet.deployableSol} deployable</span>
                      <span style={{ color: wallet.rpcHealthy ? 'var(--ok)' : 'var(--bad)' }}> RPC {wallet.rpcHealthy ? 'OK' : 'DOWN'}
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" className="btn-terminal-outline" style={{ flex: 1 }} onClick={refreshWallet}> REFRESH BALANCE
                      </button>
                      <button type="button" className="btn-terminal-outline" style={{ flex: 1 }} onClick={unlinkWallet}> UNLINK
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
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: 'var(--fg-dim)' }}>
                      <input
                        type="checkbox"
                        checked={walletPersist}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWalletPersist(e.target.checked)}
                      /> Save to .photon-wallet.json so it reloads on restart
                    </label>
                    <button type="button" className="btn-terminal" onClick={linkWallet} disabled={!walletKeyInput.trim()}> LINK WALLET
                    </button>
                  </div>
                )}
              </div>

              {/* Strategy Parameters Grid */}
              <div style={{ marginTop: '10px' }}>
                <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-secondary)', marginBottom: '6px' }}> Strategy Parameters
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
                    <label className="form-label">Max Concurrent Positions</label>
                    <input
                      type="number"
                      className="form-input"
                      value={configForm.maxActivePositions}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, maxActivePositions: Number(e.target.value) })}
                    />
                  </div>
                </div>

                {/* PRIORITY FEE — surfaced because it is the single biggest
                    lever on whether a transaction lands, and it is the one
                    setting here that costs SOL on every trade whether the trade
                    wins or loses. It was previously pinned (floor == ceiling)
                    with no way to change it outside a config file. */}
                <div style={{ marginTop: '10px', padding: '10px', background: 'var(--warn-bg)', border: '1px solid var(--warn-bg)', borderRadius: '4px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--warn)', marginBottom: '6px' }}> Priority Fee — what you pay to land
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <div className="form-group">
                      <label className="form-label">Fee Floor (SOL)</label>
                      <input
                        type="number"
                        step="0.001"
                        className="form-input"
                        value={configForm.priorityFeeSol ?? 0.001}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, priorityFeeSol: Number(e.target.value) })}
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Fee Ceiling (SOL)</label>
                      <input
                        type="number"
                        step="0.001"
                        className="form-input"
                        value={configForm.maxPriorityFeeSol ?? 0.01}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, maxPriorityFeeSol: Number(e.target.value) })}
                      />
                    </div>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--fg-dim)', marginTop: '6px', lineHeight: 1.5 }}> Paid on <strong>every</strong> transaction, win or lose. The floor is what you always pay;
                    with dynamic fees on, a congested slot can bid up to the ceiling.
                    A fee too low simply does not land — and a send that does not land still burns its base fee.
                    <br /> Whatever you set here, a single fee is never more than <strong>5% of the position</strong>,
                    so on a {(configForm.buyAmountSol ?? 0.6).toFixed(3)} SOL position the most one trade can pay is{' '}
                    <strong>{Math.min(configForm.maxPriorityFeeSol ?? 0.01, (configForm.buyAmountSol ?? 0.6) * 0.05).toFixed(4)} SOL</strong>
                    {' '}(~{((Math.min(configForm.maxPriorityFeeSol ?? 0.01, (configForm.buyAmountSol ?? 0.6) * 0.05) * 2 / (configForm.buyAmountSol || 1)) * 100).toFixed(1)}% of the position for a round trip).
                  </div>
                </div>

                {/* Take-profit Automation Controls (positive P&L only). The
                    loss side lives in its own Exit Policy block below. */}
                <div style={{ marginTop: '10px', padding: '10px', background: 'var(--ok-bg)', border: '1px solid var(--ok-bg)', borderRadius: '4px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ok)', marginBottom: '6px' }}> Take-Profit Automation (Positive P&L Only)
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <div className="form-group">
                      <label className="form-label">Take Profit 1 Target (+%)</label>
                      <input
                        type="number"
                        className="form-input"
                        value={configForm.takeProfitPct ?? 100}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, takeProfitPct: Number(e.target.value) })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Take Profit 2 Target (+%)</label>
                      <input
                        type="number"
                        className="form-input"
                        value={configForm.takeProfitRung2Pct ?? 400}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, takeProfitRung2Pct: Number(e.target.value) })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Trailing Profit Arm Multiple (x)</label>
                      <input
                        type="number"
                        step="0.1"
                        className="form-input"
                        value={configForm.trailingArmMultiple ?? 3.0}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, trailingArmMultiple: Number(e.target.value) })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Trailing Profit Distance (%)</label>
                      <input
                        type="number"
                        className="form-input"
                        value={configForm.trailingStopPct ?? 30}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, trailingStopPct: Number(e.target.value) })}
                      />
                    </div>
                  </div>
                </div>

                {/* Exit Policy. Every automatic sell on the loss side is a
                    switch, not a hardcoded rule. All off = the bot never sells
                    on its own; dangers are still detected and logged. */}
                <div style={{ marginTop: '10px', padding: '10px', background: 'var(--warn-bg)', border: '1px solid var(--warn-bg)', borderRadius: '4px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--warn)', marginBottom: '4px' }}> Exit Policy — which automatic sells may fire
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginBottom: '8px', lineHeight: 1.5 }}> Turn every switch off and the bot never sells on its own — dangers are still detected and
                    logged, and LIQUIDATE stays the only exit. Take-profit rungs above are unaffected.
                  </div>

                  {([
                    ['exitOnPoolDrain', 'Pool drained',
                      `Sell 100% when liquidity falls ${Math.round((configForm.poolDrainExitFraction ?? 0.5) * 100)}% from its peak. This is the event that makes a bag unsellable, so it outranks every other exit.`],
                    ['exitOnDevSell', 'Creator dumps',
                      'Sell 100% when the creator sells their own bag. Needs the Dev-Sell Stop feature flag for detection.'],
                    ['exitOnHoneypot', 'Honeypot confirmed',
                      'Sell 100% when the post-buy sell simulation reverts. Needs the Honeypot Checks flag, and real mode.'],
                    ['exitOnSellFlowCollapse', 'Buy pressure collapses',
                      `Sell 50%, then the rest on a second collapse, after ${configForm.sellFlowExitTicks ?? 3} consecutive ticks under 25% buy pressure.`],
                    ['exitOnNoData', 'Never got a market',
                      `Sell 100% if no market data has appeared ${configForm.noDataExitSeconds ?? 180}s after entry. Reads no price — only whether a market exists.`],
                    ['exitOnMaxHold', 'Time stop',
                      `Sell 100% once the position is older than ${Math.round((configForm.maxHoldSeconds ?? 1800) / 60)} min, whatever the P&L. Dead tokens release the capital.`],
                    ['exitOnPriceStop', 'Price stop',
                      `Sell 100% at −${configForm.stopLossPct ?? 30}% from the VERIFIED FILL price. Off by default: a 20–35% drawdown here is noise, and a stop inside the entry band just realises it.`],
                  ] as Array<[keyof BotConfig, string, string]>).map(([key, title, detail]) => (
                    <div
                      key={String(key)}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '5px 0', borderTop: '1px solid var(--border-hairline)' }}
                    >
                      <div>
                        <div style={{ fontSize: '10px', fontWeight: 700 }}>{title}</div>
                        <div style={{ fontSize: '10px', color: 'var(--ink-muted)', lineHeight: 1.45 }}>{detail}</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={!!configForm[key]}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setConfigForm({ ...configForm, [key]: e.target.checked } as Partial<BotConfig>)
                        }
                      />
                    </div>
                  ))}

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' }}>
                    <div className="form-group">
                      <label className="form-label">Time Stop (minutes)</label>
                      <input
                        type="number"
                        className="form-input"
                        value={Math.round((configForm.maxHoldSeconds ?? 1800) / 60)}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, maxHoldSeconds: Math.round(Number(e.target.value) * 60) })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">No-Market Exit (seconds)</label>
                      <input
                        type="number"
                        className="form-input"
                        value={configForm.noDataExitSeconds ?? 180}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, noDataExitSeconds: Number(e.target.value) })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Pool Drain Trigger (% of peak)</label>
                      <input
                        type="number"
                        className="form-input"
                        value={Math.round((configForm.poolDrainExitFraction ?? 0.5) * 100)}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, poolDrainExitFraction: Number(e.target.value) / 100 })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Sell-Flow Ticks</label>
                      <input
                        type="number"
                        className="form-input"
                        value={configForm.sellFlowExitTicks ?? 3}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, sellFlowExitTicks: Number(e.target.value) })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Price Stop (−%)</label>
                      <input
                        type="number"
                        className="form-input"
                        disabled={!configForm.exitOnPriceStop}
                        value={configForm.stopLossPct ?? 30}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, stopLossPct: Number(e.target.value) })}
                      />
                    </div>
                  </div>
                </div>

                {/* Wallet-split sizing: the run budget is carved into equal
                    slots at START, so one dead trade costs 1/N of the run. */}
                <div style={{ marginTop: '8px', padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                  <div>
                    <div style={{ fontSize: '10px', fontWeight: 700 }}>Split Wallet Across Slots</div>
                    <div style={{ fontSize: '10px', color: 'var(--ink-muted)' }}> At START, divide the deployable balance into {configForm.maxActivePositions ?? 3} equal
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

                {/* Launch snipe (Play 1): enabled by the Launch Snipe flag
                    below; these tune WHEN it pulls the trigger. */}
                <div style={{ marginTop: '10px' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-secondary)', marginBottom: '6px' }}> Launch Snipe (Play 1)
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--ink-muted)', marginBottom: '6px' }}> Buys fresh launches in their first candle, next to the other snipers, skipping the
                    slow screening entirely. Inflow 0 = buy the instant the create event arrives; otherwise
                    wait until that much SOL from other buyers hits the curve inside the window, AND the
                    trade tape shows it came from a crowd: at least this many distinct wallets over this
                    many distinct slots, with no single wallet above the share cap. One slot is one bundle.
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <div className="form-group">
                      <label className="form-label">Confirm Inflow (SOL, 0 = instant)</label>
                      <input
                        type="number"
                        step="0.1"
                        className="form-input"
                        value={configForm.launchSnipeMinSolInflow}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, launchSnipeMinSolInflow: Number(e.target.value) })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Snipe Window (seconds)</label>
                      <input
                        type="number"
                        className="form-input"
                        value={configForm.launchSnipeWindowSeconds}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, launchSnipeWindowSeconds: Number(e.target.value) })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Max Dev Buy (SOL)</label>
                      <input
                        type="number"
                        step="0.1"
                        className="form-input"
                        value={configForm.launchSnipeMaxDevBuySol}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, launchSnipeMaxDevBuySol: Number(e.target.value) })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Min Dev Buy (SOL, 0 = off)</label>
                      <input
                        type="number"
                        step="0.1"
                        className="form-input"
                        value={configForm.launchSnipeMinDevBuySol}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, launchSnipeMinDevBuySol: Number(e.target.value) })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Min Distinct Buyers</label>
                      <input
                        type="number"
                        className="form-input"
                        value={configForm.launchSnipeMinDistinctBuyers}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, launchSnipeMinDistinctBuyers: Number(e.target.value) })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Min Distinct Slots</label>
                      <input
                        type="number"
                        className="form-input"
                        value={configForm.launchSnipeMinDistinctSlots}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, launchSnipeMinDistinctSlots: Number(e.target.value) })}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Max Single Buyer Share (%)</label>
                      <input
                        type="number"
                        className="form-input"
                        value={configForm.launchSnipeMaxSingleBuyerPct}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfigForm({ ...configForm, launchSnipeMaxSingleBuyerPct: Number(e.target.value) })}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Feature Flags Matrix */}
              <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border-hairline)' }}>
                <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-secondary)', marginBottom: '6px' }}> Engine Feature Flags &amp; Guards
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                  <div style={{ padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '10px', fontWeight: 700 }}>Launch Snipe</div>
                      <div style={{ fontSize: '10px', color: 'var(--ink-muted)' }}>Play 1: first-candle entry, screens skipped</div>
                    </div>
                    <input type="checkbox" checked={!!featureFlags.launchSnipe} onChange={e => handleToggleFlag('launchSnipe', e.target.checked)} />
                  </div>

                  <div style={{ padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '10px', fontWeight: 700 }}>Dev Sell Stop</div>
                      <div style={{ fontSize: '10px', color: 'var(--ink-muted)' }}>Exit on creator / cluster sells</div>
                    </div>
                    <input type="checkbox" checked={!!featureFlags.devSellStop} onChange={e => handleToggleFlag('devSellStop', e.target.checked)} />
                  </div>

                  <div style={{ padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '10px', fontWeight: 700 }}>Honest Paper</div>
                      <div style={{ fontSize: '10px', color: 'var(--ink-muted)' }}>Real curve fills &amp; fee drag</div>
                    </div>
                    <input type="checkbox" checked={!!featureFlags.honestPaper} onChange={e => handleToggleFlag('honestPaper', e.target.checked)} />
                  </div>

                  <div style={{ padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '10px', fontWeight: 700 }}>Playbook Router</div>
                      <div style={{ fontSize: '10px', color: 'var(--ink-muted)' }}>Measured curve routing</div>
                    </div>
                    <input type="checkbox" checked={!!featureFlags.playbookRouting} onChange={e => handleToggleFlag('playbookRouting', e.target.checked)} />
                  </div>

                  <div style={{ padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '10px', fontWeight: 700 }}>Kill Switch</div>
                      <div style={{ fontSize: '10px', color: 'var(--ink-muted)' }}>Auto-pause on hourly loss</div>
                    </div>
                    <input type="checkbox" checked={!!featureFlags.killSwitch} onChange={e => handleToggleFlag('killSwitch', e.target.checked)} />
                  </div>

                  <div style={{ padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '10px', fontWeight: 700 }}>Dynamic Priority Fee</div>
                      <div style={{ fontSize: '10px', color: 'var(--ink-muted)' }}>P75 network fee scaling</div>
                    </div>
                    <input type="checkbox" checked={!!featureFlags.dynamicPriorityFee} onChange={e => handleToggleFlag('dynamicPriorityFee', e.target.checked)} />
                  </div>

                  <div style={{ padding: '6px 8px', background: 'var(--bg-subtle)', border: '1px solid var(--border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '10px', fontWeight: 700 }}>Honeypot Audit</div>
                      <div style={{ fontSize: '10px', color: 'var(--ink-muted)' }}>Freeze &amp; transfer hook check</div>
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
                > DISCARD
                </button>
                <button
                  type="submit"
                  className="btn-terminal"
                  style={{ flex: 1 }}
                > APPLY PARAMETERS
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
