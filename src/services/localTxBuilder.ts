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
import { bondingCurveTokensOut } from './pipelineUtils';

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
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Anchor discriminator, computed rather than trusted from memory.
const BUY_DISCRIMINATOR = crypto.createHash('sha256').update('global:buy').digest().subarray(0, 8);

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
    this.refresher = setInterval(refresh, 20_000);
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

  private pdas(mint: PublicKey, user: PublicKey, creator: PublicKey | null) {
    const [global] = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP_PROGRAM);
    const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM);
    const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_PROGRAM);
    const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
      [bondingCurve.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
    const [associatedUser] = PublicKey.findProgramAddressSync(
      [user.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
    const creatorVault = creator
      ? PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), creator.toBuffer()], PUMP_PROGRAM)[0]
      : null;
    return { global, bondingCurve, eventAuthority, associatedBondingCurve, associatedUser, creatorVault };
  }

  // ---------------- On-chain reads ----------------

  private async getFeeRecipient(): Promise<PublicKey | null> {
    if (this.feeRecipient) return this.feeRecipient;
    if (!this.connection) return null;
    try {
      const [global] = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP_PROGRAM);
      const info = await this.connection.getAccountInfo(global, 'confirmed');
      if (!info) return null;
      // Global layout: 8 discriminator + 1 initialized + 32 authority + 32 feeRecipient
      this.feeRecipient = new PublicKey(info.data.subarray(41, 73));
      return this.feeRecipient;
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
  public async buildBuy(params: {
    user: PublicKey;
    mint: string;
    solAmount: number;
    slippagePct: number;
    priorityFeeSol: number;
  }): Promise<{ tx: VersionedTransaction; tokensOutRaw: bigint; detail: string } | null> {
    try {
      if (!this.connection) return null;
      if (!this.blockhash || Date.now() - this.blockhashFetchedAt > 60_000) return null;

      const mint = new PublicKey(params.mint);
      const [feeRecipient, curve] = await Promise.all([this.getFeeRecipient(), this.getCurveState(mint)]);
      if (!feeRecipient) return null;
      if (!curve || curve.complete) return null; // migrated or unknown -> AMM territory, not ours

      const lamportsIn = BigInt(Math.floor(params.solAmount * 1e9));
      const tokensOut = bondingCurveTokensOut(lamportsIn, curve.virtualSolReserves, curve.virtualTokenReserves);
      if (tokensOut <= 0n) return null;
      const maxSolCost = (lamportsIn * BigInt(Math.floor((100 + params.slippagePct) * 100))) / 10_000n;

      const p = this.pdas(mint, params.user, curve.creator);

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
            { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
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
          { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: p.creatorVault, isSigner: false, isWritable: true },
          { pubkey: p.eventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
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
