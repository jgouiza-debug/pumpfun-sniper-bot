# Sniper Bot Deep Dive, Critique, and Upgrade Plan
**Date:** 2026-08-13 | **Scope:** full codebase (src/, 33 files, ~12k lines), all trade logs (21,100 candidate records, 13 run reports), fresh market research (Aug 2026)

> Not financial advice. This is an engineering and strategy audit of your own system, grounded in your own logs.

---

## 0. TL;DR, no sugar

Your bot is not losing because it's slow. It's losing because of three decisions, and two of them were yours:

1. **It only buys graduation tops.** Every buy it has ever made (all 22, paper and real) fired on a `migrate` event, at a median market cap 8 to 11x the launch price, and 38% of gate-passed migrations were already up more than 100% in the trailing 5 minutes. The chart you screenshotted, buying the vertical candle and riding it under your average price, is not bad luck. It is the only trade this bot is currently capable of making.
2. **The loss side of the exit engine was deleted on 2026-08-12 at your direction.** `sniperEngine.ts:2948-2952` says it in caps: "THE BOT NEVER SELLS ON ITS OWN." Exits only fire when PnL is positive (`:3076`). On an asset class where your own research doc puts block-0 rug rate above 85%, a losing position now has exactly one exit: you, manually, 9 hours later.
3. **The good code is switched off.** EntryGateV2 (real data only, no fabricated inputs), dynamic priority fees, local tx building, and slot sampling all exist, are well written, and are all `false` in flags.json. The live path runs the legacy filter whose Gate 0 contains 10 hardcoded `true` values, then a router override that flips unsafe verdicts to safe.

The one real closed trade in your entire log corpus is KINGLON: bought 91% of the wallet at 2.55x the decision price, no exit for 9h08m, sold manually at -93.5%. Bankroll went from $8.20 to $1.04. That single trade is a complete catalog of everything in this document.

One more thing before anything else: **the +$3,331 / 93.3% win rate paper report you may be measuring against is fabricated.** It contains a +118,362% trade in 35 seconds and exit reasons ("Smart Chart Trailing Stop", "2x Resistance Breakout Target") that do not exist anywhere in the code. Do not benchmark against it.

---

## 1. The KINGLON autopsy (your screenshot, explained by your logs)

Source: `dist-exe/reports/run_2026-08-13T03-41-44-904Z.json`, `dist-exe/reports/candidates-2026-08-13.jsonl`. Fill verified on-chain.

| Step | What happened | Why |
|---|---|---|
| 04:38:16Z | Token creates at $2,723 mcap. Bot rejects it: "Dev initial buy 12.5% of supply > max 6%" | Correct call. The dev owned an eighth of the supply |
| 04:39:30Z | 74 seconds later it graduates. Snapshot: mcap $12,606, **+362% in 5 min**, pair 77s old | Migration is the only event the bot buys |
| Gate | Legacy gate says `isSafe: false`, score 58 | The gate did its job |
| Override | `sniperEngine.ts:1662-1672` flips it to safe: `gate0.allPassed` and score 58 >= half-unit floor 55 | Gate 0 "all passed" includes 10 checks hardcoded `true` (`riskFilter.ts:118-206`), so the override's precondition is theater |
| Sizing | 0.098338 SOL = $7.48 = **91% of the wallet** | `maxActivePositions: 1` + `maxDeployedFractionPct: 100` puts the whole bankroll in one slot |
| Fill | 1.95s detect-to-confirm, filled at implied mcap **$32.2k, 2.55x the decision snapshot** | 25% slippage tolerance, no re-quote at build, no fill-price abort. The bot decided at $12.6k and paid $32.2k without noticing |
| Hold | **9h 08m with zero exit attempts** while mcap fell to ~$2.1k | All loss-side exits deleted 08-12. `maxHoldSeconds: 1800` is dead config |
| Exit | "Manual User Force Sell Override", proceeds $0.49, PnL **-93.5%** | The only exit path that still exists for a loser |

Also in the logs: a second real buy (Spellingworld, confirmed on-chain 13:51:17Z) landed after the last run report closed. No report covers it. Your real losses are at least one trade bigger than your reports say.

The causal chain for your screenshot is: **migration-only entries** buy the frenzy top, **stale decision data + 25% slippage** fills you far above even that, **all-in sizing** makes the trade existential, and **the no-stop-loss directive** converts a bounded -25% into -93.5%. Latency is fourth-order here. Fixing the first four costs nothing.

---

## 2. What the funnel data says

Across 21,100 candidate records (Aug 5 to 13):

- ~20,580 creates seen, **zero ever bought**. In the exe, `launchSnipe` is false, and `payload.timestamp` doesn't exist on PumpPortal creates, so `ageSeconds` computes 0 and every create classifies as BLOCK_0 and is rejected (`pipelineUtils.ts:22-27`). 97.2% of the funnel dies here.
- ~98% of all rejections are "data unavailable" style reasons, not measured risk. The bot mostly rejects tokens because it can't see, not because it looked and disliked.
- Migration candidates that passed: median mcap $23.4k (8 to 11x launch), median 5m change +56%, p90 +648%. The gate systematically selects already-vertical charts.
- Real closed trades in the whole corpus: **1**. Paper trades: 16, of which 15 sit in the fabricated report. There is no statistically meaningful evidence about your edge in either direction. That is itself a finding: the bot has no measurement loop that could ever prove or disprove profitability (see §5.4).
- Latency where it's measured: detect-to-decision p50 178ms, p99 2,012ms. Build/submit/land (t5/t6/t7) has **zero samples** because `timelineSlotSampling` was never turned on. You literally cannot see the phase of the trade where KINGLON's 2.55x fill happened.

---

## 3. Architecture critique

### 3.1 What's actually good (credit where due)

- **EntryGateV2** (`entryGateV2.ts`): "no invented values, unknown is not safe" is exactly the right design, with real payload math (vSol minus 30 virtual, dev buy bands) and measured RugCheck concentration. It has been sitting in shadow mode since it was written.
- **playbookRouter** (`playbookRouter.ts`): phase classification off measured curve progress, block-0 refusal, boosted-token penalty. The comments show real learning from measurement.
- **dexscreenerService**: token bucket, TTL cache, in-flight dedup, null-on-transport-failure. Best-defended dependency in the repo.
- **paperSimulator** charges pump 1% + portal 0.5% + priority + ATA rent instead of pretending fills are free.
- **rugcheckService** holder normalization (curve PDA exclusion, per-owner aggregation) is careful work.
- The habit of writing down *why* in comments and audit docs is better than most professional shops. The problem is what happened after the writing.

### 3.2 The strategy layer is inverted

- The only live entry is Play 3 (migration), which by construction buys the most crowded, most botted moment of a token's life, 90 to 180 seconds behind bots that streamed the graduation via gRPC. Play 2 (mid-curve momentum, the entry that buys *before* the crowd) is structurally dead on the free tier: `subscribeTokenTrade` delivers zero events without a funded PumpPortal key, so `uniqueBuyers5m` reads 0-1 forever and the velocity fallback rarely clears (`curveWatcher.ts:7-23`, `playbookRouter.ts:243-254`).
- The router override (`sniperEngine.ts:1662-1672`) lets a strategy score overrule a safety verdict. KINGLON is the proof of what that buys you. A score floor is not a safety check, and `gate0.allPassed` is meaningless while `riskFilter.ts` hardcodes 10 of its booleans.
- Migration liquidity is still fabricated: `sniperEngine.ts:1552` asserts `2 * 79 * solPriceUsd` (~$12k) whenever DexScreener hasn't indexed, which is ~97% of migrations at decision time. Every liquidity floor and the mcap:liquidity ratio check run against a constant. Your own audit flagged this (#32); it's still live.
- The two flags.json files have diverged: repo root has `launchSnipe: true`, the exe that actually trades has `false`. Whatever you think you're testing, the binary is doing something else. `DEFAULTS` vs `PACKAGED_DEFAULTS` also differ on 8 of 16 flags.

### 3.3 The exit engine is the single biggest defect, and it's on purpose

Current state (`sniperEngine.ts:2945-3144`):

- Profit side: pullback rung at +60%, TP1 at +100%, TP2 at +400%, trailing armed at 3.0x. All fine, all real.
- Loss side: **nothing**. Pool drained? Logs a warning, holds. Buy pressure collapsed? Warning, holds. Honeypot sell-sim fails post-buy? Logs, holds (`:2924-2929`). Time stop, no-data exit, structural stops: all deleted. `maxHoldSeconds`, `noDataExitSeconds`, `poolDrainExitFraction`, `sellFlowExitTicks` are all dead knobs the UI still renders as live.

Here's the math that makes "no stop losses" untenable on pump.fun specifically. Your winners are capped by your TP ladder (first rung +60 to +100%), but your losers are uncapped and the loss distribution on this asset class includes a fat spike at -80 to -100% (rugs, 85%+ of block-0 launches per your own research doc; 98.7% of tokens show pump-and-dump patterns per Solidus Labs). Asymmetric ladders only produce positive expectancy when the left tail is amputated. Hold-the-loser works on assets with mean reversion. Pump.fun tokens do not mean-revert; 68.7% record their last trade the same day they launch (CoinGecko). The 2026 winners went the *opposite* direction: Padre ships a dedicated dev-sell trigger order, Trojan's headline feature is a multi-level TP/SL ladder armed at buy. Exits are now the product these platforms compete on.

The stop-loss deletion happened because stops kept firing on noise. That was a real problem, but the fix was scoping (structural stops + wide price stop + time stop), not amputation. Section 6 restores exits in three tiers with exactly that scoping.

### 3.4 Infrastructure: single-vendor everything, measured by nothing

- **Detection**: one free PumpPortal websocket. No Geyser/gRPC, no `logsSubscribe` fallback, no heartbeat, no staleness detection, flat 2s reconnect with no backoff or jitter (`sniperEngine.ts:1337-1342`). A socket that stays open but goes silent halts the bot invisibly. The market baseline in 2026 is Yellowstone gRPC ($99-199/mo) and the top tier is shred-level feeds; a raw websocket adds roughly 50-100ms+ before your 178ms of processing even starts.
- **Execution**: decision → PumpPortal trade-local HTTP hop (10s timeout, measured 68-85ms) → sign locally → `sendRawTransaction` to Helius with `skipPreflight: true, maxRetries: 3` → poll every 1.5s up to 30s → up to 9s of fill inspection. Worst case, **~39 seconds between submitting a buy and the position becoming visible to monitoring**, during which nothing can exit it. No staked-connection sender, no Jito path. `jitoTipSol` exists in config and the UI and is wired to nothing (`sniperEngine.ts:212`).
- **Slippage policy**: 25% base, and on a 6004 failure it *retries at* `min(100, s*1.5+5)`: 25 → 42 → 68%. A 68% tolerance on a memecoin buy is an instruction to get sandwiched. Solana sandwich rates average ~5% of trades with much worse pockets; unprotected high-slippage snipes are the ideal victim.
- **Position pricing**: 1s loop off DexScreener's 2.5s cache. Your exit decisions run 3+ seconds behind a market that moves in 400ms blocks, and the free-tier trade stream that would fix it delivers zero events.
- **Hot-path sleeps**: `rugcheckService.getReportWithHolders` can block up to ~33s (3 × 1.2s sleeps + 3 × 10s timeouts) inside Play 3's 90-180s window. `analyzeLeaderTx` in the copy trader sleeps 700ms inside an `onLogs` callback with unbounded concurrency and a TOCTOU dedup race that can double-buy one leader trade (`copyTraderService.ts:389-509`).
- **Measurement**: t5/t6/t7 never sampled, no outcome follower (audit #28: nothing records what any token did after the decision, so no filter change can ever be evaluated for PnL), replay uses a different gate than production (`replay.ts:65-79`), and the funnel report still can't say why 63 passed tokens produced 1 position.

### 3.5 Security: fix these before the next real trade

Ranked, all verified in code:

1. **Wildcard CORS + zero auth on a server holding the signing key** (`server.ts:76`). It binds loopback, but wildcard CORS means any website you visit can POST to `/api/bot/config`, `/api/flags`, `/api/copy/wallets` (add an attacker's wallet as copy leader), `/api/bot/sell-position`, `/api/wallet/link`. That's remote control of your money via a browser tab. Fix: strict `Origin` allowlist + a bearer token the UI sends.
2. **Hardcoded Helius API key, published in a public GitHub repo** (`clientWallet.ts:4`, duplicated `sniperEngine.ts:262,347,355`; repo named in `updaterService.ts:17-18`). FLAGS.md itself says to rotate it. It has not been rotated. Rotate it today, move it to env only.
3. **Private key in browser localStorage, plaintext** (`clientWallet.ts:19,82`), plus plaintext `.photon-wallet.json` whose `0o600` is a no-op on Windows, your only build target. Keep the key server-side only; the browser never needs it.
4. **Shell command interpolation of untrusted data**: `exec('cmd /c start "" "https://photon-sol.tinyastro.io/en/lp/' + mint)` where `mint` arrives from a websocket (`sniperEngine.ts:1200-1206`). Also opens two browser tabs per fill, which is absurd for a bot. Delete the feature or validate `mint` as base58.
5. **Real-mode lock is not atomic and trusts recycled PIDs** (`realModeLock.ts:77-96`); a stale held lock currently ships in the repo. Use `fs.open(path, 'wx')`.
6. **Silent error swallowing**: `server.ts:22-32` matches `/429|timeout|ECONNRESET|.../` on uncaught exceptions and returns without logging. An unoperable choice for a trading process. Log everything, crash on unknown.
7. `parseSecret` tries base64 before base58 with an ambiguous regex, so some valid base58 keys silently derive the wrong wallet (`walletService.ts:195-206`).

### 3.6 Honesty debt (things the system tells you that aren't true)

This category matters because you can't tune what lies to you.

| Lie | Where | Truth |
|---|---|---|
| 10 green Gate 0 checkmarks (`sellSimPassed`, `notHoneypot`, `devPriorRugRateClean`...) | `riskFilter.ts:118-206` → UI | Hardcoded `true`, never computed |
| `allInSizing` toggle | flags + UI | Read once into `getConfig()`, drives nothing (`sniperEngine.ts:521`). The 91% deployment came from 1 slot × 100% deployed fraction |
| `jitoTipSol` setting | config + UI | Wired to nothing |
| `maxHoldSeconds`, `noDataExitSeconds`, pool-drain and sell-flow knobs | config + UI | Exits deleted; knobs tune log lines |
| `copySells`, `sellMode`, `takeProfitPct` in copy trader | `copyTraderService.ts:106-118` | Documented INERT, still rendered as live settings |
| Migration "liquidity $12,0xx" | `sniperEngine.ts:1552` | A constant, not a measurement |
| +$3,331 paper run, 93.3% WR | `reports/run_2026-08-08*` | Fabricated pricing path; exit engines named in it don't exist in the code |
| MCP "subscribe_pump_launches" | `pumpfunMcpServer.ts:152-237` | Connects to a fake hostname, then invents tokens every 15s. Dead code, but if you ever wire it up it will happily feed the pipeline fiction |

---

## 4. What the winning bots do (August 2026) and how you compare

BullX is dead (suspended trading June 2026). The active majors: Axiom, Trojan, Photon, GMGN, Padre (owned by pump.fun), Bloom, Nova, BONKbot, Maestro, Banana Gun. All charge ~1% per trade. Nobody at the top competes on raw fee anymore; they compete on **exits, filters, and landing rate**.

| Capability | Top bots (Trojan/Padre/GMGN/Bloom) | Your bot |
|---|---|---|
| Detection | Geyser/gRPC server-side, shred-level for the leaders (Jito ShredStream sunsets Sept 5 2026 → DoubleZero Edge) | Free PumpPortal websocket, no fallback |
| Submission | Staked-connection (SWQoS) senders + Jito dual-path, dynamic priority fees, regional endpoints | Plain `sendRawTransaction` to one RPC |
| Entry filters | Bundle % (>30% = untouchable), same-block sniper count, dev wallet history with migration success rates, holder clustering, socials | Legacy gate w/ fabricated inputs + score override; V2 exists but off |
| Exits | Trojan: multi-level TP/SL armed at buy. Padre: trailing stops + **dev-sell trigger orders**. Bloom/Nova: TP/SL presets | Profit ladder only. No SL, no time stop, no dev-sell action (monitor exists but is feed-starved and warn-only) |
| Copy trade | Per-wallet filters, 10 wallets, buy caps | Exists, but dedup race, 700ms sleeps, inert sell config |
| Measurement | Landing rates, per-filter PnL attribution (internally) | t5/t6/t7 never sampled, no outcome data |

Two market facts that should reshape the strategy:

- **Same-block sniping is an insider game.** Pine Analytics: >50% of launches get sniped in their creation block, and in 15,000+ documented cases the deployer funded the sniper wallets (~87% win rate for them). When you buy a fresh vertical candle, their scripted exit is what you're buying. You cannot out-latency the person who created the token. You can only refuse to be their counterparty.
- **Cheap filters carry huge lift.** From an 832,941-launch survival study (arXiv:2607.02823): tokens with a Telegram graduate 8.9x more often; all three socials, 17.4x; creator self-buy above ~31 SOL initial mcap, ~3x. Your payload already contains most of this. You currently use none of it.

---

## 5. The economics of $5-10 positions (why trade selection beats speed for you)

Round trip on a $7.50 position at SOL ≈ $73-76, using your actual stack (pump.fun 1.25%/side + PumpPortal local 0.5%/side + priority fees + realistic adverse movement):

| Cost | Calm conditions | Contested launch |
|---|---|---|
| pump.fun + portal fees | ~3.5% | ~3.5% |
| Priority fee (2 tx, 0.001 SOL each) | ~2% | 5-19% |
| Adverse move between decision and fill | 2-5%/side | 10%+ (KINGLON: +155%) |
| Failed-tx burn amortized | ~0.2% | 2-5% |
| **Total** | **~8-14%** | **30%+** |

Consequences:

- Fixed SOL-denominated costs don't scale down. 0.001 SOL of priority fee is 0.03% of a $500 trade and ~1% of a $7.50 trade, per leg. The identical strategy is structurally worse at your size. Your own code knows this: `walletService` refuses nothing (owner decision), but `pipelineUtils` breakeven math says a 0.098 SOL slot carries ~8.4% round-trip drag.
- Break-even win rates at ~10% cost: TP +50%/SL -30% needs 50% wins. TP +100%/SL -30% needs 31%. **No honest operator claims >50% on pump.fun entries.** The only viable shape at your size is: first TP rung at +40-60% that returns cost + most of principal, moonbag rides with a trail, and losers cut hard at -25 to -35 because the loss distribution includes -100 and no ladder saves you from it.
- At 8-14% cost per attempt, **not trading is a position**. Halving trade count by tightening filters outperforms any latency upgrade you can buy at this size.
- The $8 bankroll cannot support the strategy. One slot at 0.098 SOL is below your own economics gate's viability line, which is why the sizing math had to be overridden to trade at all. Either fund ≥1 SOL so 2-3 slots clear the 6% breakeven ceiling, or run paper until the edge is proven. Trading real at $8 total only buys variance, not information.

---

## 6. The upgrade plan

Ordered by EV per hour of work. Phases 0-3 cost $0 in infrastructure. Do not reorder: exits and security before entries, entries before speed, measurement before scaling.

### Phase 0: stop the bleeding (day 1, non-negotiable)

1. **Restore loss-side exits.** Reinstate in `updateAndCheckPositionExit`, in this order of authority:
   - Structural: pool drain ≥50% from peak → sell 100% immediately (it was a warning; make it act again). Sell-flow collapse (<25% buy pressure, 3 ticks) → sell 50%, second trigger → 100%.
   - Dev-sell: wire `devSellMonitor` creator resolution from `curveWatcher.getLast(mint)?.creator` (audit #22, the decode already extracts creator at `curveWatcher.ts:66`), and make `devSold` sell, not log. This is Padre's flagship feature and you already stream the data for open positions.
   - Post-buy honeypot: `verifySellPath` false → exit now, not "log and hold" (`sniperEngine.ts:2924-2929`).
   - Price stop: hard -30% from verified fill price (not decision price). Noise-resistant because it sits behind the structural stops that catch rugs earlier.
   - Time stop: re-enable `maxHoldSeconds` (1800s) and `noDataExitSeconds` (180s). A dead token holding your bankroll hostage for 9 hours is how KINGLON happened.
   If you keep any manual-only philosophy, keep it for *winners* (never auto-sell green without hitting a rung), not losers. "Never sell red automatically" is the single most expensive line of code in this repo.
2. **Fill-price sanity abort.** Compare verified fill (`inspectFill`) against the decision snapshot; if fill price > decision × 1.20, exit immediately as a failed entry. KINGLON filled at 2.55x; that trade was lost at entry and the bot had 9 hours to notice.
3. **Slippage: 10% buys, 15% sells, and delete the ×1.5+5 escalation for buys** (keep one modest bump for exits only, capped at 30%). If a buy can't fill within 10%, you wanted that miss.
4. **Sizing: `maxDeployedFractionPct` 100 → 50** and treat sub-0.3 SOL-per-slot bankrolls as paper-only (your own breakeven math). Delete the decorative `allInSizing` flag.
5. **Security batch:** rotate the Helius key and remove it from source; add an auth token + Origin allowlist to every mutating endpoint; kill the browser-localStorage key path; remove or base58-validate the `exec(cmd /c start ...)` calls; make `realModeLock` use `wx` open; log swallowed exceptions.
6. **Reconcile flags.json** between repo root and dist-exe (launchSnipe diverges), and make the build fail if `DEFAULTS !== PACKAGED_DEFAULTS` without an explicit changelog entry.

### Phase 1: fix what you buy (week 1)

1. **Flip `entryGateV2: true`.** It was built for exactly this and has been shadow-logging divergences for days. Before flipping, pull the shadow divergence log and confirm it would have refused KINGLON (it would: mcap band + verified-concentration rule).
2. **Delete the router safety override** (`sniperEngine.ts:1662-1672`) or re-scope it to strategy-only fields. A score is not a safety check. While there, delete the 10 hardcoded `true` booleans in `riskFilter.ts` so `gate0.allPassed` means something (audit #34).
3. **Add the cheap high-lift filters** to GateV2, all from data you already hold:
   - Socials present (payload/DexScreener): 8.9-17.4x graduation lift, free.
   - Momentum ceiling: reject migration entries with `priceChange5mPct > 100` and pairAge < 120s unless volume confirms continuation. This single line refuses the KINGLON class of entry.
   - Bundle heuristic: insider/top-10 concentration you already compute, plus same-block buy clustering from the trade stream once funded (>30% bundled = skip, per Trench consensus).
   - Dev history: count prior launches by `creator` and their migration rate (RugCheck + your own candidate archive can seed this).
4. **Fund the PumpPortal API key with 0.02+ SOL (~$1.50).** This is the single cheapest unlock in the entire system: it turns on `subscribeTokenTrade`, which revives unique-buyer counts, buy-pressure, Play 2 (the only entry that buys before the crowd), and the dev-sell monitor's food supply. Budget $5-20/mo for metering.
5. **Stop fabricating migration liquidity.** Read the real pool with one RPC call at migration (the accounts are in the migrate tx), or at minimum mark fabricated values so no ratio check runs on them (audit #32/33).

### Phase 2: execution, free tier (week 2)

1. **Adopt Helius Sender** for submission: dual-path SWQoS + Jito, free, min tip 0.0002 SOL, `maxRetries: 0`, client-side rebroadcast with fresh blockhash. This is the published pro checklist and costs nothing but the tip.
2. **Turn on `dynamicPriorityFee`.** The service is written, clamped, cached, and off. Static 0.001 SOL loses races when busy and overpays when quiet, exactly as its own comment says.
3. **Run the `localTxShadowCompare` parity session and turn on `localTxBuild`** for curve buys. Removes the 68-85ms PumpPortal hop and its 10s-timeout availability risk from the critical path, and saves the 0.5% portal fee per side where it applies.
4. **Either wire `jitoTipSol` via the tip-floor API (75th percentile) or delete the field.** A visible knob that does nothing is how config drift happens.
5. **Reduce the blind window:** register positions optimistically at submit (PENDING state, audit #31), drop confirm polling to 500ms with `getSignatureStatuses` batching, and cap fill-inspection retries. Target: position visible to exits in <5s, from ~39s.
6. **Websocket hygiene:** heartbeat + 30s staleness kill, exponential backoff with jitter, and a Helius `logsSubscribe` on the pump program as a second migration detector so one silent vendor can't blind you.

### Phase 3: measurement, or you're flying blind forever (weeks 2-3)

1. **`timelineSlotSampling: true`.** Your audit called this the first dependency of everything and it's still off. You need t5/t6/t7 and landed-slot deltas to see fills like KINGLON's in real time.
2. **Build the outcome follower** (audit #28): for every decided candidate (passed AND rejected), sample price at +1m/+5m/+15m/+1h via the curve or DexScreener and write `outcomes-*.jsonl`. This is the only way to learn whether filters reject winners, and it makes every future threshold change testable against reality instead of vibes. Nothing else in this plan compounds like this does.
3. **Replay parity** (audit #26): make `replay.ts` call the engine's real decision path. Right now replay results are fiction relative to production.
4. **Funnel honesty:** log router/economics refusals with reasons (the 63-passed → 1-position gap is currently unexplained in reports), and fix the `latencyTimeline.open` leak (entries that never `complete()` accumulate raw payloads forever).
5. **Define promotion criteria before scaling size:** e.g. 200+ paper trades on the new gate with outcome data showing positive expectancy after modeled costs, max drawdown < 30% of bankroll, then fund 1-2 SOL, then re-evaluate at 100 real trades. Write it down so future-you can't rationalize skipping it.

### Phase 4: optional spend, only after Phase 3 proves an edge

- **Yellowstone gRPC feed, $99-199/mo** (Shyft/Subglow/Chainstack tier): 50-100ms+ faster detection and independence from PumpPortal. Worth it only when outcome data shows you're losing viable entries to detection lag, not before.
- **Solana Tracker risk API or similar** if building bundle detection in-house stalls.
- That's it. **Do not buy**: dedicated nodes ($1,900+/mo), shred feeds, 0slot-class senders with 0.001 SOL/tx tips. At $5-10 a position the fixed costs exceed any plausible PnL; the block-0 race is structurally closed to your size (the tip auction on contested launches runs 10-50% of your whole position). The winners' latency stack exists to serve $200+ positions and volume-tier fee rebates you can't reach.

---

## 7. Recommended config diff

| Setting | Now | Change to | Why |
|---|---|---|---|
| `entryGateV2` | false | **true** | Real-data gate, already validated in shadow |
| Router safety override | active | **delete** | Flipped KINGLON's unsafe → safe |
| `maxSlippagePct` | 25 (→68 on retry) | **10 buy / 15 sell**, no buy escalation | Sandwich surface, fill quality |
| Stop loss | none (deleted) | **-30% hard**, behind structural stops | The -93.5% was optional |
| `maxHoldSeconds` / `noDataExitSeconds` | inert | **re-enable** (1800 / 180) | Dead tokens release capital |
| Pool-drain / sell-flow / dev-sell / honeypot verdicts | warn only | **act** (sell) | Warnings don't stop rugs |
| Fill sanity | none | **abort if fill > decision × 1.2** | Caught KINGLON at entry |
| `maxDeployedFractionPct` | 100 | **50** | One rug ≠ ruin |
| `maxActivePositions` | 1 | 2-3 once bankroll ≥ 1 SOL | Diversify the rug risk |
| `takeProfitPct` (TP1) | 100 | **50-60** | First rung must repay costs + principal at your size |
| `trailingArmMultiple` | 3.0 | **1.75-2.0** | 3x arms too late; most runners round-trip first |
| `dynamicPriorityFee` | false | **true** | Written, tested, off |
| `localTxBuild` | false | **true** after parity run | Removes vendor hop + 0.5%/side |
| `timelineSlotSampling` | false | **true** | Can't fix what you can't see |
| `launchSnipe` | true (root) / false (exe) | **false everywhere** | Block-0 is the insiders' trade; also reconcile the files |
| `allInSizing`, `jitoTipSol` (unwired) | present | **delete or wire** | UI honesty |
| PumpPortal key | free tier | **fund 0.02+ SOL** | Revives Play 2, dev-sell, buyer counts for ~$1.50 |
| Helius key | hardcoded, public | **rotate, env-only** | It's published on GitHub |
| CORS/auth | wildcard, none | **allowlist + token** | Browser tabs can currently trade your wallet |

---

## 8. What success realistically looks like

Be clear-eyed about the base rates: ~0.2-1% of launches graduate, 68.7% of tokens die the day they launch, most retail wallets lose, and the consistently profitable "snipers" on this venue are substantially deployer-funded insiders. A solo bot at $5-10 a position is not going to out-infrastructure anyone. Its only available edges are discipline (filters that refuse 99%+ of candidates), exits (ladders + stops that industrial bots ship as their headline feature), cost control (fewer, better trades), and measurement (the outcome loop nobody else will run for you).

The good news: every one of those is software you can write in weeks, most of it is *already written in this repo and turned off*, and the total required infrastructure spend to reach a competent 2026 retail stack is roughly $1.50 once plus $0-200/mo. The bot's biggest enemies right now are its own switches, one deleted subsystem, and an evidence loop that was never closed. Fix those before spending a dollar on speed.

---

## Appendix A: evidence index

- One real closed trade, -93.5%: `dist-exe/reports/run_2026-08-13T03-41-44-904Z.json` (fillVerified, exitReason "Manual User Force Sell Override", holdTimeSeconds 32892)
- Exit deletion: `src/services/sniperEngine.ts:2945-2953` (comment), `:3073-3076` (positive-only gate), `:3053/:3066` (warn-only structural alerts), `:2924-2929` (honeypot log-only)
- Router override: `src/services/sniperEngine.ts:1662-1672`; hardcoded Gate 0 booleans: `src/filters/riskFilter.ts:118-206`
- Fabricated migration liquidity: `src/services/sniperEngine.ts:1551-1553`
- Entry funnel and phase math: `src/services/pipelineUtils.ts:22-27`, `src/services/playbookRouter.ts:62-95`
- Free-tier trade stream dead: `src/services/curveWatcher.ts:1-23`
- Slippage escalation: `src/services/sniperEngine.ts:1157-1161`; execution path `:1099-1248`; browser-tab exec `:1200-1206`
- Security: `src/server.ts:76` (CORS), `src/services/clientWallet.ts:4,19,82` (key + localStorage), `src/services/walletService.ts:195-206` (parseSecret), `src/services/realModeLock.ts:77-96`
- Off-but-written services: `src/services/entryGateV2.ts`, `priorityFeeService.ts`, `localTxBuilder.ts` + `flags.json`
- Fabricated paper report: `reports/run_2026-08-08T20-52-26-418Z.*` (exit names absent from codebase; +118,362% in 35s)
- Prior internal audits this doc cross-references: `docs/research/audit-2026-08-09-architecture-rug-entry-exit.md` (45 findings; ~12 implemented, ~15 ignored, exit items reversed), `docs/research/exit-policy-and-zero-trade-diagnosis-2026-08-09.md`, `docs/research/sniper-market-and-bots-2026-08.md`

## Appendix B: external sources (fresh research, Aug 2026)

- PumpPortal fees and data metering: pumpportal.fun/fees
- Helius Sender / zero-slot execution checklist: helius.dev/blog/zero-slot; landing guide: helius.dev/blog/how-to-land-transactions-on-solana
- Jito ShredStream sunset (Sept 5, 2026) and tip-floor API: docs.jito.wtf
- Survival study, 832,941 launches, 0.198% graduation, social-link lift: arxiv.org/abs/2607.02823
- Same-block sniping and deployer-funded wallets (~87% WR): Pine Analytics via beincrypto.com
- Token lifespan (68.7% die day one): coingecko.com/research/publications/average-lifespan-of-pumpfun-tokens
- Rug/pump-dump prevalence (98.7%): soliduslabs.com Solana report
- MEV/sandwich rates: helius.dev/blog/solana-mev-report, solanacompass.com
- BullX shutdown: crypto.news, cryptotimes.io (June 2026)
- Bot feature comparisons: trojan.com/blog (biased, feature-factual), solanatracker.io/blog, coincodecap.com reviews, dysnix.com/blog/top-solana-sniper-bot (vendor benchmarks, treat directionally)
- Open-source references worth reading: github.com/chainstacklabs/pumpfun-bonkfun-bot (pluggable listeners), jito-labs/shredstream-proxy, bitman09/pumpfun-sniper-bot (dev-buy band filter + TP/SL/timeout exits), cicere/pumpfun-bundler (know your enemy)
- Yellowstone gRPC pricing: shyft.to, subglow.io, chainstack.com
