import fs from 'fs';
import path from 'path';

const LOCK_FILE = path.resolve(process.cwd(), '.real-mode.lock');

export interface LockHolder {
  pid: number;
  port: number;
  instanceName: string;
  startedAt: number;
}

export interface LockState {
  /** True when this process currently owns live trading. */
  heldByThisInstance: boolean;
  /** Set when some other live process owns it. */
  heldByOther: LockHolder | null;
}

/**
 * Cross-process mutex for REAL trading mode.
 *
 * Bot instances are separate Node processes on separate ports, but they all
 * sign with the same Photon wallet. Two of them armed at once would read the
 * same balance, size against it independently and double-spend it — the second
 * buy fails on-chain at best, and at worst both land and blow the gas float.
 *
 * Paper mode is untouched: run as many simulated instances as you like.
 */
export class RealModeLock {
  private owned = false;

  private read(): LockHolder | null {
    try {
      if (!fs.existsSync(LOCK_FILE)) return null;
      const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (typeof raw?.pid !== 'number') return null;
      return raw as LockHolder;
    } catch {
      return null;
    }
  }

  /**
   * Signal 0 performs the permission/existence check without delivering a
   * signal. EPERM means the process exists but belongs to another user, which
   * still counts as alive.
   */
  private static isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      return err?.code === 'EPERM';
    }
  }

  /** Current holder, ignoring locks left behind by dead processes. */
  public getHolder(): LockHolder | null {
    const holder = this.read();
    if (!holder) return null;
    if (!RealModeLock.isAlive(holder.pid)) {
      // Crashed or killed without releasing — the lock is stale.
      this.forceClear();
      return null;
    }
    return holder;
  }

  public getState(): LockState {
    const holder = this.getHolder();
    if (!holder) return { heldByThisInstance: false, heldByOther: null };
    if (holder.pid === process.pid) return { heldByThisInstance: true, heldByOther: null };
    return { heldByThisInstance: false, heldByOther: holder };
  }

  public acquire(port: number, instanceName: string): { ok: boolean; holder?: LockHolder } {
    const holder = this.getHolder();

    if (holder && holder.pid !== process.pid) {
      return { ok: false, holder };
    }

    try {
      fs.writeFileSync(
        LOCK_FILE,
        JSON.stringify({ pid: process.pid, port, instanceName, startedAt: Date.now() } satisfies LockHolder, null, 2)
      );
      this.owned = true;
      return { ok: true };
    } catch {
      // If the lock cannot be written, fail closed rather than allowing a
      // second instance to trade unguarded.
      return { ok: false };
    }
  }

  /** Releases only if this process owns it, so we never free someone else's lock. */
  public release(): void {
    if (!this.owned) return;
    const holder = this.read();
    if (holder && holder.pid !== process.pid) {
      this.owned = false;
      return;
    }
    this.forceClear();
    this.owned = false;
  }

  private forceClear(): void {
    try {
      if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
    } catch { /* best effort */ }
  }

  public isOwned(): boolean {
    return this.owned;
  }
}

export const realModeLock = new RealModeLock();

// Release on every normal exit path so a clean shutdown never strands the lock.
// Note: We do NOT call process.exit() here — the server must keep running even
// when the bot is stopped/paused. Only a hard kill (SIGKILL) should stop it.
process.on('exit', () => realModeLock.release());
process.on('SIGINT', () => {
  realModeLock.release();
  // Allow graceful shutdown only on explicit Ctrl+C in a terminal
  process.exit(130);
});
process.on('SIGTERM', () => {
  // On SIGTERM (e.g. from a process manager), release the lock but stay alive
  realModeLock.release();
});

