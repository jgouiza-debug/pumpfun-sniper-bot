/**
 * WHO IS ACTUALLY GOOD AT THIS — decided from chain history, never from a list.
 *
 * WHY THIS EXISTS. The ask was to snipe what proven traders buy, naming a
 * couple of well-known ones. The obvious implementation is to paste their
 * wallet addresses into a config, and it is the wrong one for three reasons
 * that all cost money:
 *
 *  1. NOBODY CAN VERIFY THE ADDRESS. The published lists (KOL trackers, tweet
 *     screenshots, Telegram) mislabel constantly, and a bot pointed at the
 *     wrong address does not fail — it quietly copies a stranger.
 *  2. THEY ROTATE. A trader who matters uses many wallets and changes them,
 *     precisely because people copy them. A static list decays from the day it
 *     is written, silently, while continuing to produce signals.
 *  3. BEING FAMOUS IS NOT BEING PROFITABLE RIGHT NOW. A wallet that ran hot
 *     last month and has been bleeding since looks identical in a config file.
 *
 * So this file holds no addresses. It holds EVIDENCE, gathered by watching what
 * happened on chain, and it promotes a wallet only when its own record clears a
 * bar. When a trader rotates, the new wallet earns its way in on the same
 * evidence and the old one ages out. When one goes cold, it is demoted without
 * anybody noticing they should have edited a list.
 *
 * DESIGN RULE: THIS FILE DOES NO I/O AND MAKES NO RPC CALLS. It is a pure
 * accounting structure over facts it is handed, which is what makes the
 * promotion rules — the part that decides whether real money follows a wallet —
 * testable without a network. Persistence is wired at the bottom of the file,
 * outside the class, exactly as tradeGovernor does it and for the same reason.
 *
 * THE HONEST LIMIT, STATED UP FRONT. Copier returns are structurally worse than
 * the returns they copy: a wallet worth following moves the price when it buys,
 * and everyone following it buys into that move. This ledger cannot fix that.
 * What it can do is stop us following a wallet that is not actually good, which
 * is the larger and more common loss.
 */
import fs from 'fs';
import { installPath } from './installPaths';

export type WalletState =
  /** Seen at least once. No opinion yet; not enough evidence to have one. */
  | 'candidate'
  /** Enough evidence to be scored, not enough (or not good enough) to follow. */
  | 'observed'
  /** Cleared the bar. ONLY this state may drive a real buy. */
  | 'promoted'
  /** Cleared it once and no longer does. Kept, not deleted — see demote(). */
  | 'demoted';

/** One completed round trip we observed a wallet make. */
export interface ObservedTrade {
  mint: string;
  /** SOL the wallet put in. */
  solIn: number;
  /** SOL the wallet took out. Undefined while the position is still open. */
  solOut?: number;
  openedAt: number;
  closedAt?: number;
}

export interface WalletRecord {
  address: string;
  state: WalletState;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Buys observed, whether or not they ever closed. */
  buysSeen: number;
  /** Closed round trips — the denominator for every rate below. */
  closedTrades: number;
  wins: number;
  losses: number;
  realizedPnlSol: number;
  /** Sum of hold durations over closed trades, for the mean. */
  holdSecTotal: number;
  /**
   * Times this wallet was among the earliest buyers of a token that later ran.
   * The strongest single signal available without paying for an indexer: it
   * measures being early to a winner, which is the thing being copied.
   */
  earlyOnWinners: number;
  /** Times it was early on a token that went nowhere. The denominator's other half. */
  earlyOnLosers: number;
  /** When the state last changed, and why. Shown to the operator. */
  stateChangedAt: number;
  stateReason: string;
  /** Set by the operator to override the ladder in either direction. */
  pinned?: 'always' | 'never';
  /** Bounded tail of recent trades, for the UI and for debugging a bad promotion. */
  recent: ObservedTrade[];
}

export interface PromotionThresholds {
  /** Closed round trips before a win rate means anything. */
  minClosedTrades: number;
  /** Fraction of closed trades that were profitable. */
  minWinRate: number;
  /** Total realized SOL. A wallet can win often and still lose money. */
  minRealizedPnlSol: number;
  /** Early-on-winner events, which can promote a wallet with no closed trades yet. */
  minEarlyOnWinners: number;
  /** Share of early calls that were winners. */
  minEarlyHitRate: number;
  /** Below this the wallet is demoted, whatever promoted it. */
  demoteWinRate: number;
  demoteRealizedPnlSol: number;
  /** No signal for this long and the wallet stops being followed. */
  staleAfterMs: number;
  /** Hard cap on how many wallets may be promoted at once. */
  maxPromoted: number;
}

/**
 * Deliberately demanding, because the cost of the two errors is not symmetric.
 *
 * A wallet wrongly left out costs nothing but missed signals, of which there
 * are always more. A wallet wrongly promoted spends real money on somebody's
 * bad idea, repeatedly, until a human notices. So the bar is set where a run of
 * luck does not clear it: eight closed trades at 55% is not a coin flip, and
 * the early-on-winner route needs four hits at a 40% rate rather than one lucky
 * call.
 */
export const DEFAULT_PROMOTION_THRESHOLDS: PromotionThresholds = {
  minClosedTrades: 8,
  minWinRate: 0.55,
  minRealizedPnlSol: 0.5,
  minEarlyOnWinners: 4,
  minEarlyHitRate: 0.4,
  demoteWinRate: 0.40,
  demoteRealizedPnlSol: -0.5,
  staleAfterMs: 72 * 60 * 60 * 1000,
  maxPromoted: 25,
};

/** Recent trades kept per wallet. Enough to explain a promotion, not a database. */
const RECENT_TRADE_CAP = 25;
/**
 * Total wallets kept. The harvester sees a great many addresses and most are
 * noise; without a cap this becomes an unbounded map in a long-running process.
 * Eviction prefers the least interesting, never a promoted wallet — see prune().
 */
const MAX_WALLETS = 5_000;

export interface WalletScore {
  address: string;
  winRate: number | null;
  realizedPnlSol: number;
  closedTrades: number;
  earlyHitRate: number | null;
  earlyOnWinners: number;
  meanHoldSec: number | null;
  /** Single 0-1 number for ranking and for conviction sizing. Null with no evidence. */
  conviction: number | null;
}

export class WalletLedger {
  private wallets = new Map<string, WalletRecord>();
  private thresholds: PromotionThresholds = { ...DEFAULT_PROMOTION_THRESHOLDS };
  private listeners = new Set<() => void>();

  // ---------------- observation ----------------

  private ensure(address: string, now: number): WalletRecord {
    let w = this.wallets.get(address);
    if (!w) {
      w = {
        address,
        state: 'candidate',
        firstSeenAt: now,
        lastSeenAt: now,
        buysSeen: 0,
        closedTrades: 0,
        wins: 0,
        losses: 0,
        realizedPnlSol: 0,
        holdSecTotal: 0,
        earlyOnWinners: 0,
        earlyOnLosers: 0,
        stateChangedAt: now,
        stateReason: 'first seen',
        recent: [],
      };
      this.wallets.set(address, w);
      this.prune();
    }
    w.lastSeenAt = now;
    return w;
  }

  /** A wallet bought a mint. Opens a trade; nothing is scored until it closes. */
  public recordBuy(address: string, mint: string, solIn: number, now = Date.now()): void {
    if (!address || !Number.isFinite(solIn) || solIn <= 0) return;
    const w = this.ensure(address, now);
    w.buysSeen++;
    w.recent.push({ mint, solIn, openedAt: now });
    if (w.recent.length > RECENT_TRADE_CAP) w.recent.splice(0, w.recent.length - RECENT_TRADE_CAP);
    this.changed();
  }

  /**
   * A wallet closed a position. This is the only thing that moves the win rate.
   *
   * Matched against the most recent OPEN trade for that mint. An unmatched sell
   * is dropped rather than invented: a sell of a bag we never saw bought has no
   * cost basis, and guessing one manufactures a win rate out of nothing.
   */
  public recordSell(address: string, mint: string, solOut: number, now = Date.now()): boolean {
    if (!address || !Number.isFinite(solOut) || solOut < 0) return false;
    const w = this.wallets.get(address);
    if (!w) return false;
    w.lastSeenAt = now;

    for (let i = w.recent.length - 1; i >= 0; i--) {
      const t = w.recent[i];
      if (t.mint !== mint || t.solOut !== undefined) continue;
      t.solOut = solOut;
      t.closedAt = now;
      const pnl = solOut - t.solIn;
      w.closedTrades++;
      if (pnl > 0) w.wins++; else w.losses++;
      w.realizedPnlSol = round6(w.realizedPnlSol + pnl);
      w.holdSecTotal += Math.max(0, Math.round((now - t.openedAt) / 1000));
      this.changed();
      return true;
    }
    return false;
  }

  /**
   * This wallet was among the earliest buyers of a token, and we now know how
   * that token turned out.
   *
   * Separate from the win rate on purpose. A wallet can be brilliant at finding
   * tokens and terrible at selling them, and only the first half is what a
   * sniper copies — we bring our own exit policy. This is the metric that can
   * promote a wallet whose sells we never observed at all.
   */
  public recordEarlyCall(address: string, mint: string, wasWinner: boolean, now = Date.now()): void {
    if (!address) return;
    const w = this.ensure(address, now);
    if (wasWinner) w.earlyOnWinners++; else w.earlyOnLosers++;
    void mint;
    this.changed();
  }

  // ---------------- scoring ----------------

  public score(address: string): WalletScore | null {
    const w = this.wallets.get(address);
    return w ? WalletLedger.scoreOf(w) : null;
  }

  public static scoreOf(w: WalletRecord): WalletScore {
    const winRate = w.closedTrades > 0 ? w.wins / w.closedTrades : null;
    const earlyTotal = w.earlyOnWinners + w.earlyOnLosers;
    const earlyHitRate = earlyTotal > 0 ? w.earlyOnWinners / earlyTotal : null;
    const meanHoldSec = w.closedTrades > 0 ? Math.round(w.holdSecTotal / w.closedTrades) : null;

    // Conviction blends the two independent kinds of evidence, each weighted by
    // how much of it there is. A wallet with three trades at 100% is not more
    // convincing than one with forty at 62%, and a formula that ignores sample
    // size says it is.
    let conviction: number | null = null;
    const parts: Array<{ value: number; weight: number }> = [];
    if (winRate !== null) {
      parts.push({ value: pessimisticRate(w.wins, w.closedTrades), weight: Math.min(1, w.closedTrades / 20) });
    }
    if (earlyHitRate !== null) {
      parts.push({ value: pessimisticRate(w.earlyOnWinners, earlyTotal), weight: Math.min(1, earlyTotal / 10) });
    }
    if (parts.length) {
      const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
      if (totalWeight > 0) {
        const mean = parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight;
        // SHRINK TOWARD NEUTRAL BY HOW MUCH EVIDENCE THERE IS.
        //
        // A weighted mean of a single part is just that part, so weighting
        // alone did nothing: a wallet with three wins out of three scored a
        // perfect 1.0 and outranked one with forty trades at 62%. That is the
        // single most common way a screening rule promotes noise, and it was
        // live in the first version of this function until the test for it was
        // written.
        //
        // The fix is a prior. With little evidence the score is pulled toward
        // 0.5 — "no opinion" — and only a real sample can move it away. Three
        // perfect trades now land just above neutral; forty at 62% land above
        // them, which is the ordering a human would give.
        const confidence = clamp01(totalWeight / parts.length);
        conviction = clamp01(mean * confidence + 0.5 * (1 - confidence));
      }
    }

    return {
      address: w.address,
      winRate,
      realizedPnlSol: w.realizedPnlSol,
      closedTrades: w.closedTrades,
      earlyHitRate,
      earlyOnWinners: w.earlyOnWinners,
      meanHoldSec,
      conviction,
    };
  }

  // ---------------- the ladder ----------------

  /**
   * Re-evaluate every wallet against the thresholds.
   *
   * Called on a timer and after a harvest, never on the trading path. Returns
   * what changed so the caller can log it — a wallet silently starting or
   * stopping being followed is exactly the kind of thing an operator should
   * find out from a log line rather than from their balance.
   */
  public reevaluate(now = Date.now()): Array<{ address: string; from: WalletState; to: WalletState; reason: string }> {
    const T = this.thresholds;
    const changes: Array<{ address: string; from: WalletState; to: WalletState; reason: string }> = [];

    const setState = (w: WalletRecord, to: WalletState, reason: string) => {
      if (w.state === to) return;
      changes.push({ address: w.address, from: w.state, to, reason });
      w.state = to;
      w.stateChangedAt = now;
      w.stateReason = reason;
    };

    // Ranked, so the promoted cap keeps the BEST wallets rather than whichever
    // happened to be iterated first.
    const ranked = [...this.wallets.values()]
      .map(w => ({ w, s: WalletLedger.scoreOf(w) }))
      .sort((a, b) => (b.s.conviction ?? -1) - (a.s.conviction ?? -1));

    let promotedCount = 0;
    for (const { w, s } of ranked) {
      // An operator's explicit decision outranks the ladder in both directions.
      if (w.pinned === 'never') { setState(w, 'demoted', 'pinned off by the operator'); continue; }
      if (w.pinned === 'always') {
        setState(w, 'promoted', 'pinned on by the operator');
        promotedCount++;
        continue;
      }

      // SILENCE IS A DEMOTION. A wallet we have not heard from in days is not
      // a wallet whose next signal we should spend money on — it has stopped
      // trading, rotated, or been abandoned, and we cannot tell which.
      if (now - w.lastSeenAt > T.staleAfterMs) {
        setState(w, 'demoted', `no activity for ${Math.round((now - w.lastSeenAt) / 3_600_000)}h`);
        continue;
      }

      const failsHard =
        (s.winRate !== null && s.closedTrades >= T.minClosedTrades && s.winRate < T.demoteWinRate)
        || s.realizedPnlSol < T.demoteRealizedPnlSol;
      if (failsHard) {
        setState(w, 'demoted',
          `win rate ${s.winRate === null ? 'n/a' : (s.winRate * 100).toFixed(0) + '%'}, `
          + `realized ${s.realizedPnlSol.toFixed(3)} SOL`);
        continue;
      }

      // TWO INDEPENDENT ROUTES IN. Either a closed-trade record good enough to
      // stand on, or a demonstrated knack for being early to tokens that ran.
      const byTrades = s.closedTrades >= T.minClosedTrades
        && s.winRate !== null && s.winRate >= T.minWinRate
        && s.realizedPnlSol >= T.minRealizedPnlSol;
      const byEarly = s.earlyOnWinners >= T.minEarlyOnWinners
        && s.earlyHitRate !== null && s.earlyHitRate >= T.minEarlyHitRate;

      if ((byTrades || byEarly) && promotedCount < T.maxPromoted) {
        promotedCount++;
        setState(w, 'promoted', byTrades
          ? `${s.closedTrades} closed trades, ${(s.winRate! * 100).toFixed(0)}% win, ${s.realizedPnlSol.toFixed(2)} SOL`
          : `early on ${s.earlyOnWinners} winners (${(s.earlyHitRate! * 100).toFixed(0)}% hit rate)`);
        continue;
      }

      // Enough evidence to have been judged, not enough to be followed.
      const hasEvidence = s.closedTrades > 0 || s.earlyOnWinners + w.earlyOnLosers > 0;
      setState(w, hasEvidence ? 'observed' : 'candidate',
        (byTrades || byEarly) ? `qualified but the promoted cap (${T.maxPromoted}) is full` : 'below the bar');
    }

    if (changes.length) this.changed();
    return changes;
  }

  /** The only wallets a real buy may follow. */
  public promoted(): WalletRecord[] {
    return [...this.wallets.values()].filter(w => w.state === 'promoted');
  }

  public promotedAddresses(): string[] {
    return this.promoted().map(w => w.address);
  }

  public get(address: string): WalletRecord | undefined {
    return this.wallets.get(address);
  }

  public all(): WalletRecord[] {
    return [...this.wallets.values()];
  }

  public size(): number {
    return this.wallets.size;
  }

  /** Operator override. 'always'/'never' pin; null returns the wallet to the ladder. */
  public pin(address: string, mode: 'always' | 'never' | null, now = Date.now()): boolean {
    const w = this.wallets.get(address);
    if (!w) return false;
    if (mode === null) delete w.pinned; else w.pinned = mode;
    this.reevaluate(now);
    return true;
  }

  public setThresholds(patch: Partial<PromotionThresholds>): PromotionThresholds {
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        (this.thresholds as any)[k] = v;
      }
    }
    return this.getThresholds();
  }

  public getThresholds(): PromotionThresholds {
    return { ...this.thresholds };
  }

  /**
   * Keep the map bounded.
   *
   * A PROMOTED WALLET IS NEVER EVICTED, whatever the cap says — dropping one
   * would silently stop following a wallet that earned its place, and it would
   * come back as a stranger with no history. Everything else goes
   * least-evidence-first, then oldest, which is the order in which records are
   * least likely to be missed.
   */
  private prune(): void {
    if (this.wallets.size <= MAX_WALLETS) return;
    const evictable = [...this.wallets.values()]
      .filter(w => w.state !== 'promoted' && w.pinned !== 'always')
      .sort((a, b) => {
        const evidence = (w: WalletRecord) => w.closedTrades + w.earlyOnWinners + w.earlyOnLosers;
        const d = evidence(a) - evidence(b);
        return d !== 0 ? d : a.lastSeenAt - b.lastSeenAt;
      });
    let toDrop = this.wallets.size - MAX_WALLETS;
    for (const w of evictable) {
      if (toDrop <= 0) break;
      this.wallets.delete(w.address);
      toDrop--;
    }
  }

  // ---------------- persistence hooks (no I/O in this class) ----------------

  public onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* a persistence failure must not stop accounting */ }
    }
  }

  public serialize(): { version: 1; savedAt: number; thresholds: PromotionThresholds; wallets: WalletRecord[] } {
    return {
      version: 1,
      savedAt: Date.now(),
      thresholds: this.getThresholds(),
      wallets: this.all(),
    };
  }

  public restore(raw: any): number {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.wallets)) return 0;
    this.wallets.clear();
    let loaded = 0;
    for (const w of raw.wallets) {
      if (!w || typeof w.address !== 'string' || !w.address) continue;
      this.wallets.set(w.address, {
        address: w.address,
        // NEVER TRUSTED FROM DISK. The counters below are evidence and are
        // restored as written, but `state` is a CONCLUSION and this file sits
        // in the install directory as plain JSON. A hand-edited or
        // malware-written `"state": "promoted"` would put an arbitrary wallet
        // straight into the followable set and defeat the entire "earned, never
        // pasted in" property. Everything comes back as a candidate and has to
        // re-derive its state from its own numbers in reevaluate() below.
        state: 'candidate',
        firstSeenAt: num(w.firstSeenAt),
        lastSeenAt: num(w.lastSeenAt),
        buysSeen: num(w.buysSeen),
        closedTrades: num(w.closedTrades),
        wins: num(w.wins),
        losses: num(w.losses),
        realizedPnlSol: num(w.realizedPnlSol),
        holdSecTotal: num(w.holdSecTotal),
        earlyOnWinners: num(w.earlyOnWinners),
        earlyOnLosers: num(w.earlyOnLosers),
        stateChangedAt: num(w.stateChangedAt),
        stateReason: 'restored — re-deriving state from the evidence',
        // A pin is an operator decision, and `never` is the safe direction, so
        // it is honoured. `always` is not: it forces promotion with no evidence
        // at all, which is precisely the capability an attacker with write
        // access to this file would want. Re-pin it from the UI, which is
        // token-gated.
        ...(w.pinned === 'never' ? { pinned: 'never' as const } : {}),
        recent: Array.isArray(w.recent) ? w.recent.slice(-RECENT_TRADE_CAP) : [],
      });
      loaded++;
    }
    if (raw.thresholds) this.setThresholds(raw.thresholds);
    // Re-derive every state from the restored evidence. Without this the whole
    // ledger comes back as candidates and the roster is empty until the next
    // timer tick — and more importantly, this is what makes ignoring the
    // on-disk `state` safe rather than merely paranoid.
    this.reevaluate();
    return loaded;
  }

  /** Tests only. */
  public reset(): void {
    this.wallets.clear();
    this.thresholds = { ...DEFAULT_PROMOTION_THRESHOLDS };
  }
}

function isState(v: any): v is WalletState {
  return v === 'candidate' || v === 'observed' || v === 'promoted' || v === 'demoted';
}
function num(v: any): number {
  return Number.isFinite(v) ? Number(v) : 0;
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
/**
 * A success rate that a small sample cannot inflate.
 *
 * THE DEFECT THIS REPLACES. Conviction blended raw rates, shrunk toward 0.5 by
 * sample size. A wallet with four early calls and four winners scored 0.70,
 * while an honest wallet with thirty calls at a realistic 60% scored 0.60 — so
 * the manufactured record OUTRANKED the real one and, because the promoted set
 * is capped and ranked by conviction, took its slot. Producing four such
 * records costs an attacker a few tenths of a SOL.
 *
 * `wins / (total + PRIOR_TRIALS)` is a Laplace-style correction: it charges
 * every wallet a fixed number of imaginary losses, which a large sample
 * absorbs and a small one cannot. Four-for-four becomes 0.33; thirty at 60%
 * becomes 0.47. Perfection stops being free.
 */
const PRIOR_TRIALS = 8;

export function pessimisticRate(wins: number, total: number): number {
  if (!Number.isFinite(wins) || !Number.isFinite(total) || total <= 0) return 0;
  return clamp01(wins / (total + PRIOR_TRIALS));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export const walletLedger = new WalletLedger();

// ---------------- persistence, wired outside the class ----------------
//
// Same shape as tradeGovernor's: the class stays pure and testable, and the
// file I/O lives here where it can fail without corrupting the accounting.

const LEDGER_FILE = installPath('.wallet-ledger.json');

let pendingSave: NodeJS.Timeout | null = null;

export function saveWalletLedger(): void {
  if (pendingSave) return;
  // Debounced hard. This is a research record, not a trading decision: losing
  // the last few seconds of it on a crash costs nothing, while writing on every
  // observed trade would put a synchronous file write in the path of a
  // high-volume decode loop.
  pendingSave = setTimeout(() => { pendingSave = null; writeLedgerNow(); }, 5_000);
  if (typeof pendingSave.unref === 'function') pendingSave.unref();
}

export function flushWalletLedger(): void {
  if (pendingSave) { clearTimeout(pendingSave); pendingSave = null; }
  writeLedgerNow();
}

function writeLedgerNow(): void {
  try {
    const tmp = `${LEDGER_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(walletLedger.serialize(), null, 2), 'utf8');
    fs.renameSync(tmp, LEDGER_FILE);
  } catch { /* best effort — an unwritable research file must not stop trading */ }
}

export function loadWalletLedger(): number {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    return walletLedger.restore(raw);
  } catch {
    return 0; // first run, or an unreadable file: start from no evidence
  }
}

walletLedger.onChange(saveWalletLedger);
