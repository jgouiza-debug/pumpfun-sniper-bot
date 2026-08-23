/**
 * FILTER PROOFS — every screening rule, fed a known-bad token, with the actual
 * rejection printed.
 *
 * Standing rule for this file: a filter with no passing test does not exist.
 * The point is not coverage percentage, it is that each rule is demonstrated to
 * FIRE on input it is supposed to catch, and the rejection string it produces is
 * shown rather than described.
 *
 * Run: ts-node src/tests/filterProofs.ts
 *
 * Read-only. Constructs in-memory account buffers and calls pure evaluation
 * functions. No RPC, no wallet, no network, no transaction.
 */

import assert from 'assert';
import { EntryGateV2 } from '../services/entryGateV2';
import { inspectMintSafety, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../services/honeypotDetector';

let passed = 0;
let failed = 0;
const missing: string[] = [];

function proof(filter: string, badInput: string, fn: () => string[] | Promise<string[]>, expect: RegExp): void {
  const run = async () => {
    try {
      const reasons = await fn();
      const hit = reasons.find((r) => expect.test(r));
      if (!hit) {
        failed++;
        console.log(`  FAIL  ${filter}`);
        console.log(`        bad input : ${badInput}`);
        console.log(`        expected  : ${expect}`);
        console.log(`        got       : ${reasons.length ? reasons.join(' | ') : '(no rejection at all)'}`);
        missing.push(filter);
        return;
      }
      passed++;
      console.log(`  ok    ${filter}`);
      console.log(`        bad input : ${badInput}`);
      console.log(`        REJECTED  : "${hit}"`);
    } catch (e: any) {
      failed++;
      console.log(`  ERROR ${filter}: ${e?.message}`);
      missing.push(filter);
    }
  };
  queue.push(run);
}

const queue: Array<() => Promise<void>> = [];

// --------------------------------------------------------------- fixtures

/**
 * A RugCheck report that is INDEXED (not inferred), so the gate trusts it.
 *
 * Merge order matters and got this wrong on the first pass: spreading `over`
 * AFTER `fileMeta` replaced the whole merged object, dropping holderSampleSize
 * and making four concentration proofs fail with "holder list empty". That was
 * a fixture bug reporting itself as four missing filters — the exact false
 * negative this file exists to prevent. Nested keys are merged explicitly now.
 */
function rugReport(over: any = {}): any {
  const { fileMeta, token, ...rest } = over;
  return {
    isInferred: false,
    score: 0,
    ...rest,
    token: { mintAuthority: null, freezeAuthority: null, ...(token || {}) },
    fileMeta: {
      holderSampleSize: 20,
      totalHolders: 50,
      top10Pct: 10,
      maxSingleHolderPct: 3,
      insiderPct: 0,
      rugged: false,
      ...(fileMeta || {}),
    },
  };
}

/** A healthy create payload — each proof spoils exactly one field. */
function createPayload(over: any = {}): any {
  return {
    txType: 'create',
    vSolInBondingCurve: 40,      // 10 real SOL in curve
    marketCapSol: 40,
    initialBuy: 10_000_000,      // 1% of 1B supply
    solAmount: 0.5,
    ...over,
  };
}

/** 82-byte SPL mint. tag 1 = authority PRESENT. */
function splMint(mintTag: number, freezeTag: number): Buffer {
  const d = Buffer.alloc(82);
  d.writeUInt32LE(mintTag, 0);
  d.writeUInt32LE(freezeTag, 46);
  d[45] = 1;
  return d;
}

/** Token-2022 mint carrying one TLV extension after the 166-byte marker. */
function t22Mint(extType: number): Buffer {
  const d = Buffer.alloc(200);
  d.writeUInt32LE(0, 0);       // mint authority renounced
  d.writeUInt32LE(0, 46);      // freeze authority renounced
  d[45] = 1;
  d.writeUInt16LE(extType, 166);
  d.writeUInt16LE(8, 168);     // extension payload length
  return d;
}

const conn = (data: Buffer | null, program = TOKEN_PROGRAM.toBase58()) => ({
  getAccountInfo: async () => (data === null ? null : { owner: { toBase58: () => program }, data }),
});
const MINT = 'So11111111111111111111111111111111111111112';

// --------------------------------------------------------------- proofs

console.log('\n================ FILTER PROOFS ================\n');
console.log('-- honeypotDetector: on-chain mint account --\n');

proof(
  'Mint authority NOT renounced',
  'SPL mint with mintAuthority COption tag = 1 (creator can mint unlimited supply)',
  async () => (await inspectMintSafety(conn(splMint(1, 0)) as any, MINT, null)).reasons,
  /mint authority is not renounced/i
);

proof(
  'Freeze authority active',
  'SPL mint with freezeAuthority COption tag = 1 (holders can be frozen out of selling)',
  async () => (await inspectMintSafety(conn(splMint(0, 1)) as any, MINT, null)).reasons,
  /freeze authority is active/i
);

proof(
  'Token-2022 transfer FEE',
  'Token-2022 mint with TransferFeeConfig extension (ext type 1) — sells silently taxed',
  async () => (await inspectMintSafety(conn(t22Mint(1), TOKEN_2022_PROGRAM.toBase58()) as any, MINT, null)).reasons,
  /transfer fee present/i
);

proof(
  'Token-2022 transfer HOOK',
  'Token-2022 mint with TransferHook extension (ext type 14) — arbitrary code can block the sell',
  async () => (await inspectMintSafety(conn(t22Mint(14), TOKEN_2022_PROGRAM.toBase58()) as any, MINT, null)).reasons,
  /transfer hook present/i
);

proof(
  'Token-2022 PERMANENT DELEGATE',
  'Token-2022 mint with PermanentDelegate extension (ext type 12) — third party can seize tokens',
  async () => (await inspectMintSafety(conn(t22Mint(12), TOKEN_2022_PROGRAM.toBase58()) as any, MINT, null)).reasons,
  /permanent delegate/i
);

proof(
  'Token-2022 DEFAULT ACCOUNT STATE (blacklist mechanism)',
  'Token-2022 mint with DefaultAccountState extension (ext type 6) — new accounts created frozen',
  async () => (await inspectMintSafety(conn(t22Mint(6), TOKEN_2022_PROGRAM.toBase58()) as any, MINT, null)).reasons,
  /default account state/i
);

proof(
  'Mint owned by an unexpected program',
  'mint account owned by neither the SPL nor Token-2022 program',
  async () => (await inspectMintSafety(conn(splMint(0, 0), '11111111111111111111111111111111') as any, MINT, null)).reasons,
  /unexpected program/i
);

proof(
  'RugCheck danger flag propagated',
  'indexed RugCheck report carrying a danger-level risk named "Honeypot"',
  async () => (await inspectMintSafety(
    conn(splMint(0, 0)) as any, MINT,
    { isInferred: false, risks: [{ name: 'Honeypot risk', level: 'danger' }] } as any
  )).reasons,
  /rugcheck danger/i
);

console.log('\n-- entryGateV2: payload + RugCheck screening --\n');

const gate = new EntryGateV2();

proof(
  'Dev initial buy % of supply too LARGE',
  'create where the dev buys 150,000,000 tokens = 15% of the 1B supply',
  () => gate.evaluate(createPayload({ initialBuy: 150_000_000 }), rugReport(), false).reasons,
  /dev initial buy .* of supply > max/i
);

proof(
  'Dev initial buy SOL too SMALL (no skin in the game)',
  'create where the dev commits 0 SOL of their own',
  () => gate.evaluate(createPayload({ solAmount: 0 }), rugReport(), false).reasons,
  /no skin in the game/i
);

proof(
  'Dev initial buy SOL too LARGE (exit-liquidity setup)',
  'create where the dev commits 50 SOL — building a bag to dump on buyers',
  () => gate.evaluate(createPayload({ solAmount: 50 }), rugReport(), false).reasons,
  /exit-liquidity setup risk/i
);

proof(
  'Real SOL in curve below minimum',
  'create with vSolInBondingCurve = 30.0 (zero real SOL above the 30 virtual base)',
  () => gate.evaluate(createPayload({ vSolInBondingCurve: 30.0 }), rugReport(), false).reasons,
  /real sol in curve .* < min/i
);

proof(
  'Market cap already pumped at detection',
  'create arriving at marketCapSol = 5000 — the move already happened',
  () => gate.evaluate(createPayload({ marketCapSol: 5000 }), rugReport(), false).reasons,
  /market cap .* > max/i
);

proof(
  'RugCheck risk score above maximum',
  'indexed RugCheck report with score 120,001',
  () => gate.evaluate(createPayload(), rugReport({ score: 120_001 }), false).reasons,
  /rugcheck score .* > max/i
);

proof(
  'Mint authority active (via RugCheck)',
  'indexed RugCheck report with a non-null mintAuthority',
  () => gate.evaluate(createPayload(), rugReport({ token: { mintAuthority: 'SomeAuthorityPubkey' } }), false).reasons,
  /mint authority active/i
);

proof(
  'Freeze authority active (via RugCheck)',
  'indexed RugCheck report with a non-null freezeAuthority',
  () => gate.evaluate(createPayload(), rugReport({ token: { freezeAuthority: 'SomeAuthorityPubkey' } }), false).reasons,
  /freeze authority active/i
);

proof(
  'BUNDLED LAUNCH — top 10 holders concentration',
  'dev holds 90% across 20 wallets that look organic: top10Pct = 90 with a 20-holder sample',
  () => gate.evaluate(createPayload(), rugReport({ fileMeta: { top10Pct: 90 } }), false).reasons,
  /top10 holders .* > max/i
);

proof(
  'Single largest holder too big',
  'one wallet holding 60% of supply',
  () => gate.evaluate(createPayload(), rugReport({ fileMeta: { maxSingleHolderPct: 60 } }), false).reasons,
  /largest holder .* > max/i
);

proof(
  'Insider holdings too big',
  'RugCheck-flagged insider network holding 55%',
  () => gate.evaluate(createPayload(), rugReport({ fileMeta: { insiderPct: 55 } }), false).reasons,
  /insider holdings .* > max/i
);

proof(
  'RugCheck marks token as RUGGED',
  'indexed report with fileMeta.rugged = true',
  () => gate.evaluate(createPayload(), rugReport({ fileMeta: { rugged: true } }), false).reasons,
  /marks token as rugged/i
);

proof(
  'Holder concentration UNVERIFIED (empty holder list)',
  'indexed report whose holder sample is 0 — unknown must not read as safe',
  () => gate.evaluate(createPayload(), rugReport({ fileMeta: { holderSampleSize: 0, top10Pct: undefined } }), false).reasons,
  /holder concentration unverified/i
);

proof(
  'RugCheck NOT INDEXED yet',
  'rug = null — the token is too fresh for RugCheck to have data',
  () => gate.evaluate(createPayload(), null, false).reasons,
  /rugcheck not indexed yet/i
);

proof(
  'Migration already pumped (buying the snipers exit)',
  'migration with +362% in 5m on a 77s-old pair and only $20,969 of volume — the $KINGLON entry that lost 93.5%',
  () => gate.evaluate({ txType: 'migrate' }, rugReport(), true, {
    priceChange5mPct: 362, pairAgeSeconds: 77, volume5mUsd: 20_969, socialCount: 2,
  }).reasons,
  /already \+362% in 5m/i
);

proof(
  'No linked socials',
  'migration with socialCount = 0 (published lift for socials is 8.94x-17.4x)',
  () => {
    const g = new EntryGateV2({ minSocialCount: 1 });
    return g.evaluate({ txType: 'migrate' }, rugReport(), true, {
      priceChange5mPct: 5, pairAgeSeconds: 900, volume5mUsd: 30_000, socialCount: 0,
    }).reasons;
  },
  /no linked socials/i
);

// --------------------------------------------------------------- run

(async () => {
  for (const t of queue) { await t(); console.log(''); }

  console.log('==============================================');
  console.log(`${passed} filters PROVEN to fire, ${failed} unproven`);
  if (missing.length) {
    console.log('\nUNPROVEN — treat these as NOT EXISTING until a test passes:');
    for (const m of missing) console.log('  - ' + m);
  }
  console.log('==============================================\n');
  process.exit(failed > 0 ? 1 : 0);
})();
