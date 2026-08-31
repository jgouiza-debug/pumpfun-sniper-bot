/**
 * WHERE CANDIDATE WALLETS COME FROM — and why none of them is trusted.
 *
 * A leaderboard is a lead, not a fact. Every ranked-trader list on the internet
 * is some combination of: computed from an indexer that may be wrong, gameable
 * by anyone who wants to be on it, and silently reshaped whenever the vendor
 * ships. Two of them disagree about who is first on any given day.
 *
 * So this file's only job is to produce ADDRESSES. The numbers that come back
 * with them are recorded for display and are never used to rank anything —
 * traderScout re-derives every figure it ranks on from the chain itself. A
 * source that lies about a wallet's PnL costs us one wasted verification pass;
 * a source we believed would cost us the wallet.
 *
 * WHAT IS DELIBERATELY NOT HERE. GMGN's rank endpoint and Kolscan's
 * leaderboard are the two lists people actually quote, and both are unusable
 * from a server: Cloudflare rejects them on TLS fingerprint before any header
 * you can set matters, so reaching them needs a real browser. Rather than ship
 * a scraper that works until it does not, this uses Solana Tracker's mirror of
 * the KOL leaderboard, which is the same population over a plain keyed GET.
 *
 * ON RATIOS. Ranking traders by percentage return surfaces accounts that turned
 * 0.3 SOL into 3 — a 900% gain you cannot size into and cannot copy. Every
 * query here asks for ABSOLUTE realized profit, and the scout's ranking does
 * the same. This is the single most common way a copy-trading tool ends up
 * following someone useless.
 */

export interface ScoutCandidate {
  wallet: string;
  /** Which lists named it. Two lists agreeing is weak evidence, but it is evidence. */
  sources: string[];
  /**
   * What the SOURCE claimed. Shown to the operator beside our own measurement
   * so a source that is systematically wrong becomes visible. Never ranked on.
   */
  claimedRealizedSol?: number;
  claimedWinRate?: number;
  claimedTrades?: number;
  /** A human name when the list has one — the KOL leaderboard does. */
  label?: string;
}

export interface SourceOutcome {
  name: string;
  ok: boolean;
  candidates: ScoutCandidate[];
  /** Why it produced nothing. Shown in the UI verbatim — a silent source reads as a dead feature. */
  detail?: string;
  /**
   * The top-level keys of the first item, when parsing found nothing usable.
   *
   * These APIs are undocumented-adjacent and reshape without notice; a source
   * that silently returns zero candidates after a vendor rename is the failure
   * mode that would take longest to notice. Printing the keys we actually got
   * turns "the scout found nobody" into "the field is called X now".
   */
  seenKeys?: string[];
}

export interface SourceDeps {
  /** Injected so the suite can drive every branch without a network. */
  fetch: typeof fetch;
  now?: () => number;
  /** Per-request ceiling. These are 1 req/s free tiers; nothing here is on a hot path. */
  timeoutMs?: number;
}

export interface SourceKeys {
  solanaTracker?: string;
  birdeye?: string;
}

const DEFAULT_TIMEOUT_MS = 12_000;
/** Candidates taken from any one list. Beyond this the tail is noise. */
export const PER_SOURCE_LIMIT = 40;

async function getJson(url: string, headers: Record<string, string>, deps: SourceDeps): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const r = await deps.fetch(url, { headers, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Base58, 32-44 chars. Cheap sanity so a vendor's placeholder string is not queued for an RPC walk. */
export function looksLikeWallet(s: unknown): s is string {
  return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

/**
 * Solana Tracker's on-chain-derived PnL leaderboard.
 *
 * The primary source: plain keyed GET, no Cloudflare, free tier. The query is
 * built to ask the API to do the first pass of filtering for us —
 * `excludeArbitrage` drops the MEV wallets that dominate any raw profit
 * ranking and cannot be copied at any latency, and `minTrades` drops the
 * one-lucky-token accounts. Both are re-checked on chain regardless; asking
 * here just means fewer wallets to walk.
 *
 * FIELD NAMES ARE NOT THE OBVIOUS ONES. The address key is `wallet`, not
 * `address`; realized profit is `realized`, not `realized_profit` or `pnl`.
 * Guessing yields `undefined` silently, which is why an unparseable response
 * reports the keys it actually saw instead of returning an empty list.
 */
export async function fetchSolanaTrackerTop(
  key: string,
  deps: SourceDeps,
  opts: { days?: number; minTrades?: number; limit?: number } = {},
): Promise<SourceOutcome> {
  const name = 'solanatracker/top';
  const days = opts.days ?? 7;
  const q = new URLSearchParams({
    sort: 'realized',                 // ABSOLUTE profit. Never 'roi'.
    direction: 'desc',
    days: String(days),
    minTrades: String(opts.minTrades ?? 20),
    excludeArbitrage: 'true',
    pnlMode: 'adjusted',
    limit: String(Math.min(PER_SOURCE_LIMIT, opts.limit ?? PER_SOURCE_LIMIT)),
  });
  try {
    const j = await getJson(`https://data.solanatracker.io/v2/pnl/leaderboard/top?${q}`,
      { 'x-api-key': key }, deps);
    return parseSolanaTracker(name, j?.traders ?? j?.wallets ?? j);
  } catch (err: any) {
    return { name, ok: false, candidates: [], detail: String(err?.message ?? err) };
  }
}

/**
 * Solana Tracker's mirror of the KOL leaderboard.
 *
 * This is the list the operator was actually pointing at — the named traders
 * people follow. It is a small, human-curated population, so it is used as a
 * SOURCE OF CANDIDATES and nothing more: being famous is not evidence of being
 * profitable this week, and the verification pass treats these addresses
 * exactly like any other.
 */
export async function fetchSolanaTrackerKols(key: string, deps: SourceDeps): Promise<SourceOutcome> {
  const name = 'solanatracker/kols';
  try {
    const j = await getJson('https://data.solanatracker.io/v2/pnl/leaderboard/kols',
      { 'x-api-key': key }, deps);
    return parseSolanaTracker(name, j?.traders ?? j?.wallets ?? j);
  } catch (err: any) {
    return { name, ok: false, candidates: [], detail: String(err?.message ?? err) };
  }
}

function parseSolanaTracker(name: string, rows: any): SourceOutcome {
  if (!Array.isArray(rows)) {
    return { name, ok: false, candidates: [], detail: 'response was not a list' };
  }
  const candidates: ScoutCandidate[] = [];
  for (const r of rows) {
    const wallet = r?.wallet;
    if (!looksLikeWallet(wallet)) continue;
    candidates.push({
      wallet,
      sources: [name],
      claimedRealizedSol: num(r?.period?.realized) ?? num(r?.summary?.realized) ?? num(r?.realized),
      claimedWinRate: num(r?.winRate) ?? num(r?.summary?.winPercentage),
      claimedTrades: num(r?.counts?.trades) ?? num(r?.summary?.totalWins),
      ...(typeof r?.name === 'string' ? { label: r.name } : {}),
    });
    if (candidates.length >= PER_SOURCE_LIMIT) break;
  }
  if (!candidates.length) {
    return {
      name, ok: false, candidates: [],
      detail: 'no wallet field found in any row',
      seenKeys: rows.length && rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).slice(0, 25) : [],
    };
  }
  return { name, ok: true, candidates };
}

/**
 * Birdeye's chain-wide gainers/losers board. The fallback.
 *
 * TWO TRAPS, both of which return a 400 or an empty list rather than an error
 * you would notice:
 *   - `type` is the TIME WINDOW (`today` | `yesterday` | `1W`). It is NOT a
 *     gainers-vs-losers selector; passing `type=gainers` is a 400.
 *   - the chain goes in the `x-chain` HEADER, never in the path. The path form
 *     exists but is WebSocket-only.
 * The address key here is `address`, where the same vendor's other endpoints
 * use `owner` — hence the two-name read below, which is the one place in this
 * file where guessing is warranted, because the inconsistency is the vendor's
 * and it is documented.
 */
export async function fetchBirdeyeGainers(
  key: string,
  deps: SourceDeps,
  opts: { window?: 'today' | 'yesterday' | '1W'; limit?: number } = {},
): Promise<SourceOutcome> {
  const name = 'birdeye/gainers';
  const q = new URLSearchParams({
    type: opts.window ?? 'today',
    sort_by: 'PnL',
    sort_type: 'desc',
    offset: '0',
    limit: String(Math.min(10, opts.limit ?? 10)),
  });
  try {
    const j = await getJson(`https://public-api.birdeye.so/trader/gainers-losers?${q}`,
      { 'X-API-KEY': key, 'x-chain': 'solana' }, deps);
    const rows = j?.data?.items ?? j?.data ?? j?.items;
    if (!Array.isArray(rows)) {
      return { name, ok: false, candidates: [], detail: 'response carried no item list' };
    }
    const candidates: ScoutCandidate[] = [];
    for (const r of rows) {
      const wallet = looksLikeWallet(r?.address) ? r.address : (looksLikeWallet(r?.owner) ? r.owner : null);
      if (!wallet) continue;
      candidates.push({
        wallet,
        sources: [name],
        claimedRealizedSol: undefined,      // this board reports USD, and we rank in SOL
        claimedTrades: num(r?.trade_count) ?? num(r?.tradeCount),
      });
      if (candidates.length >= PER_SOURCE_LIMIT) break;
    }
    if (!candidates.length) {
      return {
        name, ok: false, candidates: [],
        detail: 'no address field found in any row',
        seenKeys: rows.length && rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).slice(0, 25) : [],
      };
    }
    return { name, ok: true, candidates };
  } catch (err: any) {
    return { name, ok: false, candidates: [], detail: String(err?.message ?? err) };
  }
}

/**
 * Every configured source, run independently, merged by wallet.
 *
 * INDEPENDENTLY is load-bearing: one vendor being down, rate-limited or
 * reshaped must not stop the others, and it must not silently reduce the run
 * to "we found nobody today". Each outcome is returned whether it worked or
 * not, and the caller shows all of them.
 */
export async function gatherCandidates(keys: SourceKeys, deps: SourceDeps): Promise<{
  candidates: ScoutCandidate[];
  outcomes: SourceOutcome[];
}> {
  const outcomes: SourceOutcome[] = [];

  if (keys.solanaTracker) {
    // Sequential, not parallel: the free tier is 1 request/second and the two
    // calls share it. Racing them spends the budget on a 429.
    outcomes.push(await fetchSolanaTrackerTop(keys.solanaTracker, deps));
    outcomes.push(await fetchSolanaTrackerKols(keys.solanaTracker, deps));
  } else {
    outcomes.push({
      name: 'solanatracker', ok: false, candidates: [],
      detail: 'no Solana Tracker key set — this is the only free source that ranks wallets by realized profit',
    });
  }

  if (keys.birdeye) {
    outcomes.push(await fetchBirdeyeGainers(keys.birdeye, deps));
  } else {
    outcomes.push({ name: 'birdeye', ok: false, candidates: [], detail: 'no Birdeye key set' });
  }

  const byWallet = new Map<string, ScoutCandidate>();
  for (const o of outcomes) {
    for (const c of o.candidates) {
      const prev = byWallet.get(c.wallet);
      if (!prev) { byWallet.set(c.wallet, { ...c }); continue; }
      for (const s of c.sources) if (!prev.sources.includes(s)) prev.sources.push(s);
      // Keep the first claim seen. These are display-only, and averaging two
      // vendors' disagreeing numbers would produce a figure neither published.
      prev.claimedRealizedSol ??= c.claimedRealizedSol;
      prev.claimedWinRate ??= c.claimedWinRate;
      prev.claimedTrades ??= c.claimedTrades;
      prev.label ??= c.label;
    }
  }
  return { candidates: [...byWallet.values()], outcomes };
}
