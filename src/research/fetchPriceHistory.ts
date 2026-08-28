/**
 * Historical price-path collection for the backtest harness.
 *
 * WHY: outcome labels ("where is this token now") answer survival but cannot
 * evaluate a HOLD POLICY. To ask "what would a 30-minute time stop have returned"
 * you need the price path between entry and exit, minute by minute. This fetches
 * that path from GeckoTerminal, which publishes OHLCV aggregated from real on-chain
 * DEX trades — real historical chain data, not a synthetic random walk.
 *
 * Read-only HTTP. No wallet, no keypair, no transaction. Cannot trade.
 *
 * HONEST SCOPE:
 *
 *   1. Minute candles are an AGGREGATE of real trades, not the trade stream. Within
 *      a candle we know open/high/low/close and total volume, not sequence. Any
 *      backtest built on this must therefore make a stated intra-candle assumption
 *      rather than pretending to tick resolution — see backtest.ts, which fills
 *      pessimistically and says so.
 *
 *   2. Candles exist only from POOL CREATION. A pump.fun token that never graduated
 *      has no pool and therefore no path, which is itself information: it never had
 *      a market to exit into.
 *
 *   3. Volume is quote-currency volume for the candle. It bounds how much could
 *      have traded, which is what the slippage model needs, but it is not pool
 *      depth. Depth is inferred separately from reserves where available.
 *
 *   4. GeckoTerminal's free tier is rate limited (~30 requests/minute). This paces
 *      itself accordingly and caches every response to disk, so a re-run costs
 *      nothing and the dataset is reproducible rather than re-fetched.
 *
 * Usage:
 *   ts-node src/research/fetchPriceHistory.ts <labelled.jsonl> [--out DIR] [--max N]
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

const API = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';
// MEASURED, not documented. The published figure is ~30/min; in practice an
// unauthenticated caller gets 429s well below that and then stays penalised for
// a while. Start conservative and let the pacer adapt from observed responses
// rather than from the docs.
let gapMs = 8_500;
const GAP_MIN_MS = 6_000;
const GAP_MAX_MS = 30_000;
const RATE_LIMIT_PENALTY_MS = 60_000;
const CANDLE_LIMIT = 1000;                   // max the endpoint returns per call
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 20_000;

export interface Candle {
  /** Unix seconds, candle open. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Quote-currency volume for the candle. */
  v: number;
}

export interface PricePath {
  mint: string;
  symbol: string;
  poolAddress: string | null;
  dexId: string | null;
  poolCreatedAtMs: number | null;
  decisionAtMs: number;
  /** Ascending by time. Empty when the token never had a pool. */
  candles: Candle[];
  note: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function get(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { accept: 'application/json' }, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('429'));
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * Adaptive pacing. A 429 both sleeps out the penalty AND widens the standing gap,
 * because being throttled means the current pace is wrong, not just that this one
 * request was unlucky. Sustained success narrows it again, slowly.
 */
async function getWithRetry(url: string): Promise<any | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const r = await get(url);
      gapMs = Math.max(GAP_MIN_MS, gapMs - 250);
      return r;
    } catch (e: any) {
      if (e?.message === '429') {
        gapMs = Math.min(GAP_MAX_MS, Math.ceil(gapMs * 1.5));
        await sleep(RATE_LIMIT_PENALTY_MS);
      } else {
        await sleep(gapMs * (attempt + 1));
      }
    }
  }
  return null;
}

/** Deepest pool wins — that is the market an exit would actually hit. */
async function resolvePool(mint: string): Promise<{ address: string; dexId: string; createdAtMs: number } | null> {
  const j = await getWithRetry(`${API}/networks/${NETWORK}/tokens/${mint}/pools`);
  const list = j?.data;
  if (!Array.isArray(list) || !list.length) return null;
  let best: any = null;
  let bestLiq = -1;
  for (const p of list) {
    const liq = Number(p?.attributes?.reserve_in_usd ?? 0);
    if (liq > bestLiq) { bestLiq = liq; best = p; }
  }
  if (!best) return null;
  const created = best?.attributes?.pool_created_at;
  return {
    address: String(best.attributes.address),
    dexId: String(best?.relationships?.dex?.data?.id ?? ''),
    createdAtMs: created ? new Date(created).getTime() : 0,
  };
}

/**
 * Walks BACKWARD from `untilMs` in pages until we reach `fromMs` or the data runs
 * out. The endpoint is before-timestamp paginated, so this is the only direction
 * available; results are reversed to ascending at the end.
 */
async function fetchCandles(pool: string, fromMs: number, untilMs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let before = Math.floor(untilMs / 1000);
  const fromSec = Math.floor(fromMs / 1000);

  for (let page = 0; page < 12; page++) {
    const url = `${API}/networks/${NETWORK}/pools/${pool}/ohlcv/minute`
      + `?aggregate=1&before_timestamp=${before}&limit=${CANDLE_LIMIT}&currency=usd`;
    const j = await getWithRetry(url);
    const list = j?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list) || !list.length) break;

    for (const row of list) {
      const [t, o, h, l, c, v] = row;
      out.push({ t: Number(t), o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) });
    }

    const oldest = Number(list[list.length - 1][0]);
    if (oldest <= fromSec) break;
    if (list.length < CANDLE_LIMIT) break;   // no more history
    before = oldest;
    await sleep(gapMs);
  }

  out.sort((a, b) => a.t - b.t);
  // Trim to the window we asked for, keeping one candle of lead-in.
  return out.filter((c) => c.t >= fromSec - 60);
}

export async function collect(
  targets: Array<{ mint: string; symbol: string; decisionAtMs: number; knownPool?: string | null; knownDex?: string | null }>,
  outDir: string,
  onProgress?: (done: number, total: number, note: string) => void
): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  let done = 0;

  for (const t of targets) {
    const cacheFile = path.join(outDir, `${t.mint}.json`);
    if (fs.existsSync(cacheFile)) {
      done++;
      onProgress?.(done, targets.length, 'cached');
      continue;
    }

    let record: PricePath;
    // DexScreener already gave us the pool for tokens it still lists, and its
    // limits are generous where GeckoTerminal's are not. Reuse that address and
    // spend the scarce request on candles instead of rediscovery.
    const pool = t.knownPool
      ? { address: t.knownPool, dexId: t.knownDex || '', createdAtMs: 0 }
      : await resolvePool(t.mint);
    if (!t.knownPool) await sleep(gapMs);

    if (!pool) {
      record = {
        mint: t.mint, symbol: t.symbol, poolAddress: null, dexId: null,
        poolCreatedAtMs: null, decisionAtMs: t.decisionAtMs, candles: [],
        note: 'no pool — never had a market to exit into',
      };
    } else {
      // 12 hours forward fits inside ONE 1000-candle page, so the common case is
      // a single request. 48h forced three pages and spent two of them on data
      // past any hold policy we would consider.
      const candles = await fetchCandles(pool.address, t.decisionAtMs, t.decisionAtMs + 12 * 3600_000);
      record = {
        mint: t.mint, symbol: t.symbol,
        poolAddress: pool.address, dexId: pool.dexId,
        poolCreatedAtMs: pool.createdAtMs || null,
        decisionAtMs: t.decisionAtMs,
        candles,
        note: candles.length ? `${candles.length} minute candles` : 'pool exists but no candles in window',
      };
      await sleep(gapMs);
    }

    fs.writeFileSync(cacheFile, JSON.stringify(record));
    done++;
    onProgress?.(done, targets.length, record.note);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const labelled = args[0];
  if (!labelled) {
    console.error('usage: ts-node src/research/fetchPriceHistory.ts <labelled.jsonl> [--out DIR] [--max N]');
    process.exit(1);
  }
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : path.join('reports', 'pricepaths');
  const maxIdx = args.indexOf('--max');
  const max = maxIdx >= 0 ? Number(args[maxIdx + 1]) : Infinity;

  // Accepts several labelled files so one run can cover every corpus day. Later
  // files never overwrite an earlier mint — the first sighting wins, same rule
  // the labeller uses.
  const files = labelled.split(',').map((f) => f.trim()).filter(Boolean);
  const seen = new Set<string>();
  const targets: Array<{ mint: string; symbol: string; decisionAtMs: number; knownPool: string | null; knownDex: string | null }> = [];

  for (const file of files) {
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    for (const r of rows) {
      // Migrations only: the only population this bot has ever traded.
      if (r.txType !== 'migrate' || !(r.decisionAtMs > 0)) continue;
      if (seen.has(r.mint)) continue;
      seen.add(r.mint);
      targets.push({
        mint: r.mint, symbol: r.symbol, decisionAtMs: r.decisionAtMs,
        knownPool: r.pairAddress ?? null, knownDex: r.dexId ?? null,
      });
    }
  }

  const withPool = targets.filter((t) => t.knownPool).length;
  const slice = targets.slice(0, max);
  console.log(`[paths] ${slice.length} migration candidates from ${files.length} corpus file(s) -> ${outDir}`);
  console.log(`[paths] ${withPool} already carry a pool address (1 request); the rest need resolution first (2 requests)`);
  console.log('[paths] pacing adapts from observed 429s; this is a long job — it caches, so it can be resumed');

  await collect(slice, outDir, (d, t, note) => {
    if (d % 10 === 0 || d === t) console.log(`[paths] ${d}/${t} — ${note}`);
  });

  const written = fs.readdirSync(outDir).filter((f) => f.endsWith('.json'));
  let withCandles = 0, totalCandles = 0;
  for (const f of written) {
    const r = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
    if (r.candles?.length) { withCandles++; totalCandles += r.candles.length; }
  }
  console.log(`[paths] done: ${written.length} records, ${withCandles} with a usable path, ${totalCandles} candles total`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
