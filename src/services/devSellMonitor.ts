/**
 * Creator / insider sell monitor. Flag: devSellStop.
 *
 * WHY: the playbook ranks structural stops ABOVE time, price and profit rules —
 * "the first cluster sell you see IS the event, not a warning of it", with 90%+
 * of insider exits completing in one or two transactions. The engine shipped
 * with `devSoldAnyClean = true` hardcoded and no creator tracking at all, so
 * its entire loss side was a -35% price stop and a 30-minute timer. By the time
 * a -35% price stop fires on a dev dump, the dump is over.
 *
 * This is cheap because the data is already flowing: every PumpPortal trade
 * event carries `traderPublicKey`, and open positions are already subscribed to
 * their own trade streams. Matching the creator address costs one map lookup.
 */

export interface TrackedCreator {
  mint: string;
  creator: string;
  /** Wallets that received tokens from the creator — the classic laundering hop. */
  linked: Set<string>;
  devSold: boolean;
  devSoldAt?: number;
  devSoldSol?: number;
  largeSells: Array<{ at: number; wallet: string; solAmount: number }>;
}

export interface StructuralAlert {
  mint: string;
  kind: 'DEV_SOLD' | 'LINKED_WALLET_SOLD' | 'LARGE_SELL_CLUSTER';
  detail: string;
  at: number;
}

export class DevSellMonitor {
  private tracked = new Map<string, TrackedCreator>();

  /** Begins watching a token's creator. Call when a position opens. */
  public track(mint: string, creator?: string): void {
    if (!mint || !creator || creator === 'Unknown') return;
    if (this.tracked.has(mint)) return;
    this.tracked.set(mint, {
      mint,
      creator,
      linked: new Set([creator]),
      devSold: false,
      largeSells: [],
    });
  }

  public untrack(mint: string): void {
    this.tracked.delete(mint);
  }

  public isTracked(mint: string): boolean {
    return this.tracked.has(mint);
  }

  public getState(mint: string): TrackedCreator | undefined {
    return this.tracked.get(mint);
  }

  /**
   * Folds one trade event in and reports a structural alert if this trade IS
   * the exit event.
   *
   * @param clusterSolThreshold a single sell above this size counts toward the
   *        coordinated-exit signal, independent of who made it.
   */
  public onTrade(payload: any, nowMs = Date.now(), clusterSolThreshold = 1.5): StructuralAlert | null {
    const state = this.tracked.get(payload?.mint);
    if (!state) return null;

    const wallet: string = payload.traderPublicKey || '';
    const isSell = payload.txType === 'sell';
    const solAmount = Number(payload.solAmount) || 0;
    if (!wallet) return null;

    if (isSell) {
      if (wallet === state.creator && !state.devSold) {
        state.devSold = true;
        state.devSoldAt = nowMs;
        state.devSoldSol = solAmount;
        return {
          mint: state.mint,
          kind: 'DEV_SOLD',
          detail: `creator ${wallet.slice(0, 6)}... sold ${solAmount.toFixed(3)} SOL`,
          at: nowMs,
        };
      }

      if (state.linked.has(wallet) && wallet !== state.creator) {
        return {
          mint: state.mint,
          kind: 'LINKED_WALLET_SOLD',
          detail: `creator-linked wallet ${wallet.slice(0, 6)}... sold ${solAmount.toFixed(3)} SOL`,
          at: nowMs,
        };
      }

      if (solAmount >= clusterSolThreshold) {
        // Keep only a 60s window: a coordinated exit is fast, and stale sells
        // must not accumulate into a false cluster.
        state.largeSells = state.largeSells.filter(s => nowMs - s.at < 60_000);
        state.largeSells.push({ at: nowMs, wallet, solAmount });

        const distinct = new Set(state.largeSells.map(s => s.wallet));
        if (distinct.size >= 3) {
          const total = state.largeSells.reduce((a, s) => a + s.solAmount, 0);
          return {
            mint: state.mint,
            kind: 'LARGE_SELL_CLUSTER',
            detail: `${distinct.size} wallets dumped ${total.toFixed(2)} SOL within 60s`,
            at: nowMs,
          };
        }
      }
      return null;
    }

    // Not a sell: record creator-funded recipients so a dev dumping through a
    // fresh wallet is still caught. A buy by a wallet the creator funded is a
    // weaker signal, so it is only recorded, never alerted on.
    if (payload.txType === 'buy' && wallet === state.creator) {
      state.linked.add(wallet);
    }
    return null;
  }

  /** Registers wallets known to be funded by the creator (from RugCheck insiders). */
  public addLinkedWallets(mint: string, wallets: string[]): void {
    const state = this.tracked.get(mint);
    if (!state) return;
    for (const w of wallets) if (w) state.linked.add(w);
  }

  public size(): number {
    return this.tracked.size;
  }
}

export const devSellMonitor = new DevSellMonitor();
