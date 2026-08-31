import crypto from 'crypto';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { bondingCurveTokensOut, bondingCurveSolOut } from './pipelineUtils';

/**
 * Local pump.fun bonding-curve BUY construction.
 * Flags: localTxShadowCompare (evidence collection, zero behavior change) and
 * localTxBuild (actually submit locally built txs).
 *
 * Why: the audit measured the PumpPortal trade-local HTTP hop at 68-85ms and
 * it is a third-party availability risk on the critical path. A locally built
 * tx with a background-refreshed blockhash removes both.
 *
 * Why the guard rails: pump.fun's account layout has changed over time
 * (creator vault, volume accumulators). We refuse to trust any hardcoded
 * layout: with localTxShadowCompare on, every real buy also builds locally and
 * structurally diffs our tx against the trade-local one (which is what gets
 * submitted). Only after a clean structural parity IN THE CURRENT SESSION will
 * localTxBuild actually use a local tx; without parity it silently falls back
 * to trade-local and logs why. Migrated tokens (curve complete) always fall
 * back — they route through the AMM, which this builder does not implement.
 */

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
/**
 * Accounts pump.fun added to buy/sell since this builder was written. Verified
 * 2026-08-29 against the program's OWN on-chain Anchor IDL (the authority, not
 * memory): buy now takes 16 accounts and sell 14, where this file built 12.
 * Every derivation below was checked against a real landed buy and matches.
 */
const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
/** The IDL's second fee_config seed, a 32-byte constant. */
const FEE_CONFIG_SEED = Buffer.from('0156e0f693665acf44db1568bf175baa5189cb97f5d2ff3b655d2bb6fd6d18b0', 'hex');

/**
 * Two more accounts the DEPLOYED program requires that its published IDL does
 * not list, verified 2026-08-29 across 108 landed instructions (29 mints, 72
 * wallets) and by simulating a landed buy with one account swapped for a random
 * key, which makes the program name them itself:
 *
 *   idx swapped -> AnchorError 6074 InvalidBondingCurveV2   (sell.rs:133)
 *   idx swapped -> AnchorError 6057 BuybackFeeRecipientNotAuthorized (lib.rs:1494)
 *   omitted     -> AnchorError 6062 BuybackFeeRecipientMissing (sell.rs:145)
 *
 * 6062 is the error this builder used to die on. The seed below was also found
 * verbatim in the deployed BPF binary next to "bonding-curve" and
 * "creator-vault".
 */
const BONDING_CURVE_V2_SEED = 'bonding-curve-v2';

/** How often the cached blockhash is refreshed in the background. */
const BLOCKHASH_REFRESH_MS = 2_000;
/**
 * How old the cached blockhash may be before a build refuses to use it.
 *
 * Was 60s, which is most or all of a blockhash's ~60-90s validity — a
 * transaction built at that age can expire before it lands. 20s leaves the
 * large majority of the window intact for the send, the rebroadcast and the
 * confirmation poll. With a 2s refresh this bar is only ever reached when the
 * refresher itself has been failing, which is exactly when falling back to
 * trade-local (whose blockhash comes from PumpPortal's own server) is right.
 */
const BLOCKHASH_MAX_AGE_MS = 20_000;
/** Mint -> owning token program. Immutable per mint; bounded so it cannot grow forever. */
const TOKEN_PROGRAM_CACHE_MAX = 2_000;
/** Offset of the 8-entry buyback-recipient array inside the pump `global` account. */
const GLOBAL_BUYBACK_OFFSET = 741;
const GLOBAL_BUYBACK_COUNT = 8;

// Anchor discriminator, computed rather than trusted from memory.
const BUY_DISCRIMINATOR = crypto.createHash('sha256').update('global:buy').digest().subarray(0, 8);
const SELL_DISCRIMINATOR = crypto.createHash('sha256').update('global:sell').digest().subarray(0, 8);

const ASSUMED_COMPUTE_UNITS = 200_000;
/** Parity evidence goes stale: re-verify at least every 6h of runtime. */
const PARITY_TTL_MS = 6 * 60 * 60 * 1000;

interface CurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  complete: boolean;
  creator: PublicKey | null;
}

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

export class LocalTxBuilder {
  private connection: Connection | null = null;
  private blockhash: string | null = null;
  private blockhashFetchedAt = 0;
  private refresher: NodeJS.Timeout | null = null;
  private feeRecipient: PublicKey | null = null;
  private buybackRecipient: PublicKey | null = null;
  private feeRecipients: PublicKey[] | null = null;
  private lastParityAt = 0;
  private lastParityDetail = 'never compared';

  /** Safe to call repeatedly — rebinds to the latest connection (e.g. after an RPC key change). */
  public start(connection: Connection): void {
    this.connection = connection;
    if (this.refresher) {
      clearInterval(this.refresher);
      this.refresher = null;
    }
    const refresh = async () => {
      try {
        const bh = await this.connection!.getLatestBlockhash('confirmed');
        this.blockhash = bh.blockhash;
        this.blockhashFetchedAt = Date.now();
      } catch { /* keep last */ }
    };
    void refresh();
    // 2s, not 20s. A blockhash is only valid for ~150 slots (~60-90s), so one
    // fetched 20s ago has already spent a third of its life before the buy that
    // uses it is even built — and under the old 60s staleness bar, up to ALL of
    // it. A transaction signed against a nearly-dead blockhash does not fail
    // loudly; it simply never lands, and settlement correctly reports 'expired'
    // some seconds later. That is a missed fill with no error attached to it.
    //
    // The cost of the tighter cadence is one getLatestBlockhash every 2s on a
    // connection that is already open, which is nothing next to a lost entry.
    this.refresher = setInterval(refresh, BLOCKHASH_REFRESH_MS);
    this.refresher.unref?.();
  }

  public stop(): void {
    if (this.refresher) clearInterval(this.refresher);
    this.refresher = null;
  }

  public hasRecentParity(): boolean {
    return Date.now() - this.lastParityAt < PARITY_TTL_MS;
  }

  public getParityStatus(): { parity: boolean; detail: string; lastParityAt: number } {
    return { parity: this.hasRecentParity(), detail: this.lastParityDetail, lastParityAt: this.lastParityAt };
  }

  // ---------------- PDAs ----------------

  private pdas(mint: PublicKey, user: PublicKey, creator: PublicKey | null, tokenProgram: PublicKey) {
    const [global] = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP_PROGRAM);
    const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM);
    const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_PROGRAM);
    // The ATA seed is the mint's OWN token program. Deriving with the legacy
    // program for a Token-2022 mint yields an address the program rejects with
    // IncorrectProgramId — measured 2026-08-29 on 6 of 6 live pump.fun mints,
    // all of which are Token-2022.
    const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
      [bondingCurve.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
    const [associatedUser] = PublicKey.findProgramAddressSync(
      [user.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
    const creatorVault = creator
      ? PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), creator.toBuffer()], PUMP_PROGRAM)[0]
      : null;
    const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync(
      [Buffer.from('global_volume_accumulator')], PUMP_PROGRAM);
    const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
      [Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP_PROGRAM);
    const [feeConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from('fee_config'), FEE_CONFIG_SEED], FEE_PROGRAM);
    // Uninitialized on chain for every mint checked — pass it anyway, the
    // program only validates the address.
    const [bondingCurveV2] = PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_V2_SEED), mint.toBuffer()], PUMP_PROGRAM);
    return {
      global, bondingCurve, eventAuthority, associatedBondingCurve, associatedUser, creatorVault,
      globalVolumeAccumulator, userVolumeAccumulator, feeConfig, bondingCurveV2,
    };
  }

  // ---------------- On-chain reads ----------------

  /**
   * Every fee recipient the pump `global` account authorizes, most-likely first.
   *
   * Offset 41 is the primary, and offsets 162 + 32*i (i = 0..6) are the
   * secondary array; both are live simultaneously — measured 2026-08-29, seven
   * distinct recipients appeared across 20 landed instructions. Using the
   * primary alone made 3 of 5 buys simulate as 6000 NotAuthorized
   * (fee_recipient.rs:19), so the caller walks this list until one simulates.
   */
  private async getFeeRecipients(): Promise<PublicKey[]> {
    if (this.feeRecipients) return this.feeRecipients;
    if (!this.connection) return [];
    try {
      const [global] = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP_PROGRAM);
      const info = await this.connection.getAccountInfo(global, 'confirmed');
      if (!info) return [];
      const out: PublicKey[] = [];
      const push = (off: number) => {
        if (off + 32 > info.data.length) return;
        const pk = new PublicKey(info.data.subarray(off, off + 32));
        if (!pk.equals(PublicKey.default) && !out.some((k) => k.equals(pk))) out.push(pk);
      };
      push(41);                                   // primary
      for (let i = 0; i < 7; i++) push(162 + 32 * i); // secondary array
      push(483);
      this.feeRecipients = out;
      return out;
    } catch {
      return [];
    }
  }

  /** The recipient that last simulated clean, tried first next time. */
  private async getFeeRecipient(): Promise<PublicKey | null> {
    const all = await this.getFeeRecipients();
    if (!all.length) return null;
    return this.feeRecipient ?? all[0];
  }

  /**
   * The token program that actually owns this mint (legacy SPL or Token-2022).
   *
   * Memoised, because a mint account's owner is fixed at creation and cannot
   * change — so this was one guaranteed-identical getAccountInfo per build, on
   * the buy path, for an answer we already had. Only SUCCESSFUL lookups are
   * cached: a null can mean the RPC would not answer, and caching that would
   * strand a tradable mint on the fallback path for the life of the process.
   *
   * Bounded, evicting oldest-first. An unbounded map keyed by mint in a process
   * that sees thousands of new tokens a day is a leak with a long fuse.
   */
  private tokenProgramCache = new Map<string, PublicKey>();

  private async getTokenProgram(mint: PublicKey): Promise<PublicKey | null> {
    if (!this.connection) return null;
    const key = mint.toBase58();
    const cached = this.tokenProgramCache.get(key);
    if (cached) return cached;
    try {
      const info = await this.connection.getAccountInfo(mint, 'confirmed');
      if (!info) return null;
      const owner = info.owner;
      if (owner.equals(TOKEN_PROGRAM) || owner.equals(TOKEN_2022_PROGRAM)) {
        if (this.tokenProgramCache.size >= TOKEN_PROGRAM_CACHE_MAX) {
          const oldest = this.tokenProgramCache.keys().next().value;
          if (oldest) this.tokenProgramCache.delete(oldest);
        }
        this.tokenProgramCache.set(key, owner);
        return owner;
      }
      return null; // some other program owns it — not a token we can trade
    } catch {
      return null;
    }
  }

  /**
   * One of the 8 authorized buyback fee recipients, read out of the pump
   * `global` account rather than hardcoded — pump.fun rotates them, and a key
   * that is not in the live array is rejected with 6057
   * BuybackFeeRecipientNotAuthorized. Any of the 8 is accepted.
   */
  private async getBuybackFeeRecipient(): Promise<PublicKey | null> {
    if (this.buybackRecipient) return this.buybackRecipient;
    if (!this.connection) return null;
    try {
      const [global] = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP_PROGRAM);
      const info = await this.connection.getAccountInfo(global, 'confirmed');
      if (!info || info.data.length < GLOBAL_BUYBACK_OFFSET + 32 * GLOBAL_BUYBACK_COUNT) return null;
      const keys: PublicKey[] = [];
      for (let i = 0; i < GLOBAL_BUYBACK_COUNT; i++) {
        const off = GLOBAL_BUYBACK_OFFSET + 32 * i;
        const pk = new PublicKey(info.data.subarray(off, off + 32));
        if (!pk.equals(PublicKey.default)) keys.push(pk);
      }
      if (!keys.length) return null;
      this.buybackRecipient = keys[0];
      return this.buybackRecipient;
    } catch {
      return null;
    }
  }

  private async getCurveState(mint: PublicKey): Promise<CurveState | null> {
    if (!this.connection) return null;
    try {
      const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM);
      const info = await this.connection.getAccountInfo(bondingCurve, 'processed');
      if (!info || info.data.length < 49) return null;
      const d = info.data;
      return {
        // 8 disc + vTokens u64 + vSol u64 + realTokens u64 + realSol u64 + supply u64 + complete u8 [+ creator 32]
        virtualTokenReserves: d.readBigUInt64LE(8),
        virtualSolReserves: d.readBigUInt64LE(16),
        complete: d.readUInt8(48) === 1,
        creator: d.length >= 81 ? new PublicKey(d.subarray(49, 81)) : null,
      };
    } catch {
      return null;
    }
  }

  // ---------------- Build ----------------

  /**
   * Builds an UNSIGNED buy tx. Returns null (caller falls back to trade-local)
   * when: curve missing/complete (migrated), blockhash stale, or fee recipient
   * unknown. Never throws onto the buy path.
   */
  private async buildBuyWith(params: {
    user: PublicKey;
    mint: string;
    solAmount: number;
    slippagePct: number;
    priorityFeeSol: number;
  }, feeRecipientOverride: PublicKey | null): Promise<{ tx: VersionedTransaction; tokensOutRaw: bigint; detail: string } | null> {
    try {
      if (!this.connection) return null;
      if (!this.blockhash || Date.now() - this.blockhashFetchedAt > BLOCKHASH_MAX_AGE_MS) return null;

      const mint = new PublicKey(params.mint);
      const [defaultFeeRecipient, curve, tokenProgram, buybackRecipient] = await Promise.all([
        this.getFeeRecipient(), this.getCurveState(mint), this.getTokenProgram(mint), this.getBuybackFeeRecipient(),
      ]);
      const feeRecipient = feeRecipientOverride ?? defaultFeeRecipient;
      if (!feeRecipient) return null;
      if (!curve || curve.complete) return null; // migrated or unknown -> AMM territory, not ours
      if (!tokenProgram || !buybackRecipient) return null;

      const lamportsIn = BigInt(Math.floor(params.solAmount * 1e9));
      const tokensOut = bondingCurveTokensOut(lamportsIn, curve.virtualSolReserves, curve.virtualTokenReserves);
      if (tokensOut <= 0n) return null;
      const maxSolCost = (lamportsIn * BigInt(Math.floor((100 + params.slippagePct) * 100))) / 10_000n;

      const p = this.pdas(mint, params.user, curve.creator, tokenProgram);

      const cuPriceMicroLamports = Math.max(1, Math.floor((params.priorityFeeSol * 1e9 * 1e6) / ASSUMED_COMPUTE_UNITS));
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: ASSUMED_COMPUTE_UNITS }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports }),
        // Idempotent ATA create (instruction index 1 on the ATA program).
        new TransactionInstruction({
          programId: ATA_PROGRAM,
          keys: [
            { pubkey: params.user, isSigner: true, isWritable: true },
            { pubkey: p.associatedUser, isSigner: false, isWritable: true },
            { pubkey: params.user, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([1]),
        }),
      ];

      // Best-known 2025+ account order incl. creator_vault. If pump.fun has
      // shifted the layout again, shadow compare fails parity and this builder
      // stays dormant — that is the designed failure mode, not an accident.
      if (!p.creatorVault) {
        this.lastParityDetail = 'curve has no creator field — layout older/newer than builder expects';
        return null;
      }
      ixs.push(new TransactionInstruction({
        programId: PUMP_PROGRAM,
        keys: [
          { pubkey: p.global, isSigner: false, isWritable: false },
          { pubkey: feeRecipient, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: p.bondingCurve, isSigner: false, isWritable: true },
          { pubkey: p.associatedBondingCurve, isSigner: false, isWritable: true },
          { pubkey: p.associatedUser, isSigner: false, isWritable: true },
          { pubkey: params.user, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: tokenProgram, isSigner: false, isWritable: false },
          { pubkey: p.creatorVault, isSigner: false, isWritable: true },
          { pubkey: p.eventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
          // Added by pump.fun since this builder was written; order and
          // writability taken from the on-chain IDL.
          { pubkey: p.globalVolumeAccumulator, isSigner: false, isWritable: true },
          { pubkey: p.userVolumeAccumulator, isSigner: false, isWritable: true },
          { pubkey: p.feeConfig, isSigner: false, isWritable: false },
          { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },
          // Required by the deployed program, absent from its IDL. Omitting
          // them is exactly the 6062 BuybackFeeRecipientMissing this builder
          // used to die on. Confirmed clean by three independent simulations.
          { pubkey: p.bondingCurveV2, isSigner: false, isWritable: false },
          { pubkey: buybackRecipient, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([BUY_DISCRIMINATOR, u64le(tokensOut), u64le(maxSolCost)]),
      }));

      const msg = new TransactionMessage({
        payerKey: params.user,
        recentBlockhash: this.blockhash,
        instructions: ixs,
      }).compileToV0Message();

      return {
        tx: new VersionedTransaction(msg),
        tokensOutRaw: tokensOut,
        detail: `local build: ${tokensOut} raw tokens, maxSol ${Number(maxSolCost) / 1e9}`,
      };
    } catch {
      return null;
    }
  }

  /**
   * Builds an UNSIGNED sell tx for a bonding-curve token. Returns null (caller
   * falls back to trade-local) on a migrated curve, a stale blockhash, an
   * unknown fee recipient, or no token balance to sell.
   *
   * Exists because a bot that can buy without PumpPortal but not sell without
   * it has not removed the dependency — it has only moved where it hurts.
   * NOTE the account order: pump.fun's sell instruction puts creator_vault
   * BEFORE token_program, the reverse of buy. Getting that backwards produces
   * a transaction that simulates as a program error, which is exactly what the
   * simulation gate below is for.
   */
  private async buildSellVariant(params: {
    user: PublicKey;
    mint: string;
    tokenAmountRaw: bigint;
    slippagePct: number;
    priorityFeeSol: number;
  }, withCashback: boolean, feeRecipientOverride: PublicKey | null = null): Promise<{ tx: VersionedTransaction; minSolOutRaw: bigint; detail: string } | null> {
    try {
      if (!this.connection) return null;
      if (!this.blockhash || Date.now() - this.blockhashFetchedAt > BLOCKHASH_MAX_AGE_MS) return null;
      if (params.tokenAmountRaw <= 0n) return null;

      const mint = new PublicKey(params.mint);
      const [defaultFeeRecipient, curve, tokenProgram, buybackRecipient] = await Promise.all([
        this.getFeeRecipient(), this.getCurveState(mint), this.getTokenProgram(mint), this.getBuybackFeeRecipient(),
      ]);
      const feeRecipient = feeRecipientOverride ?? defaultFeeRecipient;
      if (!feeRecipient) return null;
      if (!curve || curve.complete) return null; // migrated -> AMM, not ours
      if (!tokenProgram || !buybackRecipient) return null;

      const p = this.pdas(mint, params.user, curve.creator, tokenProgram);
      if (!p.creatorVault) {
        this.lastParityDetail = 'curve has no creator field — layout older/newer than builder expects';
        return null;
      }

      const grossOut = bondingCurveSolOut(params.tokenAmountRaw, curve.virtualSolReserves, curve.virtualTokenReserves);
      // Slippage floor. A sell that cannot clear it reverts rather than dumping
      // into a pool that moved against us between build and land.
      const minSolOut = (grossOut * BigInt(Math.floor((100 - params.slippagePct) * 100))) / 10_000n;

      const cuPriceMicroLamports = Math.max(1, Math.floor((params.priorityFeeSol * 1e9 * 1e6) / ASSUMED_COMPUTE_UNITS));
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: ASSUMED_COMPUTE_UNITS }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports }),
        new TransactionInstruction({
          programId: PUMP_PROGRAM,
          keys: [
            { pubkey: p.global, isSigner: false, isWritable: false },
            { pubkey: feeRecipient, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: p.bondingCurve, isSigner: false, isWritable: true },
            { pubkey: p.associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: p.associatedUser, isSigner: false, isWritable: true },
            { pubkey: params.user, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: p.creatorVault, isSigner: false, isWritable: true },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
            { pubkey: p.eventAuthority, isSigner: false, isWritable: false },
            { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
            // Sell takes fee_config + fee_program, and NO volume accumulators.
            { pubkey: p.feeConfig, isSigner: false, isWritable: false },
            { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },
            // Extras the deployed program wants but the IDL omits. Sell takes
            // the CASHBACK form: user_volume_accumulator FIRST, then
            // bonding_curve_v2, then the buyback recipient. Measured
            // 2026-08-29 on 6 of 6 live holders: without the accumulator the
            // program answers 6073 InvalidCashbackAccumulator (sell.rs:33),
            // with it the sell simulates clean. `withCashback` false builds the
            // shorter form some wallets still take — which one applies is
            // per-user state, so buildSell simulates and picks.
            ...(withCashback ? [{ pubkey: p.userVolumeAccumulator, isSigner: false, isWritable: true }] : []),
            { pubkey: p.bondingCurveV2, isSigner: false, isWritable: false },
            { pubkey: buybackRecipient, isSigner: false, isWritable: true },
          ],
          data: Buffer.concat([SELL_DISCRIMINATOR, u64le(params.tokenAmountRaw), u64le(minSolOut)]),
        }),
      ];

      const msg = new TransactionMessage({
        payerKey: params.user,
        recentBlockhash: this.blockhash,
        instructions: ixs,
      }).compileToV0Message();

      return {
        tx: new VersionedTransaction(msg),
        minSolOutRaw: minSolOut,
        detail: `local sell build (${withCashback ? 'cashback' : 'short'} form): ${params.tokenAmountRaw} raw tokens, minSol ${Number(minSolOut) / 1e9}`,
      };
    } catch {
      return null;
    }
  }

  /**
   * Build a sell and prove it, trying the cashback form first.
   *
   * Which form a wallet needs is per-user state that cannot be read ahead of
   * time — measured 2026-08-29, ordinary holders require the accumulator
   * (without it: 6073 InvalidCashbackAccumulator) while a minority of landed
   * sells used the shorter form. Rather than guess, build both and let the
   * chain decide: simulation is already the gate before signing, so trying the
   * second form costs one extra simulate on an exit that would otherwise fail.
   *
   * An exit that cannot be built is worse than an entry that cannot be — it
   * strands a position — so this deliberately spends the extra round trip.
   */
  public async buildSell(params: {
    user: PublicKey;
    mint: string;
    tokenAmountRaw: bigint;
    slippagePct: number;
    priorityFeeSol: number;
  }): Promise<{ tx: VersionedTransaction; minSolOutRaw: bigint; detail: string; simulated: true } | null> {
    const candidates = await this.getFeeRecipients();
    const ordered = this.feeRecipient
      ? [this.feeRecipient, ...candidates.filter((k) => !k.equals(this.feeRecipient!))]
      : candidates;

    for (const withCashback of [true, false]) {
      for (const fr of ordered) {
        const built = await this.buildSellVariant(params, withCashback, fr);
        if (!built) break; // build failure is about the curve, not the recipient
        const sim = await this.simulateOk(built.tx);
        if (sim.ok) {
          this.feeRecipient = fr;
          return { ...built, simulated: true as const };
        }
        this.lastParityDetail = `sell ${withCashback ? 'cashback' : 'short'} form: ${sim.detail}`;
        if (!/6000|NotAuthorized|InvalidAccountForFee/.test(sim.detail)) break; // wrong FORM, try the other one
      }
    }
    return null;
  }

  /** Raw token balance of the user's ATA for `mint`, or null when unreadable. */
  public async ownedTokenAmountRaw(user: PublicKey, mint: string): Promise<bigint | null> {
    if (!this.connection) return null;
    try {
      const mintPk = new PublicKey(mint);
      const tokenProgram = await this.getTokenProgram(mintPk);
      if (!tokenProgram) return null;
      const [ata] = PublicKey.findProgramAddressSync(
        [user.toBuffer(), tokenProgram.toBuffer(), mintPk.toBuffer()], ATA_PROGRAM);
      const bal = await this.connection.getTokenAccountBalance(ata, 'processed');
      return BigInt(bal.value.amount);
    } catch {
      return null;
    }
  }

  /**
   * Prove a locally built transaction is correct by SIMULATING it, before it is
   * signed or sent.
   *
   * This replaces the old dependency on shadow-comparing against PumpPortal.
   * That comparison can no longer pass: measured 2026-08-29, trade-local
   * returns transactions routed through a third-party program, so a structural
   * diff against our direct pump.fun build will differ forever and the builder
   * would stay dormant permanently. Simulation proves the same thing the diff
   * was a proxy for — that our account order and instruction data are what the
   * program expects — and it proves it against the chain rather than against
   * another vendor's opinion.
   *
   * Fails CLOSED: anything other than a clean simulation returns false and the
   * caller falls back.
   */
  public async simulateOk(tx: VersionedTransaction): Promise<{ ok: boolean; detail: string }> {
    if (!this.connection) return { ok: false, detail: 'no connection' };
    try {
      const res = await this.connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'processed',
      });
      if (res.value.err) {
        const logs = (res.value.logs || []).filter((l) => /Error|failed/i.test(l)).slice(-2).join(' | ');
        return { ok: false, detail: `simulation failed: ${JSON.stringify(res.value.err)}${logs ? ' — ' + logs : ''}` };
      }
      this.lastParityAt = Date.now();
      this.lastParityDetail = 'verified by on-chain simulation';
      return { ok: true, detail: 'simulation clean' };
    } catch (err: any) {
      return { ok: false, detail: `simulation threw: ${err?.message || 'unknown'}` };
    }
  }

  /**
   * Build a buy and prove it by simulation, walking the authorized fee
   * recipients until one is accepted.
   *
   * pump.fun runs several fee recipients at once and rejects the wrong one for
   * a given mint with 6000 NotAuthorized. Using the primary alone failed 3 of 5
   * live mints. The recipient that works is cached, so the common case costs a
   * single simulate.
   */
  public async buildBuy(params: {
    user: PublicKey;
    mint: string;
    solAmount: number;
    slippagePct: number;
    priorityFeeSol: number;
  }): Promise<{ tx: VersionedTransaction; tokensOutRaw: bigint; detail: string; simulated: true } | null> {
    const candidates = await this.getFeeRecipients();
    if (!candidates.length) return null;
    // Whatever worked last time first — pump.fun does not rotate these often.
    const ordered = this.feeRecipient
      ? [this.feeRecipient, ...candidates.filter((k) => !k.equals(this.feeRecipient!))]
      : candidates;

    for (const fr of ordered) {
      const built = await this.buildBuyWith(params, fr);
      if (!built) return null; // a build failure is not about the recipient
      const sim = await this.simulateOk(built.tx);
      if (sim.ok) {
        this.feeRecipient = fr;
        // SIMULATED, and the caller is told so. The engine used to simulate the
        // returned transaction a second time — a full extra RPC round trip on
        // the buy path, re-asking a question this loop had just answered about
        // these exact bytes. See the `simulated` check in sniperEngine.
        return { ...built, simulated: true as const };
      }
      // Only a credential-shaped rejection is worth another recipient; a
      // slippage or economics failure would fail identically for all of them.
      if (!/6000|NotAuthorized|InvalidAccountForFee/.test(sim.detail)) {
        this.lastParityDetail = sim.detail;
        return null;
      }
      this.lastParityDetail = sim.detail;
    }
    return null;
  }

  // ---------------- Shadow compare ----------------

  /**
   * Structurally diffs a trade-local tx against our local build for the same
   * intent. Called fire-and-forget AFTER submission — adds zero latency.
   * Parity criterion: the pump-program instruction has identical account
   * pubkeys in identical order, same discriminator, same data length.
   * (Amounts differ legitimately: independent reserve snapshots.)
   */
  public async shadowCompare(
    remoteTxBytes: Uint8Array,
    params: { user: PublicKey; mint: string; solAmount: number; slippagePct: number; priorityFeeSol: number },
    log: (level: 'info' | 'warn', msg: string) => void
  ): Promise<void> {
    try {
      const local = await this.buildBuy(params);
      const remote = VersionedTransaction.deserialize(remoteTxBytes);

      const describe = (tx: VersionedTransaction) => {
        const msg = tx.message;
        const keys = msg.staticAccountKeys.map(k => k.toBase58());
        return msg.compiledInstructions.map(ix => ({
          program: keys[ix.programIdIndex],
          accounts: ix.accountKeyIndexes.map(i => keys[i] ?? `lut:${i}`),
          dataHex: Buffer.from(ix.data).toString('hex'),
        }));
      };

      const remoteIxs = describe(remote);
      const remotePump = remoteIxs.find(ix => ix.program === PUMP_PROGRAM.toBase58());
      if (!remotePump) {
        this.lastParityDetail = 'trade-local tx contains no pump-program instruction (AMM route?) — local builder not applicable';
        log('info', `🔬 [SHADOW BUILD] ${this.lastParityDetail}`);
        return;
      }
      if (!local) {
        this.lastParityDetail = 'local build returned null while trade-local succeeded';
        log('warn', `🔬 [SHADOW BUILD] ${this.lastParityDetail}`);
        return;
      }

      const localIxs = describe(local.tx);
      const localPump = localIxs.find(ix => ix.program === PUMP_PROGRAM.toBase58())!;

      const accountsMatch = JSON.stringify(localPump.accounts) === JSON.stringify(remotePump.accounts);
      const discMatch = localPump.dataHex.slice(0, 16) === remotePump.dataHex.slice(0, 16);
      const lenMatch = localPump.dataHex.length === remotePump.dataHex.length;

      if (accountsMatch && discMatch && lenMatch) {
        this.lastParityAt = Date.now();
        this.lastParityDetail = 'structural parity: accounts, discriminator and data length match';
        log('info', `🔬 [SHADOW BUILD] ✅ PARITY — local builder matches trade-local for ${params.mint.slice(0, 6)}...`);
      } else {
        this.lastParityDetail =
          `MISMATCH acc=${accountsMatch} disc=${discMatch} len=${lenMatch} | ` +
          `remote accounts: ${remotePump.accounts.join(',')} | local accounts: ${localPump.accounts.join(',')} | ` +
          `remote data: ${remotePump.dataHex} | local data: ${localPump.dataHex}`;
        log('warn', `🔬 [SHADOW BUILD] ❌ NO PARITY — ${this.lastParityDetail}`);
      }
    } catch (err: any) {
      log('warn', `🔬 [SHADOW BUILD] compare failed: ${err.message}`);
    }
  }
}

export const localTxBuilder = new LocalTxBuilder();
