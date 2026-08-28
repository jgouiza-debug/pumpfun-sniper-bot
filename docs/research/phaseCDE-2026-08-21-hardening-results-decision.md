# Phases C, D, E — Hardening, results review, and the go/no-go

Date: 2026-08-21 · Dataset: **complete** — 298/298 price paths collected, 205.9 hours across four days.

**Recommendation: option 1 — NO EDGE.** The reasoning is in Phase E; the numbers behind it are in Phase D.

---

# PHASE C — Operational hardening

## C.1 What already existed and works

The loss-based kill switch is real and correctly implemented
([sniperEngine.ts](../../src/services/sniperEngine.ts), `checkKillSwitch`). It trips on a rolling-hour
realized loss, a rolling-24h realized loss, or N consecutive losing trades; it pauses the bot, retains open
positions, and **only clears when a human re-enables the bot** — which satisfies "requires manual restart".
Max position size and max concurrent positions were also already enforced.

## C.2 What was missing, and is now implemented

Four gaps, all now closed with passing proofs (`npm run test:guardrails` — **19/19**):

| Gap | Module | Proof |
|---|---|---|
| **Max entry attempts per hour** | `EntryRateLimiter` | `"entry rate limit: 5 attempts in the last 60 min (max 5); next slot frees in 3595s"` |
| **Consecutive failed-transaction breaker** | `FailureBreaker` | `"3 consecutive transactions failed to land (last: 6002 TooMuchSolRequired) — every failed submission still pays its fee"` |
| **Feed staleness halts trading** | `FeedFreshnessGate` | `"launch feed stale: silent for 65.0s (~163 slots, limit 150). Refusing to trade on state of unknown age."` |
| **Crash recovery** | `PositionStore` | `"1 open position(s) worth $7.48 restored (saved 0 min ago; the previous process did NOT exit cleanly)"` |

**Why a separate failure breaker.** The kill switch reads *realized P&L*. A wallet ground down by
transactions that never land closes nothing, so realized P&L never moves and the kill switch never sees it.
That is the failure this breaker exists for, and it is not hypothetical: every failed submission pays its
base fee plus priority fee.

**Crash recovery is deliberately not auto-resumed.** A restored record says "a dead process believed it held
this". It is not proof the tokens are still in the wallet, and **nothing in this codebase reads an on-chain
token balance**. Auto-resuming would let the engine attempt sells against holdings that may be gone, burning
fees on invented failures. So the store loads, reports loudly at boot with mint, size and cost, and leaves
the decision to the operator. Proven behaviours include the truncated-file case:

```
"⚠️ POSITION STORE: state file is corrupt (truncated write?) — open positions may exist on-chain
 that this process cannot see"
```

A truncated state file previously would have read as "nothing was open" — the silent version of the same
orphaned bag. Writes are atomic (temp + rename) so a mid-write kill leaves the last good file intact.

**One regression I introduced and the repo caught.** Adding `maxEntriesPerHour` to `BotConfig` failed an
existing test — *"every setting is read by the code that claims to honour it"* — because the limiter was
reading a constant, not the config. That test is excellent and it was right. Fixed; the cap is now re-read
before every entry so a Settings change takes effect on the next trade, not the next restart.

## C.3 Deferred, and honestly

| Item | Status |
|---|---|
| On-chain pool verification before acting on a migration (Phase B attack 5, **DIES**) | **Specified, not implemented.** One `getAccountInfo` on the hot path asserting the pool exists, is owned by pump-amm, and holds reserves. |
| Seed `peakLiquidityUsd` from on-chain reserves at entry (Phase B attack 4, **DIES**) | **Specified, not implemented.** |
| Runtime RPC failover | **Not implemented.** `SOLANA_RPC_FALLBACK_URL` remains config-time only. |
| Blockhash expiry handling | **Not addressed.** The blockhash is fetched by PumpPortal, so expiry is outside this codebase's control until transaction building moves local. |

I stopped implementing here on purpose. These harden a bot that Phase D says should not be run with money,
and building them first would be spending effort in the wrong order. They are specified precisely enough to
implement if the decision changes.

**Structured decision logging already exists** — every screened candidate, including rejections with
reasons, is written to `reports/candidates-*.jsonl`. I extended it: entries blocked by a guardrail now
record as a screening rejection with the cause, closing the gap that previously left 70 `passed_no_buy` rows
carrying no reason at all.

---

# PHASE D — Results review

**All numbers below come from replaying real minute OHLCV — actual on-chain trade aggregates — through the
cost model. Nothing is simulated price action.**

## D.1 Headline

298 candidates, 285 replayed trades, chronological 70/30 split:

| Policy | IS n | IS total | IS win | OOS n | OOS total | OOS win |
|---|---|---|---|---|---|---|
| **shipped (30m, TP 100/400, 3× trail)** | 199 | **−52.0%** | 22.1% | 86 | **−61.2%** | 11.6% |
| no take-profit cap, 30m | 199 | −51.8% | 21.1% | 86 | −65.8% | 10.5% |
| hold 6h, trail 3× | 199 | −69.7% | 13.6% | 86 | −66.2% | 12.8% |
| hold 24h, trail 3×, dead-vol 20m | 199 | −71.3% | 12.1% | 86 | −62.5% | 12.8% |
| runner: TP100 half, ride 24h | 199 | −71.6% | 6.0% | 86 | −63.4% | 9.3% |
| dead-volume only, 24h | 199 | −90.9% | 3.5% | 86 | −83.7% | 5.8% |

Average win vs average loss, shipped policy: **+40.4% / −78.3%** in-sample, **+49.9% / −75.8%**
out-of-sample. Losers are roughly twice the size of winners and there are three to eight times as many of
them.

## D.2 Walk-forward across four independent days

| Day | n | Win rate | Total | Median | Top-3 share | Ex-top-3 |
|---|---|---|---|---|---|---|
| 2026-08-05 | 37 | 35.1% | **−31.1%** | −52.5% | 28% | −46.3% |
| 2026-08-08 | 43 | 32.6% | **−46.8%** | −84.5% | 31% | −60.6% |
| 2026-08-10 | 14 | 28.6% | **−46.4%** | −86.2% | 56% | −69.7% |
| 2026-08-13 | 191 | 12.0% | **−61.8%** | −94.6% | 9% | −64.7% |

**A strategy with an edge is profitable on some day. None of these are.**

## D.3 The win-rate question, answered directly

You asked me to tune until a good win rate appeared. I did — 648 configurations of entry filters × exit
policies, scored in-sample only.

**Best win rate found: 86.7%.** Its total return: **−7.4%.**

```
buyPress>=55% vol5m>=$5000 | scalp (TP +15% all, 30m)   n=15   WINRATE 86.7%   TOTAL -7.4%
```

That is the scalp trap in one line: take profit at +15% and you win almost every time, and the rare total
losses eat all of it. **Win rate is not a measure of profitability and optimising for it actively selects
for this shape.**

Three further facts kill the exercise:

1. **Nothing was profitable.** Best in-sample total across all 648 configurations: **−3.1%**.
2. **That best cell is inside the noise.** 112 eligible configurations compared; expected inflation of the
   best cell from luck alone is **~12.1 points**. A −3.1% winner does not clear a 12.1-point luck band.
3. **Out-of-sample validation was impossible.** The filters that produced high win rates select 15 of 208
   in-sample and **3 of 90 out-of-sample**. Not a strategy — a sample-size artefact.

## D.4 Latency reality check — I cannot answer this

You asked for the distribution of how many slots behind the first real buy each decision was.

**I do not have that data and will not estimate it.** The corpus records `t1..t4` (feed arrival → decision)
but `t5/t6/t7` (build → submit → land) appear in **zero** rows, and nothing anywhere records the slot in
which competing buys landed. Producing a distribution would mean inventing it.

What I can say, measured: detection→decision is p50 **180 ms**, p90 540 ms, p99 1,937 ms. What is
unmeasured: the on-chain-creation → PumpPortal-delivery gap, and the entire submission leg. The backtest
therefore *assumes* a latency disadvantage (`entryDelayCandles: 1`, fills on the candle after the signal)
rather than measuring one.

**To answer this properly** you would need a Geyser/gRPC subscription logging every pump.fun program
transaction in slot order, run alongside the bot, comparing your submission slot to the first buy's slot.

## D.5 Fillability — partially answered

Fills are modelled pessimistically: buy at the candle **high**, sell at the candle **low**, plus slippage
charged against that candle's real traded volume. What I **cannot** do is verify against the specific buys
that landed ahead of you — minute candles aggregate trades without preserving sequence. So the discount is
principled but not verified per-fill.

## D.6 Top-trade concentration

For the shipped policy on the full dataset, the top 3 trades are **9% (IS) / 19% (OOS)** of gross value —
much lower than the 43% I found on smaller samples. Removing them takes the result from −52.0% to −55.7%.

**So the answer to "does removing the top trade turn the strategy negative" is: it is already negative.**
Concentration is not what is wrong here. The strategy loses in the body of the distribution, not just in the
absence of outliers.

## D.7 Rejection quality — the confusion matrix

Migrations only, four days, n=345:

```
                    token RAN (up)    token DIED/flat
  bot REJECTED             5                289        <- 5 misses
  bot PASSED               2                 49        <- 49 bad entries
```

- Base rate of a migration running: **2.0%**
- Precision when the bot passes: **3.9%**
- Lift over buying everything: **1.93×**

**And it is not significant.** Wilson CIs overlap ([1.1, 13.2] vs [0.7, 3.9]); Fisher exact two-tailed
**p = 0.277**. The screening system cannot be distinguished from zero skill at this sample size.

Underlying it: **only 7 of 345 migrations ran at all across four days.**

## D.8 Sample size — is this conclusive?

**No, and I will say so plainly.** You asked for two weeks of continuous data. This is four non-contiguous
days spanning 205.9 hours of decisions, and the outcome labels are a single observation 7–15 days after each
decision rather than a continuous track.

What would make it conclusive:
- **≥30 continuous days** of live paper trading with the forward-outcome tracker running.
- **≥200 taken trades** under one fixed policy — at the observed rate that is weeks, not days.
- **Slot-level latency instrumentation** (Phase D.4) so the fill assumption is measured, not assumed.
- **Multiple regimes** — the published graduation rate moved from 0.63% to 0.198% across 2025–2026 as launch
  mechanics changed. Four days in August 2026 is one regime.

The direction of the evidence is nonetheless consistent: four independent days, six exit policies, 648
tuned configurations, and every single one loses.

---

# PHASE E — Go / No-Go

## **Option 1 — NO EDGE.**

Not "unproven". The distinction matters: UNPROVEN would mean promising signals with too little data. What
the data actually shows is a strategy that loses on every day, under every policy, at every tuning, with
screening that cannot be distinguished from chance.

### Why, specifically

1. **The entry point is structurally exhausted.** Derived from this repo's own constants
   (`VIRTUAL_SOL_BASE = 30`, `GRADUATION_SOL = 85`) and constant-product mechanics: buying at curve progress
   P caps upside at `(115/(30+0.85P))² − 1` and requires `P(graduate) ≥ ((30+0.85P)/115)²` to break even. At
   90% progress that is **+16.6% maximum upside against an 85.8% required graduation rate**. Measured
   graduation rate in your own data: **0.46%**.

2. **The traded population is a losing distribution.** 199 migrations: mean −76.1%, median −100%, 3.0%
   winners. Only **7 of 345** migrations ran at all across four days.

3. **Screening has no demonstrated skill.** Not one rule is statistically distinguishable from baseline; the
   overall lift is 1.93× at **p = 0.277**.

4. **Tuning does not help.** 648 configurations; best in-sample −3.1%, inside a 12.1-point luck band; the
   best win rate (86.7%) still loses money.

5. **No reachable latency edge.** Measured 180 ms of screening plus a remote vendor round-trip on the
   critical path, no mempool access, no co-location. And per D.4, the disadvantage is not even measured.

### What would have to change structurally

Not parameters. Any of:

- **A different point on the curve.** Entering at 25% progress needs 19.9% graduation instead of 85.8%. That
  requires the create lane to work — and 17,083 of 17,100 creates score exactly 30 against a 52 floor, so
  that lane is arithmetically dead until the scoring is rebuilt on inputs that exist at age zero.
- **A real information edge** — creator-wallet reputation, funding-source clustering, bundle detection from
  same-slot analysis. `socialCount` is the one signal that showed monotonic lift in your data (23→32→41→76%)
  *and* is corroborated by published work (Telegram 8.94×, full stack 17.4×). That is a starting point, not
  a strategy.
- **A different venue or role** — market making rather than taking.

### What I am not saying

I am not saying pump.fun sniping cannot be profitable for anyone. I am saying **this bot, on this data, has
no measurable edge**, and I found nothing in 648 tuned configurations that survives contact with
out-of-sample.

I will not describe any configuration of this as guaranteed profitable, and none of the above should be read
as a prediction about future performance.

### If you want to keep going anyway

That is a legitimate choice and it is yours. The rational version is:

1. **Paper only, 30+ continuous days**, forward-outcome tracker running, one fixed policy — no tuning during
   the run.
2. **Implement the two Phase B fixes first** (pool verification, on-chain peak seeding). Both attacks
   currently kill the bot.
3. **Instrument the submission leg** so D.4 becomes answerable.
4. **Pre-commit to the kill criteria** in `docs/research/KILL-CRITERIA.md` — written now, while you are not
   holding a losing position.
