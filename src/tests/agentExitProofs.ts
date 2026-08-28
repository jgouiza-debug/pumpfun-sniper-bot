/**
 * Guardrail proofs for the agent exit ladder.
 *
 * PROOF 1 is the one that matters: the owner's constraint is that no automatic
 * sell may be triggered by price alone. This drives a monotonically falling
 * price from entry to -95%, across every shape, with every sensor silent, and
 * asserts nextExitAction returns null at every step. If someone ever adds a
 * stop-loss, this fails.
 */
import {
  nextExitAction, applyExit, rungIndexFor, LADDERS, EXIT_DEFAULTS,
  NO_EVIDENCE, PositionLedger, ExitShape, ExitConfig,
} from '../agent/exitLadder';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) { failures++; console.log(`  FAIL  ${name} ${detail}`); }
  else console.log(`  ok    ${name}`);
}

function ledger(shape: ExitShape, entry = 0.001, ageMs = 0): PositionLedger {
  return {
    positionId: 'p1', mint: 'M', shape, conviction: 'MEDIUM',
    entryPriceUsd: entry, entryAtMs: 1_000_000 - ageMs,
    remainingFraction: 1, rungsTaken: [], curveDrainScaleTaken: false, redCount: 0,
  };
}
const NOW = 1_000_000;

console.log('\nPROOF 1 — falling price with no evidence never sells');
for (const shape of ['SCALP','BALANCED','RUNNER'] as ExitShape[]) {
  const L = ledger(shape);
  let fired: string | null = null;
  for (let pct = 100; pct >= 5; pct--) {
    const price = L.entryPriceUsd * (pct / 100);
    const a = nextExitAction(L, price, NO_EVIDENCE, EXIT_DEFAULTS, NOW);
    if (a) { fired = `${a.trigger} at ${pct}% of entry`; break; }
  }
  check(`${shape}: no action from entry to -95%`, fired === null, fired ?? '');
}

console.log('\nPROOF 2 — rungs are upside-only and latched');
{
  const L = ledger('BALANCED');
  const up = L.entryPriceUsd * 2.0;
  const a1 = nextExitAction(L, up, NO_EVIDENCE, EXIT_DEFAULTS, NOW);
  check('rung 1 fires at 2x', a1?.trigger === 'AGENT_RUNG', JSON.stringify(a1));
  if (a1) applyExit(L, a1, rungIndexFor(ledger('BALANCED'), up));
  const a2 = nextExitAction(L, up, NO_EVIDENCE, EXIT_DEFAULTS, NOW);
  check('rung 1 does not re-fire at same price', a2 === null, JSON.stringify(a2));
  const a3 = nextExitAction(L, L.entryPriceUsd * 0.5, NO_EVIDENCE, EXIT_DEFAULTS, NOW);
  check('round trip back down sells nothing', a3 === null, JSON.stringify(a3));
}

console.log('\nPROOF 3 — moonbag floor is never breached');
for (const shape of ['SCALP','BALANCED','RUNNER'] as ExitShape[]) {
  const L = ledger(shape);
  for (let i = 0; i < 10; i++) {
    const a = nextExitAction(L, L.entryPriceUsd * 100, NO_EVIDENCE, EXIT_DEFAULTS, NOW);
    if (!a || a.trigger !== 'AGENT_RUNG') break;
    applyExit(L, a, rungIndexFor({ ...L, rungsTaken: L.rungsTaken }, L.entryPriceUsd * 100));
  }
  check(`${shape}: remaining >= moonbag floor`,
    L.remainingFraction >= EXIT_DEFAULTS.moonbagFloor - 1e-9,
    `remaining=${L.remainingFraction.toFixed(3)}`);
}

console.log('\nPROOF 4 — null sensors are never read as verdicts');
{
  const L = ledger('BALANCED');
  const allNull = nextExitAction(L, L.entryPriceUsd, NO_EVIDENCE, EXIT_DEFAULTS, NOW);
  check('all-null evidence produces no action', allNull === null, JSON.stringify(allNull));
  const allFalse = nextExitAction(L, L.entryPriceUsd,
    { sellPathReverts: false, authorityRegained: false, poolDrained: false, curveDrained: false, devSold: false },
    EXIT_DEFAULTS, NOW);
  check('all-false evidence produces no action', allFalse === null, JSON.stringify(allFalse));
}

console.log('\nPROOF 5 — RED evidence outranks profit and forces');
{
  const L = ledger('BALANCED');
  const a = nextExitAction(L, L.entryPriceUsd * 10, { ...NO_EVIDENCE, sellPathReverts: true }, EXIT_DEFAULTS, NOW);
  check('honeypot closes even at 10x', a?.kind === 'CLOSE' && a.trigger === 'AGENT_HONEYPOT');
  check('RED action carries force=true', a?.force === true);
}

console.log('\nPROOF 6 — curve drain scales once, escalates only on a distinct second red');
{
  const L = ledger('BALANCED');
  const a1 = nextExitAction(L, L.entryPriceUsd, { ...NO_EVIDENCE, curveDrained: true }, EXIT_DEFAULTS, NOW);
  check('first trip scales, not closes', a1?.kind === 'SCALE' && a1.pct === 0.5, JSON.stringify(a1));
  if (a1) applyExit(L, a1);
  const a2 = nextExitAction(L, L.entryPriceUsd, { ...NO_EVIDENCE, curveDrained: true }, EXIT_DEFAULTS, NOW);
  check('second trip alone does nothing', a2 === null, JSON.stringify(a2));
  L.redCount = 2;
  const a3 = nextExitAction(L, L.entryPriceUsd, { ...NO_EVIDENCE, curveDrained: true }, EXIT_DEFAULTS, NOW);
  check('escalates once a distinct second red is counted', a3?.kind === 'CLOSE', JSON.stringify(a3));
}

console.log('\nPROOF 7 — every trigger has a toggle that silences it');
{
  const allOff: ExitConfig = {
    ...EXIT_DEFAULTS,
    honeypotExit: false, authorityExit: false, poolDrainExit: false,
    curveDrainScale: false, devSellExit: false, profitRungs: false, maxHoldExit: false,
  };
  const L = ledger('BALANCED', 0.001, 99 * 3_600_000);
  const a = nextExitAction(L, L.entryPriceUsd * 50,
    { sellPathReverts: true, authorityRegained: true, poolDrained: true, curveDrained: true, devSold: true },
    allOff, NOW);
  check('all toggles off => no action under any evidence', a === null, JSON.stringify(a));
}

console.log(`\n${failures === 0 ? 'ALL PROOFS PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
