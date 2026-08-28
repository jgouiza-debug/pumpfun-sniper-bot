/**
 * Outcome labelling for the candidate corpus.
 *
 * WHY THIS EXISTS: the corpus records what the bot DECIDED and then stops. Nothing
 * records what the token did afterwards, so there is nothing to score a strategy
 * against — a backtest built on this data would have no ground truth and would be
 * scoring the bot against its own opinions.
 *
 * This reads the decision-time snapshot out of a candidates JSONL and asks
 * DexScreener what actually became of each mint. Read-only HTTP. No wallet, no
 * keypair, no transaction, no mainnet funds — it cannot trade and has no code
 * path that could.
 *
 * HONEST SCOPE — read this before using the output as if it were a backtest:
 *
 *   1. The label is the token's state AS OF NOW, not its price at decision+30min.
 *      DexScreener's token endpoint returns current state, not a historical series.
 *      So `returnPct` answers "if you had bought at the decision price and still
 *      held today, where would you be" — a survival/rug label, NOT the return of
 *      the bot's actual 30-minute hold policy. `lagHours` records the gap so no
 *      downstream consumer can forget it.
 *
 *   2. Absence of a pair is itself a label, not a gap. A pump.fun mint that never
 *      graduated has no DexScreener pair, and one whose pool was pulled loses its
 *      pair. Both are recorded as outcome NO_PAIR rather than dropped, because
 *      silently dropping them would bias every base rate upward — the dead tokens
 *      are exactly the ones that disappear.
 *
 *   3. `pairCreatedAt` here is the REAL pair creation timestamp from the indexer.
 *      It is the independent check on the bot's own `pairAgeSeconds`, which the
 *      Phase 1 audit found measures time-since-websocket-message instead.
 *
 * Usage:
 *   ts-node src/research/labelOutcomes.ts <corpus.jsonl> [--creates N] [--out FILE]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import https from 'https';

const DEXSCREENER_BATCH = 30;          // the tokens endpoint accepts up to 30 comma-separated mints
const REQUESTS_PER_SECOND = 4;         // documented limit is 300/min; 240/min leaves headroom
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;

export type OutcomeKind = 'NO_PAIR' | 'ALIVE';

export interface DecisionSnapshot {
  mint: string;
  symbol: string;
  decision: string;
  txType: string;
  activeGate: string;
  /** Engine clock at the moment the decision was taken (ms). */
  decisionAtMs: number;
  decisionPriceUsd: number;
  decisionMarketCapUsd: number;
  decisionLiquidityUsd: number;
  /** True when the liquidity above is the 2*79*solPrice assertion, not a reading. */
  liquidityIsAsserted: boolean;
  gateV1Score: number | null;
  gateV1Safe: boolean | null;
  gateV2Safe: boolean | null;
  priceChange5mPct: number | null;
  buyPressurePct: number | null;
  volume5mUsd: number | null;
  /** The bot's own age figure — audited as unreliable, kept for comparison. */
  reportedPairAgeSeconds: number | null;
  socialCount: number | null;
}

export interface LabelledOutcome extends DecisionSnapshot {
  outcome: OutcomeKind;
  observedAtMs: number;
  lagHours: number;
  outcomePriceUsd: number | null;
  outcomeLiquidityUsd: number | null;
  outcomeFdvUsd: number | null;
  outcomeVolume24hUsd: number | null;
  /**
   * The deepest pool's address. Captured here because DexScreener's limits are
   * generous and GeckoTerminal's are not — carrying the address forward means the
   * OHLCV collector needs one request per token instead of two.
   */
  pairAddress: string | null;
  dexId: string | null;
  /** Indexer's real pair creation time — the check on reportedPairAgeSeconds. */
  truePairCreatedAtMs: number | null;
  /** Buy-at-decision, still-holding-today. NOT the bot's hold policy. See header. */
  returnPct: number | null;
}

/** Pulls the one decision snapshot we keep per mint (the first sighting). */
function toSnapshot(row: any): DecisionSnapshot | null {
  const mint = row?.mint;
  if (typeof mint !== 'string' || !mint) return null;
  const d = row.launchData || {};
  return {
    mint,
    symbol: String(row.symbol ?? ''),
    decision: String(row.decision ?? ''),
    txType: String(row.txType ?? ''),
    activeGate: String(row.activeGate ?? ''),
    decisionAtMs: Number(row.t4DecisionMs ?? row.t1ArrivalMs ?? 0),
    decisionPriceUsd: Number(d.priceUsd ?? 0),
    decisionMarketCapUsd: Number(d.marketCapUsd ?? 0),
    decisionLiquidityUsd: Number(d.liquidityUsd ?? 0),
    liquidityIsAsserted: Boolean(d.liquidityIsAsserted),
    gateV1Score: typeof row.gateV1?.score === 'number' ? row.gateV1.score : null,
    gateV1Safe: typeof row.gateV1?.isSafe === 'boolean' ? row.gateV1.isSafe : null,
    gateV2Safe: typeof row.gateV2?.isSafe === 'boolean' ? row.gateV2.isSafe : null,
    priceChange5mPct: typeof d.priceChange5mPct === 'number' ? d.priceChange5mPct : null,
    buyPressurePct: typeof d.buyPressurePct === 'number' ? d.buyPressurePct : null,
    volume5mUsd: typeof d.volume5mUsd === 'number' ? d.volume5mUsd : null,
    reportedPairAgeSeconds: typeof d.pairAgeSeconds === 'number' ? d.pairAgeSeconds : null,
    socialCount: typeof d.socialCount === 'number' ? d.socialCount : null,
  };
}

export async function readCorpus(
  file: string,
  createSampleSize: number
): Promise<DecisionSnapshot[]> {
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  // Keep the FIRST sighting per mint: that is the decision the bot actually acted
  // on. Later rows for the same mint are re-screens and would leak hindsight.
  const byMint = new Map<string, DecisionSnapshot>();
  const creates: string[] = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    const snap = toSnapshot(row);
    if (!snap || byMint.has(snap.mint)) continue;
    byMint.set(snap.mint, snap);
    if (snap.txType === 'create' && snap.decision === 'rejected') creates.push(snap.mint);
  }

  const keep = new Set<string>();
  for (const [mint, s] of byMint) {
    // Everything interesting, in full: every migration, everything that passed,
    // everything that was bought or attempted.
    if (s.txType === 'migrate') keep.add(mint);
    else if (s.decision !== 'rejected') keep.add(mint);
  }

  // Plus a deterministic sample of rejected creates, for base rates. Deterministic
  // so a re-run labels the SAME tokens — a fresh random sample each run would let
  // anyone quietly reroll until the base rate flattered a strategy.
  const step = Math.max(1, Math.floor(creates.length / Math.max(1, createSampleSize)));
  for (let i = 0; i < creates.length && keep.size < createSampleSize + byMint.size; i += step) {
    keep.add(creates[i]);
  }

  return [...keep].map((m) => byMint.get(m)!).filter(Boolean);
}

function fetchBatch(mints: string[]): Promise<any> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A mint can carry several pairs. Take the deepest one — that is the market a
 * real exit would actually hit, and picking the highest-priced pair instead would
 * flatter every outcome by quoting an empty pool.
 */
function bestPair(pairs: any[]): any | null {
  let best: any = null;
  for (const p of pairs) {
    const liq = Number(p?.liquidity?.usd ?? 0);
    if (!best || liq > Number(best?.liquidity?.usd ?? 0)) best = p;
  }
  return best;
}

export async function labelOutcomes(
  snapshots: DecisionSnapshot[],
  onProgress?: (done: number, total: number) => void
): Promise<LabelledOutcome[]> {
  const out: LabelledOutcome[] = [];
  const byMint = new Map(snapshots.map((s) => [s.mint, s]));
  const batches: string[][] = [];
  const all = [...byMint.keys()];
  for (let i = 0; i < all.length; i += DEXSCREENER_BATCH) {
    batches.push(all.slice(i, i + DEXSCREENER_BATCH));
  }

  const gapMs = Math.ceil(1000 / REQUESTS_PER_SECOND);
  let done = 0;

  for (const batch of batches) {
    let payload: any = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try { payload = await fetchBatch(batch); break; }
      catch { await sleep(gapMs * (attempt + 1) * 3); }
    }

    const observedAtMs = Date.now();
    const found = new Map<string, any>();
    if (payload && Array.isArray(payload.pairs)) {
      const grouped = new Map<string, any[]>();
      for (const p of payload.pairs) {
        const addr = p?.baseToken?.address;
        if (!addr) continue;
        if (!grouped.has(addr)) grouped.set(addr, []);
        grouped.get(addr)!.push(p);
      }
      for (const [addr, list] of grouped) found.set(addr, bestPair(list));
    }

    for (const mint of batch) {
      const snap = byMint.get(mint)!;
      const pair = found.get(mint) || null;
      const lagHours = snap.decisionAtMs > 0
        ? (observedAtMs - snap.decisionAtMs) / 3_600_000
        : 0;

      if (!pair) {
        // No pair today. Either it never graduated or the pool is gone. Recorded,
        // never dropped — see the header note on base-rate bias.
        out.push({
          ...snap,
          outcome: 'NO_PAIR',
          observedAtMs,
          lagHours: Number(lagHours.toFixed(2)),
          outcomePriceUsd: null,
          outcomeLiquidityUsd: null,
          outcomeFdvUsd: null,
          outcomeVolume24hUsd: null,
          pairAddress: null,
          dexId: null,
          truePairCreatedAtMs: null,
          returnPct: null,
        });
        continue;
      }

      const price = Number(pair.priceUsd ?? 0) || null;
      const returnPct = price && snap.decisionPriceUsd > 0
        ? Number((((price - snap.decisionPriceUsd) / snap.decisionPriceUsd) * 100).toFixed(2))
        : null;

      out.push({
        ...snap,
        outcome: 'ALIVE',
        observedAtMs,
        lagHours: Number(lagHours.toFixed(2)),
        outcomePriceUsd: price,
        outcomeLiquidityUsd: Number(pair?.liquidity?.usd ?? 0) || null,
        outcomeFdvUsd: Number(pair?.fdv ?? 0) || null,
        outcomeVolume24hUsd: Number(pair?.volume?.h24 ?? 0) || null,
        pairAddress: String(pair?.pairAddress ?? '') || null,
        dexId: String(pair?.dexId ?? '') || null,
        truePairCreatedAtMs: Number(pair?.pairCreatedAt ?? 0) || null,
        returnPct,
      });
    }

    done += batch.length;
    onProgress?.(done, all.length);
    await sleep(gapMs);
  }

  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const corpus = args[0];
  if (!corpus) {
    console.error('usage: ts-node src/research/labelOutcomes.ts <corpus.jsonl> [--creates N] [--out FILE]');
    process.exit(1);
  }
  const createsIdx = args.indexOf('--creates');
  const createSampleSize = createsIdx >= 0 ? Number(args[createsIdx + 1]) : 2000;
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0
    ? args[outIdx + 1]
    : path.join(path.dirname(corpus), `labelled-${path.basename(corpus)}`);

  console.log(`[label] reading ${corpus}`);
  const snapshots = await readCorpus(corpus, createSampleSize);
  const byType: Record<string, number> = {};
  for (const s of snapshots) byType[`${s.txType}/${s.decision}`] = (byType[`${s.txType}/${s.decision}`] || 0) + 1;
  console.log(`[label] ${snapshots.length} mints selected:`, byType);

  const labelled = await labelOutcomes(snapshots, (d, t) => {
    if (d % 300 === 0 || d === t) console.log(`[label] ${d}/${t}`);
  });

  fs.writeFileSync(outFile, labelled.map((l) => JSON.stringify(l)).join('\n') + '\n');
  console.log(`[label] wrote ${labelled.length} rows to ${outFile}`);

  const alive = labelled.filter((l) => l.outcome === 'ALIVE');
  const noPair = labelled.length - alive.length;
  console.log(`[label] ALIVE ${alive.length} · NO_PAIR ${noPair} (${((noPair / labelled.length) * 100).toFixed(1)}%)`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
