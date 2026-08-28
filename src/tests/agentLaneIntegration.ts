/**
 * Integration proof: a position's whole life through the real modules —
 * PaperPort fills, EvidenceSensors state, exit ladder decisions — with a
 * scripted market. No network, no API key, no engine.
 */
import { PaperPort } from '../agent/executionPort';
import { EvidenceSensors } from '../agent/evidenceSensors';
import { nextExitAction, applyExit, rungIndexFor, EXIT_DEFAULTS, PositionLedger, countReds } from '../agent/exitLadder';
import { authorize, newBrokerState, recordBuy, BROKER_DEFAULTS } from '../agent/broker';

let fails = 0;
const check = (n: string, ok: boolean, d = '') => { if (!ok) { fails++; console.log(`  FAIL ${n} ${d}`); } else console.log(`  ok   ${n}`); };

async function main() {
const SOL_USD = 200;
const MINT = 'ProofMint111111111111111111111111111111pump';

// --- 1. Broker authorizes a synthetic BUY intent; port fills it on the curve ---
const broker = newBrokerState('2026-08-28');
const verdict = authorize(
  { action: 'BUY', mint: MINT, conviction: 'MEDIUM', exitShape: 'BALANCED', rationale: 't', keyFactors: [] },
  MINT, broker, BROKER_DEFAULTS, Date.now()
);
check('broker authorizes offered mint', verdict.authorized === true);
if (!verdict.authorized) return finish();

const port = new PaperPort(1.0);
let vSol = 32, vTok = 1_006_000_000;
const fill = await port.buy(MINT, verdict.sizeSol, { vSolInBondingCurve: vSol, vTokensInBondingCurve: vTok }, SOL_USD);
check('paper buy fills with real costs', fill.ok && (fill.feeSol ?? 0) > 0 && (fill.solDelta ?? 0) < 0, JSON.stringify(fill));
check('bankroll debited', port.bankrollSol() < 1.0);
recordBuy(broker, MINT, verdict.sizeSol, Date.now());

const entryPriceUsd = fill.effectivePriceUsd!;
const ledger: PositionLedger = {
  positionId: 'p', mint: MINT, shape: 'BALANCED', conviction: 'MEDIUM',
  entryPriceUsd, entryAtMs: Date.now(), remainingFraction: 1,
  rungsTaken: [], curveDrainScaleTaken: false, redCount: 0,
};

// --- 2. Sensors armed; curve pumps; rung 1 fires at 2x and fills through the port ---
const sensors = new EvidenceSensors();
sensors.arm(MINT, { creator: 'Dev1111', entryMintRevoked: true, entryFreezeRevoked: true, vSol, vTokens: vTok });

// Pump the curve: buys push vSol up (constant product: k = vSol*vTok).
const k = vSol * vTok;
vSol = 54; vTok = k / vSol; // ~2.85x spot = ~2.4x the EFFECTIVE entry (fill includes impact+fees)
sensors.onTrade({ mint: MINT, txType: 'buy', traderPublicKey: 'Whale', vSolInBondingCurve: vSol, vTokensInBondingCurve: vTok });
const mark1 = sensors.mark(MINT)!;
const price1 = (mark1.pool.vSolInBondingCurve! / mark1.pool.vTokensInBondingCurve!) * SOL_USD;
check('price mark >2x effective entry', price1 / entryPriceUsd > 2.0, (price1 / entryPriceUsd).toFixed(2));

const a1 = nextExitAction(ledger, price1, sensors.evidence(MINT), EXIT_DEFAULTS, Date.now());
check('rung 1 fires at ~2x', a1?.trigger === 'AGENT_RUNG' && a1.kind === 'SCALE', JSON.stringify(a1));
if (a1) {
  const sellFill = await port.sell(MINT, a1.pct / ledger.remainingFraction, mark1.pool, SOL_USD);
  check('rung sell fills with proceeds', sellFill.ok && (sellFill.solDelta ?? 0) > 0);
  applyExit(ledger, a1, rungIndexFor(ledger, price1));
  check('ledger latched rung', ledger.rungsTaken.length === 1 && ledger.remainingFraction < 1);
}

// --- 3. Dev dumps; curve drains; evidence goes RED; ladder scales then closes on 2nd red ---
vSol = 36; vTok = k / vSol;
sensors.onTrade({ mint: MINT, txType: 'sell', traderPublicKey: 'Dev1111', vSolInBondingCurve: vSol, vTokensInBondingCurve: vTok });
vSol = 32.2; vTok = k / vSol; // real SOL 2.2 vs peak 16 -> drained
sensors.onTrade({ mint: MINT, txType: 'sell', traderPublicKey: 'Other', vSolInBondingCurve: vSol, vTokensInBondingCurve: vTok });

const ev = sensors.evidence(MINT);
check('devSold latched TRUE', ev.devSold === true);
check('curveDrained TRUE after drain from peak', ev.curveDrained === true, JSON.stringify(ev));
check('unreported sensors are null, not false', ev.sellPathReverts === null && ev.poolDrained === null);

ledger.redCount = countReds(ev);
const price2 = (vSol / vTok) * SOL_USD;
// devSellExit defaults OFF (owner constraint) — so the acting trigger must be curve drain SCALE.
const a2 = nextExitAction(ledger, price2, ev, EXIT_DEFAULTS, Date.now());
check('dev-sell exit stays OFF by default; curve drain scales instead',
  a2?.trigger === 'AGENT_CURVE_DRAIN' && a2.kind === 'SCALE', JSON.stringify(a2));
if (a2) { applyExit(ledger, a2); }

// A second structurally distinct red (honeypot) escalates to CLOSE.
sensors.onSellSim(MINT, true);
const ev2 = sensors.evidence(MINT);
ledger.redCount = countReds(ev2);
const a3 = nextExitAction(ledger, price2, ev2, EXIT_DEFAULTS, Date.now());
check('honeypot RED closes the remainder, forced', a3?.kind === 'CLOSE' && a3.force === true, JSON.stringify(a3));
if (a3) {
  const closeFill = await port.sell(MINT, 1, sensors.mark(MINT)!.pool, SOL_USD);
  check('close fills', closeFill.ok === true);
  applyExit(ledger, a3);
}
check('position fully unwound', ledger.remainingFraction <= 1e-9 && port.tokensHeld(MINT) === 0);

// --- 4. The economics are honest: full cycle P&L reflects fees + impact, not fantasy ---
const pnl = port.bankrollSol() - 1.0;
console.log(`  info paper cycle P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(5)} SOL (entry 2x rung banked, rest exited into drain)`);
check('bankroll changed by a plausible amount', Math.abs(pnl) < 0.05, pnl.toFixed(5));

finish();
}
function finish() {
  console.log(`\n${fails === 0 ? 'ALL INTEGRATION PROOFS PASS' : `${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
