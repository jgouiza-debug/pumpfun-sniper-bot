import { Connection, PublicKey } from '@solana/web3.js';
import { RugCheckReport } from '../types';

/**
 * Sell-path safety checks. Flag: honeypotChecks.
 *
 * WHY: RiskFilter shipped with `sellSimPassed = true`, `notHoneypot = true` and
 * `noToken2022Hooks = true` — three hardcoded constants, so the entire
 * blocked-sell scam class was undetectable. A honeypot is a blocked SELL path,
 * which a buy-side check can never catch.
 *
 * HONEST LIMIT: a true sell simulation requires already holding the token, so
 * it cannot run before the first buy. What CAN be verified up front is the
 * machinery a honeypot needs:
 *   1. Freeze authority — lets the creator freeze your account so you cannot sell.
 *   2. Token-2022 transfer hooks — arbitrary program logic on every transfer,
 *      the standard way to make sells revert.
 *   3. Token-2022 transfer fees — a 100% fee is a sell block wearing a hat.
 *   4. RugCheck danger flags — their own detectors, already paid for.
 * Together these cover the mechanisms; they are not a substitute for the
 * post-buy sell simulation in `simulateSellPath`, which IS a real test.
 */

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/** Token-2022 extension discriminators that can block or tax a sell. */
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_PERMANENT_DELEGATE = 12;
const EXT_TRANSFER_HOOK = 14;
const EXT_DEFAULT_ACCOUNT_STATE = 6; // can default every new account to frozen

export interface HoneypotVerdict {
  safe: boolean;
  reasons: string[];
  /** Fields we could not verify, so callers can treat unknown as unknown. */
  unverified: string[];
  details: {
    tokenProgram: 'spl' | 'token-2022' | 'unknown';
    freezeAuthorityActive: boolean | null;
    hasTransferHook: boolean;
    hasTransferFee: boolean;
    hasPermanentDelegate: boolean;
    defaultsFrozen: boolean;
    rugcheckDangers: string[];
  };
}

/**
 * Inspects the mint account itself. This is the pre-buy check.
 * Never throws — an unreachable RPC yields `unverified`, not a false pass.
 */
export async function inspectMintSafety(
  connection: Connection,
  mint: string,
  rug: RugCheckReport | null
): Promise<HoneypotVerdict> {
  const reasons: string[] = [];
  const unverified: string[] = [];
  const details: HoneypotVerdict['details'] = {
    tokenProgram: 'unknown',
    freezeAuthorityActive: null,
    hasTransferHook: false,
    hasTransferFee: false,
    hasPermanentDelegate: false,
    defaultsFrozen: false,
    rugcheckDangers: [],
  };

  // --- RugCheck's own danger flags (free, already fetched) ---
  if (rug && !rug.isInferred && Array.isArray(rug.risks)) {
    for (const r of rug.risks) {
      const name = String(r?.name || '');
      const level = String(r?.level || '').toLowerCase();
      if (level === 'danger') {
        details.rugcheckDangers.push(name);
        if (/honeypot|freeze|transfer.?fee|transfer.?hook|non.?transferable|blacklist/i.test(name)) {
          reasons.push(`RugCheck danger: ${name}`);
        }
      }
    }
  } else {
    unverified.push('rugcheckRisks');
  }

  // --- The mint account itself ---
  try {
    const info = await connection.getAccountInfo(new PublicKey(mint), 'confirmed');
    if (!info) {
      unverified.push('mintAccount');
      return { safe: reasons.length === 0, reasons, unverified, details };
    }

    const owner = info.owner.toBase58();
    if (owner === TOKEN_PROGRAM.toBase58()) details.tokenProgram = 'spl';
    else if (owner === TOKEN_2022_PROGRAM.toBase58()) details.tokenProgram = 'token-2022';
    else {
      details.tokenProgram = 'unknown';
      reasons.push(`Mint owned by an unexpected program (${owner.slice(0, 8)}...)`);
    }

    const data = info.data;
    // Base Mint layout (82 bytes): freeze authority is COption<Pubkey> at 46,
    // i.e. a 4-byte tag then 32 bytes of key.
    if (data.length >= 82) {
      const freezeTag = data.readUInt32LE(46);
      details.freezeAuthorityActive = freezeTag === 1;
      if (freezeTag === 1) {
        reasons.push('Freeze authority is active — holders can be frozen out of selling');
      }
    } else {
      unverified.push('freezeAuthority');
    }

    // Token-2022 packs TLV extensions after the 165-byte account type marker.
    if (details.tokenProgram === 'token-2022' && data.length > 166) {
      let cursor = 166;
      while (cursor + 4 <= data.length) {
        const extType = data.readUInt16LE(cursor);
        const extLen = data.readUInt16LE(cursor + 2);
        if (extType === 0 || extLen === 0 && extType === 0) break;

        if (extType === EXT_TRANSFER_HOOK) {
          details.hasTransferHook = true;
          reasons.push('Token-2022 transfer hook present — arbitrary code runs on every transfer and can block sells');
        } else if (extType === EXT_TRANSFER_FEE_CONFIG) {
          details.hasTransferFee = true;
          reasons.push('Token-2022 transfer fee present — sells can be taxed arbitrarily');
        } else if (extType === EXT_PERMANENT_DELEGATE) {
          details.hasPermanentDelegate = true;
          reasons.push('Token-2022 permanent delegate — a third party can move your tokens at will');
        } else if (extType === EXT_DEFAULT_ACCOUNT_STATE) {
          details.defaultsFrozen = true;
          reasons.push('Token-2022 default account state — new accounts can be created frozen');
        }

        cursor += 4 + extLen;
        if (extLen === 0) break; // malformed TLV; stop rather than spin
      }
    }
  } catch {
    unverified.push('mintAccount');
  }

  return { safe: reasons.length === 0, reasons, unverified, details };
}

/**
 * A REAL sell simulation, for a token already held.
 *
 * Builds the sell through the normal execution path and asks the RPC to run it
 * without submitting. If simulation reverts, the sell path is blocked — this is
 * the check that actually proves a honeypot, and the only way to run it is to
 * hold the token first.
 *
 * @returns null when the simulation itself could not be performed (unknown),
 *          true when the sell would succeed, false when it would revert.
 */
export async function simulateSellPath(
  connection: Connection,
  buildSellTx: () => Promise<{ serialize(): Uint8Array } | null>,
  log?: (msg: string) => void
): Promise<boolean | null> {
  try {
    const tx = await buildSellTx();
    if (!tx) return null;

    const { VersionedTransaction } = await import('@solana/web3.js');
    const vtx = VersionedTransaction.deserialize(tx.serialize());
    const sim = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });

    if (sim.value.err) {
      log?.(`sell simulation FAILED: ${JSON.stringify(sim.value.err)} | ${(sim.value.logs || []).slice(-3).join(' | ')}`);
      return false;
    }
    return true;
  } catch {
    return null;
  }
}
