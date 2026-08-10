# Diagnosis: why the bot isn't trading, and the removal of the price stop-loss

Date: 2026-08-09 · Commit under review: `b9f35dd` · Evidence: `reports/*.md`, `reports/*.json`,
`reports/candidates-2026-08-05.jsonl`, `reports/candidates-2026-08-08.jsonl` (6,380 candidate rows)

---

## 1. Headline

**The bot does not take bad trades. It takes no trades.**

Across ≥4 real-mode sessions totalling ≥114 minutes and 3,534 real-mode candidates, the corpus
contains **zero** `buy_confirmed`, `buy_failed`, or `buy_attempted` records in real mode. All 20
`buy_confirmed` rows carry `mode: "paper"`. Both real-mode run reports show a wallet delta of
exactly **0 SOL**. Every report carries `fillVerifiedLegs: 0`.

**The honest live sample size is zero.** No real closed trade exists in this repository.

## 2. Why zero entries — four independent hard walls

Each of these alone is sufficient to produce a 0-trade run.

### 2.1 The breakeven gate is unpassable at the wallet size used

At the 0.2 SOL wallet the bot actually ran on:

| Step | Value |
|---|---|
| `getDeployableSol()` = 0.2 − 0.005 gas float | 0.195 SOL |
| `maxAffordableBuySol(0.195, 25, 0.003)` | 0.1498 SOL |
| `breakevenPct(0.1498, 0.003)` | **8.37%** |
| `maxBreakevenPct` | **6** → refused |

22 router-eligible candidates (gateV2 `isSafe: true`, empty reasons) died here in the 89-minute
window. Clearing 6% needs a stake ≥ **0.268 SOL**, i.e. a wallet ≥ **~0.35 SOL**.

### 2.2 Sizing is permanently locked to a half unit

`scoreTier` awards a full unit only at `score >= minScoreFullUnit` (71 strict / 65 normal). The
**maximum `gateV1.score` observed across all 3,635 rows is 66. Zero rows reach 71.** So every entry
is sized at `buyAmountSol × 0.5` = 0.15 SOL → 8.37% breakeven.

`affordableStakeSol` is a `Math.min`, so **a larger wallet cannot fix this** — only `buyAmountSol`
can. A half unit hits exactly 6.00% at `buyAmountSol` ≥ 0.5366 SOL.

The scoring rewrite dropped real-data scores by ~35 points (08-05 scores clustered at 85–95 on
fabricated inputs) while the 71/65 bands were left where the inflated scores had put them.

### 2.3 97.2% of the funnel is unbuyable by construction

`payload.timestamp` is present in **0 of 6,380** rows — PumpPortal's `subscribeNewToken` does not
send it. `computeAgeSeconds(undefined)` returns 0, so `launchData.ageSeconds === 0` in **6,380 of
6,380** rows, and `classifyPhase` always hits `if (ageSeconds < 120) return BLOCK_0`.

Creates are 6,202/6,380 = **97.2%** of the funnel and are rejected as "inside the block-0 insider
window". `buy_confirmed` by txType across the whole corpus: **`{migrate: 20}`** — zero creates, ever.

### 2.4 Play 2 — the only full-unit, non-crowded path — has never fired

The mid-curve re-screen requires a token to be ≥ 600s old, but `curveWatcher` holds
`maxWatched = 40` and evicts the oldest first. At the measured create rate of **0.52/s**, 40 slots
churn completely every **~77s** against a **600s** requirement — an 8x shortfall. No token can
survive long enough to be re-screened.

**Consequence: the only entries this architecture can produce are Play 3 migration snipes at 100%
curve progress — the most crowded point on the curve.**

## 3. Trade-quality defects (they bite once entries unblock)

- **Fabricated liquidity, still live** (`sniperEngine.ts:1131`): migrations are assigned
  `2 × 79 × solPrice` ≈ **$12,044** when the indexer has no reading. Measured migration
  `liquidityUsd`: p50 **12,033**, p90 12,052 — the median *is* the assertion. **71 of 73** migration
  rows carry it. Play 3's floor is $2,287, so the liquidity gate is **inert on 97% of migrations**,
  removing the one check that would catch a graduation whose pool was pulled.
- **10 of Gate 0's 20 checks are hardcoded `true`** (`riskFilter.ts`), and 8 are not even ANDed into
  `allPassed` — yet they are returned to the UI as verdicts. On migrations the 41
  `Top10 + Dev holdings` rejections all show `top10Pct === devHoldingsPct` to the decimal: two
  "checks" reading one field.
- **The strict 62 score bar is bypassed to 55** (`sniperEngine.ts:1201-1211`). Both `buy_confirmed`
  rows in the 08-08 corpus ($AT, $DOUG) have `gateV1.isSafe: false` and score 58 — 100% of that
  run's buys exist only because of the override.

## 4. The reports are not evidence

`reports/run_2026-08-05T03-11-51-333Z.*` (+$3,331.83, 93.3% win rate, +3331.8% ROI) is **fiction**,
on five independent proofs:

1. **It predates version control.** File mtime 2026-08-04 23:31; initial commit is 2026-08-06 22:56.
2. **Its exit engine never existed here.** `"Smart Chart Trailing Stop"`, `"2x Resistance Breakout
   Target"`, `"5x Momentum Saturation Target"` return zero hits across `src/` and zero commits on
   any branch via `git log --all -S`.
3. **`honestPaper` was not applied** — trade 9 records `investedSol: 0.025` exactly, and
   `buyPriceUsd` is a bit-exact match for `marketCapUsd / 1e9`.
4. **It sells 200% of every position that took a partial.** $TNOS bought 60,754 tokens, sold 91,379,
   and still lists 30,460 held. Halving every doubled leg gives $1,666.01 — exactly 2.00x under the
   reported total.
5. **Its headline win is a price-source mismatch.** Two $TNOS legs at **1,184x over 35 seconds** are
   98.3% of that run's P&L. The documented paper RNG drift (+40.2%/min) caps growth at ~3.26x over
   35s — it cannot produce 1,184x.

`run_2026-08-05T03-32-31-990Z.json` (labelled REAL, +$1,195 unrealized) holds the **same four mints
with the same entry times** as the paper session. It is the paper bag relabelled.

**Reporting also cannot answer "why didn't it trade":** `recordScreened` is called *before*
`evaluatePlaybookTrigger`, and its only outcomes are pass and reject-with-reason. All 81 tokens that
passed the gate and never opened a position (59 router-refused, 22 economics-refused) appear
nowhere. The funnel just ends at "Passed 102 / Opened 0".

## 5. The stop-loss problem, and what replaced it

### What actually fired

There were **two** price stops, and the one being complained about was mostly dead code.

**The trailing stop was the real liquidator.** It armed at `highestPriceUsd > buyPriceUsd × 1.3` and
was **never cleared, never disarmed, never re-armed**. `highestPriceUsd` is a monotonic ratchet that
is never lowered, and `recordPartialSell` left it pinned to the all-time peak.

Once armed, its level (≥ 1.30 × 0.8 = **1.04x**) always sat above the −35% stop's 0.65x level, so
**for any position that ever exceeded 1.30x, the −35% stop was dead by domination.**

Three defects made it actively harmful:

| Defect | Effect |
|---|---|
| **Dead band** | The pullback partial needs peak ≥ 1.8824x; TP1 needs 2x. Anything peaking in **[1.30x, 1.8824x)** cleared no rung at all and was **100% liquidated on one 20% retrace**. |
| **Double-tap** | When the pullback partial did fire at 0.85×peak, the surviving half was force-sold next tick at 0.80×peak. The whole position exited on a single wick. |
| **Exits below breakeven** | Minimum armed exit was **+4.0% gross** against a **5.68%** round-trip cost at 0.3 SOL (19.10% at the UI's old 0.05 SOL default). Between 1.30x and 1.321x the "profit-protecting" stop **booked a loss**. |

Plus: the peak was set from an unvalidated mix of three price sources (curve price, DexScreener
quote, and `marketCap/1e9` — which the code's own comment documents as **2x wrong** for a 2B-supply
token). One high tick from a different source permanently anchored the stop at 0.8× a bogus peak
with no recovery path.

### What changed

**Deleted:** the `pnlPct <= -stopLossPct` block, `stopLossPct` from `BotConfig`, the engine default,
and the Settings input. A test now asserts the engine source contains no `config.stopLossPct` and no
negative-P&L price stop, so it cannot be reintroduced silently.

**Re-scoped, not deleted — the trailing stop is now a moonbag ratchet:**

| | Before | After |
|---|---|---|
| Arms at | 1.3x peak | **3.0x peak** |
| Give-back | 20% | **30%** |
| Earliest forced exit | 1.04x (a loss) | **2.10x** |
| On trigger | sells 100% | **sells 50%**, re-anchors; only a second, independently re-armed trigger closes |

Also: `recordPartialSell` now re-anchors `highestPriceUsd` to the current price and clears the
trailing target (kills the double-tap); the peak is re-anchored whenever the price *source* changes;
and a >4x single-tick spike is refused for peak purposes.

**Structural exits carry the loss side instead:**

| Trigger | Source | Status |
|---|---|---|
| `CURVE_DRAINED` — reserves ≤ 60% of peak | Helius account updates | Already live |
| `DEV_SOLD` / `LINKED_WALLET_SOLD` / `LARGE_SELL_CLUSTER` | `devSellMonitor` | Wired, **feed-starved** — see risk 3 |
| **`POOL_DRAINED`** (new) — liquidity ≤ 50% of peak | `dexData.liquidityUsd`, already fetched every tick and previously discarded | Added |
| **`SELL_FLOW`** (new) — buy pressure < 25% for 3 consecutive ticks | `dexData.buyPressurePct`, likewise discarded | Added |
| Time stop | `maxHoldSeconds` 1800 | Unchanged |

**Blocking prerequisite that had to land first:** `sellPctReal` began with a fee-burn backoff that
reaches **10 minutes** after 8 failures, and structural stops went through it with no bypass. A
`DEV_SOLD` was also `untrack`ed unconditionally after a failed sell, and `devSellMonitor` latches
`devSold` permanently — so a blocked creator-dump alert **could never fire again**. Removing the
price stop while that was true would have removed the only working exit.

Fixed by: a `force` flag that bypasses the backoff for structural and manual exits; latching the
intent on the *position* (`forceExitReason`) so it survives a failed transaction and retries every
tick; untracking only once the position is genuinely closed; and an `exitInFlight` guard so a WS
structural alert cannot re-enter an exit already in flight and double-credit the bankroll.

### The risk being accepted

A position whose pool stays intact and whose dev never sells can bleed to −95% and **will not be
sold until the 30-minute time stop**. At a 0.3 SOL stake and SOL ≈ $76:

- Worst case per position: **~0.308 SOL ≈ $23**
- Worst case concurrent (`maxActivePositions` now **3**, was 5): **~0.92 SOL ≈ $70**
- `maxHourlyLossUsd` raised 25 → **70** to match; note it sums *realized* P&L only, cannot see an
  open −90% position, and only pauses entries — it never closes anything.

Structural stops do **not** cover a slow bleed on a healthy-looking pool. That is the accepted loss.

## 6. Still open — owner decisions

1. **Wallet funding.** 0.2 SOL cannot open a single position. Options: (a) keep 0.2 SOL and drop
   `priorityFeeSol` to 0.001 → stake 0.15, breakeven 5.70%, passes — but a 0.001 fee loses
   migration-snipe races; (b) ~0.4 SOL with `buyAmountSol` 0.6 → one position at a time;
   (c) ~1.2 SOL with `buyAmountSol` 0.6 → three concurrent.
2. **Paid Helius transaction stream?** Three of the four structural triggers are fed by PumpPortal
   `subscribeTokenTrade`, which this codebase documents as returning **zero events on the free
   tier**. Without it the replacement exit policy rests on `CURVE_DRAINED` plus the two new
   DexScreener-derived triggers.
3. **Full-unit band.** Max observed score is 66; strict requires 71. Either lower
   `minScoreFullUnit` to ~63, switch to `normal`, or accept that half-unit sizing is permanent — in
   which case `buyAmountSol` must be set at 2x the intended per-trade stake.
4. **Migration-only entries?** Fixing Play 2 needs the `curveWatcher` capacity raise and the age
   clock. Otherwise the bot only ever snipes graduations.
