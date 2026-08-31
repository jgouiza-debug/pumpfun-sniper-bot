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

// SPL Token instructions that MOVE tokens at the top level. A pump/PumpSwap
// trade moves tokens inside the program's own CPI, never as a bare top-level
// Transfer — so one appearing here is not part of the trade. Left unchecked, a
// single appended Transfer(source = our ATA, destination = attacker's ATA,
// authority = our wallet) empties the whole bag, and the guard returned ok.
const TOKEN_TRANSFER = 3;
const TOKEN_TRANSFER_CHECKED = 12;
const TOKEN_BURN = 8;
const TOKEN_BURN_CHECKED = 15;

/**
 * System instruction types, as an ALLOW-list.
 *
 * It used to be a block-list that inspected exactly two types (Transfer and
 * TransferWithSeed) and let every other value fall through unchecked —
 * including `Assign` (1), which reassigns the OWNER PROGRAM of an account. One
 * appended `SystemProgram.assign({accountPubkey: ourWallet, programId:
 * attacker})` handed the signing wallet to an attacker outright, and the guard
 * returned ok:true.
 *
 * An allow-list is the correct shape here: the set of System instructions a
 * trade legitimately needs is small and known, and anything outside it is a
 * refusal rather than an unchecked pass. Assign, AssignWithSeed, AdvanceNonce,
 * WithdrawNonce, Authorize* and everything added to the System program in
 * future are all refused by construction.
 */
const SYS_CREATE_ACCOUNT = 0;
const SYS_TRANSFER = 2;
const SYS_CREATE_ACCOUNT_WITH_SEED = 3;
const SYS_ALLOCATE = 8;
const SYS_ALLOCATE_WITH_SEED = 9;
const SYS_TRANSFER_WITH_SEED = 11;
const ALLOWED_SYSTEM_TYPES = new Set<number>([
  SYS_CREATE_ACCOUNT,
  SYS_TRANSFER,
  SYS_CREATE_ACCOUNT_WITH_SEED,
  SYS_ALLOCATE,
  SYS_ALLOCATE_WITH_SEED,
  SYS_TRANSFER_WITH_SEED,
]);

// ComputeBudget instruction tags.
const CB_SET_UNIT_LIMIT = 2;
const CB_SET_UNIT_PRICE = 3;

/**
 * Hardest ceiling on what a priority fee may cost, in lamports.
 *
 * ComputeBudget was on the allowed-program list and its DATA was never read, so
 * an otherwise perfect pump.fun buy carrying SetComputeUnitLimit(1_400_000) and
 * a large SetComputeUnitPrice passed the guard and was signed and broadcast
 * with skipPreflight — burning the wallet to the block leader in one
 * transaction, with no instruction that looks remotely like a transfer.
 *
 * The caller passes its own tighter figure (maxPriorityFeeSol); this is the
 * backstop for a caller that passes nothing.
 */
const MAX_PRIORITY_FEE_LAMPORTS = 50_000_000; // 0.05 SOL

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
  opts: {
    /**
     * Worst-case lamports this trade is allowed to move OUT of our wallet in
     * top-level System transfers. The caller knows the size it ordered; the
     * guard cannot infer it.
     *
     * This closes the naming bypass: `tradeAccountSet` is built from the
     * accounts of every non-System instruction, so anyone who could shape the
     * response simply listed their own address among a router instruction's
     * accounts and their address became "part of the trade" — after which a
     * full-balance SystemProgram.transfer to it passed the unrelated-lamports
     * cap untouched. A total ceiling applies regardless of who is named.
     */
    maxLamportsOut?: bigint;
    /** Ceiling on the priority fee the ComputeBudget instructions may set, in lamports. */
    maxPriorityFeeLamports?: bigint;
  } = {},
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
    /** Accounts named by the VENUE instructions only — see the loop below. */
    const venueAccountSet = new Set<string>();
    /** Total lamports leaving our wallet to addresses outside the trade. */
    let unrelatedLamports = 0n;
    /** Total lamports leaving our wallet in top-level System transfers, to anyone but us. */
    let totalLamportsOut = 0n;
    /** ComputeBudget settings, checked as a product once all instructions are read. */
    let cbUnitLimit = 0n;
    let cbUnitPrice = 0n;
    for (const ix of instructions) {
      const program = keys[ix.programIdIndex]?.toBase58();
      if (program && program !== SYSTEM_PROGRAM && program !== COMPUTE_BUDGET) {
        for (const idx of ix.accountKeyIndexes) {
          const k = keys[idx];
          if (k) tradeAccountSet.add(k.toBase58());
        }
        // A SECOND, narrower set that excludes the token programs.
        //
        // tradeAccountSet has to include token-instruction accounts — a
        // legitimate SOL wrap references its WSOL ATA only from SyncNative, and
        // the System-transfer check needs to recognise that ATA. But using the
        // same set to police a token TRANSFER is self-defeating: the accounts
        // of a token instruction are exactly what is being policed, so a
        // hostile `Transfer(our ATA -> attacker ATA)` added its OWN destination
        // and then passed the "is this destination part of the trade?" test it
        // had just satisfied. An instruction may not vouch for itself, so a
        // token transfer's destination must be named by the VENUE.
        if (!TOKEN_PROGRAMS.has(program)) {
          for (const idx of ix.accountKeyIndexes) {
            const k = keys[idx];
            if (k) venueAccountSet.add(k.toBase58());
          }
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

      // ComputeBudget was allow-listed and its DATA never read. Fee =
      // unitPrice (microLamports per CU) x unitLimit / 1e6 lamports, and both
      // are attacker-chosen in a response we did not build. Capture them here
      // and check the product once every instruction has been seen.
      if (program === COMPUTE_BUDGET && data.length >= 1) {
        if (data[0] === CB_SET_UNIT_LIMIT && data.length >= 5) cbUnitLimit = BigInt(data.readUInt32LE(1));
        if (data[0] === CB_SET_UNIT_PRICE && data.length >= 9) cbUnitPrice = data.readBigUInt64LE(1);
      }

      // System: block any transfer of OUR lamports to an address that is not part
      // of the trade (and is not us). WSOL wrapping sends to our own WSOL ATA,
      // which the swap instruction references, so it stays in tradeAccountSet.
      if (program === SYSTEM_PROGRAM) {
        if (data.length < 4) {
          return { ok: false, reason: 'System instruction with no readable type' };
        }
        const type = data.readUInt32LE(0);
        if (!ALLOWED_SYSTEM_TYPES.has(type)) {
          // Assign (1) is the one that matters most: it reassigns the OWNER
          // PROGRAM of an account, and applied to our wallet it hands the
          // wallet over. Nothing outside the small known set belongs on a trade.
          return { ok: false, reason: `System instruction type ${type} is not part of a trade (only create/allocate/transfer are)` };
        }
        // CreateAccount MOVES LAMPORTS. Allow-listing it without counting them
        // would have opened, in the act of closing another hole, a way to send
        // an arbitrary amount to an account the caller chose — no Transfer
        // instruction anywhere in sight. Both forms carry a lamports field; the
        // seeded one carries it after a variable-length seed, so it is parsed
        // rather than assumed.
        if (type === SYS_CREATE_ACCOUNT || type === SYS_CREATE_ACCOUNT_WITH_SEED) {
          const from = keys[ix.accountKeyIndexes[0]]?.toBase58();
          let lamports = 0n;
          if (type === SYS_CREATE_ACCOUNT) {
            // u32 type | u64 lamports | u64 space | pubkey owner
            if (data.length >= 12) lamports = data.readBigUInt64LE(4);
          } else {
            // u32 type | pubkey base | u64 seedLen | seed | u64 lamports | ...
            if (data.length >= 44) {
              const seedLen = Number(data.readBigUInt64LE(36));
              const at = 44 + seedLen;
              if (Number.isFinite(seedLen) && seedLen >= 0 && data.length >= at + 8) {
                lamports = data.readBigUInt64LE(at);
              } else {
                // Unparseable: fail CLOSED rather than let an unmeasured
                // lamport movement through.
                return { ok: false, reason: 'System createAccountWithSeed has an unreadable layout — refusing rather than signing an unmeasured lamport movement' };
              }
            } else {
              return { ok: false, reason: 'System createAccountWithSeed is truncated' };
            }
          }
          if (from === ownerB58) totalLamportsOut += lamports;
        }

        if (type === SYS_TRANSFER || type === SYS_TRANSFER_WITH_SEED) {
          const from = keys[ix.accountKeyIndexes[0]]?.toBase58();
          const to = keys[ix.accountKeyIndexes[1]]?.toBase58();
          const lamportsOut = from === ownerB58 && data.length >= 12 ? data.readBigUInt64LE(4) : 0n;
          // TOTAL out of our wallet, to anyone but ourselves — counted whether
          // or not the destination is "part of the trade", because who is named
          // in the trade is exactly what a hostile response controls.
          if (from === ownerB58 && to && to !== ownerB58) totalLamportsOut += lamportsOut;
          if (from === ownerB58 && to && to !== ownerB58 && !tradeAccountSet.has(to)) {
            // Refusing this outright also refused the routing fee PumpPortal
            // collects, which is a legitimate part of every real trade. Cap it
            // instead: a fee is a slice, a drain is the balance. Amounts are
            // SUMMED so many small transfers cannot add up to a drain.
            unrelatedLamports += lamportsOut;
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
        if (tag === TOKEN_TRANSFER || tag === TOKEN_TRANSFER_CHECKED) {
          // A pump / PumpSwap trade moves tokens inside the program's own CPI,
          // never as a bare top-level Transfer. One appearing here is not part
          // of the trade — and Transfer(source = our ATA, destination =
          // attacker's ATA, authority = our wallet) empties the whole bag.
          // Permitted only when the destination is an account the trade itself
          // already references AND is not a fresh external address.
          const dest = keys[ix.accountKeyIndexes[tag === TOKEN_TRANSFER ? 1 : 2]]?.toBase58();
          if (!dest || (dest !== ownerB58 && !venueAccountSet.has(dest))) {
            return { ok: false, reason: `top-level token Transfer to ${dest ?? 'an unreadable account'} — a trade moves tokens through the program, not directly` };
          }
        }
        if (tag === TOKEN_BURN || tag === TOKEN_BURN_CHECKED) {
          return { ok: false, reason: 'token Burn instruction present — a trade never burns our tokens' };
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

    // ---- WHOLE-TRANSACTION CEILINGS -------------------------------------
    // Checked after every instruction, because both are about the TOTAL a
    // transaction can cost, and any single instruction can look reasonable.
    if (opts.maxLamportsOut !== undefined && totalLamportsOut > opts.maxLamportsOut) {
      return {
        ok: false,
        reason: `transaction moves ${Number(totalLamportsOut) / 1e9} SOL out of our wallet, above the `
          + `${Number(opts.maxLamportsOut) / 1e9} SOL this trade was sized for`,
      };
    }

    if (cbUnitPrice > 0n && cbUnitLimit > 0n) {
      // microLamports/CU x CU / 1e6 = lamports.
      const feeLamports = (cbUnitPrice * cbUnitLimit) / 1_000_000n;
      const cap = opts.maxPriorityFeeLamports ?? BigInt(MAX_PRIORITY_FEE_LAMPORTS);
      if (feeLamports > cap) {
        return {
          ok: false,
          reason: `ComputeBudget sets a priority fee of ${Number(feeLamports) / 1e9} SOL `
            + `(${cbUnitPrice} microLamports/CU x ${cbUnitLimit} CU), above the ${Number(cap) / 1e9} SOL ceiling`,
        };
      }
    }

    return { ok: true };
  } catch (err: any) {
    // A guard that throws must still fail closed.
    return { ok: false, reason: `intent check errored: ${err?.message || String(err)}` };
  }
}
