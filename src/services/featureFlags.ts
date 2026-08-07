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
  /** Refuse entries whose round-trip cost exceeds maxBreakevenPct of position size. */
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
}

const DEFAULTS: FeatureFlagSet = {
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
};

const FLAGS_PATH = path.resolve(process.cwd(), 'flags.json');

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
    const merged: FeatureFlagSet = { ...DEFAULTS };

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

  /** Sets a flag at runtime and persists it, so a toggle survives restarts. */
  public set(key: keyof FeatureFlagSet, value: boolean): FeatureFlagSet {
    if (!(key in DEFAULTS)) throw new Error(`Unknown feature flag: ${key}`);
    this.flags[key] = value;
    try {
      fs.writeFileSync(FLAGS_PATH, JSON.stringify(this.flags, null, 2));
    } catch (err: any) {
      console.warn(`[Flags] Could not persist flags.json: ${err.message}`);
    }
    return this.all();
  }
}

export const featureFlags = new FeatureFlags();
