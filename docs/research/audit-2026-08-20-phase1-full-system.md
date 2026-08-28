# Phase 1 — Full-system audit

Date: 2026-08-20 · Commit under review: `205888d` (clean tree) · Baseline: `tsc --noEmit` clean, `npm test` **329 passed / 0 failed**

Evidence base: `dist-exe/reports/candidates-2026-08-13.jsonl` (**17,538 rows**, 40 MB — the authoritative
live corpus), five 08-13 run reports, and the older `reports/candidates-2026-08-{05,08,10}.jsonl`.
No code was changed in this phase.

---

## 0. Three corrections before anything else

Earlier in this session I stated two things that subsequent forensic work **disproved**. Correcting them
up front, because both would have sent Phase 4 in the wrong direction.

**1. "The bot gas-locked itself out of selling." — Wrong.** Both real positions could comfortably afford
their exits. Reconstructing from the code's own sizing formulas: KINGLON held a residual of 0.009302 SOL
against an exit cost of 0.004922 SOL (**1.9× margin**); Spellingworld held 0.005593 SOL against 0.001005 SOL
(**5.6× margin**). The decisive proof is that the manual force-sell *did* land on-chain, from exactly that
balance, with `fillVerified: true` and `fractionSold: 1.0`. The gas reserve has real defects (§5) but it did
not cause these two non-sells.

**2. "Paper and real were the same build, so the exit machinery works in paper and not in real." — Wrong
premise.** The exe that ran the real sessions was built from `5152ebb` (2026-08-12 23:36). Reading that
exact blob, its only automatic exits were a pullback rung at `pnlPct >= 60`, TP1 at `>= 100`, TP2 at
`>= 400`, and a trailing ratchet arming at 3×. **All four require positive P&L.** The strings
`exitOnMaxHold` and `max hold time reached` do not appear in that build at all. KINGLON at −93.5% could not
trigger any of them.

So **KINGLON was not a bug — it was the exit policy of the build that was running.** The entire loss-side
exit suite landed later the same day in `a01187e` (14:34) and is compiled into the current exe (I grepped
the binary; `exitOnMaxHold` and the KINGLON comment are both present, 11 occurrences each).

**3. There is no evidence the fixed build has ever been run.** `.copy-trader.json` was last written
2026-08-13 19:44 — one minute *before* the current exe was built at 19:45. No run report exists after
08-13. Whatever you have been experiencing since, this repo holds no telemetry of it.

---

## 1. Architecture map

### 1.1 Data ingestion

| Feed | Transport | Used for | Failure posture |
|---|---|---|---|
| **PumpPortal** `wss://pumpportal.fun/api/data` | WebSocket | `subscribeNewToken` (creates) + migration events. The only launch feed. | Keepalive in `wsKeepalive.ts`; reconnect with backoff |
| **Helius / public RPC** | HTTPS + WS | Balances, mint account reads, `getSignatureStatus`, curve account subscriptions | `withRpcRetry` (`rpcHealth.ts`), health latch |
| **DexScreener** `api.dexscreener.com` | HTTPS poll | Price, liquidity, volume, buy pressure — feeds repricing **and three of the exits** | Returns `hasPair:false` on miss |
| **RugCheck** `api.rugcheck.xyz/v1` | HTTPS | Holder concentration, authorities, danger flags | 88% of the funnel dies here (§4.2) |
| **PumpPortal** `/api/trade-local` | HTTPS POST | **Builds 100% of buys and 100% of sells** | Single point of failure (§5) |

Note the shape: ingestion is entirely **third-party HTTP/WS**. There is no mempool access, no block
subscription, no geographic co-location, and no private orderflow. That is the single most important
architectural fact in this document and §7 returns to it.

### 1.2 Signal detection

`sniperEngine` → `riskFilter` (Gate v1, legacy scoring) and `entryGateV2` (real-data gate) run in shadow
against each other (`shadowGateV2: true`), then `playbookRouter` assigns one of three plays:

- **Play 1 `launchSnipe`** — first-candle creates, screens deliberately skipped. Flag is ON. **Has never fired.**
- **Play 2 mid-curve re-screen** — requires a token ≥ 600 s old. **Has never fired** (§4.3).
- **Play 3 migration snipe** — graduation to `pump-amm`. **The only path that has ever produced a buy.**

### 1.3 Execution path

`localTxBuild` is `false`, and `localTxBuilder.ts` is **buy-only** (`buildBuy` exists; there is no
`buildSell`). So every buy and every sell — including manual LIQUIDATE — is one
`axios.post('https://pumpportal.fun/api/trade-local')` returning a serialized `VersionedTransaction`, which
the engine signs and submits with `skipPreflight: true, maxRetries: 3` ([sniperEngine.ts:1423](../../src/services/sniperEngine.ts)).
Confirmation is a 1.5 s poll of `getSignatureStatus` for 30 s, then `inspectFill` reconciles against
on-chain balance deltas. Commitment is `confirmed`, never `finalized`.

### 1.4 Exit logic

Every exit is gated on its own `exitOn*` toggle, evaluated in this order in `updateAndCheckPositionExit`:

| Order | Exit | Default | Fed by |
|---|---|---|---|
| 1 | `NO_DATA` (180 s, never indexed) | ON | clock only |
| 2 | `TIME_STOP` (`maxHoldSeconds` 1800) | ON | clock only |
| 3 | `POOL_DRAINED` (≤50% of peak) | ON | DexScreener `liquidityUsd` |
| 4 | `SELL_FLOW` (buy pressure <25%, 3 ticks) | ON | DexScreener `buyPressurePct` |
| 5 | `PRICE_STOP` | **OFF** | price |
| 6 | Take-profit ladder / moonbag ratchet | ON | price |

Plus `DEV_SOLD` via `devSellMonitor` and `HONEYPOT` via post-fill `simulateSellPath`.

The ordering is sound — the two clock-driven exits run **before** the `!dexData.hasPair` early return, so a
position with no market is not immortal. That was the KINGLON failure mode and it is genuinely fixed.

### 1.5 State management — **the most serious finding in this section**

`private activePositions: InternalPosition[] = []` ([sniperEngine.ts:332](../../src/services/sniperEngine.ts)).
**In-memory only. Never persisted, never recovered.** The copy trader persists its state
(`copyTraderService.ts:1200`); the sniper does not.

Combined with the fact that **nothing in this codebase ever reads an on-chain token balance**, the
consequence is unconditional: *if the process restarts while holding a position, the bag is orphaned
permanently.* The bot has no way to learn it owns those tokens. No exit will ever run against them. This is
a direct, untested path to "the bot does not sell."

---

## 2. Latency budget — measured, not estimated

From `t1..t4` timestamps present on **17,535 of 17,538 corpus rows**:

| Stage | p50 | p90 | p99 | max |
|---|---|---|---|---|
| `t1→t2` parse WS payload | **0 ms** | 0 ms | 1 ms | 1 ms |
| `t2→t3` filters (RugCheck + DexScreener + mint reads) | **129 ms** | 456 ms | 1,580 ms | 20,336 ms |
| `t3→t4` routing decision | **49 ms** | 71 ms | 207 ms | 8,121 ms |
| **`t1→t4` detection → decision** | **180 ms** | **540 ms** | **1,937 ms** | 22,591 ms |

**Two honest caveats that make this budget a floor, not the real number:**

1. **The clock starts too late.** `t1` is when the WebSocket message *arrived at this process*. The interval
   between on-chain token creation and PumpPortal emitting that message is **not measured anywhere and is
   not in this data**. The true detection→broadcast figure is 180 ms *plus* an unknown third-party relay leg.
2. **The execution legs are unmeasured.** `t5BuiltSignedMs`, `t6SubmittedMs`, `t7ConfirmedMs` exist in
   `latencyTimeline.ts` and are stamped in `sniperEngine.ts` (lines 1420, 1426, 1487) — but **none of them
   appear in any corpus row**. The JSONL is written at decision time and never updated. So decision → build
   → sign → submit → land is instrumented and then discarded. With only 5 buys ever recorded there would be
   no usable sample regardless.

**What this means competitively:** a remote build round-trip to `pumpportal.fun` sits on the critical path
of every order. Add ~130 ms of pre-decision screening and an unmeasured relay leg. Against bots that hold
their own block subscriptions and build transactions locally, this is not a competitive latency profile,
and no amount of parameter tuning changes it.

---

## 3. Constants, magic numbers, and tunables

### 3.1 Named constants

| Value | Where | Note |
|---|---|---|
| `POSITION_MONITOR_INTERVAL_MS = 1000` | sniperEngine.ts:72 | exit tick rate |
| `MIN_CURVE_LIQUIDITY_SOL = 10` | sniperEngine.ts:52 | |
| `MIN_HOLDER_SAMPLE = 5` / `MIN_TOTAL_HOLDERS = 10` | sniperEngine.ts:88-89 | |
| `MAX_RUGCHECK_SCORE = 1000` | sniperEngine.ts:96 | |
| `DEFAULT_BUY_SLIPPAGE_PCT = 10` | sniperEngine.ts:109 | |
| `DEFAULT_SELL_SLIPPAGE_PCT = 15` | sniperEngine.ts:110 | |
| `MAX_SELL_RETRY_SLIPPAGE_PCT = 30` | sniperEngine.ts:111 | **de-escalates above 30** (§4.6) |
| `MAX_FILL_SLIPPAGE_MULTIPLE = 1.2` | sniperEngine.ts:119 | |
| `DEFAULT_DEPLOYED_FRACTION_PCT = 50` | sniperEngine.ts:122 | overridden to 100 by `allInSizing` |
| `UNVERIFIED_DISTRIBUTION_CREDIT = 18` | riskFilter.ts:12 | **awards score for unknowns** |
| `UNVERIFIED_DEPLOYER_CREDIT = 12` | riskFilter.ts:13 | **awards score for unknowns** |
| `PUMP_FEE_PCT = 0.01`, `PORTAL_FEE_PCT = 0.005` | paperSimulator.ts:28,30 | |
| `NETWORK_FEE_SOL = 0.000005`, `ATA_RENT_SOL = 0.00203928` | paperSimulator.ts:32,34 | |
| `INITIAL_VIRTUAL_SOL = 30`, `INITIAL_VIRTUAL_TOKENS = 1_073_000_000` | paperSimulator.ts:36-37 | |
| `GRADUATION_SOL = 85`, `VIRTUAL_SOL_BASE = 30` | playbookRouter.ts:22,24 | |
| `ASSUMED_COMPUTE_UNITS = 200_000` | localTxBuilder.ts:39, priorityFeeService.ts:21 | assumed, never measured |
| `FIXED_OVERHEAD_SOL = 0.0025`, `PROTOCOL_FEE_FRACTION = 0.015` | pipelineUtils.ts:128-129 | |
| `gasFloatSol = 0.005` | walletService.ts:62 | **`setGasFloat` has zero callers** |

### 3.2 Runtime-tunable config (engine defaults, `sniperEngine.ts:190–300`)

`buyAmountSol: 0.6` · `maxActivePositions: 1` · `priorityFeeSol: 0.001` · `maxPriorityFeeSol: 0.005` ·
`maxSlippagePct: 10` · `maxSellSlippagePct: 15` · `maxHoldSeconds: 1800` · `noDataExitSeconds: 180` ·
`takeProfitPct: 100` · `takeProfitRung2Pct: 400` · `trailingArmMultiple: 3.0` · `trailingStopPct: 30` ·
`poolDrainExitFraction: 0.5` · `sellFlowExitTicks: 3` · `maxForceExitAttempts: 20` ·
`maxDeployedFractionPct: 50` · `maxHourlyLossUsd: 12` · `maxDailyLossUsd: 16` ·
`maxConsecutiveLosses: 2` · `maxMcapToLiquidityRatio: 20` · `sellSimDelayMs: 4000` ·
`solPriceUsd: 200` (**a hardcoded default that is wrong by ~2.6× against the $76 actually observed**)

### 3.3 Undocumented magic numbers embedded in logic

`bondingProgress: 90` and `marketCapSol: 30` are **constant on every migration row in the corpus** —
they are asserted, not measured. `liquidityUsd` is asserted as `2 * 79 * solPriceUsd` at
[sniperEngine.ts:1904](../../src/services/sniperEngine.ts) whenever the indexer has no reading; across all
438 migration rows the median `liquidityUsd` is **11,963**, i.e. *the assertion is the median*. It is now
labelled `liquidityIsAsserted: true`, and the code comment says any consumer treating liquidity as evidence
"must consult `liquidityIsAsserted` first" — **no consumer does.**

---

## 4. Failure modes

### 4.1 The create lane is dead by construction — **fatal, newly proven**

A create is screened exactly once, at age ≈ 0, when every scoring input is structurally unavailable.
Empirically, from the corpus:

| txType | distinct scores | histogram |
|---|---|---|
| **create** | 5 (min 28, max 42) | **`30: 17,083`**, `42: 10`, `34: 4`, `40: 2`, `28: 1` |
| migrate | 31 (min 22, max 78) | `42: 114`, `30: 90`, `52: 36`, `58: 30`, `62: 29`, … |

**99.9% of all 17,100 creates score exactly 30**, against a half-unit floor of 52 and a full-unit floor of
71. No create can clear any band, in any mode, ever. Creates are 97.5% of the funnel. This is why the bot
only produces migration snipes — and it is not a tuning problem, it is a structural one.

### 4.2 RugCheck timing — the loudest reason, but not the binding one

"RugCheck not indexed yet" rejects **15,447 of 17,538 rows (88%)**. But per §4.1, granting those tokens a
patient re-read would not help: they would still fail on score. Fixing the noisy reason without fixing the
score would change nothing. Worth stating clearly before Phase 4 tempts anyone to loosen it.

### 4.3 Play 2 has never executed

The mid-curve re-screen requires ≥ 600 s of age; `curveWatcher` holds 40 slots and evicts oldest-first at a
measured create rate that churns all 40 in **66–106 s**. An ~6–9× shortfall. No token survives to be
re-screened.

### 4.4 Play 3 measures the wrong clock

The discovery window measures **time since the WebSocket message**, not time since graduation. The corpus
confirms the damage: across 438 migration rows `pairAgeSeconds` has p90 **96,418 s (>1 day)** and max
**35,346,298 s (>1 year)**. `$WTBL` was entered as a "fresh migration" at **4 days old**. So "migration
snipe" frequently means buying an unrelated old token.

### 4.5 RPC timeout / dropped tx / partial fill

- **RPC timeout** — `withRpcRetry` covers most paths; `getBalance` got its retry in `205888d`. The health
  latch no longer sticks. This area is in good shape.
- **Dropped tx** — `skipPreflight: true` + 30 s `getSignatureStatus` poll. **A sell that lands at second 31
  is booked as a failure.** Because nothing ever reads the on-chain token balance, the position is never
  closed and the bot will try to sell tokens it no longer owns.
- **Partial fill** — handled well: `<95%` filled keeps the position open and records a partial rather than
  stranding a bag behind a closed trade. This is one of the better-engineered paths.
- **A confirmed sell that moved zero tokens** is nevertheless booked as a full exit at quoted prices —
  fabricating proceeds and closing a position that still holds its bag.

### 4.6 Slippage retry de-escalates

The 6004 ladder resubmits a failed sell at `min(30, round(15 * 1.5 + 5))` = 28%. For any configured sell
slippage **above 30%**, the "escalation" is a strictly *tighter* tolerance than the attempt that just
failed. Buys correctly never escalate, and `retryCount < 1` makes looping impossible — that part is sound.

### 4.7 Reorg and nonce collision — mapping the question to Solana

These two are Ethereum-shaped; the honest Solana answers are:

- **Nonce collision does not apply.** Solana has no per-account transaction nonce. Durable nonces exist and
  this codebase does not use them. Replay protection comes from the recent blockhash. **However**, the
  blockhash is fetched by PumpPortal, not by this bot — so blockhash *expiry* is a real and unmeasured
  failure mode: if the remote build round-trip plus signing plus submission exceeds ~60–90 s, the
  transaction is rejected as expired. Nothing measures that interval (§2).
- **Reorg** — Solana forks are resolved before finalization. The bot confirms at `confirmed`, **not
  `finalized`**, so a confirmed-then-dropped transaction is possible. Nothing re-verifies a fill after the
  fact, and again, no on-chain balance is ever read. Low probability, unbounded consequence.

### 4.8 Honeypot / transfer-tax / blacklist — the strongest area of the codebase

`honeypotDetector.ts` reads the mint account directly and decodes Token-2022 extensions:
`EXT_TRANSFER_FEE_CONFIG (1)` = transfer tax, `EXT_PERMANENT_DELEGATE (12)` = seizure,
`EXT_TRANSFER_HOOK (14)` = arbitrary sell-blocking code, `EXT_DEFAULT_ACCOUNT_STATE (6)` = every new account
frozen (the blacklist mechanism). Mint and freeze authority are read **on-chain rather than from RugCheck**,
with an explicit note that RugCheck asserts both are null when it 404s and that 85.4% of candidates were
inferred. Unknowns return `unverified`, not a false pass. `simulateSellPath` then builds the real sell and
asks the RPC to run it without submitting — a genuine test, not a heuristic.

This is materially better than most retail bots. Two defects: the post-fill simulation uses the **buy**
slippage, and **any simulation error is treated as a honeypot** — so a fast-moving migration can force an
exit seconds after entry.

### 4.9 The `force` contract is violated at every automatic call site

`sellPctReal`'s contract ([sniperEngine.ts:3047](../../src/services/sniperEngine.ts)) states structural
stops **MUST** pass `force`, because the fee-burn backoff reaches 10 minutes. `executeSell` defaults
`force = false` and **every automatic exit omits it** — TIME_STOP (3410), POOL_DRAINED (3499), DEV_SOLD
(2324), NO_DATA (3399), SELL_FLOW (3522), moonbag (3617). Only manual LIQUIDATE (3765) passes `true`.

Consequence: one failed sell arms a backoff that mutes *every* automatic exit for that position; at 20
failures `sellRetryAfterMs` is set to `MAX_SAFE_INTEGER` and automatic exits are **permanently** disabled
with no on-chain re-check and no way to re-arm. The backoff branch also suppresses its own log line, so the
operator sees silence rather than failure.

### 4.10 `pos.venue` is frozen at entry

Written once at [sniperEngine.ts:2752](../../src/services/sniperEngine.ts) (`venue: launchData?.pool`),
read at 3092 and 3326 for every sell, never updated. A launch-snipe position hard-codes `'pump'`; if it
graduates while held, **every sell for the rest of its life routes to a completed bonding curve.** The
corpus shows the exposed population: 17,034 of 17,100 creates carry pool `pump`.

---

## 5. Security review

**Private key handling.** `.photon-wallet.json` beside the exe, `0o600` on POSIX, **a no-op on Windows**
where it inherits the directory ACL — the code says so plainly. `parseSecret` accepts base58, base64, hex,
and JSON arrays. The key is held in memory as a `Keypair` for the process lifetime. Honest scope: this
protects against another user on the box and against the key reaching the repo; it is **not** a defence
against local malware running as this user. That is stated accurately in the source and I agree with the
assessment.

**Local API.** Binds `127.0.0.1` explicitly (not `0.0.0.0`), plus a best-effort `::1` listener. Two
controls: an **origin allowlist** — the one that matters, since browsers set `Origin` and scripts cannot
forge it, closing the "any open tab can POST to `/api/bot/sell-position`" hole — and a **bearer token** on
mutating calls as defence in depth. This was previously a genuine drive-by vulnerability and is now
correctly closed.

**Credential handling.** The embedded Helius key was removed (`a01187e`). `.api-keys.json` is per-install.
Keys are stripped from `getStatus` so they never echo back to the UI. `205888d` added shape validation so a
malformed key is refused rather than persisted.

**Dependency risk.** `npm audit --omit=dev`: **3 moderate**, all one chain —
`uuid <11.1.1` (missing buffer bounds check) ← `jayson` ← `@solana/web3.js ≤1.98.4`. Not directly
exploitable here (the bot does not pass attacker-controlled buffers to `uuid`), and the advertised fix
downgrades `@solana/web3.js` to `0.0.3`, which is not a real option. **Recommendation: accept and document,
do not run `npm audit fix --force`.**

**Where a malicious contract could drain or brick the bot.** It cannot *drain* — the bot signs only
transactions it requested from PumpPortal for a specific mint and amount, and never grants an open-ended
approval (Solana has no unlimited-allowance pattern here). It can absolutely *brick a position*: a transfer
hook, a frozen default account state, or a permanent delegate makes a bag unsellable, and §4.9's
20-attempt cap then permanently disables automatic exits for it. **The largest real exposure is trust in
`pumpportal.fun`** — it builds 100% of the transactions this bot signs, including every exit. A compromised
or hostile response there is a transaction the bot will sign. There is no local sell builder to fall back on.

---

## 6. Does this bot have an edge?

**On the evidence available: no, and there is no data that could currently demonstrate one.**

The complete live record is **two real trades** — one closed at −93.5%, one left open at −92%. That is not
a sample; it is an anecdote. Every reported "win" in this repository is paper, and one earlier paper report
(+$3,331, 93.3% win rate) was previously shown to be fabricated on five independent grounds.

Structurally, the bot's only working entry is a migration snipe at `bondingProgress: 90` — the single most
crowded, most contested point on the curve — reached through a ~180 ms screening path plus a remote
transaction-build round-trip, with no mempool access and no co-location. It is systematically arriving late
to the most competitive moment in the lifecycle.

**What a real edge would have to be.** One of: (a) genuine latency advantage — local block subscription,
locally built transactions, co-located infrastructure, which is a different systems project; (b) an
information edge — creator-wallet reputation graphs, funding-source clustering, social signals ahead of
price; (c) a selection edge — provable skill at ranking which graduations survive, which requires labelled
outcome data this repo does not collect; or (d) being a market maker rather than a taker. The current
architecture pursues none of these. Nothing in Phases 3–5 should be expected to manufacture one, and I will
not report a tuned parameter set as if it had.

---

## 7. Recommended Phase 2 entry conditions

Two items are cheap, high-value, and independent of any strategy question. I flag them now but **have not
changed any code**:

1. **Position persistence + on-chain recovery** (§1.5). Without it, every other exit fix is conditional on
   the process never restarting.
2. **Outcome labelling.** The corpus records the decision and stops. Nothing records what the token did
   afterwards, and 70 `passed_no_buy` rows carry no reason at all. **Phase 3's backtest cannot be built
   from this data as it stands** — there are no labels to score against. Collecting forward outcomes should
   start as early as possible, because it is wall-clock-bound, not compute-bound.

---

## Appendix — corpus at a glance

```
rows 17,538 · real 15,964 / paper 1,574 · create 17,100 / migrate 438
decisions: rejected 17,463 · passed_no_buy 70 · buy_confirmed 4 · buy_failed 1
launchData.phase: undefined on 100% of rows · ageSeconds: 0 on effectively all rows
top rejections: RugCheck-not-indexed 15,447 · real-SOL-in-curve 9,296 ·
                dev-buy-too-small 6,825 · dev-buy-%-too-large 5,794
migration entry quality: 75/438 already >+100% in 5m · 47 >+300% · 29 >+600%
```
