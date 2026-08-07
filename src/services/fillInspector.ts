import { Connection, PublicKey } from '@solana/web3.js';

/**
 * What a confirmed transaction actually did to our wallet — straight from the
 * chain's balance deltas, not from any price feed.
 */
export interface ActualFill {
  txid: string;
  /** SOL change for our wallet. Negative on a buy, positive on a sell. Network fees included. */
  solDelta: number;
  /** Token change for our wallet on the traded mint. Positive on a buy. */
  tokenDelta: number;
  /** Network fee paid (informational — already reflected in solDelta). */
  feeSol: number;
  slot: number;
}

/**
 * Reads the actual fill of a confirmed swap.
 *
 * Why this exists: quotes are opinions, balance deltas are facts. A meme-coin
 * fill can differ from the screen-time quote by double-digit percent (slippage,
 * bonding-curve impact, pump.fun 1% + PumpPortal 0.5% fees, priority fee), and
 * PnL computed from quotes told the operator they were up while their wallet
 * was down. Everything downstream (position cost basis, realized PnL, reports)
 * should prefer these numbers.
 *
 * Returns null when the transaction failed on-chain or cannot be fetched in
 * time — callers keep their estimates and mark the record unverified.
 */
export async function inspectFill(
  connection: Connection,
  txid: string,
  ownerAddress: string,
  mint: string,
  opts: { retries?: number; delayMs?: number } = {}
): Promise<ActualFill | null> {
  const retries = opts.retries ?? 6;
  const delayMs = opts.delayMs ?? 1500;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const tx = await connection.getParsedTransaction(txid, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx || !tx.meta) {
        // Confirmed transactions can lag the query index by a few seconds.
        await sleep(delayMs);
        continue;
      }

      if (tx.meta.err) return null; // landed but failed — no fill happened

      const keys = tx.transaction.message.accountKeys;
      const ownerIndex = keys.findIndex(k => k.pubkey.toBase58() === ownerAddress);
      if (ownerIndex === -1) return null;

      const solDelta = (tx.meta.postBalances[ownerIndex] - tx.meta.preBalances[ownerIndex]) / 1e9;

      const sumTokens = (balances: typeof tx.meta.preTokenBalances) =>
        (balances || [])
          .filter(b => b.mint === mint && b.owner === ownerAddress)
          .reduce((acc, b) => acc + (b.uiTokenAmount.uiAmount || 0), 0);

      const tokenDelta = sumTokens(tx.meta.postTokenBalances) - sumTokens(tx.meta.preTokenBalances);

      return {
        txid,
        solDelta: Number(solDelta.toFixed(9)),
        tokenDelta,
        feeSol: Number(((tx.meta.fee || 0) / 1e9).toFixed(9)),
        slot: tx.slot,
      };
    } catch {
      await sleep(delayMs);
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}
