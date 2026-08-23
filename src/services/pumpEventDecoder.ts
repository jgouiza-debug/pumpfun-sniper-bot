import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';

/**
 * pump.fun TradeEvent straight from a transaction's log lines.
 *
 * WHY: the copy trader learns about a leader's trade from a `logsSubscribe`
 * notification at 'processed' — but classifying it needed the transaction
 * itself, which `getTransaction` only serves once 'confirmed', 0.5–1.2s
 * later. pump.fun's program logs every trade as an Anchor event
 * (`Program data: <base64>` carrying a TradeEvent), so for the venue this bot
 * lives on the whole signal — mint, side, SOL, tokens, trader — is already in
 * the notification. Decoding it here lets the copy order leave before the
 * leader's own transaction is confirmed.
 *
 * Verified against live transactions on 2026-08-23: one TradeEvent line per
 * trade, 358–359 bytes (newer fields appended over time); the leading 129
 * bytes are the original layout and the only ones read here.
 */

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/** Anchor event discriminator: sha256("event:TradeEvent")[0..8]. */
export const TRADE_EVENT_DISCRIMINATOR: Buffer = createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8);

const PROGRAM_DATA_PREFIX = 'Program data: ';
/** disc(8) mint(32) sol(8) tokens(8) isBuy(1) user(32) ts(8) vSol(8) vTok(8) rSol(8) rTok(8) */
const TRADE_EVENT_MIN_BYTES = 129;

/** pump.fun mints are minted with 6 decimals. */
export const PUMP_TOKEN_DECIMALS = 6;

export interface PumpTradeEvent {
  mint: string;
  user: string;
  isBuy: boolean;
  solLamports: bigint;
  tokenRaw: bigint;
  timestamp: number;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
}

export function decodeTradeEvent(data: Buffer): PumpTradeEvent | null {
  if (data.length < TRADE_EVENT_MIN_BYTES) return null;
  if (!data.subarray(0, 8).equals(TRADE_EVENT_DISCRIMINATOR)) return null;
  try {
    let o = 8;
    const mint = new PublicKey(data.subarray(o, o + 32)).toBase58(); o += 32;
    const solLamports = data.readBigUInt64LE(o); o += 8;
    const tokenRaw = data.readBigUInt64LE(o); o += 8;
    const isBuy = data.readUInt8(o) === 1; o += 1;
    const user = new PublicKey(data.subarray(o, o + 32)).toBase58(); o += 32;
    const timestamp = Number(data.readBigInt64LE(o)); o += 8;
    const virtualSolReserves = data.readBigUInt64LE(o); o += 8;
    const virtualTokenReserves = data.readBigUInt64LE(o); o += 8;
    const realSolReserves = data.readBigUInt64LE(o); o += 8;
    const realTokenReserves = data.readBigUInt64LE(o);
    return {
      mint, user, isBuy, solLamports, tokenRaw, timestamp,
      virtualSolReserves, virtualTokenReserves, realSolReserves, realTokenReserves,
    };
  } catch {
    return null;
  }
}

/**
 * Every TradeEvent the pump.fun program emitted in a transaction. `Program
 * data:` lines are attributed to the program executing at that point (tracked
 * from the `invoke` / `success` / `failed` lines), so an unrelated program
 * that emits an event with the same discriminator is not mistaken for a
 * pump.fun trade.
 */
export function tradeEventsFromLogs(logs: readonly string[]): PumpTradeEvent[] {
  const out: PumpTradeEvent[] = [];
  const stack: string[] = [];
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    const done = /^Program (\S+) (success|failed)/.exec(line);
    if (done) {
      if (stack.length && stack[stack.length - 1] === done[1]) stack.pop();
      continue;
    }
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    if (stack[stack.length - 1] !== PUMP_PROGRAM_ID) continue;
    let bytes: Buffer;
    try { bytes = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length), 'base64'); } catch { continue; }
    const ev = decodeTradeEvent(bytes);
    if (ev) out.push(ev);
  }
  return out;
}

/** Realized price of the trade in SOL per token; 0 when either side is empty. */
export function tradeEventPriceSol(ev: PumpTradeEvent): number {
  const sol = Number(ev.solLamports) / 1e9;
  const tokens = Number(ev.tokenRaw) / 10 ** PUMP_TOKEN_DECIMALS;
  return sol > 0 && tokens > 0 ? sol / tokens : 0;
}
