import * as fs from 'fs';
import * as path from 'path';
import { installPath } from './installPaths';

/**
 * Durable log beside the exe (same base-dir rule as loadEnv/keyStore: the
 * exe's own directory when packaged, cwd in dev — a Task Scheduler launch has
 * cwd C:\Windows\System32, and a log written there is a log nobody finds).
 *
 * WHY (2026-08-23): the live session that stranded a real position left NO
 * evidence on disk — the engine log is an in-memory ring of 300 lines, the
 * copy feed auto-clears every 2 minutes, and both die with the process. The
 * whole diagnosis was only possible because the exe happened to still be
 * running. Everything console-visible now also lands in `bot.log`.
 *
 * Writes are buffered and flushed asynchronously every 250ms — a sync append
 * per line would put file I/O (and any AV/sync-tool stall on it) on the same
 * hot path the snipe timings are measured on. The last partial buffer is
 * flushed synchronously at process exit. Rotation at 5 MB; a rotation blocked
 * by a file lock is retried on every flush rather than silently abandoned.
 */
// Resolved through the SHARED helper, which honours SNIPER_DATA_DIR — the
// per-user app-data path electron/main.js sets. This file re-derived the rule
// and missed that branch, so under the installed desktop app (not `process.pkg`)
// it fell through to process.cwd(): C:\Windows\System32 from a Start-menu
// shortcut, or the read-only Program Files install directory. Every append
// then failed, and every failure is swallowed by design here — so the ONLY
// durable forensic artifact this bot produces did not exist for exactly the
// users who run the installer, while positions and copy state (which do use
// installPath) landed correctly in AppData.
//
// That is why an incident report can arrive with no way to tell a phantom
// position from a real one: the log line that records which flags were live,
// and every ⚠️/❌ the engine emitted, had nowhere to go.
const LOG_FILE = installPath('bot.log');
const MAX_BYTES = 5 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 250;

let bytesWritten = -1;
let installed = false;
let buffer: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let asyncWriteInFlight = false;
/** Payload handed to fs.appendFile and not yet confirmed written — recovered by the sync exit flush so process.exit cannot eat the newest lines. */
let inFlightChunk = '';

function rotateIfDue(): void {
  if (bytesWritten <= MAX_BYTES) return;
  try {
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    bytesWritten = 0;
  } catch { /* held open by AV/sync — keep appending, retry on the next flush */ }
}

function flush(sync: boolean): void {
  // The exit flush also recovers a chunk the threadpool may not have written
  // yet (process.exit does not drain pending appendFile work). If that write
  // did land, the chunk appears twice — in a forensic log, a duplicated line
  // beats a vanished one.
  const chunk = sync ? inFlightChunk + buffer.join('') : buffer.join('');
  if (!chunk || (asyncWriteInFlight && !sync)) return;
  if (sync) inFlightChunk = '';
  buffer = [];
  try {
    if (bytesWritten < 0) {
      bytesWritten = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    }
    rotateIfDue();
    bytesWritten += Buffer.byteLength(chunk);
    if (sync) {
      fs.appendFileSync(LOG_FILE, chunk);
    } else {
      asyncWriteInFlight = true;
      inFlightChunk = chunk;
      fs.appendFile(LOG_FILE, chunk, () => { asyncWriteInFlight = false; inFlightChunk = ''; });
    }
  } catch { asyncWriteInFlight = false; inFlightChunk = ''; /* logging must never break trading */ }
}

export function appendBotLog(line: string): void {
  buffer.push(`${new Date().toISOString()} ${line}\n`);
  if (!flushTimer) {
    flushTimer = setInterval(() => flush(false), FLUSH_INTERVAL_MS);
    // The log must never be what keeps the process alive.
    flushTimer.unref?.();
    process.on('exit', () => flush(true));
  }
}

/** Tee console.log/warn/error into the file. Idempotent. */
export function installConsoleTee(): void {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      appendBotLog(`[${level}] ${args.map(formatArg).join(' ')}`);
    };
  }
  appendBotLog(`[log] ---- console tee installed (pid ${process.pid}) ----`);
}

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}
