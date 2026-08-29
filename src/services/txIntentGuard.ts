import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';

/**
 * Pre-sign intent guard for transactions we did not build ourselves.
 *
 * The live buy/sell path fetches a serialized transaction from PumpPortal
 * (`/api/trade-local`), deserializes it, and signs it with the wallet key. Every
 * real trade the bot makes goes through that one sign site. Nothing between
 * deserialize and sign used to inspect the bytes, so a malicious or compromised
 * PumpPortal response — or a MITM of that HTTPS hop — could hand us a transaction
 * that transfers the whole wallet balance to an attacker or reassigns a token
 * account's authority, and we would sign and broadcast it. Because the same
 * wallet builds 100% of trades this way, one hostile response drains the wallet.
 *
 * This guard fails CLOSED: it asserts the transaction only does what a legitimate
 * pump.fun / PumpSwap trade does, and refuses to sign anything else. A false
 * reject blocks a trade (safe); a missed drain loses the wallet (not).
 *
 * Scope: designed for the PumpPortal pump / pump-amm routes and our own local
 * bonding-curve build, which are the only things this bot signs. It deliberately
 * does not try to validate arbitrary DEX aggregator routes — the bot never asks
 * PumpPortal for those.
 */

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
/**
 * PumpPortal's routing program. Every trade-local response goes through it as
 * of 2026-08-29, which is why refusing it blocked 100% of real trades from
 * v2.0.0 onward — the version before that signed these transactions with no
 * checks at all.
 *
 * Understand what allowing this does and does not mean. It is NOT pump.fun's:
 * those mints' bonding curves are owned by 6EF8rrec…, and this program's
 * upgrade authority (83CpBne2…) differs from the one pump.fun uses for both of
 * its programs (7gZufwww…). It is upgradeable, so its code can change without
 * warning, and it is undocumented.
 *
 * It is allow-listed deliberately, as an operator decision, and every other
 * check in this file still applies: the fee payer must be our wallet, ours must
 * be the only signature, no SetAuthority / Approve / CloseAccount may appear,
 * and lamports leaving our wallet to an address outside the trade are capped
 * (below). That is strictly more protection than the pre-v2.0.0 build, which
 * signed the same transactions blind. The way to stop trusting it entirely is
 * localTxBuild, which constructs the pump.fun instruction directly.
 */
const PUMPPORTAL_ROUTER = 'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe';

/**
 * Lamports allowed to leave our wallet, in total, to addresses that are not
 * part of the trade. A vendor fee is a small slice; a drain is the balance.
 * ponytail: one absolute cap, not a percentage of a trade size this function
 * cannot see — raise it if you trade sizes where a ~1% routing fee exceeds it.
 */
const MAX_UNRELATED_LAMPORTS = 10_000_000; // 0.01 SOL
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();

/** The only programs a legitimate PumpPortal trade (or our local build) invokes. */
const ALLOWED_PROGRAMS = new Set<string>([
  COMPUTE_BUDGET,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ATA_PROGRAM,
  PUMP_PROGRAM,
  PUMP_AMM_PROGRAM,
  PUMPPORTAL_ROUTER,
]);

const TOKEN_PROGRAMS = new Set<string>([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);

// SPL Token instruction tags (data[0]) that hand our funds or authority to
// someone else. None of these appears in a normal pump/PumpSwap buy or sell,
// where token movement happens inside the program's own CPI.
const TOKEN_APPROVE = 4;
const TOKEN_REVOKE = 5;
const TOKEN_SET_AUTHORITY = 6;
const TOKEN_CLOSE_ACCOUNT = 9;
const TOKEN_APPROVE_CHECKED = 13;

// System instruction type (first 4 bytes, little-endian).
const SYS_TRANSFER = 2;
const SYS_TRANSFER_WITH_SEED = 11;

export interface TxIntentVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Assert an unsigned transaction only performs a trade FOR `owner`, before it is
 * signed. Returns `{ ok: false, reason }` on anything suspicious; the caller must
 * refuse to sign when `ok` is false.
 */
export function assertOutboundTradeTx(
  tx: VersionedTransaction,
  owner: PublicKey,
  lookupAccounts?: readonly AddressLookupTableAccount[],
): TxIntentVerdict {
  try {
    const msg: any = tx.message;

    // Address-table lookups hide account identities behind tables that have to
    // be fetched to resolve. Refusing every one of them fails closed but ALSO
    // fails useful: measured 2026-08-29, PumpPortal returns lookup-bearing
    // transactions for ordinary routes, so a blanket refusal blocked every
    // real buy while paper mode looked fine — the bot appeared to trade and
    // nothing reached the chain.
    //
    // Resolving the tables loses no safety: the checks below then run over the
    // COMPLETE account list, exactly as they do for a static message. What is
    // still refused is a table we could not resolve — unverified is unsigned.
    const tableLookups = Array.isArray(msg.addressTableLookups) ? msg.addressTableLookups : [];
    let keys: PublicKey[];

    if (tableLookups.length > 0) {
      if (!lookupAccounts || lookupAccounts.length === 0) {
        return { ok: false, reason: 'transaction uses address lookup tables that were not resolved (unverifiable route)' };
      }
      const supplied = new Set(lookupAccounts.map((a) => a.key.toBase58()));
      for (const l of tableLookups) {
        const wanted = l.accountKey?.toBase58?.();
        if (!wanted || !supplied.has(wanted)) {
          return { ok: false, reason: `address lookup table ${wanted ?? 'unknown'} was not resolved — refusing to sign blind` };
        }
      }
      try {
        // getAccountKeys returns static keys followed by the writable then the
        // readonly loaded addresses — the exact order compiledInstructions
        // index into, so every check below keeps working unchanged.
        const resolved = msg.getAccountKeys({ addressLookupTableAccounts: lookupAccounts as AddressLookupTableAccount[] });
        keys = [];
        for (let i = 0; i < resolved.length; i++) {
          const k = resolved.get(i);
          if (!k) return { ok: false, reason: `address lookup resolution left account index ${i} empty` };
          keys.push(k);
        }
      } catch (err: any) {
        return { ok: false, reason: `could not resolve address lookup tables (${err?.message || 'unknown error'})` };
      }
    } else {
      keys = msg.staticAccountKeys;
    }
    const instructions: Array<{ programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }> =
      msg.compiledInstructions;
    if (!Array.isArray(keys) || !Array.isArray(instructions)) {
      return { ok: false, reason: 'unrecognized transaction message format' };
    }

    // Fee payer (account 0) must be our wallet, and it must be the SOLE required
    // signer — no second party co-signs, and we are the one paying.
    const numSigners = msg.header?.numRequiredSignatures;
    if (numSigners !== 1) {
      return { ok: false, reason: `expected exactly 1 required signer, got ${numSigners}` };
    }
    if (!keys[0] || !keys[0].equals(owner)) {
      return { ok: false, reason: `fee payer is ${keys[0]?.toBase58() ?? 'missing'}, not our wallet` };
    }

    const ownerB58 = owner.toBase58();

    // Accounts touched by the actual trade instructions (pump / pump-amm / token /
    // ATA). A legitimate SOL wrap or rent payment goes to one of these; a siphon
    // goes to a fresh external address that appears nowhere else.
    const tradeAccountSet = new Set<string>();
    /** Total lamports leaving our wallet to addresses outside the trade. */
    let unrelatedLamports = 0n;
    for (const ix of instructions) {
      const program = keys[ix.programIdIndex]?.toBase58();
      if (program && program !== SYSTEM_PROGRAM && program !== COMPUTE_BUDGET) {
        for (const idx of ix.accountKeyIndexes) {
          const k = keys[idx];
          if (k) tradeAccountSet.add(k.toBase58());
        }
      }
    }

    for (const ix of instructions) {
      const program = keys[ix.programIdIndex]?.toBase58();
      if (!program) return { ok: false, reason: 'instruction references an out-of-range program index' };
      if (!ALLOWED_PROGRAMS.has(program)) {
        return { ok: false, reason: `instruction invokes unexpected program ${program}` };
      }

      const data = Buffer.from(ix.data);

      // System: block any transfer of OUR lamports to an address that is not part
      // of the trade (and is not us). WSOL wrapping sends to our own WSOL ATA,
      // which the swap instruction references, so it stays in tradeAccountSet.
      if (program === SYSTEM_PROGRAM && data.length >= 4) {
        const type = data.readUInt32LE(0);
        if (type === SYS_TRANSFER || type === SYS_TRANSFER_WITH_SEED) {
          const from = keys[ix.accountKeyIndexes[0]]?.toBase58();
          const to = keys[ix.accountKeyIndexes[1]]?.toBase58();
          if (from === ownerB58 && to && to !== ownerB58 && !tradeAccountSet.has(to)) {
            // Refusing this outright also refused the routing fee PumpPortal
            // collects, which is a legitimate part of every real trade. Cap it
            // instead: a fee is a slice, a drain is the balance. Amounts are
            // SUMMED so many small transfers cannot add up to a drain.
            const lamports = data.length >= 12 ? data.readBigUInt64LE(4) : 0n;
            unrelatedLamports += lamports;
            if (unrelatedLamports > BigInt(MAX_UNRELATED_LAMPORTS)) {
              return {
                ok: false,
                reason: `SystemProgram transfer(s) of ${Number(unrelatedLamports) / 1e9} SOL from our wallet to account(s) outside the trade (${to}) — above the ${MAX_UNRELATED_LAMPORTS / 1e9} SOL fee allowance`,
              };
            }
          }
        }
      }

      // Token / Token-2022: none of the authority/allowance instructions belong on
      // a trade we build. CloseAccount is allowed only when it refunds us.
      if (TOKEN_PROGRAMS.has(program) && data.length >= 1) {
        const tag = data[0];
        if (tag === TOKEN_APPROVE || tag === TOKEN_APPROVE_CHECKED || tag === TOKEN_REVOKE) {
          return { ok: false, reason: 'token Approve/Revoke instruction present (delegates our tokens)' };
        }
        if (tag === TOKEN_SET_AUTHORITY) {
          return { ok: false, reason: 'token SetAuthority instruction present (reassigns account ownership)' };
        }
        if (tag === TOKEN_CLOSE_ACCOUNT) {
          // CloseAccount accounts: [account, destination, owner, ...]. The rent
          // refund destination must be us.
          const dest = keys[ix.accountKeyIndexes[1]]?.toBase58();
          if (dest && dest !== ownerB58 && !tradeAccountSet.has(dest)) {
            return { ok: false, reason: `token CloseAccount refunds to unrelated account ${dest}` };
          }
        }
      }
    }

    return { ok: true };
  } catch (err: any) {
    // A guard that throws must still fail closed.
    return { ok: false, reason: `intent check errored: ${err?.message || String(err)}` };
  }
}
