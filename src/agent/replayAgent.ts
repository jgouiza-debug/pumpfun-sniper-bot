/**
 * Experiment harness — run the model over the recorded candidates corpus.
 *
 * This is where you should spend the first weeks. It replays real historical
 * launches (`reports/candidates-*.jsonl` carries `launchData` + `rug`, which is
 * exactly what the dossier needs) through the full decision path: dossier ->
 * model -> broker. No wallet, no key, no clock, no live feed.
 *
 * What it can tell you:
 *   - what a decision actually costs, measured rather than estimated
 *   - the BUY rate and conviction distribution (a model that buys 60% of a
 *     corpus is not screening, it is agreeing)
 *   - which dossier fields the model cites, from `keyFactors`
 *   - whether two runs over the same rows agree with themselves
 *
 * What it CANNOT tell you: whether the decisions were profitable. That needs
 * forward outcomes joined in from outcomeTracker. Until that corpus exists this
 * harness measures behaviour and cost, not edge — do not read a BUY rate as a
 * result.
 *
 * Usage:
 *   ts-node src/agent/replayAgent.ts reports/candidates-2026-08-10.jsonl --dry
 *   ts-node src/agent/replayAgent.ts reports/candidates-2026-08-10.jsonl --limit 50
 */

import fs from 'fs';
import path from 'path';
import { buildDossier, renderDossier, estimateTokens, TOKEN_BUDGET } from './dossier';
import { decide, AGENT_DEFAULTS, AgentConfig, estimateCostUsd } from './geminiClient';
import { authorize, newBrokerState, recordBuy, BROKER_DEFAULTS } from './broker';
import { policyHash } from './schema';

/** Free tier is 10 RPM on Flash-class models. 6.5s spacing keeps headroom. */
const FREE_TIER_SPACING_MS = 6500;

interface Args {
  file: string;
  dry: boolean;
  limit: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const file = argv[0];
  if (!file) {
    console.error('usage: replayAgent.ts <candidates.jsonl> [--dry] [--limit N] [--out FILE]');
    process.exit(2);
  }
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    file,
    dry: argv.includes('--dry'),
    limit: Number(get('--limit') ?? 0) || Infinity,
    out: get('--out') ?? path.join('reports', `agent-decisions-${Date.now()}.jsonl`),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!args.dry && !apiKey) {
    console.error('GEMINI_API_KEY not set. Use --dry to check dossiers without calling the API.');
    process.exit(2);
  }

  const cfg: AgentConfig = { apiKey, ...AGENT_DEFAULTS };
  const policy = policyHash(cfg.model, cfg.thinkingLevel);
  const state = newBrokerState(new Date().toISOString().slice(0, 10));

  const rows = fs
    .readFileSync(args.file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter((r) => r && r.launchData);

  console.log(`corpus ${rows.length} rows | policy ${policy} | model ${cfg.model}/${cfg.thinkingLevel}`);
  if (args.dry) console.log('DRY RUN — no API calls, no cost');

  const out = fs.createWriteStream(args.out, { flags: 'a' });
  const tally = {
    seen: 0, called: 0, buy: 0, skip: 0, failed: 0, authorized: 0,
    tokensIn: 0, tokensOut: 0, latencies: [] as number[], budgetBusts: 0,
    reasons: {} as Record<string, number>,
    conviction: {} as Record<string, number>,
  };

  for (const row of rows) {
    if (tally.seen >= args.limit) break;
    tally.seen++;

    const isMigration = row.txType === 'migrate';
    const dossier = buildDossier(row.launchData, row.rug ?? null, isMigration);
    const rendered = renderDossier(dossier);
    const est = estimateTokens(rendered);
    if (est > TOKEN_BUDGET) { tally.budgetBusts++; continue; }

    if (args.dry) {
      tally.tokensIn += est;
      continue;
    }

    const t0 = Date.now();
    const decision = await decide(dossier, cfg);
    tally.called++;
    tally.tokensIn += decision.promptTokens;
    tally.tokensOut += decision.outputTokens;
    tally.latencies.push(decision.latencyMs);

    let verdict: any = { authorized: false, reason: 'no_intent' };
    if (decision.intent) {
      if (decision.intent.action === 'BUY') tally.buy++; else tally.skip++;
      tally.conviction[decision.intent.conviction] =
        (tally.conviction[decision.intent.conviction] ?? 0) + 1;
      verdict = authorize(decision.intent, dossier.mint, state, BROKER_DEFAULTS, Date.now());
      if (verdict.authorized) {
        tally.authorized++;
        recordBuy(state, verdict.mint, verdict.sizeSol, Date.now());
      } else {
        tally.reasons[verdict.reason] = (tally.reasons[verdict.reason] ?? 0) + 1;
      }
    } else {
      tally.failed++;
      tally.reasons[decision.failure ?? 'unknown'] =
        (tally.reasons[decision.failure ?? 'unknown'] ?? 0) + 1;
    }

    out.write(JSON.stringify({
      mint: dossier.mint,
      policy,
      model: decision.model,
      historicalDecision: row.decision,
      intent: decision.intent,
      failure: decision.failure,
      verdict,
      latencyMs: decision.latencyMs,
      promptTokens: decision.promptTokens,
      outputTokens: decision.outputTokens,
      unverifiedCount: dossier.unverified.length,
      replayedAtMs: t0,
    }) + '\n');

    const elapsed = Date.now() - t0;
    if (elapsed < FREE_TIER_SPACING_MS) await sleep(FREE_TIER_SPACING_MS - elapsed);
  }

  out.end();
  const lat = tally.latencies.sort((a, b) => a - b);
  const p = (q: number) => (lat.length ? lat[Math.floor(lat.length * q)] : 0);

  console.log('\n--- replay summary ---');
  console.log(`seen ${tally.seen} | called ${tally.called} | budget busts ${tally.budgetBusts}`);
  if (args.dry) {
    console.log(`mean dossier ${Math.round(tally.tokensIn / Math.max(1, tally.seen))} tokens (budget ${TOKEN_BUDGET})`);
    console.log(`projected input cost for full corpus: $${estimateCostUsd(tally.tokensIn, 0).toFixed(4)}`);
  } else {
    console.log(`BUY ${tally.buy} | SKIP ${tally.skip} | failed ${tally.failed}`);
    console.log(`buy rate ${((100 * tally.buy) / Math.max(1, tally.buy + tally.skip)).toFixed(1)}%`);
    console.log(`conviction ${JSON.stringify(tally.conviction)}`);
    console.log(`broker authorized ${tally.authorized} | blocked ${JSON.stringify(tally.reasons)}`);
    console.log(`latency p50 ${p(0.5)}ms p90 ${p(0.9)}ms`);
    console.log(`tokens in ${tally.tokensIn} out ${tally.tokensOut}`);
    console.log(`measured cost $${estimateCostUsd(tally.tokensIn, tally.tokensOut).toFixed(4)} over ${tally.called} calls`);
    console.log(`=> $${(estimateCostUsd(tally.tokensIn, tally.tokensOut) / Math.max(1, tally.called)).toFixed(5)} per decision`);
  }
  console.log(`decisions -> ${args.out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
