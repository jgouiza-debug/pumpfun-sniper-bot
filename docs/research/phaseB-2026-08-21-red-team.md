# Phase B — Adversarial red team

Date: 2026-08-21 · Method: attack the bot as an adversary trying to drain it. Every verdict cites code.

**Scoreboard: 2 DIE · 4 DEGRADE · 3 SURVIVE.**

| # | Attack | Verdict |
|---|---|---|
| 4 | Deployer pulls LP in the next slot | **DIES** |
| 5 | Fake migration / spoofed pool | **DIES** |
| 1 | Honeypot — sell reverts | DEGRADES |
| 7 | Bundled launch across many wallets | DEGRADES |
| 8 | Stale or manipulated RPC data | DEGRADES |
| 3 | Freeze authority used post-buy | DEGRADES (launch-snipe lane only) |
| 2 | Transfer fee / transfer hook | SURVIVES |
| 6 | Metadata mimicking a trending token | SURVIVES |
| 9 | Dependency exfiltrates the keypair | SURVIVES (structurally exposed) |

---

## 4. Deployer opens LP, bot buys, deployer pulls LP in the next slot — **DIES**

`isPoolDrained` ([pipelineUtils.ts](../../src/services/pipelineUtils.ts)):

```ts
const { peakLiquidityUsd, currentLiquidityUsd, drainFraction, minPeakUsd = 2000 } = params;
if (!(peakLiquidityUsd >= minPeakUsd)) return false;
```

`pos.peakLiquidityUsd` is written **only** inside the monitor tick, from `dexData.liquidityUsd`
([sniperEngine.ts:3507](../../src/services/sniperEngine.ts)), and only *after* the drain check runs. So the
sequence for a next-slot rug is:

1. Buy fills.
2. Deployer pulls LP ~400 ms later, before any monitor tick has recorded a peak.
3. First monitor tick: `peakLiquidityUsd` is `undefined` → `?? 0` → `0 >= 2000` is false → **`isPoolDrained`
   returns false, permanently.** The peak can never be established because the liquidity is already gone.
4. The position now waits for `exitOnNoData` (180 s) or the 30-minute time stop — and by then there is no
   pool to sell into anyway.

There is a second, independent failure in the same path: even when a peak *is* recorded, it comes from
DexScreener, whose indexing lag is far longer than the 1-second monitor interval
(`POSITION_MONITOR_INTERVAL_MS = 1000`). The drain detector is structurally slower than the drain.

**Fix (specified, implemented in Phase C):** seed `peakLiquidityUsd` at entry from an **on-chain read of the
pool's reserves**, not from DexScreener, so a peak exists before the first tick. Then gate entry on a
minimum verified on-chain reserve, so a pool too thin to have a meaningful peak is never entered. This also
removes the dependency on the `2 * 79 * solPrice` asserted liquidity, which is what currently populates the
field for migrations.

## 5. Fake migration / spoofed pool — **DIES**

`detectMigration` ([pipelineUtils.ts:39](../../src/services/pipelineUtils.ts)) with
`strictMigrationDetect: true`:

```ts
if (payload.txType === 'migrate') return true;
if (strict) return false;
```

The **entire** migration decision is one string field from a third-party WebSocket. Nothing verifies that a
pool exists, that it is owned by the pump-amm program, or that it holds any reserves. The venue the bot then
routes every buy and sell to is likewise taken straight from the payload
(`venue: launchData?.pool`, [sniperEngine.ts:2752](../../src/services/sniperEngine.ts)).

So an attacker who can influence what that feed emits — or a feed bug — can route real money at a pool the
bot never checked existed. Recall from Phase 1 that **100% of buys and sells are built by the same vendor**.
The trust concentration is total: one party supplies the signal, the venue, the transaction and the
blockhash.

**Fix (specified, implemented in Phase C):** before acting on a migration event, fetch the named pool
account and assert (a) it exists, (b) its owner is the expected pump-amm program ID, (c) its reserves are
non-zero. Refuse the entry if any check fails. This is one `getAccountInfo` on the hot path.

---

## 1. Honeypot — token buys fine, sell reverts — **DEGRADES**

Two classes, and the bot handles them differently.

**Mint-flag honeypots** (freeze authority, Token-2022 transfer hook, permanent delegate, default-frozen
accounts) are caught **before entry**. `inspectMintSafety` is called at
[sniperEngine.ts:1919](../../src/services/sniperEngine.ts), and `executeBuy` is at :2660 — the check
genuinely precedes the money. All six are proven to fire in `src/tests/filterProofs.ts`.

**Behavioural honeypots** — where the sell reverts because of program logic invisible in the mint account —
are **not** caught before entry. `verifySellPath` runs `sellSimDelayMs = 4000` ms *after* the fill, and the
source states why: the simulation needs the tokens to exist before it can build a real sell.

So the answer to "does my bot detect this before entry, or only discover it when the exit fails" is:
**before entry for mint-flag honeypots; ~4 seconds after entry for behavioural ones — but still before the
exit is attempted.** With `exitOnHoneypot` defaulting on, a confirmed reverting sell triggers an immediate
exit attempt.

This is a real limitation, not a bug: you cannot simulate selling a token you do not yet hold. The honest
mitigations are position sizing and accepting the ~4 s exposure. Not a fix, a stated risk.

## 7. Bundled launch — dev holds 90% across 20 wallets that look organic — **DEGRADES**

`Top10 holders > max 25%` fires correctly and is proven:

```
bad input : dev holds 90% across 20 wallets that look organic: top10Pct = 90
REJECTED  : "Top10 holders 90.0% > max 25% (measured, pools excluded)"
```

But do the arithmetic on the attacker's side. 90% split across **20** wallets is 4.5% each, so the top 10
hold 45% — caught. Split across **40** wallets it is 2.25% each, top 10 hold **22.5%** — **under the 25%
threshold, and it passes.** The filter is defeated by adding wallets, which costs the attacker almost
nothing.

Worse, the check has three preconditions: RugCheck must be indexed, `holderSampleSize >= 5`, and
`totalHolders >= 10`. On a fresh create none of those hold — which is exactly the "RugCheck not indexed"
rejection that kills 88% of the funnel. So on creates the bundle defence is *refusing unknowns*, not
measuring anything.

**Fix:** stop relying on a top-10 scalar. RugCheck already returns `insiderNetworks` and per-holder insider
flags in the response the bot **already fetches and discards**. Same-slot funding clustering over the
creation block is the structural detector; wallet count is not.

## 3. Freeze authority used to lock the account post-buy — **DEGRADES (one lane)**

Pre-entry the check is real and proven, both on-chain
(`Freeze authority is active — holders can be frozen out of selling`) and via RugCheck
(`Freeze authority active`). Standard pump.fun mints have both authorities revoked by the program, so for
the normal path this attack requires a non-standard mint, which the pre-entry read catches.

**Nothing re-checks after the buy.** Grep for `freezeAuthority` in the engine returns one hit, and it is
this, on the launch-snipe path ([sniperEngine.ts:2277](../../src/services/sniperEngine.ts)):

```ts
mintAuthorityRevoked: true,
freezeAuthorityRevoked: true,
lpLockedPct: 100,
reasons: [`LAUNCH SNIPE: ${args.trigger} — screening skipped for speed`],
```

These are **asserted, not read**. The comment defends them as platform facts, which is true for a genuine
pump.fun create — but the launch-snipe lane exists precisely to buy before anything has been verified, so
"it is structurally a pump.fun mint" is the one assumption it cannot check. Note this lane is flagged on and
has never fired, so the exposure is currently theoretical.

## 8. RPC provider feeding stale or manipulated data — **DEGRADES**

**What is well defended.** `inspectFill` reads the wallet's actual balance deltas from the confirmed
transaction rather than trusting a quote — "quotes are opinions, balance deltas are facts". On top of that,
a BAD FILL guard abandons the entry when the real fill exceeds the decision price by
`MAX_FILL_SLIPPAGE_MULTIPLE = 1.2`:

```ts
if (fillVerified && decisionPriceUsd > 0 && buyPriceUsd > decisionPriceUsd * MAX_FILL_SLIPPAGE_MULTIPLE) {
```

A manipulated *price feed* therefore cannot silently give the bot a bad cost basis. That is genuinely good.

**What is not defended.**
- **No runtime RPC failover.** `SOLANA_RPC_FALLBACK_URL` is consulted only when resolving an endpoint at
  startup or on a config change (`new Connection` appears at :449, :767, :846 — all config-time). A provider
  that degrades mid-run is never switched away from.
- **A stale feed does not stop trading.** `onStale` logs and terminates the socket to force a reconnect
  ([sniperEngine.ts:1590](../../src/services/sniperEngine.ts)). It does not set `isBotActive` false, and
  nothing marks decisions taken while blind. The bot stays nominally "active" while receiving nothing.

**Fix:** halt new entries when the feed has been silent beyond a threshold, and add runtime endpoint
rotation on sustained failure. Both land in Phase C.

## 2. Transfer fee / transfer hook token that quietly eats the position — **SURVIVES**

Caught pre-entry, both proven:

```
Token-2022 transfer FEE   -> "Token-2022 transfer fee present — sells can be taxed arbitrarily"
Token-2022 transfer HOOK  -> "Token-2022 transfer hook present — arbitrary code runs on every transfer and can block sells"
```

Also covered: permanent delegate (seizure) and default-account-state (the blacklist mechanism). A transfer
fee is not expressible on a classic SPL mint, so Token-2022 extension coverage is complete for this vector.
This is the strongest part of the codebase.

## 6. Metadata mimicking a trending token — **SURVIVES BY ABSENCE**

There is no name or symbol pattern-matching anywhere in the screening path. `tokenName` appears once, in
`riskFilter.ts:321`, purely to populate a display field. With no pattern-matcher, there is no bait to take.

Worth stating plainly because it cuts both ways: this is missing functionality acting as a defence, and any
future "trending name" heuristic would open this attack.

## 9. A dependency exfiltrates the keypair — **SURVIVES, structurally exposed**

Measured surface:

```
packages with install hooks (the exfiltration vector): 3
  bufferutil@4.1.0    :: install     -> node-gyp-build
  esbuild@0.25.12     :: postinstall -> node install.js
  utf-8-validate@6.0.6:: install     -> node-gyp-build
```

All three are legitimate native-build helpers (two are `ws` optional deps, one is vite's bundler). That is a
small and clean install-time surface — the classic npm supply-chain vector is largely absent here.

`npm audit --omit=dev` reports 3 moderate, all one chain (`uuid` ← `jayson` ← `@solana/web3.js`), not
exploitable in this usage, and the advertised fix downgrades web3.js to 0.0.3.

**The structural exposure remains and cannot be audited away:** every production dependency executes
in-process with the decrypted `Keypair` resident in memory, and the key file is `0o600` on POSIX and a no-op
on Windows. A malicious update to any transitive dependency reaches the key.

**Fix:** `npm ci --ignore-scripts` in CI and release builds, lockfile integrity enforced, and — the only real
structural answer — move signing behind a boundary the dependency tree does not share.

---

## What Phase C must implement

Ordered by whether the attack currently kills the bot:

1. **On-chain pool verification before acting on a migration** (kills attack 5).
2. **Seed `peakLiquidityUsd` from on-chain reserves at entry** (kills attack 4).
3. **Halt entries on a stale feed** (attack 8, and it is also a Phase C requirement in its own right).
4. **Runtime RPC failover** (attack 8).
5. `npm ci --ignore-scripts` for release builds (attack 9 hygiene).

Not fixable, to be stated as accepted risk: the ~4 s behavioural-honeypot window (attack 1), and the
in-process keypair exposure (attack 9).
