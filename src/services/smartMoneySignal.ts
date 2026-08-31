import { walletLedger, WalletLedger } from './walletLedger';

/**
 * CONFLUENCE — several proven wallets converging on the same token.
 *
 * WHY CONFLUENCE RATHER THAN MIRRORING. The copy trader already mirrors one
 * chosen leader as fast as it can. Doing the same thing again, faster, is not
 * what this is for, and the research says why: copier returns are structurally
 * worse than the returns they copy, because a wallet worth following moves the
 * price the moment it buys and every follower buys into that move. Racing one
 * wallet is a race you are structurally behind in.
 *
 * What is NOT structurally behind is agreement. When several wallets that each
 * earned their place independently buy the same token inside a short window,
 * that is information no single one of them carries — and it is information a
 * fast follower of any one of them does not have. The price impact is already
 * paid by then; what we are buying is the higher prior that this token is one
 * of the few that runs.
 *
 * This also makes the failure mode benign. Mirroring one wallet inherits every
 * mistake it makes. Requiring K of them to agree means one wallet having a bad
 * day produces nothing at all.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO DO. It does not decide sizing, it does not
 * touch the wallet, and it does not bypass anything. It turns observations into
 * a signal; the engine decides what to do with one, through the same
 * `withEntrySlot` chokepoint and the same safety gates every other entry uses.
 * There is no second door — see the note in sniperEngine's entry path.
 */

export interface SmartMoneyBuy {
  wallet: string;
  mint: string;
  solIn: number;
  at: number;
  /** The leader's slot, when the feed carried one. */
  slot?: number;
  /**
   * The transaction this buy came from.
   *
   * The independence test. "Distinct wallet address" is not independence — a
   * bundler buys from sixteen wallets in ONE transaction, which is one actor
   * expressing one opinion, and counting it as sixteen is a confluence
   * detector agreeing with itself. Two votes from the same signature are one
   * vote.
   */
  signature?: string;
  /**
   * The bonding curve's virtual SOL reserves at the moment of this buy.
   *
   * Comes free with the decoded TradeEvent — no RPC — and it is what tells the
   * playbook router WHERE ON THE CURVE the token is. Without it the router
   * cannot classify the phase and refuses the candidate outright, which is how
   * the first version of this lane could never buy anything.
   */
  vSolInBondingCurve?: number;
}

export interface SmartMoneySignal {
  mint: string;
  /** The promoted wallets that bought inside the window, in arrival order. */
  wallets: string[];
  /** Combined SOL those wallets put in. */
  totalSolIn: number;
  /** First and last buy in the window. */
  firstAt: number;
  lastAt: number;
  /**
   * 0-1. The mean conviction of the contributing wallets, scaled by how far
   * past the minimum the agreement went. Drives sizing; never drives safety.
   */
  strength: number;
  /** The best slot we know of, so the entry can be scored against the leaders. */
  leaderSlot?: number;
  /** Curve position at the freshest contributing buy. Measured, never assumed. */
  vSolInBondingCurve?: number;
}

export interface ConfluenceConfig {
  /** Distinct promoted wallets required before a signal fires. */
  minWallets: number;
  /** How long they have to agree, ms. */
  windowMs: number;
  /** A buy smaller than this does not count toward the quorum. */
  minBuySol: number;
  /**
   * How long a mint is ignored after it fires, ms. Without this, wallet 4, 5
   * and 6 arriving a second later each re-fire the same signal and the engine
   * sees three entries for one event.
   */
  cooldownMs: number;
}

export const DEFAULT_CONFLUENCE: ConfluenceConfig = {
  // TWO, not three. Three independently-promoted wallets agreeing inside a
  // minute is rare enough that the strategy would almost never fire; two is
  // still a real filter (a promoted roster is capped at 25 wallets out of every
  // address on the chain) while producing signals often enough to be measured.
  // Raise it if the feed proves noisy — that is what the config is for.
  minWallets: 2,
  windowMs: 60_000,
  minBuySol: 0.2,
  cooldownMs: 10 * 60_000,
};

/** How long a buy stays eligible to contribute. Bounds the memory, not the rule. */
const BUY_RETENTION_MS = 10 * 60_000;
/** Mints tracked at once. A busy roster touches many; this caps the map. */
const MAX_TRACKED_MINTS = 500;

export class SmartMoneyDetector {
  private buysByMint = new Map<string, SmartMoneyBuy[]>();
  private firedAt = new Map<string, number>();
  private config: ConfluenceConfig = { ...DEFAULT_CONFLUENCE };

  constructor(private ledger: WalletLedger = walletLedger) {}

  public setConfig(patch: Partial<ConfluenceConfig>): ConfluenceConfig {
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) (this.config as any)[k] = v;
    }
    return this.getConfig();
  }

  public getConfig(): ConfluenceConfig {
    return { ...this.config };
  }

  /**
   * Feed one observed buy. Returns a signal only on the transition into
   * quorum — never again for the same mint until the cooldown expires.
   *
   * The PROMOTED check happens here, at the front door, rather than being left
   * to the caller. Anything else means a caller that forgets is a caller that
   * spends money on an unproven wallet.
   */
  public observe(buy: SmartMoneyBuy, now = buy.at): SmartMoneySignal | null {
    if (!buy.wallet || !buy.mint) return null;
    if (!Number.isFinite(buy.solIn) || buy.solIn < this.config.minBuySol) return null;

    const record = this.ledger.get(buy.wallet);
    if (!record || record.state !== 'promoted') return null;

    const list = this.buysByMint.get(buy.mint) ?? [];
    // ONE VOTE PER WALLET. A single wallet buying five times in a minute — a
    // DCA ladder, or a bot splitting an order across transactions to hide its
    // size — is one opinion, and counting it as five is how a "confluence"
    // detector fires on a single participant. This is the defect that makes the
    // whole idea worthless if it is missed.
    const already = list.find(b => b.wallet === buy.wallet);
    if (already) {
      // Keep the larger stake and the earliest time; still just one vote.
      already.solIn = Math.max(already.solIn, buy.solIn);
      if (buy.slot && !already.slot) already.slot = buy.slot;
      // The curve moves, so the FRESHEST reading wins — an old one would price
      // the candidate against a position the token has already left.
      if (buy.vSolInBondingCurve !== undefined) already.vSolInBondingCurve = buy.vSolInBondingCurve;
    } else {
      list.push(buy);
    }
    this.buysByMint.set(buy.mint, list);
    this.prune(now);

    const cooledUntil = (this.firedAt.get(buy.mint) ?? 0) + this.config.cooldownMs;
    if (now < cooledUntil) return null;

    const inWindow = list.filter(b => now - b.at <= this.config.windowMs);
    if (inWindow.length < this.config.minWallets) return null;

    // Re-checked at fire time, not only at observe time: a wallet can be
    // demoted between its buy and the quorum completing, and a signal is only
    // as good as the wallets standing behind it AT THE MOMENT it fires.
    const stillPromoted = inWindow.filter(b => this.ledger.get(b.wallet)?.state === 'promoted');
    if (stillPromoted.length < this.config.minWallets) return null;

    // ONE TRANSACTION IS ONE OPINION. Wallets that bought in the same
    // transaction were bundled by whoever built it — a fleet operator, or a
    // launch bundler moving sixteen wallets at once. They are not independent
    // observers agreeing; they are one actor, and the whole argument for
    // preferring confluence over mirroring rests on the observers being
    // independent. Buys with no signature are treated as distinct, because the
    // fast lane always supplies one and a missing one is not evidence of
    // bundling.
    const bySignature = new Map<string, SmartMoneyBuy>();
    const independent: SmartMoneyBuy[] = [];
    for (const b of stillPromoted) {
      if (!b.signature) { independent.push(b); continue; }
      const seen = bySignature.get(b.signature);
      if (seen) continue;                       // same transaction — already counted once
      bySignature.set(b.signature, b);
      independent.push(b);
    }
    if (independent.length < this.config.minWallets) return null;

    this.firedAt.set(buy.mint, now);

    const convictions = independent
      .map(b => this.ledger.score(b.wallet)?.conviction)
      .filter((c): c is number => typeof c === 'number');
    const meanConviction = convictions.length
      ? convictions.reduce((s, c) => s + c, 0) / convictions.length
      : 0.5;
    // Agreement beyond the minimum counts for something, but with sharply
    // diminishing weight: four wallets is better than two, not twice as good.
    const excess = independent.length - this.config.minWallets;
    const agreementBonus = 1 - Math.pow(0.6, excess);       // 0, 0.4, 0.64, …
    const strength = clamp01(meanConviction * (0.75 + 0.25 * agreementBonus));

    const slots = independent.map(b => b.slot).filter((s): s is number => typeof s === 'number' && s > 0);
    // The most recent contributor's reading of the curve.
    const freshest = [...independent].sort((a, b) => b.at - a.at)
      .find(b => typeof b.vSolInBondingCurve === 'number');

    return {
      mint: buy.mint,
      wallets: independent.map(b => b.wallet),
      totalSolIn: round4(independent.reduce((s, b) => s + b.solIn, 0)),
      firstAt: Math.min(...independent.map(b => b.at)),
      lastAt: Math.max(...independent.map(b => b.at)),
      strength,
      ...(slots.length ? { leaderSlot: Math.max(...slots) } : {}),
      ...(freshest ? { vSolInBondingCurve: freshest.vSolInBondingCurve } : {}),
    };
  }

  /** Drop buys that can no longer contribute, and bound the map. */
  private prune(now: number): void {
    for (const [mint, list] of this.buysByMint) {
      const kept = list.filter(b => now - b.at <= BUY_RETENTION_MS);
      if (kept.length) this.buysByMint.set(mint, kept);
      else this.buysByMint.delete(mint);
    }
    if (this.buysByMint.size > MAX_TRACKED_MINTS) {
      // Oldest last-activity first.
      const byAge = [...this.buysByMint.entries()]
        .sort((a, b) => lastAt(a[1]) - lastAt(b[1]));
      let drop = this.buysByMint.size - MAX_TRACKED_MINTS;
      for (const [mint] of byAge) {
        if (drop-- <= 0) break;
        this.buysByMint.delete(mint);
      }
    }
    for (const [mint, at] of this.firedAt) {
      if (now - at > this.config.cooldownMs * 2) this.firedAt.delete(mint);
    }
  }

  /** What is currently accumulating, for the UI. */
  public pending(now = Date.now()): Array<{ mint: string; wallets: number; needed: number }> {
    const out: Array<{ mint: string; wallets: number; needed: number }> = [];
    for (const [mint, list] of this.buysByMint) {
      const inWindow = list.filter(b => now - b.at <= this.config.windowMs);
      if (inWindow.length > 0) {
        out.push({ mint, wallets: inWindow.length, needed: this.config.minWallets });
      }
    }
    return out.sort((a, b) => b.wallets - a.wallets);
  }

  public reset(): void {
    this.buysByMint.clear();
    this.firedAt.clear();
    this.config = { ...DEFAULT_CONFLUENCE };
  }
}

function lastAt(list: SmartMoneyBuy[]): number {
  return list.reduce((m, b) => Math.max(m, b.at), 0);
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export const smartMoneyDetector = new SmartMoneyDetector();
