/**
 * Forward-outcome tracker — the measurement the pipeline has never had.
 *
 * THE GAP THIS CLOSES: the candidates corpus records what the bot DECIDED and
 * then stops. Nothing records what the token did next. So the screening rules
 * have never been scored: a rule that rejects 88% of the funnel might be saving
 * the wallet from 88% rugs or throwing away every winner, and the existing data
 * cannot tell those apart. Phase 1 found 70 `passed_no_buy` rows carrying no
 * reason at all.
 *
 * This follows a live candidates JSONL and samples each mint forward on a fixed
 * schedule, writing an outcome record per sample. Rejections are tracked exactly
 * as carefully as entries — that is the whole point. Scoring only the trades you
 * took tells you nothing about the trades you refused.
 *
 * SAFETY: read-only. HTTP GETs against a public price indexer, plus reading a log
 * file the bot already writes. No wallet, no keypair, no RPC write, no import of
 * the execution path. It cannot place or cancel an order, and it runs as a
 * separate process so it cannot destabilise the trading engine.
 *
 * SAVE-TO-MISS: for every rejection reason, the report counts how often that
 * reason rejected a token that subsequently died (a SAVE) versus one that
 * subsequently ran (a MISS). A rule with a poor ratio is costing money, and until
 * now there was no way to know which rules those were.
 *
 * Usage:
 *   ts-node src/research/outcomeTracker.ts <candidates.jsonl> [--out FILE] [--poll-ms N]
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

/** Minutes after the decision at which we take a reading. */
export const SAMPLE_SCHEDULE_MIN = [5, 15, 30, 60, 180, 360, 1440];

const DEXSCREENER_BATCH = 30;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 30_000;
/** Stop tracking a mint once the last scheduled sample is taken. */
const MAX_TRACK_MIN = SAMPLE_SCHEDULE_MIN[SAMPLE_SCHEDULE_MIN.length - 1];

export interface TrackedCandidate {
  mint: string;
  symbol: string;
  decision: string;
  txType: string;
  /** Populated for rejects; this is what save-to-miss is computed per. */
  reasons: string[];
  decisionAtMs: number;
  decisionPriceUsd: number;
  decisionMarketCapUsd: number;
  /** Which scheduled samples have already been written. */
  taken: Set<number>;
}

export interface OutcomeSample {
  mint: string;
  symbol: string;
  decision: string;
  txType: string;
  reasons: string[];
  decisionAtMs: number;
  decisionPriceUsd: number;
  decisionMarketCapUsd: number;
  sampleAtMin: number;
  sampledAtMs: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  hasPair: boolean;
  /** Null when the decision-time price was missing — recorded, never invented. */
  returnPct: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fetchTokens(mints: string[]): Promise<any> {
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
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Deepest pool — the market an exit would actually hit. */
function bestPair(pairs: any[]): any | null {
  let best: any = null;
  for (const p of pairs) {
    if (!best || Number(p?.liquidity?.usd ?? 0) > Number(best?.liquidity?.usd ?? 0)) best = p;
  }
  return best;
}

export function extractReasons(row: any): string[] {
  const v2 = row?.gateV2?.reasons;
  if (Array.isArray(v2) && v2.length) return v2.map(String);
  const v1 = row?.gateV1?.reasons;
  if (Array.isArray(v1) && v1.length) return v1.map(String);
  return [];
}

/** Strips embedded numbers so "Top 10 holders 41%" and "...38%" group together. */
export function normaliseReason(reason: string): string {
  return String(reason).replace(/[0-9][0-9.,]*/g, 'N').trim();
}

export class OutcomeTracker {
  private tracked = new Map<string, TrackedCandidate>();
  private out: fs.WriteStream;

  constructor(outFile: string) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    this.out = fs.createWriteStream(outFile, { flags: 'a' });
  }

  register(row: any): void {
    const mint = row?.mint;
    if (typeof mint !== 'string' || !mint || this.tracked.has(mint)) return;
    const d = row.launchData || {};
    const decisionAtMs = Number(row.t4DecisionMs ?? row.t1ArrivalMs ?? Date.now());
    this.tracked.set(mint, {
      mint,
      symbol: String(row.symbol ?? ''),
      decision: String(row.decision ?? ''),
      txType: String(row.txType ?? ''),
      reasons: extractReasons(row),
      decisionAtMs,
      decisionPriceUsd: Number(d.priceUsd ?? 0),
      decisionMarketCapUsd: Number(d.marketCapUsd ?? 0),
      taken: new Set(),
    });
  }

  /** Mints with a scheduled sample now due. */
  private due(now: number): Array<{ c: TrackedCandidate; atMin: number }> {
    const out: Array<{ c: TrackedCandidate; atMin: number }> = [];
    for (const c of this.tracked.values()) {
      const ageMin = (now - c.decisionAtMs) / 60_000;
      for (const s of SAMPLE_SCHEDULE_MIN) {
        if (ageMin >= s && !c.taken.has(s)) { out.push({ c, atMin: s }); break; }
      }
    }
    return out;
  }

  private retire(now: number): void {
    for (const [mint, c] of this.tracked) {
      if ((now - c.decisionAtMs) / 60_000 > MAX_TRACK_MIN + 5) this.tracked.delete(mint);
    }
  }

  async tick(): Promise<number> {
    const now = Date.now();
    const due = this.due(now);
    if (!due.length) { this.retire(now); return 0; }

    let written = 0;
    for (let i = 0; i < due.length; i += DEXSCREENER_BATCH) {
      const slice = due.slice(i, i + DEXSCREENER_BATCH);
      let payload: any = null;
      try { payload = await fetchTokens(slice.map((s) => s.c.mint)); } catch { /* recorded as no-pair below */ }

      const found = new Map<string, any>();
      if (payload && Array.isArray(payload.pairs)) {
        const grouped = new Map<string, any[]>();
        for (const p of payload.pairs) {
          const a = p?.baseToken?.address;
          if (!a) continue;
          if (!grouped.has(a)) grouped.set(a, []);
          grouped.get(a)!.push(p);
        }
        for (const [a, list] of grouped) found.set(a, bestPair(list));
      }

      const sampledAtMs = Date.now();
      for (const { c, atMin } of slice) {
        const pair = found.get(c.mint) || null;
        const price = pair ? Number(pair.priceUsd ?? 0) || null : null;
        const sample: OutcomeSample = {
          mint: c.mint, symbol: c.symbol, decision: c.decision, txType: c.txType,
          reasons: c.reasons,
          decisionAtMs: c.decisionAtMs,
          decisionPriceUsd: c.decisionPriceUsd,
          decisionMarketCapUsd: c.decisionMarketCapUsd,
          sampleAtMin: atMin,
          sampledAtMs,
          priceUsd: price,
          liquidityUsd: pair ? Number(pair?.liquidity?.usd ?? 0) || null : null,
          fdvUsd: pair ? Number(pair?.fdv ?? 0) || null : null,
          volume24hUsd: pair ? Number(pair?.volume?.h24 ?? 0) || null : null,
          hasPair: Boolean(pair),
          returnPct: price && c.decisionPriceUsd > 0
            ? Number((((price - c.decisionPriceUsd) / c.decisionPriceUsd) * 100).toFixed(2))
            : null,
        };
        this.out.write(JSON.stringify(sample) + '\n');
        c.taken.add(atMin);
        written++;
      }
      await sleep(300);
    }

    this.retire(now);
    return written;
  }

  size(): number { return this.tracked.size; }
}

/**
 * Follows a JSONL file that is still being appended to, replaying what is already
 * there and then streaming new lines. Survives the writer truncating or rotating.
 */
export async function follow(
  file: string,
  onLine: (row: any) => void,
  onIdle: () => Promise<void>,
  pollMs: number
): Promise<void> {
  let offset = 0;
  let carry = '';

  for (;;) {
    try {
      const stat = fs.statSync(file);
      if (stat.size < offset) { offset = 0; carry = ''; }   // rotated or truncated
      if (stat.size > offset) {
        const fd = fs.openSync(file, 'r');
        const len = stat.size - offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        fs.closeSync(fd);
        offset = stat.size;
        const text = carry + buf.toString('utf8');
        const lines = text.split('\n');
        carry = lines.pop() ?? '';
        for (const l of lines) {
          if (!l.trim()) continue;
          try { onLine(JSON.parse(l)); } catch { /* partial or malformed line */ }
        }
      }
    } catch { /* file not created yet — keep waiting */ }

    await onIdle();
    await sleep(pollMs);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const corpus = args[0];
  if (!corpus) {
    console.error('usage: ts-node src/research/outcomeTracker.ts <candidates.jsonl> [--out FILE] [--poll-ms N]');
    process.exit(1);
  }
  const outIdx = args.indexOf('--out');
  const day = new Date().toISOString().slice(0, 10);
  const outFile = outIdx >= 0 ? args[outIdx + 1] : path.join('reports', `outcomes-${day}.jsonl`);
  const pollIdx = args.indexOf('--poll-ms');
  const pollMs = pollIdx >= 0 ? Number(args[pollIdx + 1]) : DEFAULT_POLL_MS;

  const tracker = new OutcomeTracker(outFile);
  console.log(`[outcomes] following ${corpus}`);
  console.log(`[outcomes] writing   ${outFile}`);
  console.log(`[outcomes] schedule  ${SAMPLE_SCHEDULE_MIN.join('m, ')}m after each decision`);
  console.log('[outcomes] read-only: no wallet, no keypair, no transaction path');

  let totalWritten = 0;
  await follow(
    corpus,
    (row) => tracker.register(row),
    async () => {
      const n = await tracker.tick();
      if (n) {
        totalWritten += n;
        console.log(`[outcomes] +${n} samples (tracking ${tracker.size()}, total ${totalWritten})`);
      }
    },
    pollMs
  );
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
