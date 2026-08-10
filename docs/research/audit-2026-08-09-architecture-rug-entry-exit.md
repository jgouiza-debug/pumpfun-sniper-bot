# Step-1 Audit — architecture, rug filtering, entry/exit, thresholds, latency, validation

_Commit a3dad0f. Produced 2026-08-09. Evidence: 6,380 recorded candidates, 125/125 tests, tsc clean._

# SNIPER BOT — AUDIT REPORT & PRIORITIZED FIX LIST
**Commit a3dad0f (master). Evidence base: 6,380 recorded candidates across `reports/candidates-2026-08-05.jsonl` (2,745) + `candidates-2026-08-08.jsonl` (3,635); 125/125 tests pass; `tsc --noEmit` clean.**

---

## PART 1 — AUDIT

### 1. Architecture

**Detection.** One WebSocket, one vendor: `new WebSocket('wss://pumpportal.fun/api/data')` — `sniperEngine.ts:994`. On open it sends exactly three subscriptions: `subscribeNewToken` (`:998`), `subscribeMigration` (`:999`), `subscribeTokenTrade` for already-known mints (`:1008`). There is **no** `logsSubscribe`, `programSubscribe`, `blockSubscribe`, Geyser or gRPC anywhere in `src/` (grep returns zero). Reconnect is a fixed 2,000 ms with no backoff and no attempt cap (`:1055-1059`); there is no heartbeat, no last-message timer, no staleness detector — a silently-alive-but-dead socket is undetectable.

The only chain-level subscription is `accountSubscribe` on the pump.fun bonding-curve PDA over Helius (`curveWatcher.ts:187`, PDA seeds `['bonding-curve', mint]` at `curveWatcher.ts:47-52`), capped at 40 mints (`sniperEngine.ts:274`). It only subscribes to mints PumpPortal already told us about (`sniperEngine.ts:1566`, `:1837`) — **it cannot discover anything**, so it is not a detection fallback. It does prove the chain-level path is already wired and reachable, which makes the absence of a detection-side chain feed a choice, not a missing capability.

**Venues actually supported — correcting the brief.**

| Venue | Detected? | Evidence |
|---|---|---|
| pump.fun bonding curve | **YES** | `subscribeNewToken` `:998`; curve PDA `curveWatcher.ts:187` |
| pump.fun AMM (`pump-amm`) | **YES**, via graduation | 177 of 178 measured `migrate` payloads |
| Raydium CPMM | **ONLY as a pump.fun graduation destination** — 1 of 178 measured (0.56%) | `pool` is an opaque string forwarded to PumpPortal: `pool: pool || 'auto'` `sniperEngine.ts:863` |
| Raydium pools created independently | **NO** — no feed, no poller, no fallback | Raydium program IDs appear only as a holder-exclusion list, `rugcheckService.ts:20-23` |
| Meteora / DLMM | **NO — zero references in the entire repo** | `git grep -in "meteora\|dlmm"` → 0 hits |
| Orca / Whirlpools | **NO** | only in `POOL_OWNERS` exclusion, `rugcheckService.ts:24-25` |

If you believe the bot covers Pump.fun / Raydium / Meteora: it covers **pump.fun and its graduation destination only**. Everything downstream also assumes pump.fun curve math (`pipelineUtils.ts:81 bondingCurveTokensOut`, `entryGateV2.ts:24 PUMP_VIRTUAL_SOL_BASE=30`), so adding a venue is a real project, not a subscription line. Also stale: `types.ts:5` documents "77x pump-amm, 1x raydium-cpmm over 78 graduations" — the current data is 177/1 over 178.

**Hot path — detection → fill, every await, with measured timings (n=6,380).**

| # | Step | file:line | Measured |
|---|---|---|---|
| 1 | ws message arrives, `arrivalMs` stamped | `sniperEngine.ts:1012-1015` | t1 |
| 2 | `JSON.parse` | `:1018` | t1→t2 **p50 0ms, p99 1ms, max 2ms** |
| 3 | optional `getSlot` (flag OFF) | `:1096` | never sampled |
| 4 | **await** `Promise.all([RugCheck.getReport(WithHolders), DexScreener])` | `:1163-1168` | t2→t3 **p50 128, p90 456, p99 1,602, max 10,436ms** |
| 5 | **await** `inspectMintSafety` → `getAccountInfo` | `:1280` → `honeypotDetector.ts:88` | inside t3→t4 |
| 6 | `riskFilter.evaluateToken` (sync) | `:1310` | — |
| 7 | t4 decision stamped | `:1348` | t3→t4 **p50 38, p90 81, p99 566, max 4,511ms** |
| — | **t1→t4 total** | | **p50 178, p90 538, p95 805, p99 2,012, max 10,504ms** |
| 8 | **await** `wallet.refreshBalance(true)` → `getBalance` | `:1653` → `walletService.ts:265` | **0 samples** |
| 9 | **await** `axios.post('pumpportal.fun/api/trade-local')` timeout 10,000ms | `:844` | **0 samples** |
| 10 | sign, t5 | `:869-870` | **0 samples** |
| 11 | **await** `sendRawTransaction({skipPreflight:true, maxRetries:3})`, t6 | `:872-876` | **0 samples** |
| 12 | **await** `confirmTransaction` — polls `getSignatureStatus` every 1,500ms up to 30,000ms | `:894`, `:955-975` | **0 samples** |
| 13 | **await** `inspectFill`, t7 | `:919-925` | **0 samples** |
| 14 | `activePositions.push` — position becomes visible to exits | `:1806` | — |

**t5, t6, t7, `slotAtArrival` and `landedSlot` are present in 0 of 6,380 records.** Steps 8–14 have never executed: 3,534 real-mode candidates over 114.7 minutes and 98 real migrations produced zero `buy_attempted`/`buy_failed`/`buy_confirmed`. All 20 `buy_confirmed` rows are `mode:"paper"`, all `txType:"migrate"`.

**Concurrency.** The ws handler is `async` and not awaited (`:1012`), so candidates run concurrently — measured max **8 in flight** (histogram: 1×5,044 / 2×915 / 3×250 / 4×91 / 5×47 / 6×24 / 7×7 / 8×2). There is **no queue, no semaphore, no per-mint in-flight set, no dedup** anywhere.

**Exit trigger path** — `updateAndCheckPositionExit`, `sniperEngine.ts:2166-2404`, evaluated every 1,000 ms (`:65`), fixed order, each rung returns early:

1. latched `forceExitReason` → sell 100%, `force=true` (`:2171`) — **short-circuits before the price update**
2. no-market-data branch → only the 1,800s time stop (`:2192-2203`)
3. POOL_DRAINED (`:2283-2292`) — requires `hasPair && liquidityUsd > 0`
4. SELL_FLOW (`:2303-2310`) — `buyPressurePct < 25` for 3 ticks
5. pullback rung +60%/−15% → sell 50% (`:2332`)
6. TP1 `takeProfitPct` +100% → sell 50% (`:2346`)
7. TP2 +400% → sell 50% (`:2357`)
8. trailing ratchet, arms at 3.0× peak, 30% giveback → 50% then 100% on second trigger (`:2372-2386`)
9. time stop 1,800s (`:2397`)
10. plus CURVE_DRAINED out-of-band (`:1506`) and manual LIQUIDATE (`:2531`)

---

### 2. Rug filtering today

| # | Owner's check | Status | file:line | Reality |
|---|---|---|---|---|
| a | Mint & freeze authority renounced | **PARTIAL** | `riskFilter.ts:108-109`; `rugcheckService.ts:241-265`; `honeypotDetector.ts:105-113` | Freeze **is** read on-chain (COption at offset 46). **Mint authority is never read on-chain anywhere.** Both are derived from the RugCheck report, and when RugCheck 404s the inferred report *asserts* both are null — **5,450 of 6,380 rows (85.4%) are `isInferred:true`**, i.e. asserted, not measured |
| b | LP burned or locked | **STUBBED** | `riskFilter.ts:120-129` | Only `markets[0].lp.lpLockedPct`. Empty-markets branch leaves it `true` → **92.2% of candidates skip the check**. Data present on 285/3,635 (7.8%), 284 read 100%, producing **exactly 1 rejection in 3,635 rows**. No burn-address check, no locker-program recognition, no lock duration, only `markets[0]`. Default `minLpLockedPct = 0` makes the comparison vacuous outside strict mode |
| c | Holder concentration / top-10 | **EXISTS — best-built check in the system** | `rugcheckService.ts:129-225`; `sniperEngine.ts:1218-1223` | Correctly strips the curve PDA, `POOL_OWNERS`, and report market accounts; aggregates by owner; flags `concentrationAnomaly > 100.5`; **fails closed**. Usable on only 67/3,635 (1.8%) overall — but **61/101 migrations (60.4%)**, which is the only tradeable class. `MIN_HOLDER_SAMPLE=5`/`MIN_TOTAL_HOLDERS=10`/`MAX_RUGCHECK_SCORE=1000` are module consts with no config knob |
| d | Deployer history (prior rugs, wallet age, supply held) | **ABSENT** | `riskFilter.ts:170` `const devPriorRugRateClean = true` | Sole reference in the repo. Supply-held is a *largest-holder proxy* (`sniperEngine.ts:1226-1231`). Real dev-buy checks exist in `entryGateV2.ts:145-163` but the gate is flag-off and create-only (`if (!isMigration)`) — so it would not fire on migrations anyway |
| e | Sell simulation / honeypot | **STUBBED (pre-buy) + DEAD CODE (real test)** | `riskFilter.ts:131` `const sellSimPassed = true`; `honeypotDetector.ts:159-180` | `simulateSellPath()` is written, correct, and has **zero call sites**. The module's own comment (`:20-21`) calls the pre-buy checks "not a substitute for the post-buy sell simulation… which IS a real test" — and never wires it up |
| f | Liquidity vs market cap sanity | **ABSENT** | `riskFilter.ts:180-185`; `playbookRouter.ts:259-262`, `:272-275` | Every liquidity rule is an absolute floor. The only ratio computed anywhere is `turnover5m` (`dexscreenerService.ts:271`), carried into `launchData` (`sniperEngine.ts:1256`) and **read by nothing**. A $12k-liquidity / $400k-mcap token (33:1) passes every rule |
| g | Velocity red flags (LP pull, buy/sell ratio, single-wallet volume) | **POST-BUY ONLY** | `sniperEngine.ts:1132`, `:1506`, `:2281`, `:2302` | Pre-buy: `washScore` hardcoded to 0 when real data is on, so `washScoreClean` is unconditionally true; `buyPressureClean` hardcoded true. Buy/sell ratio is used only as a *strategy* term (`playbookRouter.ts:240`, `:281`), never as safety. Single-wallet volume is unmeasurable — `uniqueBuyers5m` needs the paid PumpPortal feed and reads 0–1 |

**Structural defect underneath all of it:** 10 of the 20 `Gate0Result` booleans are literal `true` (`riskFilter.ts:118, 131, 144, 145, 158, 170, 171, 204, 205, 206`), and `allPassed` (`:209-221`) ANDs only 12 terms — **8 of the constants are not even in the conjunction**. Nothing in `src/` reads them; they exist only to be serialized to `/api/screen` and `/api/results` (`server.ts:186`, `:201`) as green checkmarks. Six `FilterConfig` knobs (`types.ts:103,104,105,114,115,117`) have zero read sites; `setLeniencyMode` re-tunes `maxSingleHolderPct` three times per mode switch (`riskFilter.ts:57/65/74`) and no comparison ever reads it.

**Other measured facts.** The migration liquidity assertion `2 * 79 * solPriceUsd` (`sniperEngine.ts:1270`) shaped **71 of 101 migration rows (70.3%)** in the last run, including both paper buys. `inspectMintSafety.unverified` is computed and discarded — an unreachable RPC returns `{safe:true}` and the token proceeds (`sniperEngine.ts:1281` reads only `!verdict.safe`). Creator tracking is dead: all 178 migrate payloads contain only `[signature, mint, txType, pool]`; **19 of 20 buy_confirmed rows carry `creator:'Unknown'`**, so `devSellMonitor.track()` returns immediately at `devSellMonitor.ts:39` — the three creator stops are dead for a reason **independent** of the unfunded PumpPortal key. `LINKED_WALLET_SOLD` is structurally unreachable: the only in-class write to `linked` re-adds the creator, the one address the alert branch excludes (`devSellMonitor.ts:91` vs `:123-125`), and `addLinkedWallets` has no callers.

---

### 3. Entry sizing & exit logic today, stated plainly

**Sizing is flat, not risk-scored.** At arm time `computeRunBudget()` (`sniperEngine.ts:338-347`) → `splitWalletIntoSlots()` (`pipelineUtils.ts:202-216`) divides deployable SOL by `slots = min(maxActivePositions, 20)` and snapshots the result into `runSlotStakeSol`. Every entry stakes exactly that (`:1663-1668`).

Worked for the 1.2 SOL wallet at SOL=$200, `maxSlippagePct=25`, `priorityFeeSol=0.003` (static — `dynamicPriorityFee` is false):
- deployable = 1.2 − 0.005 gas float = **1.195 SOL**
- slot budget = 1.195 / 3 = **0.39833 SOL**
- stake per slot = (0.39833 − 0.003 − 0.0025) / 1.265 = **0.31054 SOL ≈ $62.11**
- breakeven = **5.59%** vs the 6% gate

**Conviction score is computed and discarded.** `routePlay()` returns `sizeMultiplier` 1 / 0.5 / 0 (`playbookRouter.ts:211-212, 243, 264, 285`), assigned at `sniperEngine.ts:1634` — and with `walletSplitSizing` default true, `runSlotStakeSol > 0` on every armed run, so the multiplier never reaches `computeEntrySizeSol`. A score-55 and a score-66 candidate stake the identical slot.

**Exposure.** There is **no max-%-of-bankroll rule anywhere** (grep for `maxExposure|exposurePct|maxBankroll|reservePct|maxDeploy` → zero). Slot budgets sum to **99.58% of the wallet**; staked notional across 3 slots is **77.6%**; the difference is fee/slippage headroom. Per-trade staked risk is **25.9% of the wallet**. The only reserve is `gasFloatSol = 0.005` (`walletService.ts:46`), and `setGasFloat()` has zero callers.

Concurrency is the only limit, and it is (a) bypassable — `sniperEngine.ts:1581` skips the check entirely when `maxActivePositions >= 99999`, and `server.ts:138` passes `req.body` into `updateConfig` with **no validation of any field**; and (b) raceable — the limit is read at `:1583` and the duplicate-mint check at `:1588`, but `activePositions.push` happens at `:1806`, after up to 30s of `confirmTransaction`. Worse, `executeBuy` reserves stake at `:1749` and `evaluatePlaybookTrigger` overwrites `availableTradeSol` wholesale at `:1654` on every entry, erasing the reservation.

**Exits.** No price stop-loss (deliberate — see Part 3). Trailing stop arms only at 3.0× peak. Profit rungs at +60%/−15% pullback and +100% are **mutually exclusive** — both require `!principalRecovered` (`:2332`, `:2346`) and the first to fire consumes the latch, so between one 50% sale and +400% there is **no profit-taking at all**. `trailingTriggerCount` (`:2373`) is never reset, so the second trigger ever — however much later, after a full re-arm from 3× — liquidates 100%.

**Circuit breakers: exactly one is wired.** `checkKillSwitch()` (`:2058-2069`), reachable only from `pushTrade()` (`:2050`), trips at −$70 realized in a rolling hour. At $62.11 per dead slot, one zero does **not** trip it; the second does — by which point slot three is already open, and tripping retains open positions (`:2055-2056`, `:2066`). `consecutiveLosses`, `dailyPnlUsd` and `peakBankrollUsd` are **write-only** — no conditional, no log line, no `getStatus()` payload reads them. No daily loss limit, no consecutive-loss cooldown, no drawdown breaker, no per-token cooldown. A position whose sell keeps failing never writes a trade record, so an unrealized wipeout cannot trip the switch while new entries keep firing.

**MEV: none.** `jitoTipSol: 0.001` appears once with the inline comment "NOT wired to anything" (`:177`, mirrored `types.ts:229-230`, `FLAGS.md:90`). Submission is a plain `sendRawTransaction` with `skipPreflight:true` to the public Helius RPC, with 25% slippage tolerance on both legs. The field is in the config surface and the UI, so it reads as a knob that does nothing.

---

### 4. Hardcoded thresholds

96 non-config numeric thresholds were catalogued. The ones that matter, by category:

**(A) Config field exists but is bypassed — live bugs**

| Value | Controls | file:line | Should be config |
|---|---|---|---|
| `2` | Play 2 min velocity5m — `config.play2MinVelocity5m` sits unused in the same function | `playbookRouter.ts:237` | **BUG — NORMAL tier's 1 has no effect** |
| `60` | Play 2 min buy pressure — `config.play2MinBuyPressurePct` unused | `playbookRouter.ts:240` | **BUG — NORMAL tier's 55 has no effect** |
| `2000` | `isPoolDrained` minPeakUsd — engine never passes it | `pipelineUtils.ts:253` | yes |
| `25` | maxHourlyLossUsd fallback — contradicts the 70 default | `sniperEngine.ts:2060` | yes |

**(B) Risk numbers gating real money with no knob**

| Value | Controls | file:line |
|---|---|---|
| `25` | SELL_FLOW buy-pressure threshold — its companion `sellFlowExitTicks` **is** config | `sniperEngine.ts:2303` |
| `60` / `15` | pullback rung: min pnl%, min drawdown% | `sniperEngine.ts:2332` |
| `5` / `0.6` | CURVE_DRAINED min peak SOL / drain fraction — POOL_DRAINED uses `config.poolDrainExitFraction=0.5` for the same class of event | `sniperEngine.ts:1506` |
| `5` / `10` / `1000` | MIN_HOLDER_SAMPLE / MIN_TOTAL_HOLDERS / MAX_RUGCHECK_SCORE | `sniperEngine.ts:81, 82, 89` |
| `0.005` | `gasFloatSol` — **the only wallet reserve that exists** | `walletService.ts:46` |
| `99999` | "unlimited positions" sentinel — **delete** | `sniperEngine.ts:748, 1581` |
| `20` | slot cap in `computeRunBudget` — conflicts with the 99999 sentinel | `sniperEngine.ts:340` |
| `2 * 79` | asserted migration liquidity, both sides, in SOL | `sniperEngine.ts:1270` |
| `10` | MIN_CURVE_LIQUIDITY_SOL | `sniperEngine.ts:45` |
| `40` | curveWatcher subscription cap | `sniperEngine.ts:274` |
| `1.5` / `60_000` / `3` | dev-sell cluster SOL / window / distinct wallets | `devSellMonitor.ts:69, 103, 107` |
| `30_000` / `1500` | confirmTransaction timeout / poll interval | `sniperEngine.ts:957, 973` |

**(C) Duplicated cost model that can drift**

| Value | Copies |
|---|---|
| `0.0025` fixed overhead | `pipelineUtils.ts:128`, `sniperEngine.ts:744`, `:2135` |
| `0.015` protocol fee (pump 1% + portal 0.5%) | `pipelineUtils.ts:129`, `sniperEngine.ts:2131`, `:2148`, and `0.03` assumed at `:2119` |
| Play 2 gate | `sniperEngine.ts:1418-1423` (bare literals) vs `playbookRouter.ts:229-240` |
| Graduation SOL | `sniperEngine.ts:1200` (85) vs `playbookRouter.ts:24` |

**(D) Dead literals to delete:** legacy fabrication block `sniperEngine.ts:1129-1141`; legacy router bands `:1638-1642`; paper RNG drift `0.12/0.048` at `:2219`; lenient tier in `riskFilter.ts:72-78` (coerced to normal at runtime); the entire duplicated threshold set in `stream_fresh_launches.ts:41-44`.

---

### 5. Latency bottlenecks, ranked

| Rank | Bottleneck | Measured cost | file:line |
|---|---|---|---|
| 1 | **PumpPortal→chain lag — completely unmeasured** | **UNKNOWN.** `timelineSlotSampling` is false, so `slotAtArrival` is 0/6,380 and `landedSlot` is 0/6,380. There is **no evidence in this repo** for the "detection ≤1 slot" belief — the only instrument that could produce it has never been on. If this is 300–800ms, every optimization below is noise | `sniperEngine.ts:994`, flag at `:1095` |
| 2 | **RugCheck enrichment `Promise.all`** | t2→t3 **p50 128, p90 456, p99 1,602, max 10,436ms** — the single largest measured stage | `sniperEngine.ts:1163-1168` |
| 2a | ↳ `getReportWithHolders` retry loop: 3 attempts × 1,200ms sleep, each with its own 10s axios timeout | **+2,400ms of pure sleep on ~25% of migrations**; worst case ~30s. Committed 00:43 today (a84ba28) — **after every run in `reports/`**, so it has 0 samples. Sits inside Play 3's 90s window, which `playbookRouter.ts:253` measures from *routing*, not detection | `rugcheckService.ts:115-124` |
| 2b | ↳ global 200ms serial rate-limit chain, no per-mint cache, no priority lane | 18.3% of inter-arrival gaps are <200ms, up to 8 in flight; a migration queues behind creates it was never going to buy | `rugcheckService.ts:59-68` |
| 3 | **Honeypot RPC runs on every candidate** | t3→t4 rose from p50 0 / p90 51 / mean 23.1ms (08-05, flag off) to **p50 44 / p90 105 / p99 865 / max 4,511 / mean 84.1ms** (08-08, flag on). 3,635 `getAccountInfo` calls of which 101 (2.8%) were migrations. The comment at `:1276-1277` claims a tradeable-candidate guard **that does not exist in the code** | `sniperEngine.ts:1279` |
| 4 | **`confirmTransaction` blocks position registration up to 30,000ms** | Position is invisible to all exits for up to 30s after submission; 1,500ms poll adds ~750ms mean detection delay on top | `sniperEngine.ts:955-975`, push at `:1806` |
| 5 | **Forced `getBalance` between decision and order** | `force=true` bypasses the TTL cache; est. 30–120ms, **0 samples**. A 10s background sync already exists and the size was snapshotted at arm time | `sniperEngine.ts:1653` |
| 6 | **DexScreener call on the migration hot path whose liquidity answer is discarded** | Runs inside the `Promise.all`, 5,000ms timeout; the liquidity result is overwritten by the `2*79*solPrice` assertion 100ms later | `sniperEngine.ts:1163-1168`, override `:1269-1271` |
| 7 | **Two synchronous side effects per log line** | ≥12,760 blocking `console.log` + SSE fan-outs; bounded by t1→t4 p50 178ms, likely single-digit ms | `sniperEngine.ts:2575-2576` |
| — | **Everything after t4 — the entire submit-and-land half** | **0 samples of t4→t5, t5→t6, t6→t7 across 6,380 records.** Any end-to-end latency claim today is an estimate of the first 178ms and a guess about the rest | `latencyTimeline.ts:120-132` |

---

## PART 2 — PRIORITIZED FIX LIST

`Sign-off` = moves a risk parameter (position size, stop behaviour, max concurrent, loss limit) and must not ship without your explicit yes.

| # | Item | Area | Impact | Eff | Latency effect on detection→buy | Sign-off |
|---|---|---|---|---|---|---|
| 1 | Fix `playbookRouter.ts:237/:240` to read `config.play2MinVelocity5m` / `play2MinBuyPressurePct` | thresholds | Live bug: NORMAL tier's loosened Play 2 triggers are silently ignored | S | none | **YES** (changes which trades fire) |
| 2 | Turn on `timelineSlotSampling`; for each `create`, fetch the signature's slot and record `slotAtArrival − txSlot`. Run one hour | observability | Answers the one question every other latency fix depends on | S | +1 fire-and-forget `getSlot` per candidate; non-blocking (`void .then()`) | no |
| 3 | Shadow the `trade-local` POST on gate-passing candidates: build, time, discard, never sign | observability | Produces real t4→t5 numbers today with zero lamports at risk; also validates `pool` routing deserializes | S | none (off the decision path) | no |
| 4 | Call `simulateSellPath` ~2–5s after fill; on `false` set a HONEYPOT `forceExitReason` marked unsellable | rug | Only real sell test in the repo, currently 0 call sites. Today a honeypot retries a full-fee failed sell **every 1,000ms indefinitely** (`:2172` passes `force=true`, bypassing the 5s→10min backoff at `:2011-2016`) | M | none (post-fill) | no |
| 5 | Cap the forced-exit retry loop: N attempts or `timeElapsedSec > maxHoldSeconds` → mark stranded, stop burning fees | exits | Prevents the unbounded fee burn above; precedent: 35 failed txs / 0.035 SOL in under a minute (`:2007-2010`) | S | none | no |
| 6 | Move `forceExitReason` short-circuit **below** the price/pnl update | exits | Today a latched exit freezes `currentPriceUsd`/`pnlPct` forever and the position can never reach the time stop | S | none | no |
| 7 | Pass the current tick's `dexData.liquidityUsd` into the paper sell sim instead of the frozen entry snapshot | paper | Paper understates rug-exit slippage by ~20+ pts (modelled ~1.3% vs real ~24% on a $12k→$500 drain). Also closes the `liquidityUsd=0` fallback at `paperSimulator.ts:154-157` that prices exits at **zero** impact forever | S | none (paper only) | no |
| 8 | Fix `feeDragUsd`: `fill.feeSol * solPriceUsd` instead of hardcoded `0/0.20/0.40` | reporting | `honestPaper` reports "Fees paid +$0.00" — the one metric built to expose the cost stack | S | none | no |
| 9 | Add `positionId` + `legIndex` to `TradeHistoryRecord`; compute per-position aggregates | reporting | Win rate counts **legs**: verified run shows 9 positions → "15 closed, 93.3% win rate". Moonbag ratchet makes this worse over time | S | none | no |
| 10 | Add structured `exitCode` and bucket on it | reporting | Current format `SOLD 50% — PROFIT +$8.2: …` has no parenthesis, so `reportService.ts:132` gives **one bucket per dollar amount** — the "by exit reason" table degenerates to one row per trade | S | none | no |
| 11 | Split the profit rungs: `pullbackRungTaken` / `tp1Taken` / `tp2Taken` instead of one shared `principalRecovered` | exits | Today +60%/−15% and +100% are mutually exclusive; a 2.9× round-trip books exactly one 50% sale near +65% and rides the rest to the time stop | S | none | **YES** |
| 12 | Reset `trailingTriggerCount` inside `recordPartialSell()` | exits | The second trigger *ever* closes 100%, however much later, defeating the stated re-arm design | S | none | **YES** |
| 13 | Interim exit for the fresh-migration blind window: secondary time stop (~180s) while a position has had **no market data at all** | exits | Play 3 — the primary play — enters with zero DexScreener data and has **only the 1,800s timer** as an exit. POOL_DRAINED and SELL_FLOW both require `hasPair && liquidityUsd>0`, and `peakLiquidityUsd` seeds from the first observed value, so pre-indexing drains are invisible by construction | S | none | **YES** |
| 14 | Entry reservation: `entriesInFlight` Set claimed synchronously at `:1588`, released in `finally`; gate on `activePositions.length + entriesInFlight.size`; change `:1654` to `deployable − reservedSol` | sizing | `maxActivePositions` is advisory across a ~30s window and the reservation is erased on every entry. Latent only because zero buys have ever fired — it **arms itself the moment the gate loosens** | M | none (O(1) set) | **YES** |
| 15 | Delete the `99999` sentinel; add a clamp table in `updateConfig`: positions 1–20, slippage 1–40, priorityFee 0–0.05, breakeven 1–15 | config safety | `POST {maxActivePositions:99999}` removes the only exposure limit; nothing validates any field | S | none | **YES** |
| 16 | Add `config.maxDeployedFractionPct` (suggest ~60) applied inside `computeRunBudget` before the division | sizing | Today 99.6% of the wallet is committed / 77.6% staked across 3 slots on an asset class the repo itself calls 60–80% rug rate, with no price stop | S | none | **YES** |
| 17 | Gate the honeypot RPC behind `isTradeableCandidate` (matches the existing comment) | latency | Removes ~44ms p50 / ~105ms p90 / 865ms p99 from 97% of candidates | S | **−44ms p50** | no |
| 18 | Make `getReportWithHolders` non-blocking, or bound it by remaining Play-3 wall clock and drop per-request timeout to ~2,500ms | latency | Removes up to 2,400ms of sleep from ~25% of migrations | M | **−2,400ms worst case** | no |
| 19 | Drop `force` on `refreshBalance` at `:1653`; widen the affordability margin | latency | Removes an est. 30–120ms RPC from every entry | S | **−30–120ms** | no |
| 20 | Read the mint-authority COption at offset 0 in the already-fetched mint account; override `gate0.mintAuthorityRevoked` with on-chain truth | rug | Closes owner check (a); mint authority is currently measured **nowhere** | S | **zero extra RPC** (reuses `honeypotDetector.ts:88`) | no |
| 21 | Treat `verdict.unverified.includes('mintAccount')` as a reject on tradeable candidates; record the rest in the timeline | rug | An RPC timeout currently returns `{safe:true}` and the token proceeds — breaks the "unknown is not safe" rule the rest of the pipeline enforces | S | none | no |
| 22 | Resolve creator from `curveWatcher.getLast(mint)?.creator` (already decoded at `curveWatcher.ts:61`) before `devSellMonitor.track()`; log loudly when still Unknown | rug | Revives DEV_SOLD / LARGE_SELL_CLUSTER for the 95% of positions where they are dead — a cause **independent** of the unfunded PumpPortal key | S | none (post-fill, in-memory) | no |
| 23 | Delete `jitoTipSol` from `BotConfig`, `types.ts` and the UI | honesty | The config surface advertises MEV protection that does not exist | S | none | no |
| 24 | Lower `maxSlippagePct` from 25 to 8–12 | MEV / cost | 25% is the width of the window a sandwicher can farm, on both legs, in the public mempool | S | none | **YES** |
| 25 | Add expected round-trip price impact to `breakevenPct` using the entry pool snapshot | economics | The 6% gate certifies a trade at 5.59% while ignoring a 25% slippage tolerance — materially understated exactly on thin pools | M | none (snapshot already fetched) | **YES** |
| 26 | Make replay call the engine's real decision path: extract options construction + honeypot block + router override + economics refusal into one shared pure function | validation | **Same gate, same 6,380 records: 111 passes live vs 27 in replay = 4.1×.** Re-running with the engine's three options gives 849 vs 27 = **31×**. Biggest single lever is the liquidity floor: $8,000 in replay vs ~$740 live. Offline validation is currently meaningless | M | none (offline) | no |
| 27 | Normalise numerals before bucketing in `replay.ts:92` and `reportService.ts:68` | validation | 498 buckets for 10 real reasons; the dominant reason prints as 1,141 when the true aggregate is **3,573 (56% of all rejections)** | S | none | no |
| 28 | Outcome follower: sample price/liquidity at T+1/5/15/60m for every recorded candidate → `reports/outcomes-*.jsonl` | validation | **Nothing anywhere records what a token did after the decision.** Until this exists, "would this filter change have made money" and "what % of rugs did we catch" are unanswerable — this is the hard ceiling on all backtesting | L | none (off the decision path; the logger already flushes async every 2,000ms) | no |
| 29 | Circuit breakers: wire `consecutiveLosses` → pause; `dailyPnlUsd` → `maxDailyLossUsd`; call `checkKillSwitch()` from the monitor tick including unrealized P&L | risk | Three write-only fields; today a slow bleed with no closes can never trip anything while new entries keep firing | M | none | **YES** |
| 30 | SELL_FLOW: count ticks only on a **changed** observation, or require 60s of wall clock. Promote the `25` to config | exits | 3 ticks span ~3s against a 2.5s HTTP cache and a rolling 5-minute aggregate — the confirmation confirms nothing | M | none | **YES** |
| 31 | Optimistic position registration at submission with `status:'PENDING'`, reconcile on confirm; drop poll to 400ms or use a signature subscription | latency / exits | Closes the 30s window where a held position is invisible to every structural stop — the only loss side that exists | M | none on entry | no |
| 32 | Replace the `2*79*solPrice` assertion with a real read of the destination pool's SOL vault; tag `liquiditySource: measured\|asserted` | rug | The fabricated number is the single input that makes Play 3 reachable and shaped 70.3% of migration candidates | M | +80–200ms on migrations only (2.8% of candidates), inside a 90s window | **YES** |
| 33 | Add `maxMcapToLiquidityRatio` to the MIGRATION / POST_MIGRATION branches (start 15–25:1; a genuine graduation is ~5:1) | rug | Closes owner check (f). Depends on #32 or it computes against a constant | S | none | **YES** |
| 34 | Delete the 8 orphaned Gate0 booleans and 6 dead FilterConfig knobs; promote `maxSingleHolderPct` into a real gate term | rug | Stops the API advertising checks that cannot affect any verdict | M | <1µs | no |
| 35 | Real LP burn/lock: LP supply==0 → burned; else resolve the largest LP holder against a locker-program set with lock end time; iterate **all** `report.markets` | rug | Closes owner check (b), currently skipped for 92.2% of candidates | L | +100–250ms, migrations only | no |
| 36 | Persist the fill (`solDelta`, `tokenDelta`, `feeSol`, `slot`) + `expectedTokensAtDetection` on `CandidateTimeline`; warn on adverse fills | MEV | The ingredients exist and are simply not joined; today the fill is logged to console and dropped | M | none (post-confirmation) | no |
| 37 | Tests for `reportService` aggregation, both reason bucketers, and `honeypotDetector` verdict logic | tests | ~3,000 lines have zero coverage, incl. every module touching real money. These tests would have caught #8, #9, #10 | L | none | no |
| 38 | Fixture suite from the corpus (mints listed in the findings) pinning the 18-of-20 Gate-V2-rejects-what-legacy-bought result | tests | Best regression guard available from recorded data | M | none | no |
| 39 | Collapse the fee/overhead model into one exported `COST_MODEL`; promote the risk literals (SELL_FLOW 25, pullback 60/15, CURVE_DRAINED 5/0.6, `isPoolDrained` 2000, gasFloat, MIN_HOLDER_SAMPLE, MAX_RUGCHECK_SCORE) to `BotConfig` | thresholds | Four independent copies of one fee model; risk numbers unreachable from config or UI | L | none | no |
| 40 | Delete dead code: legacy fabrication `:1129-1141`, legacy router `:1638-1642`, paper RNG `:2219`, lenient tier, `stream_fresh_launches.ts` (or move to `scripts/` with a header) | hygiene | `stream_fresh_launches.ts` duplicates screening thresholds that exist nowhere else — any threshold audit reading it draws conclusions about a path that never trades | M | none | no |
| 41 | Prune `migrationSeenAt` in the existing 60s watchlist prune | hygiene | Unbounded map, ~51 entries/hr, no TTL — the same leak `curveWatcher` explicitly guards against | S | none | no |
| 42 | Skip `emitChange()` for `gate0` log level; debounce SSE 100ms | latency | UI gets a full state snapshot ~1.2×/s of pure screening chatter | S | small | no |
| 43 | Two-lane RugCheck limiter (tradeable jumps the queue) + 2–5s per-mint report cache | latency | Removes queue-depth × 200ms from migrations during bursts | M | **−(depth × 200ms)** on migrations | no |
| 44 | **Decide** Raydium/Meteora: either write down that the bot is pump.fun-only, or add a real `logsSubscribe`/`programSubscribe` pool-init listener normalized into `processIncomingToken` | architecture | Addressable universe today is 0.56% of migrations for Raydium and **0% for Meteora**. Everything downstream assumes pump.fun curve math | L | none (coverage, not latency) | **YES** (strategy scope) |
| 45 | Re-run shadow mode at a3dad0f to regenerate divergence; port `devInitialBuyPct` / `devInitialBuySol` into Gate 0 meanwhile | gates | The 08-08 divergence set was produced by a **different gate composition** than ships today (its reason histogram contains a string that now lives only in `playbookRouter.ts:220`) | S | none | no |

### Grouping

**P0 — do first (this week):** #1–#16.
**P1 — next:** #17–#31.
**P2 — after:** #32–#45.

**Why this order.** P0 is deliberately front-loaded with *measurement* (#2, #3) and *correctness of things that will hurt the first real trade* (#4–#16), because the bot has never opened a live position: nothing here is fixing an observed loss, it is closing traps that spring the moment the gate loosens. #1 is first because it is an outright bug — a config field the code ignores, which means every tuning experiment you have run on the NORMAL tier's Play 2 was a no-op. #2 comes second because until you know whether PumpPortal is 100ms or 800ms behind the chain, the entire P1 latency block (#17–#19, #43, worth roughly 2.5 seconds combined) may be optimizing a rounding error against a fixed handicap — one hour of data reorders the whole list. P1 is the latency and gate-honesty work whose value #2 will confirm or kill. P2 is the expensive structural work — outcome data (#28, already promoted to P0-adjacent priority by being a hard ceiling), real LP checks, venue expansion — none of which is worth starting before the cheap correctness fixes land and the bot has actually traded once.

---

## PART 3 — CONFLICTS AND DECISIONS NEEDED

### 3.1 The brief asks for a hard stop-loss. You deleted it today.

**The conflict is direct.** Commit `b05851c` removed `config.stopLossPct` at your explicit direction, and `src/tests/run.ts` now asserts by regex that the engine source contains no reference to it. The current audit brief asks for a hard stop-loss. **I have not reimplemented it and will not without your explicit word.**

**What a hard price stop protects against, honestly:** it is the only exit that does not depend on a data feed. Every loss-side exit you have today requires something external to work — POOL_DRAINED and SELL_FLOW require an indexed DexScreener pair with non-zero liquidity and volume (`sniperEngine.ts:2281`, `:2302`); CURVE_DRAINED requires a CurveWatcher subscription that migrated positions never get (`:1835` needs `pool.vSolInBondingCurve`, absent on migrate payloads); DEV_SOLD and friends require a creator address that 19 of 20 bought tokens did not have. A price stop needs only a price. That is why finding #13 exists: a Play 3 entry — your primary play — currently has **exactly one** loss-side exit for its first several minutes, and it is a 30-minute timer.

**Why you removed it and what it cost:** on tokens this volatile, a percentage stop converts ordinary noise into realized loss and fee burn. Your memory note is unambiguous: crashes are accepted, exits should be hold-biased, tight stops must not come back. The stop was firing on wicks, not on rugs.

**These are not the only two options, and I want to name the middle one before you choose:**

| Option | What it does | What it costs |
|---|---|---|
| **A — keep no stop** (status quo) | Structural exits only | Play 3's first minutes have no loss-side exit at all. Fix #13 (a 180s no-data time stop) partially covers this without touching price |
| **B — hard price stop** as the brief asks | Fires on % drawdown from entry | Reintroduces exactly the noise-to-loss conversion you deleted; requires deleting the guard test |
| **C — catastrophic-only floor** | A single very wide floor (e.g. −70% or −80% from entry) that fires only where a rug is the overwhelmingly likely explanation, never on ordinary volatility | Not free: it is still a price stop and will occasionally sell a token that would have recovered. But at that width the noise/rug ratio has inverted |

**Decision needed: A, B, or C — and if C, at what percentage.** I recommend you consider C *only after* #13 ships, because #13 addresses the specific hole (no data → no exit) without reopening the noise problem, and it may be sufficient on its own.

### 3.2 Other places the brief conflicts with evidence or with an earlier decision

- **"Pump.fun / Raydium / Meteora pool detection."** Measured: Raydium is reached as a *graduation destination* in 1 of 178 migrations, and only as an opaque string forwarded to PumpPortal. Meteora has **zero references in the entire repository**. This is a scope decision (#44), not a bug to fix.
- **"Backtesting / paper mode" as a validation tool.** `replay.ts` runs a materially different gate than the engine — same records, same gate class, **111 passes live vs 27 in replay**, and 849 vs 27 once the engine's options are supplied. And no forward outcome is stored for any candidate, so replay can only ever score a pass-rate delta, never profitability or rug-catch. Treat every past replay result as uninformative until #26 and #28 land.
- **Circuit breakers.** The brief implies they exist. One does. `consecutiveLosses`, `dailyPnlUsd` and `peakBankrollUsd` are write-only — not read by any conditional, log line, or status payload.
- **MEV/Jito.** `jitoTipSol` is in the config API and the UI. It does nothing. An operator can set it and believe they are protected.
- **The paper report.** `honestPaper` mode prints "Fees paid $0.00" and a win rate computed on legs, not positions (verified: 9 positions reported as "15 closed, 93.3% win rate"). Do not use existing paper P&L to justify any parameter choice.

### 3.3 The context that should reorder your instincts

**The bot has never opened a real position.** Three contiguous real-mode sessions, 114.7 minutes, 3,534 real candidates, 98 real migrations, **zero** `buy_attempted` / `buy_failed` / `buy_confirmed`. All 20 `buy_confirmed` records are `mode:"paper"`.

So "weak rug filtering and entry/exit logic" is **not an observed-loss problem — it is an untested-code problem.** Nothing in the exit ladder, the sizing math, the structural stops, the fill inspector, or the confirmation path has ever run against real money. The entire second half of the latency timeline (t4→t7) has zero samples across 6,380 records.

Three consequences for how to prioritize:

1. **Instrumentation before optimization.** #2 and #3 cost hours and convert several of the fixes below them from "probably worth it" to "measurably worth N ms." Do them before spending days on the RugCheck limiter.
2. **The dangerous bugs are the latent ones.** The entry race (#14), the missing bankroll cap (#16), the unbounded honeypot retry (#4/#5), the mutually-exclusive profit rungs (#11) — none has ever fired, and all of them fire on the *first* real trade or the first loosened gate. This is the cheapest moment in the project's life to fix them.
3. **Do not loosen the gate to "get it trading" before P0 lands.** The gate being tight is currently the only thing preventing every latent defect above from becoming a realized loss.

### 3.4 Everything that would ADD latency to detection→buy — flag for conscious choice

| Fix | Added cost | Scope | Verdict |
|---|---|---|---|
| #32 — measure real migration pool liquidity instead of asserting `2*79*solPrice` | **+80–200ms** (one `getTokenAccountBalance`) | migrations only (2.8% of candidates), inside a 90s / 180s window | Recommend accept — well inside budget, and it removes a fabricated number from the sizing path |
| #35 — real LP burn/lock verification | **+100–250ms** (1–2 RPC) | migrations only | Recommend accept |
| #2 — `timelineSlotSampling` on | **~0ms hot-path** — issued fire-and-forget via `void .then()` at `:1096`; cost is Helius quota, not ms | all candidates | Accept |
| #20 — mint-authority COption read | **0ms** — reuses the `getAccountInfo` already awaited at `honeypotDetector.ts:88` | all | Accept, free |
| #25 — impact term in `breakevenPct` | **0ms** — the pool snapshot is already fetched at `:1725` | all entries | Accept, free |
| Deployer-history index (#d in the rug table, deferred) | **0ms if built off-stream and read from memory; 200–800ms if implemented as a synchronous `getSignaturesForAddress`** | all | **Only build the async version.** A synchronous implementation would sit directly in t3→t4 and roughly quadruple p50 |
| #30 — SELL_FLOW wall-clock confirmation | 0ms on entry; **intentionally delays that exit** by up to 60s | held positions | Your call — it trades exit speed for a confirmation that currently confirms nothing |
| #44b — a real Raydium/Meteora listener | Unknown; a second feed adds parse work but is parallel to PumpPortal | new coverage | Only if you choose expansion over scoping down |

Net across P0+P1: the latency additions total **~100–250ms on 2.8% of candidates**, against removals of **~44ms p50 / 865ms p99** (#17), **up to 2,400ms** (#18), **30–120ms** (#19), and **queue-depth × 200ms** (#43). The package is strongly net-negative on latency.