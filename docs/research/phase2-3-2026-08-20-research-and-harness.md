# Phases 2–3 — Comparative research and the backtest harness

Date: 2026-08-20 · Status: **Phase 2 partial (5 of 6 surveys returned), Phase 3 harness complete, full
backtest numbers pending data collection**

Everything below traces to real data or a cited primary source. Where a number is provisional, it says so.

---

## 0. Correction to something I reported earlier today

My first pass at "which screening rules actually save money" produced a headline that **four concentration
rules were discarding the best tokens** — Top-10 holders appeared to reject survivors at 5.8× the base rate.

**That was confounded and wrong.** Migrations survive at ~23%; creates at ~1.0%. Any rule that fires mostly
on migrations looks good on a pooled comparison regardless of merit. Stratifying by `txType` removed most of
the effect, and adding Wilson confidence intervals removed the rest. The corrected result is in §3.4, and it
is much less exciting and much more useful.

---

## 1. Phase 2 — what is worth taking from prior art

### 1.1 Safety first: this niche is full of traps

The single most actionable Phase 2 output. Every one verified against the live GitHub API or a primary
security writeup, not inferred from vibes:

| Repo | What it actually is |
|---|---|
| `cutupdev/Solana-Pumpfun-Sniper-Bot` | Ships a **54,519,439-byte unsigned Windows exe** while `.env.example` asks for `PRIVATE_KEY=`. README step 3 is "run the exe". No way to verify it was built from the visible source. **Do not run.** |
| `moonshot-wif-hwan/pumpfun-bump-script-bot`, `Diveinprogramming/raydium-pumpfun-fastest-sniper-bot` | **Malicious by design.** Documented by Socket and SlowMist: hidden dependencies pulled from custom GitHub URLs to bypass npm scanning, exfiltrating Solana private keys. |
| `HZCX404/memecoin-trading-bots`, `Niranjanprasad1/Solana-Memecoin-Trading-Bot` | Binary-drop repos with no inspectable code, identical README boilerplate. Treat as wallet drainers. |
| `keidev-sol/Solana-Sniper-Rust-Bot` | Entire repository lifetime was **one minute thirty-eight seconds** (created and last pushed 2025-12-23). 9 KB. Pure bait. |
| `0xalberto/solana-raydium-pumpfun-sniper-Rust` | Now redirects to a World Cup prediction-market repo. SEO content farm. |
| `Rezzecup/pump-fun-rug-checker-lite` | Ranks in search, returns **404** from the API. Deleted or renamed. |

The pattern to recognise: **precompiled binary + a request for your private key + stars that don't match
commit history.** Popularity in this niche is manufactured.

### 1.2 The pattern table

Ranked by expected value for a retail operator with no co-location.

| # | Pattern | Source | Why it matters here | Verdict | Cost |
|---|---|---|---|---|---|
| 1 | **Instrument the legs you cannot see** | hftbacktest methodology | `t5/t6/t7` are stamped and discarded. The build→submit→land legs — the ones a vendor round-trip sits on — are unmeasured. You cannot optimise what you don't measure. | Real | **LOW** |
| 2 | **Post-Rejection Follow-up Sampling (PRFS)** | Kamat, RED-2400 | Forward-track every *rejected* candidate and score each rule's save-to-miss. Directly fixes Phase 1's blocker. **Built — see §2.5.** | Real | **LOW** |
| 3 | **Top-k removal test + multiple-testing correction** | Kamat; Bailey & López de Prado (Deflated Sharpe) | An independent 15-day deployment reported 190 trades, 40.5% win rate, +117.7% — then **removing the top 3 trades (1.6% of sample) flipped it unprofitable.** Identical to what your own data shows (§3.3). | Real | **LOW** |
| 4 | **Model the lost race as a FAILED TX, not a worse fill** | pump.fun IDL | `buy` carries `max_sol_cost`; if enough SOL lands ahead of you the program aborts with **6002 TooMuchSolRequired** and the base fee is charged anyway. Losing is a fee, not a bad entry. | Real | **LOW** |
| 5 | **Jito `tip_floor` as a free congestion oracle** | `bundles.jito.wtf/api/v1/bundles/tip_floor` | Unauthenticated, no wallet, no funds. Real-time read on network competition — useful as a *signal*, with no Jito integration. | Real | **LOW** |
| 6 | **Replace 1.5 s status polling with a signature subscription** | @solana/kit | Removes up to 1.5 s of blind time per confirmation, and directly addresses the "sell landed at second 31, booked as failed" defect. | Real | **LOW** |
| 7 | **Reconstruct the curve arithmetically instead of trusting a vendor** | `pump-fun/pump-public-docs` | Constant-product with published initial virtual reserves (1,073,000,000,000,000 tokens / 30,000,000,000 lamports). Price at any point is **exact**, not estimated — this kills the fabricated-liquidity problem at the root. | Real | **MEDIUM** |
| 8 | **Generate the client from the IDL** | `codama-idl/codama`, `sevenlabs-hq/carbon` | Never hand-write pump.fun instruction builders. Also the path to a **local sell builder**, removing the single-vendor dependency on every exit. | Real | **MEDIUM** |
| 9 | **Own your blockhash and transaction assembly** | @solana/kit | Today PumpPortal fetches the blockhash, so expiry is an unmeasured failure mode entirely outside your control. | Real | **MEDIUM** |
| 10 | **Bound backtests to a regime window; never pool across regimes** | Kamat graduation-regime windows | Published graduation rate moved **0.63% → 0.198% → ~0.84% → 2.5% → 6.7%** across 2025–2026 as launch mechanics changed. Pooling across that is meaningless. | Real | **LOW** |
| — | Rust rewrite of the hot path | — | Your measured budget is parse **0 ms**, filters **129 ms** (all network I/O), decision **49 ms**. The language runtime is not the bottleneck. | **Theatre, here** | Infeasible |
| — | Geyser / Yellowstone gRPC ingestion | `rpcpool/yellowstone-grpc` | Genuine edge, but needs a paid provider and rearchitecture. Worth it only *after* there is evidence of selection skill. | Real but premature | Infeasible now |
| — | Jito bundles / ShredStream / co-location | jito-labs | 9 mainnet regions, NTP sync, leader-schedule targeting. **Tips are wasted money when the current leader is not a Jito-Solana leader.** Not a retail play. | Theatre for retail | Infeasible |

### 1.3 The one economic result worth staring at

From the published pump.fun analysis: buying at bonding-curve progress **P** is only positive-EV if

> P(graduate) > (vSol / 115)², where vSol = 30 + 0.85 × P

**Your bot's only working entry is `bondingProgress: 90`.** That gives vSol = 106.5 and a required
graduation probability of **(106.5/115)² ≈ 85.7%**.

**Since writing this section I have derived it independently — see §4.1.** It follows directly from
constant-product mechanics (`price = vSol²/k`, so the multiple between two curve points is `(vSol₂/vSol₁)²`)
using this repo's own `VIRTUAL_SOL_BASE = 30` and `GRADUATION_SOL = 85`. It holds, and the graduation rate it
must clear is measured in our own data at 0.46%. This is a structural argument, not a tuning argument.

### 1.4 Corroborated selection signal

Independent published work (Marino, Naviglio, Tarantelli & Lillo, arXiv 2602.14860) reports social presence
as a strong launch-quality prior: **Telegram 8.94×, full social stack 17.4×**. Your own data agrees —
`socialCount` is the one decision-time feature that moves monotonically with survival (§3.5).

Two findings I am **declining** to act on, both from the same research: coordination and first-buyer-flow
signals are *contaminated by construction* — roughly half the apparent lift is the manipulators' own money
being counted as the crowd it supposedly attracted.

---

## 2. Phase 3 — the harness

Five modules, all typechecking clean, all read-only. **None of them import the execution path; none can
sign or submit a transaction.**

| Module | Purpose |
|---|---|
| `src/research/labelOutcomes.ts` | Joins decision-time snapshots to what the token actually became. First-sighting-per-mint, so no hindsight leaks in. |
| `src/research/fetchPriceHistory.ts` | Collects **real minute OHLCV** from GeckoTerminal — actual on-chain trade aggregates, not a random walk. Adaptive rate pacing, disk-cached, resumable. |
| `src/research/backtest.ts` | Replays a price path against an exit policy with an honest cost model. |
| `src/research/runBacktest.ts` | Chronological in/out-of-sample split, policy comparison, sensitivity sweep. |
| `src/research/outcomeTracker.ts` | **Phase 5 core.** Follows the live candidates log and samples every candidate forward at 5/15/30/60/180/360/1440 min. Tracks *rejections* as carefully as entries. |

### 2.1 The honesty contract encoded in the engine

Every place a backtest can flatter its author, resolved pessimistically and stated in output:

- **Not first in the block.** `entryDelayCandles: 1` — the fill happens on the candle *after* the signal.
- **Intra-candle sequence is unknown.** Default fill buys the candle **high** and sells the candle **low**.
- **A dead pool is −100%, never a dropped row.** Excluding vanished tokens biases every statistic upward,
  because the ones that vanish are exactly the ones that failed.
- **Slippage is charged against real candle volume.**
- **Failed transactions still burn fees** (15% default).
- **Sharpe is printed and flagged as uninterpretable** under this skew, every single time.

### 2.2 Data collected so far — all real

| Corpus day | Mints labelled | Migrations | Still have a pool |
|---|---|---|---|
| 2026-08-05 | 481 | 38 | 26.3% |
| 2026-08-08 | 528 | 46 | 21.7% |
| 2026-08-10 | 433 | 15 | 20.0% |
| 2026-08-13 | 2,336 | 199 | 25.6% |

**Base rate is strikingly stable: 97–98.6% of all mints are dead. Migrations survive at 20–26% across four
independent days.**

---

## 3. What the real data says

### 3.1 Minute-level price paths exist and are usable

Verified: minute candles are retained for tokens **15 days old**, and — critically — **tokens DexScreener
has delisted are still queryable on GeckoTerminal** (`$ELON` still shows $1,353 of reserve). That avoids a
survivorship trap that would otherwise have poisoned the whole backtest: a token dead *today* may still have
run +500% in its first hour.

### 3.2 The engine runs end-to-end

Validated on a partial sample. Full numbers pending collection (~298 paths, rate-limited, resumable).

### 3.3 The distribution — this is the headline

Buy-and-hold across **all 199 migration candidates** from 08-13, market-cap based, dead pools counted at
−100%:

| Metric | Value |
|---|---|
| Mean return | **−76.1%** |
| Median return | **−100.0%** |
| Winners | **6 / 199 (3.0%)** |
| Top 3 share of gross terminal value | **43.0%** |
| Return excluding top 3 | **−86.2%** |

On the narrower price-based subset (n=48, which is biased toward tokens the indexer had data for) the mean
flips to **+713%** — and **92.3% of that comes from a single token**. Remove it and it is −36.3%.

**Both readings say the same thing: this is a lottery distribution.** The mean is an artefact of one or two
observations, not an expectancy. The wider, less-biased sample is the one to believe, and it is deeply
negative.

The direct consequence for Phase 4: **a take-profit at +100% destroys the only thing that could pay for the
losers.** The one big winner in the sample was +35,932%. Capping it at 2× and eating 97% losers elsewhere is
arithmetically hopeless. So is a 30-minute time stop against a tail that takes days to develop.

### 3.4 Screening rules — corrected, with confidence intervals

Migrations only. Baseline survival among rejected migrations: **23.3%, 95% CI [18.6, 28.8]**.

| Rule | n | Survived | 95% CI | Distinguishable? |
|---|---|---|---|---|
| RugCheck not indexed | 156 | 19.2% | [13.8, 26.1] | No |
| Real SOL in curve < min | 77 | 27.3% | [18.6, 38.1] | No |
| Dev buy SOL < min | 63 | 27.0% | [17.6, 39.0] | No |
| Dev buy % > max | 90 | 12.2% | [7.0, 20.6] | No — but closest |
| RugCheck score > max | 68 | 13.2% | [7.1, 23.3] | No |
| Dev buy SOL > max | 90 | 12.2% | [7.0, 20.6] | No — but closest |
| Market cap already pumped | 90 | 12.2% | [7.0, 20.6] | No — but closest |
| **Top-N holders > max** | 69 | **23.2%** | [14.8, 34.4] | **No — and dead centre on baseline** |
| Largest holder > max | 61 | 14.8% | [8.0, 25.7] | No |

**Not one rule shows a statistically defensible effect.** The entire screening apparatus — twenty-plus rules
— has never been demonstrated to do anything measurable on the population the bot actually trades.

Two honest nuances: `Top-N holders` sits at **1.00× baseline**, which is as close to provably useless as this
sample can show. And three rules (dev-buy-%, dev-buy-SOL-max, already-pumped) sit just outside significance
with CIs overlapping the baseline by ~2 points — **those are where more data would actually pay off.**

### 3.5 Feature predictiveness

Quartiles of each decision-time feature vs. survival, 298 migrations across four days:

| Feature | Q1 → Q4 survival | Read |
|---|---|---|
| **socialCount** | 23% → 32% → 41% → **76%** | Monotonic, large, **independently corroborated** |
| priceChange5mPct | 14% → 41% → 64% → 56% | Non-monotonic; extreme pumps do *worse* than moderate ones |
| buyPressurePct | 32% → 27% → 73% → 44% | Noisy, non-monotonic |
| **gateV1Score** | 26% → 8% → 27% → 38% | **The bot's own score barely ranks survival at all** |

Caveat that binds all of these: seven features tested on 298 rows invites multiple-testing inflation, and
~75 rows per quartile is thin. `socialCount` is the one I'd act on, because it is monotonic *and* matches
published work — everything else needs more data.

---

## 4. What is still running / not done

- **Phase 2**: 5 of 6 surveys returned; the direct pump.fun-sniper comparables survey and the synthesis pass
  did not complete. The patterns above are from what returned.
- **Phase 3**: price-path collection is ~26/298 and rate-limited to roughly 4 hours. Full policy comparison,
  the walk-forward, and the sensitivity sweep run once it finishes.
- **Phase 4**: not started. Deliberately — tuning before the data is in is exactly the mistake the brief
  forbids.
- **Phase 5**: tracker built, not yet run against live data (needs the bot running).

## 5. Standing assessment

Phase 1 concluded there was no demonstrated edge. Phase 3's real data **strengthens** that: the population
this bot trades has a −76% mean, a −100% median, a 3% win rate, and its entire positive tail sitting in one
or two tokens out of two hundred. Prior art says the reachable improvements for a retail operator are
measurement and cost discipline, not speed — the speed edge is real but belongs to people with
co-located infrastructure.

The honest framing for Phase 4 is therefore **not** "tune this into profitability." It is: find out whether
any selection rule has real predictive power, prove it out-of-sample, and be willing to conclude that none
does.

---

# Phase 4 (preliminary) — the parameters have no leverage

Added 2026-08-20, after Phase 2 synthesis completed and a first backtest ran on 37 collected paths.
**n is small (26 in-sample / 11 out-of-sample). Treat magnitudes as provisional. The SHAPE is the finding.**

## 4.1 The bonding-curve breakeven, derived from this repo's own constants

Not cited — derived. pump.fun's curve is constant-product, so `price = vSol²/k` and the price multiple
between two curve points is `(vSol₂/vSol₁)²`. Using `VIRTUAL_SOL_BASE = 30` and `GRADUATION_SOL = 85`
from [playbookRouter.ts:22-24](../../src/services/playbookRouter.ts), graduation is at vSol = 115:

| Curve progress | vSol | Max upside to graduation | P(graduate) needed to break even |
|---|---|---|---|
| 25% | 51.3 | +403.5% | 19.9% |
| 50% | 72.5 | +151.6% | 39.7% |
| 70% | 89.5 | +65.1% | 60.6% |
| 80% | 98.0 | +37.7% | 72.6% |
| **90%** | **106.5** | **+16.6%** | **85.8%** |
| 95% | 110.8 | +7.8% | 92.7% |
| 100% | 115.0 | 0.0% | 100.0% |

**Measured graduation rate in our own data: 0.46%** — 16 of 3,480 sampled creates reached a
post-graduation venue (`dexId` ≠ `pumpfun`). The published study reports 0.63%. These agree.

Even at the most favourable point on the curve, break-even needs **19.9%** against a measured **0.46%**.

**Honest limits on this comparison.** 0.46% is *unconditional*. The correct test is
P(graduate | already at progress P), which is higher — I cannot compute it from this data because curve
trajectories are not observed. So the shortfall is an upper bound, not an exact multiple. And the formula
assumes selling *at* graduation, whereas this bot's thesis is post-migration appreciation.

That second caveat does not rescue the position — it relocates it. If the pre-graduation profit is
exhausted at entry, then **100% of the thesis rests on the post-migration leg**, and that leg is measured
directly in §3.3: −76.1% mean, −100% median, 3.0% win rate over 199 migrations.

## 4.2 Every policy loses, and the parameters barely move the result

Six exit policies, chronological split, pessimistic fills:

| Policy | IS total | OOS total |
|---|---|---|
| shipped (30m stop, TP 100/400, 3× trail) | −64.5% | −57.8% |
| no take-profit cap, 30m stop | −67.2% | −57.8% |
| hold 6h, trail from 3× | −73.6% | −90.2% |
| hold 24h, trail from 3×, dead-volume 20m | −77.3% | −91.0% |
| runner: TP 100 half, ride 24h | −66.4% | −82.1% |
| dead-volume only, 24h ceiling | −86.4% | −91.0% |

Not one variant is positive in either window.

## 4.3 The sensitivity sweep is the real result

| Parameter | Range swept | Total return span |
|---|---|---|
| `maxHoldMinutes` | 15 → 1440 (**96×**) | −60.9% → −66.1% (**5.2 pts**) |
| `trailingArmMultiple` | 1.5 → 10 (**6.7×**) | −63.1% → −64.7% (**1.6 pts**) |
| `trailingGiveBackPct` | 10 → 50 (**5×**) | −63.6% → −64.7% (**1.1 pts**) |
| **`entryDelayCandles`** | **0 → 2** | **−59.2% → −69.3% (10.1 pts)** |

**None of the strategy parameters have leverage.** A 96-fold change in hold time moves the result five
points. Arming the trail anywhere from 1.5× to 10× moves it 1.6 points. The give-back is worth one point.

**The only lever with real effect is entry latency — and it is the one that cannot be won.** One candle of
additional delay costs twice what the entire hold-time range is worth.

The mechanism is simple and not a small-sample artefact: roughly 89% of these trades go to −100% regardless
of exit policy. **You cannot exit your way out of a token that goes to zero.** Exit tuning only redistributes
the remaining 11%.

## 4.4 What this means for Phase 4 proper

The brief says prefer removing logic over adding it, and flag fragile parameters. The sweep says something
stronger: **the exit parameters are not fragile, they are inert.** Tuning them is not risky, it is pointless.
Every hour spent on the exit ladder is an hour not spent on the only two things that showed any signal —
selection (`socialCount`) and measurement (the unmeasured submit legs, PRFS).

I am therefore **not** going to hill-climb these parameters and report the best cell. That would be
manufacturing a number from noise across a distribution whose median is −100%.
