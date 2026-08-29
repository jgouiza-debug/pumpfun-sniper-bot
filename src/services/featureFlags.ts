import fs from 'fs';
import path from 'path';

/**
 * Every behavior change from the 2026-08 latency/decision audit ships behind
 * one of these flags, default OFF, so live behavior is byte-identical until a
 * flag is deliberately enabled — after shadow validation, per the audit rules.
 *
 * Resolution order (highest wins): env var FLAG_<SNAKE_CASE> = 1/0/true/false,
 * then flags.json at the repo root, then the defaults below.
 */
export interface FeatureFlagSet {
  /** Gate candidates with EntryGateV2 (real payload + RugCheck data) instead of the legacy fabricated-input gate. */
  entryGateV2: boolean;
  /** Run EntryGateV2 alongside the legacy gate, log both verdicts + divergence, trade on legacy only. Enable this first. */
  shadowGateV2: boolean;
  /** Treat only txType === 'migrate' as a migration. Legacy also fires on vSolInBondingCurve >= 70, which mislabels big-dev-buy creates. */
  strictMigrationDetect: boolean;
  /** Dynamic priority fee from getRecentPrioritizationFees (p75, floored at config.priorityFeeSol, capped at maxPriorityFeeSol and 5% of position). */
  dynamicPriorityFee: boolean;
  /** Build bonding-curve buy transactions locally instead of the PumpPortal trade-local HTTP hop. Requires a clean shadow compare first. */
  localTxBuild: boolean;
  /** Build locally AND via trade-local, submit trade-local, log a structural diff. Zero behavior change; produces the evidence for localTxBuild. */
  localTxShadowCompare: boolean;
  /** Evaluate position exits concurrently instead of serially (one slow sell no longer blocks every other exit for up to ~40s). Exit triggers unchanged. */
  concurrentExits: boolean;
  /** Auto-pause the bot when realized losses in a rolling hour exceed config.maxHourlyLossUsd. */
  killSwitch: boolean;
  /** Sample the current slot at candidate arrival for the T0-T7 timeline (adds one cheap RPC call per candidate). */
  timelineSlotSampling: boolean;
  /**
   * Paper trading prices fills off the real curve/pool and charges the full
   * fee stack, and stops inventing price movement for unpriced positions.
   * Without this, paper P&L is a random walk with a +40%/min drift and no
   * costs — it cannot predict live results. Affects PAPER MODE ONLY.
   */
  honestPaper: boolean;
  /**
   * Warn on entries whose round-trip cost exceeds maxBreakevenPct of position
   * size. ADVISORY since 2026-08-12 (owner decision: everything in the wallet
   * is tradeable no matter the amount) — it used to refuse those entries.
   */
  enforceTradeEconomics: boolean;
  /**
   * Route entries by measured curve phase (Plays 2/3/4) instead of the legacy
   * vSol>=70 "migration" guess, and watch promising creates via their trade
   * stream so mid-curve entries become possible at all.
   */
  playbookRouting: boolean;
  /**
   * Replace the hardcoded `sellSimPassed/notHoneypot/noToken2022Hooks = true`
   * stubs with real mint inspection: freeze authority, Token-2022 transfer
   * hooks/fees/permanent delegate, and RugCheck danger flags.
   */
  honeypotChecks: boolean;
  /**
   * Structural stop: exit immediately when the creator (or a creator-linked
   * wallet) sells, or when several wallets dump together. Ranks above time and
   * price stops, per the playbook.
   */
  devSellStop: boolean;
  /**
   * Spends 100% of available deployable balance on every trade entry without budget limits.
   */
  allInSizing: boolean;
  /**
   * Play 1: buy fresh creates inside the block-0 window the router otherwise
   * bans, skipping the RugCheck/DexScreener screen entirely (it costs seconds
   * and has no data for a seconds-old mint anyway). Tuned by the
   * launchSnipe* fields on BotConfig. The honeypot sell-path check still runs
   * post-fill. HIGH RISK BY DESIGN: this is the insider-dominated window with
   * the highest rug density — opt-in, owner decision 2026-08-12.
   */
  launchSnipe: boolean;
}

/**
 * Shipped defaults, before env overrides or flags.json are applied. Exported so
 * tests can assert what the code ships with rather than whatever the operator
 * has since toggled at runtime.
 */
export const DEFAULTS: FeatureFlagSet = {
  entryGateV2: false,
  shadowGateV2: false,
  strictMigrationDetect: false,
  dynamicPriorityFee: false,
  localTxBuild: false,
  localTxShadowCompare: false,
  concurrentExits: false,
  killSwitch: false,
  timelineSlotSampling: false,
  honestPaper: false,
  enforceTradeEconomics: false,
  playbookRouting: false,
  honeypotChecks: false,
  devSellStop: false,
  allInSizing: true,
  launchSnipe: false,
};

/**
 * What a PACKAGED build runs when no flags.json is supplied.
 *
 * DEFAULTS above is "legacy behaviour, everything off" — correct for the audit
 * rollout on a dev machine that always had a flags.json, and actively dangerous
 * for a distributed binary that does not. Measured 2026-08-10 by running the
 * built exe from a clean directory: it reported `Enabled: allInSizing` — i.e.
 * all-in position sizing ON with the honeypot check, dev-sell stop, economics
 * gate, kill switch and honest-paper accounting all OFF. That is the single
 * worst combination this codebase can produce, and it is what anyone handed the
 * exe would have run.
 *
 * These are the flags the project actually operates with.
 */
export const PACKAGED_DEFAULTS: FeatureFlagSet = {
  ...DEFAULTS,
  shadowGateV2: true,
  strictMigrationDetect: true,
  killSwitch: true,
  honestPaper: true,
  enforceTradeEconomics: true,
  playbookRouting: true,
  honeypotChecks: true,
  devSellStop: true,
  allInSizing: false,
  // 2026-08-13 promotions. Each of these was written, tested and left OFF,
  // which meant the live path kept running the code they were built to replace.
  //
  // entryGateV2: refuses on measured data and treats unknown as unsafe, instead
  //   of the legacy gate whose Gate 0 hardcoded ten of its own checks to true.
  // dynamicPriorityFee: p75 of recent fees, clamped. A static 0.001 loses races
  //   when the chain is busy and overpays when it is quiet.
  // timelineSlotSampling: t5/t6/t7 have ZERO samples on record, so the build →
  //   submit → land phase — where the 2.55x fill happened — is unmeasured.
  entryGateV2: true,
  dynamicPriorityFee: true,
  timelineSlotSampling: true,
  // localTxBuild / localTxShadowCompare stay OFF by default (inherited from
  // DEFAULTS). They build the pump.fun instruction locally and PROVE it by
  // simulation before signing — which means several getAccountInfo +
  // simulateTransaction calls PER trade, plus a fee-recipient walk. Measured
  // 2026-08-29 on a live real-mode session with an active leader: that burst
  // rate-limited the Helius key (a 429 storm) and every trade — and the leader
  // watcher sharing the key — slowed to a crawl, which read as "buys are
  // delayed / not showing up". The pre-sign guard now allow-lists PumpPortal's
  // router, so trade-local (one HTTP call, no per-trade RPC) works and is
  // faster. Local building remains available as an opt-in for operators who
  // want PumpPortal independence AND have RPC headroom; it is not the default.
};

/**
 * Flags that intentionally differ between a dev checkout and a packaged build.
 *
 * Pinned so drift has to be deliberate: add a flag to PACKAGED_DEFAULTS without
 * listing it here and the test suite fails, which is the point. DEFAULTS is
 * "legacy behaviour, everything off"; this list is every place the shipped
 * product knowingly departs from it.
 */
export const INTENDED_PACKAGED_DIVERGENCE: Array<keyof FeatureFlagSet> = [
  'shadowGateV2',
  'strictMigrationDetect',
  'killSwitch',
  'honestPaper',
  'enforceTradeEconomics',
  'playbookRouting',
  'honeypotChecks',
  'devSellStop',
  'allInSizing',
  'entryGateV2',
  'dynamicPriorityFee',
  'timelineSlotSampling',
];

/**
 * True when running as a SHIPPED build rather than a dev checkout.
 *
 * Both shapes count. `process.pkg` is the single-file binary; SNIPER_PACKAGED
 * is set by electron/main.js when app.isPackaged, and it has to be honoured
 * here or the installed desktop app — the .dmg and the NSIS Setup, i.e. what
 * almost everyone runs — falls through to DEFAULTS: every guard off and
 * allInSizing ON, the exact combination PACKAGED_DEFAULTS exists to prevent.
 * That was live from the moment the Electron build shipped (v2.0.0), because
 * the packaged check only ever knew about pkg.
 */
const IS_PACKAGED = Boolean((process as any).pkg) || process.env.SNIPER_PACKAGED === '1';

/**
 * Where to look for flags.json, most specific first:
 *   1. beside the executable — how an end user overrides the shipped set
 *   2. the working directory — the dev-machine path
 *   3. inside the binary — the set this build shipped with
 */
function flagsSearchPaths(): string[] {
  const paths: string[] = [];
  // The desktop app's per-user data dir, when it set one. Inside a .app bundle
  // or Program Files, the directory beside the executable is not writable, so
  // that is where an installed build's overrides actually live.
  if (process.env.SNIPER_DATA_DIR) paths.push(path.join(process.env.SNIPER_DATA_DIR, 'flags.json'));
  if (IS_PACKAGED) paths.push(path.join(path.dirname(process.execPath), 'flags.json'));
  paths.push(path.resolve(process.cwd(), 'flags.json'));
  paths.push(path.resolve(__dirname, '../../flags.json'));
  return paths;
}

/** First existing flags.json, or the cwd path when none exists (for writes). */
function resolveFlagsPath(): string {
  for (const p of flagsSearchPaths()) {
    try { if (fs.existsSync(p)) return p; } catch { /* keep looking */ }
  }
  if (process.env.SNIPER_DATA_DIR) return path.join(process.env.SNIPER_DATA_DIR, 'flags.json');
  return IS_PACKAGED
    ? path.join(path.dirname(process.execPath), 'flags.json')
    : path.resolve(process.cwd(), 'flags.json');
}

const FLAGS_PATH = resolveFlagsPath();

function envName(key: string): string {
  return 'FLAG_' + key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (['1', 'true', 'on', 'yes'].includes(v.toLowerCase())) return true;
  if (['0', 'false', 'off', 'no'].includes(v.toLowerCase())) return false;
  return undefined;
}

class FeatureFlags {
  private flags: FeatureFlagSet;

  constructor() {
    this.flags = this.load();
  }

  private load(): FeatureFlagSet {
    // A packaged binary with no flags.json must not fall back to
    // everything-off; see PACKAGED_DEFAULTS.
    const merged: FeatureFlagSet = IS_PACKAGED ? { ...PACKAGED_DEFAULTS } : { ...DEFAULTS };

    try {
      if (fs.existsSync(FLAGS_PATH)) {
        const fromFile = JSON.parse(fs.readFileSync(FLAGS_PATH, 'utf8'));
        for (const key of Object.keys(DEFAULTS) as Array<keyof FeatureFlagSet>) {
          if (typeof fromFile[key] === 'boolean') merged[key] = fromFile[key];
        }
      }
    } catch (err: any) {
      console.warn(`[Flags] Could not read flags.json (${err.message}) — using defaults.`);
    }

    for (const key of Object.keys(DEFAULTS) as Array<keyof FeatureFlagSet>) {
      const env = parseBool(process.env[envName(key)]);
      if (env !== undefined) merged[key] = env;
    }

    const enabled = Object.entries(merged).filter(([, v]) => v).map(([k]) => k);
    console.log(`[Flags] ${enabled.length ? 'Enabled: ' + enabled.join(', ') : 'All feature flags OFF (legacy behavior).'}`);
    return merged;
  }

  public get<K extends keyof FeatureFlagSet>(key: K): boolean {
    return this.flags[key];
  }

  public all(): FeatureFlagSet {
    return { ...this.flags };
  }

  /**
   * Sets a flag at runtime and persists it, so a toggle survives restarts.
   *
   * Only the flags that DIFFER from this build's baseline are written. Writing
   * the whole resolved set froze whatever the process happened to be running
   * onto disk: toggle one flag on a dev checkout and flags.json gained an
   * explicit `false` for every guard, because DEFAULTS is everything-off. The
   * file then outranked PACKAGED_DEFAULTS forever after, so a shipped build
   * reading it ran with the honeypot check, dev-sell stop, kill switch and
   * economics gate all off and allInSizing ON — observed in this repo's own
   * flags.json, 2026-08-28. A sparse file can only ever say what was
   * deliberately changed.
   */
  public set(key: keyof FeatureFlagSet, value: boolean): FeatureFlagSet {
    if (!(key in DEFAULTS)) throw new Error(`Unknown feature flag: ${key}`);
    this.flags[key] = value;
    const baseline = IS_PACKAGED ? PACKAGED_DEFAULTS : DEFAULTS;
    const overrides: Partial<FeatureFlagSet> = {};
    for (const k of Object.keys(DEFAULTS) as Array<keyof FeatureFlagSet>) {
      if (this.flags[k] !== baseline[k]) overrides[k] = this.flags[k];
    }
    try {
      fs.writeFileSync(FLAGS_PATH, JSON.stringify(overrides, null, 2) + '\n');
    } catch (err: any) {
      console.warn(`[Flags] Could not persist flags.json: ${err.message}`);
    }
    return this.all();
  }
}

export const featureFlags = new FeatureFlags();
