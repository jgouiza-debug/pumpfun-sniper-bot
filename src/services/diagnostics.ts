import { splitWalletIntoSlots } from './pipelineUtils';

/**
 * "Why is the bot not trading?" answered by the bot itself.
 *
 * Every failure in this project's history presented the same way: the UI looked
 * fine, nothing traded, and the real reason was one line buried in a log the
 * operator never sees — a rejected Helius key answering 401 thousands of times,
 * a pre-sign guard refusing every transaction, split sizing computing a 0 SOL
 * stake so every leader buy was skipped, copy trading simply switched off. Each
 * of those cost hours to find by hand.
 *
 * This turns that guesswork into a list. It is a PURE function of state the
 * server already has, so it is cheap to poll and can be tested without a chain.
 */

export type DiagnosticLevel = 'critical' | 'warning' | 'info';

export interface Diagnostic {
  level: DiagnosticLevel;
  /** Short label, e.g. "Helius key rejected". */
  title: string;
  /** What is actually true right now. */
  detail: string;
  /** What the operator should do about it. Empty when nothing is required. */
  fix: string;
}

export interface DiagnosticsInput {
  engine: {
    isBotActive: boolean;
    tradingMode: string;
    walletAddress?: string | null;
    solBalance?: number;
    deployableSol?: number;
    rpcHealthy?: boolean;
    /** Newest first. */
    logs?: Array<{ level: string; message: string; timestamp: number }>;
  };
  copy: {
    enabled: boolean;
    tradingMode: string;
    streamConnected: boolean;
    heliusConnected: boolean;
    config: {
      maxOpenPositions: number;
      buySizeMode: string;
      fixedBuySol: number;
      maxSlippagePct: number;
      copySells: boolean;
    };
    wallets: Array<{
      address: string;
      buysSeen: number;
      copiedBuys: number;
      skippedSignals: number;
      addedAt?: number;
      lastSeenAt?: number | null;
    }>;
    openPositions: number;
  };
  rpc: {
    credentialRejected: boolean;
    consecutiveFailures: number;
    lastError?: string | null;
  };
  heliusKeySet: boolean;
  priorityFeeSol: number;
  /** Injected so the result is deterministic in tests. */
  now: number;
}

const MIN = 60_000;

export function runDiagnostics(i: DiagnosticsInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add = (level: DiagnosticLevel, title: string, detail: string, fix = '') =>
    out.push({ level, title, detail, fix });

  // ---- Credentials and connectivity: nothing works without these ----
  if (!i.heliusKeySet) {
    add('critical', 'No Helius API key',
      'Every RPC call falls back to the public endpoint, which is heavily rate limited. Launch snipes will not land.',
      'Paste a Helius key in Settings. It is a 36-character UUID from dashboard.helius.dev.');
  } else if (i.rpc.credentialRejected) {
    add('critical', 'Helius rejected your API key',
      'The key is set but the server refuses it. Nothing that needs RPC works: no launch feed, no leader watching, no buys.',
      'Replace the key in Settings. A Helius key looks like 1234abcd-12ab-34cd-56ef-1234567890ab.');
  }

  if (i.engine.rpcHealthy === false) {
    add('critical', 'RPC is down',
      i.rpc.lastError
        ? `The last call failed: ${String(i.rpc.lastError).slice(0, 140)}`
        : `${i.rpc.consecutiveFailures} consecutive RPC failures.`,
      'Check the key and your connection. Repeated 429s mean the key is over its rate limit.');
  }

  // ---- Copy trading: the reasons it silently does nothing ----
  if (!i.copy.wallets.length) {
    add('warning', 'No leader wallets tracked',
      'Copy trading has nobody to follow, so it will never open a position.',
      'Add a leader wallet on the Copy Trading page.');
  } else if (!i.copy.enabled) {
    add('warning', 'Copy trading is switched off',
      `${i.copy.wallets.length} leader(s) are configured but the master switch is off, so their trades are ignored.`,
      'Turn copy trading on.');
  }

  if (i.copy.enabled && !i.copy.streamConnected) {
    add('critical', 'Leader feed disconnected',
      'The PumpPortal stream is down, so leader trades are not being seen at all.',
      'It reconnects automatically. If it stays down, check your connection.');
  }
  if (i.copy.enabled && !i.copy.heliusConnected) {
    add('critical', 'On-chain leader watcher disconnected',
      'The Helius websocket is down. Leader buys and sells will be missed while it is.',
      'Usually a rejected or rate-limited Helius key — check the key first.');
  }

  // ---- Sizing: computes 0 and every signal is skipped ----
  if (i.copy.enabled && i.copy.config.buySizeMode === 'split') {
    const free = Math.max(1, i.copy.config.maxOpenPositions - i.copy.openPositions);
    const { stakePerSlotSol } = splitWalletIntoSlots({
      deployableSol: Math.max(0, i.engine.deployableSol ?? 0),
      slots: free,
      maxSlippagePct: i.copy.config.maxSlippagePct,
      priorityFeeSol: i.priorityFeeSol,
    });
    if (stakePerSlotSol <= 0 && i.copy.tradingMode !== 'paper') {
      add('critical', 'Split sizing stakes 0 SOL — every buy will be skipped',
        `Splitting ${(i.engine.deployableSol ?? 0).toFixed(4)} SOL across ${free} slot(s) leaves nothing per trade after fees and the slippage buffer.`,
        `Lower max open positions, switch to fixed sizing, or add SOL to the wallet.`);
    } else if (stakePerSlotSol > 0 && stakePerSlotSol < 0.005) {
      add('warning', 'Each copy trade is tiny',
        `Split sizing stakes ${stakePerSlotSol.toFixed(5)} SOL per trade across ${free} slot(s).`,
        'Lower max open positions so each trade gets a usable size.');
    }
  }

  // ---- Real mode preconditions ----
  if (i.copy.tradingMode !== 'paper' || i.engine.tradingMode !== 'paper') {
    if (!i.engine.walletAddress) {
      add('critical', 'Real mode with no wallet linked',
        'Real trading is selected but no signing wallet is loaded, so no order can be sent.',
        'Link your wallet key in Settings, or switch to paper.');
    } else if ((i.engine.solBalance ?? 0) <= 0.005) {
      add('critical', 'Wallet is empty',
        `${(i.engine.solBalance ?? 0).toFixed(4)} SOL is not enough to cover fees, let alone a trade.`,
        'Fund the wallet or switch to paper.');
    }
  }

  // ---- Leaders that will never produce a signal ----
  for (const w of i.copy.wallets) {
    const trackedMin = w.addedAt ? (i.now - w.addedAt) / MIN : 0;
    if (trackedMin > 30 && w.buysSeen === 0) {
      add('info', 'A leader has produced no buys',
        `${w.address.slice(0, 8)}… has been tracked for ${Math.round(trackedMin)} minutes with no copyable buy. Wallets that only spam failed or non-trade transactions never emit one.`,
        'Track a wallet that lands real pump.fun trades.');
    } else if (w.buysSeen >= 10 && w.skippedSignals > w.copiedBuys * 2) {
      add('warning', 'Most of a leader\'s buys are being skipped',
        `${w.address.slice(0, 8)}…: ${w.copiedBuys} copied, ${w.skippedSignals} skipped out of ${w.buysSeen} seen.`,
        'Open the copy feed to see the skip reasons — usually the open-position cap or sizing.');
    }
  }

  // ---- Whatever the engine itself last complained about ----
  const recentErrors = (i.engine.logs ?? [])
    .filter((l) => l.level === 'error' && i.now - l.timestamp < 15 * MIN)
    .slice(0, 5);
  for (const e of recentErrors) {
    add('critical', 'Engine error', e.message.slice(0, 240),
      /Refusing to sign/.test(e.message)
        ? 'A safety check blocked this transaction before signing. The message says which one.'
        : '');
  }

  if (!i.engine.isBotActive && i.copy.wallets.length === 0) {
    add('info', 'Sniper engine is paused',
      'Automatic launch sniping is off. Copy trading runs independently of this switch.',
      'Start the bot if you want launch sniping too.');
  }

  return out;
}

/** Worst level present, for a one-glance indicator. */
export function worstLevel(list: Diagnostic[]): DiagnosticLevel | 'ok' {
  if (list.some((d) => d.level === 'critical')) return 'critical';
  if (list.some((d) => d.level === 'warning')) return 'warning';
  if (list.length) return 'info';
  return 'ok';
}
