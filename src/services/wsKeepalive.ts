import type WebSocket from 'ws';

/**
 * Liveness watchdog for the two WebSocket feeds the bot trades on.
 *
 * WHY (measured 2026-08-13): both `SniperEngine.subscribeStream` and
 * `CurveWatcher.connect` reconnected only from the `close` handler. A TCP
 * connection that dies without a FIN — the normal outcome of a dropped route, a
 * sleeping NIC, or an upstream proxy timing out — never fires `close`, so
 * `readyState` stays OPEN forever and the reconnect path is simply never
 * reached. That day the candidate feed went silent at 13:16:53 while the
 * process stayed alive and was still answering `/api/flags` at 13:31: not one
 * launch was seen for the rest of the session, and nothing in the logs said so.
 * A bot that is deaf looks exactly like a market with no launches.
 *
 * The fix is to stop trusting `close` as the only failure signal. We ping on an
 * interval and treat ANY inbound traffic — a data frame or a pong — as proof of
 * life. Silence past `staleMs` means the socket is gone regardless of what
 * `readyState` claims, so we `terminate()` it, which synthesises the `close`
 * event and lets each caller's existing reconnect logic run unchanged.
 *
 * `terminate()` rather than `close()` on purpose: `close()` starts a closing
 * handshake and waits for a peer that has already stopped answering, which is
 * the exact condition being handled.
 */

export interface KeepaliveOptions {
  /** How often to ping. Must be comfortably below staleMs. */
  pingMs?: number;
  /**
   * Silence tolerated before the socket is declared dead. Sized against the
   * quietest hour observed (376 launches/hour ≈ 6/min), so a healthy feed can
   * never trip it on a lull alone — and the pong keeps it honest when the feed
   * genuinely has nothing to say.
   */
  staleMs?: number;
  /** Called just before terminate, for logging. */
  onStale?: (silentMs: number) => void;
}

export interface KeepaliveHandle {
  /** Mark the socket alive. Call from the message handler. */
  touch(): void;
  /** Clear timers. Call from the close handler so a dead socket stops pinging. */
  stop(): void;
  /** Milliseconds since the last inbound frame — for health reporting. */
  silentMs(): number;
}

export function attachKeepalive(ws: WebSocket, opts: KeepaliveOptions = {}): KeepaliveHandle {
  const pingMs = opts.pingMs ?? 20_000;
  const staleMs = opts.staleMs ?? 75_000;

  let lastSeen = Date.now();
  let stopped = false;

  const touch = () => { lastSeen = Date.now(); };

  // A pong is proof of life on a feed that legitimately has nothing to send.
  ws.on('pong', touch);
  // Some servers ping us instead; ws answers automatically, but it still counts.
  ws.on('ping', touch);

  const timer = setInterval(() => {
    if (stopped) return;

    const silent = Date.now() - lastSeen;
    if (silent > staleMs) {
      opts.onStale?.(silent);
      stopped = true;
      clearInterval(timer);
      // Synthesises 'close', which is where every caller already reconnects.
      try { ws.terminate(); } catch { /* already destroyed */ }
      return;
    }

    try { ws.ping(); } catch { /* the next staleness check will catch it */ }
  }, pingMs);

  // Never hold the event loop open just to ping a socket.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    touch,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    silentMs: () => Date.now() - lastSeen,
  };
}

/**
 * Reconnect delay with exponential backoff and full jitter.
 *
 * The fixed 2s/3s retries this replaces meant an outage at the provider became
 * a tight reconnect loop from every instance at once — the behaviour most
 * likely to keep a rate-limited key rate-limited. Jitter matters because the
 * curve watcher and the launch feed would otherwise reconnect in lockstep.
 */
export function reconnectDelayMs(attempt: number, baseMs = 2_000, capMs = 30_000): number {
  const ceiling = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}
