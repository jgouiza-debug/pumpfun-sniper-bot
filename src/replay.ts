/**
 * Offline replay harness.
 *
 * Feeds recorded candidates (reports/candidates-*.jsonl, written by the
 * always-on timeline logger) back through BOTH entry gates deterministically:
 * no network, no wallet, no orders. This is how gate/threshold changes get
 * evaluated before any flag is flipped on live traffic.
 *
 * Usage:
 *   npx ts-node src/replay.ts                 # replay every recorded day
 *   npx ts-node src/replay.ts 2026-08-05      # one day
 *   npx ts-node src/replay.ts --divergences   # only print disagreements
 */
import fs from 'fs';
import path from 'path';
import { RiskFilter } from './filters/riskFilter';
import { EntryGateV2 } from './services/entryGateV2';
import { detectMigration } from './services/pipelineUtils';

const REPORTS_DIR = path.resolve(process.cwd(), 'reports');

interface RecordedCandidate {
  mint: string;
  symbol: string;
  txType?: string;
  payload?: any;
  launchData?: any;
  rug?: any;
  gateV1?: { isSafe: boolean };
  gateV2?: { isSafe: boolean };
  decision?: string;
}

function loadRecords(dayFilter?: string): RecordedCandidate[] {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('candidates-') && f.endsWith('.jsonl'))
    .filter(f => !dayFilter || f.includes(dayFilter))
    .sort();

  const records: RecordedCandidate[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(REPORTS_DIR, file), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { records.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
  }
  return records;
}

function main() {
  const args = process.argv.slice(2);
  const divergencesOnly = args.includes('--divergences');
  const dayFilter = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

  const records = loadRecords(dayFilter);
  if (records.length === 0) {
    console.log('No recorded candidates found in reports/candidates-*.jsonl.');
    console.log('Run the bot (paper is fine) — the timeline logger records every screened token.');
    process.exit(0);
  }

  // Fresh instances so replay reflects CURRENT code and thresholds, not
  // whatever was live when the record was written.
  const legacy = new RiskFilter();
  legacy.setLeniencyMode('strict');
  const v2 = new EntryGateV2();

  let v1Pass = 0, v2Pass = 0, agree = 0, diverge = 0, skipped = 0;
  const v2RejectReasons = new Map<string, number>();

  console.log(`Replaying ${records.length} recorded candidates${dayFilter ? ` from ${dayFilter}` : ''}...\n`);

  for (const rec of records) {
    if (!rec.payload || !rec.launchData) { skipped++; continue; }

    const isMigration = detectMigration(rec.payload, true);
    const v1Result = legacy.evaluateToken(rec.rug ?? null, rec.launchData);
    const v2Result = v2.evaluate(rec.payload, rec.rug ?? null, isMigration);

    if (v1Result.isSafe) v1Pass++;
    if (v2Result.isSafe) v2Pass++;
    if (v1Result.isSafe === v2Result.isSafe) agree++;
    else {
      diverge++;
      const line = `DIVERGE ${rec.symbol.padEnd(8)} ${rec.mint.slice(0, 10)}... ` +
        `legacy=${v1Result.isSafe ? 'PASS' : 'REJECT'} v2=${v2Result.isSafe ? 'PASS' : 'REJECT'} | ` +
        (v2Result.isSafe ? `legacy said: ${v1Result.reasons[0] || '-'}` : `v2 said: ${v2Result.reasons[0] || '-'}`);
      console.log(line);
    }
    if (!v2Result.isSafe) {
      const key = (v2Result.reasons[0] || 'unknown').split('(')[0].trim().slice(0, 60);
      v2RejectReasons.set(key, (v2RejectReasons.get(key) || 0) + 1);
    }
    if (!divergencesOnly && v1Result.isSafe !== v2Result.isSafe) continue;
  }

  const evaluated = records.length - skipped;
  console.log('\n================ REPLAY SUMMARY ================');
  console.log(`Candidates:        ${records.length} (${skipped} skipped: missing payload/launchData)`);
  console.log(`Legacy gate pass:  ${v1Pass}/${evaluated} (${evaluated ? ((v1Pass / evaluated) * 100).toFixed(1) : 0}%)`);
  console.log(`Gate V2 pass:      ${v2Pass}/${evaluated} (${evaluated ? ((v2Pass / evaluated) * 100).toFixed(1) : 0}%)`);
  console.log(`Agreement:         ${agree}/${evaluated} | Divergences: ${diverge}`);
  console.log('\nTop Gate V2 rejection reasons:');
  [...v2RejectReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .forEach(([reason, count]) => console.log(`  ${String(count).padStart(5)}  ${reason}`));
  console.log('================================================');
}

main();
