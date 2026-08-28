import fs from 'fs';
import os from 'os';
import path from 'path';

// Machine-global, NOT cwd- or install-relative. The lock's whole job is to stop
// two instances arming live trading on the same wallet at once; keyed on cwd,
// two processes launched from different directories (or one from Task Scheduler)
// each acquired their OWN lock and both armed. os.tmpdir() is one shared path
// for every instance run by this user on this machine.
const LOCK_FILE = path.join(os.tmpdir(), 'pumpfun-sniper-real-mode.lock');

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

  /**
   * Take the lock, or report who holds it.
   *
   * `open(..., 'wx')` is the whole point: create-if-absent is one atomic
   * syscall, so two instances arming in the same moment cannot both succeed.
   * The previous read-then-write left a window between "nobody holds it" and
   * "I hold it" wide enough for the other process to win too — and both would
   * then size against the same balance and double-spend it.
   *
   * Failure is always closed: an unwritable lock means no live trading, never
   * unguarded live trading.
   */
  public acquire(port: number, instanceName: string): { ok: boolean; holder?: LockHolder } {
    const payload = JSON.stringify(
      { pid: process.pid, port, instanceName, startedAt: Date.now() } satisfies LockHolder,
      null,
      2
    );

    // Two passes at most: the second only runs after clearing a lock proven
    // stale, so this cannot spin.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(LOCK_FILE, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, payload);
        } finally {
          fs.closeSync(fd);
        }
        this.owned = true;
        return { ok: true };
      } catch (err: any) {
        if (err?.code !== 'EEXIST') return { ok: false };

        const holder = this.read();

        // Re-arming in the same process: refresh the record rather than
        // reporting ourselves as the blocker.
        if (holder && holder.pid === process.pid) {
          try {
            fs.writeFileSync(LOCK_FILE, payload);
            this.owned = true;
            return { ok: true };
          } catch {
            return { ok: false };
          }
        }

        if (holder && RealModeLock.isAlive(holder.pid)) return { ok: false, holder };

        // Unparseable, or written by a process that is gone. Note the honest
        // limit: a PID recycled onto an unrelated live process still reads as
        // "held", which fails closed — delete .real-mode.lock to clear it.
        this.forceClear();
      }
    }

    return { ok: false };
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

