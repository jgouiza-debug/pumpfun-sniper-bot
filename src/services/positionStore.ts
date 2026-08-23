/**
 * Crash recovery for open positions.
 *
 * THE GAP THIS CLOSES: `activePositions` is a plain in-memory array. The copy
 * trader persists its state; the sniper never has. Combined with the fact that
 * nothing in this codebase re-reads a wallet's token balance, the consequence is
 * unconditional — if the process dies while holding a position, the bag is
 * orphaned permanently. The bot cannot learn it owns those tokens, so no exit
 * ever runs against them. That is a silent, uncapped loss, and it is the single
 * most direct way this bot can lose money while appearing to be fine.
 *
 * Design decisions, and why:
 *
 *   1. WRITE ON EVERY MUTATION, not on an interval. A crash is not scheduled.
 *      The write is a few hundred bytes of JSON against a handful of positions,
 *      so the cost is irrelevant next to losing one.
 *
 *   2. ATOMIC REPLACE via write-to-temp-then-rename. A process killed midway
 *      through a plain `writeFileSync` leaves truncated JSON, and a truncated
 *      state file is worse than none: it reads as "no open positions" and the
 *      bag is orphaned exactly as if nothing had been saved.
 *
 *   3. RESTORE IS A CLAIM, NOT A FACT. A restored position says "this process
 *      believed it held this". It is not proof the tokens are still there — the
 *      operator may have sold by hand, or the exit may have landed after the
 *      crash. Restored positions are therefore marked `needsReconciliation` so
 *      the caller can verify against the chain before acting on them.
 *
 *   4. NEVER THROW. A corrupt or unreadable store must not stop the bot booting;
 *      it degrades to "no known positions" and says so loudly.
 *
 * Read/write of a local JSON file only. No network, no keypair, no signing.
 */

import fs from 'fs';
import path from 'path';

export const STORE_VERSION = 1;
const STORE_FILE = '.open-positions.json';

/** The subset of position state worth surviving a restart. */
export interface PersistedPosition {
  id: string;
  mint: string;
  tokenSymbol: string;
  tokenName?: string;
  entryTime: number;
  investedSol: number;
  investedUsd: number;
  buyPriceUsd: number;
  tokensHeld: number;
  playbook?: string;
  venue?: string;
  entryTxid?: string;
  realizedPnlUsd?: number;
  legCount?: number;
}

export interface RestoredPosition extends PersistedPosition {
  /**
   * Always true on restore. The store records what a dead process believed, not
   * what the chain currently holds.
   */
  needsReconciliation: true;
}

interface StoreFile {
  version: number;
  savedAt: number;
  pid: number;
  walletAddress: string | null;
  tradingMode: string;
  positions: PersistedPosition[];
  /** Set on clean shutdown. Absent/false means the process did not exit cleanly. */
  cleanShutdown?: boolean;
}

export function positionStorePath(): string {
  // Same base-directory rule as keyStore/apiAuth/loadEnv: beside the executable
  // when packaged, so a per-install file follows the install.
  const isPackaged = Boolean((process as any).pkg);
  const baseDir = isPackaged ? path.dirname(process.execPath) : process.cwd();
  return path.join(baseDir, STORE_FILE);
}

/** Atomic replace. A crash mid-write leaves the previous good file intact. */
function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { encoding: 'utf8' });
  fs.renameSync(tmp, file);
}

export class PositionStore {
  private file: string;

  constructor(file?: string) {
    this.file = file || positionStorePath();
  }

  public getPath(): string { return this.file; }

  /**
   * Persists the current open book. Call after EVERY mutation — open, partial
   * sell, close.
   *
   * Returns false when the write failed, so a caller can surface it. Persistence
   * failing silently would recreate the exact bug this module exists to fix.
   */
  public save(
    positions: PersistedPosition[],
    meta: { walletAddress?: string | null; tradingMode?: string; cleanShutdown?: boolean } = {}
  ): boolean {
    try {
      const payload: StoreFile = {
        version: STORE_VERSION,
        savedAt: Date.now(),
        pid: process.pid,
        walletAddress: meta.walletAddress ?? null,
        tradingMode: meta.tradingMode ?? 'unknown',
        positions,
        cleanShutdown: meta.cleanShutdown === true,
      };
      writeAtomic(this.file, JSON.stringify(payload, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Loads what the previous process believed it held.
   *
   * `cleanShutdown: true` means the last process exited deliberately with these
   * positions still open — normal, not a crash. Either way the positions are
   * returned; the distinction is reported so the caller can log it accurately
   * rather than crying crash on every restart.
   */
  public load(): {
    positions: RestoredPosition[];
    crashed: boolean;
    savedAt: number | null;
    walletAddress: string | null;
    tradingMode: string | null;
    error?: string;
  } {
    const empty = {
      positions: [] as RestoredPosition[],
      crashed: false,
      savedAt: null,
      walletAddress: null,
      tradingMode: null,
    };

    let raw: string;
    try {
      if (!fs.existsSync(this.file)) return empty;
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e: any) {
      return { ...empty, error: `could not read ${this.file}: ${e?.message}` };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A truncated file is the crash-during-write case. Report it rather than
      // treating it as "nothing was open" — that silent read is the failure mode.
      return { ...empty, error: `state file is corrupt (truncated write?) — open positions may exist on-chain that this process cannot see` };
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.positions)) {
      return { ...empty, error: 'state file has an unexpected shape' };
    }
    if (parsed.version !== STORE_VERSION) {
      return { ...empty, error: `state file version ${parsed.version} != ${STORE_VERSION}` };
    }

    const positions: RestoredPosition[] = [];
    for (const p of parsed.positions) {
      if (!p || typeof p.mint !== 'string' || !p.mint) continue;
      positions.push({
        id: String(p.id ?? p.mint),
        mint: p.mint,
        tokenSymbol: String(p.tokenSymbol ?? ''),
        tokenName: p.tokenName,
        entryTime: Number(p.entryTime ?? 0),
        investedSol: Number(p.investedSol ?? 0),
        investedUsd: Number(p.investedUsd ?? 0),
        buyPriceUsd: Number(p.buyPriceUsd ?? 0),
        tokensHeld: Number(p.tokensHeld ?? 0),
        playbook: p.playbook,
        venue: p.venue,
        entryTxid: p.entryTxid,
        realizedPnlUsd: Number(p.realizedPnlUsd ?? 0),
        legCount: Number(p.legCount ?? 0),
        needsReconciliation: true,
      });
    }

    return {
      positions,
      crashed: parsed.cleanShutdown !== true,
      savedAt: Number(parsed.savedAt ?? 0) || null,
      walletAddress: parsed.walletAddress ?? null,
      tradingMode: parsed.tradingMode ?? null,
    };
  }

  /** Marks a deliberate exit so the next boot does not report a false crash. */
  public markCleanShutdown(positions: PersistedPosition[], meta: { walletAddress?: string | null; tradingMode?: string } = {}): boolean {
    return this.save(positions, { ...meta, cleanShutdown: true });
  }

  public clear(): void {
    try { if (fs.existsSync(this.file)) fs.unlinkSync(this.file); } catch { /* nothing to clear */ }
  }
}

/**
 * Human-readable restart summary. Exists so the operator sees, in one line at
 * boot, that money is on the table — the previous behaviour was total silence.
 */
export function describeRestoration(r: ReturnType<PositionStore['load']>): string {
  if (r.error) return `⚠️ POSITION STORE: ${r.error}`;
  if (!r.positions.length) return 'no open positions carried over from a previous run';
  const age = r.savedAt ? `${Math.round((Date.now() - r.savedAt) / 60000)} min ago` : 'unknown age';
  const total = r.positions.reduce((a, p) => a + (p.investedUsd || 0), 0);
  const how = r.crashed ? 'the previous process did NOT exit cleanly' : 'carried over from a clean shutdown';
  return `${r.positions.length} open position(s) worth $${total.toFixed(2)} restored (saved ${age}; ${how}). `
    + `These are UNRECONCILED — they record what the last process believed, not what the wallet holds now.`;
}
