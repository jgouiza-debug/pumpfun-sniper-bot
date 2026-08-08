# Feature flags — audit fix rollout

Every behavior change from the 2026-08 latency/decision audit ships behind a
flag, **default OFF**. With all flags off the bot behaves exactly as before.
Toggle via `POST /api/flags {"flag":"...","value":true}` (persists to
`flags.json`), or env `FLAG_SHADOW_GATE_V2=1` style overrides.

Always on (observability, no behavior change): every screened candidate gets a
T0-T7 timeline appended to `reports/candidates-YYYY-MM-DD.jsonl` (view recent:
`GET /api/timelines`). That file is also the replay dataset.

## The three findings that explain the losses

**1. Paper mode was a random number generator.** Unpriced positions moved by
`1 + (Math.random()*0.12 - 0.048)` every 2s — a **+1.127% geometric drift per
tick, +40.2% per minute**. Simulating 200,000 positions under the engine's own
exit rules: **95.1% hit the +100% take-profit** (median 114s), **0.0% ever hit
the stop-loss**. Paper also paid zero fees and zero slippage. Fix: `honestPaper`.

**2. Real trades needed +11.1% just to break even.** At 0.05 SOL with a 0.001
priority fee: pump.fun 1% + PumpPortal 0.5% each leg, plus priority fees, sigs
and ATA rent. Fixed costs do not shrink with position size, so small positions
are eaten alive. 0.5 SOL drops this to 3.8%. Fix: `enforceTradeEconomics` plus
sizing up (or cutting the priority fee).

**3. The bot could only ever buy late.** `vSolInBondingCurve >= 70` was treated
as "migration", but virtual SOL starts at 30 and graduation is ~85 SOL raised —
so that threshold fires at **~47% up the curve**. Combined with fabricated
liquidity ($3,500 fresh vs an $8,000 floor; $12,000 for "migrations"), fresh
launches were auto-rejected and late/graduated ones auto-bought. Fix:
`playbookRouting`.

**Bonus:** migration payloads contain only `{signature, mint, txType, pool}` —
measured. No name or symbol, so the `|| 'PUMP'` placeholder shadowed RugCheck's
real metadata and every token displayed as `$PUMP`. Fixed unconditionally.

## Recommended rollout order

1. **`shadowGateV2`** — runs the real-data gate silently next to the legacy
   gate; logs divergences, trades on legacy only. Let it see 100+ launches,
   then run `npm run replay` and review pass rates and divergences.
2. **`strictMigrationDetect`** — migrations are only `txType === 'migrate'`;
   stops big-dev-buy creates being mislabeled (and auto-bought) as migrations.
3. **`killSwitch`** — auto-pause when realized losses in a rolling hour exceed
   `maxHourlyLossUsd` (config, default $25). Open positions are retained;
   exits stay on your hold-biased rules. Manual: `POST /api/bot/kill`.
4. **`entryGateV2`** — trade on the real-data gate (fresh-launch sniping on
   payload + RugCheck data; no fabricated inputs). Only after step 1 evidence.
5. **`concurrentExits`** — exit checks run in parallel; one slow sell no
   longer blocks the others for ~40s. Triggers/levels unchanged.
6. **`dynamicPriorityFee`** — p75 of recent network fees, floored at
   `priorityFeeSol`, capped at `maxPriorityFeeSol` and 5% of position.
7. **`localTxShadowCompare`** — builds each real buy locally too, submits the
   PumpPortal one, logs a structural diff. Zero behavior change; collects the
   parity evidence.
8. **`localTxBuild`** — submit locally built txs (skips the ~85ms trade-local
   hop). Hard-gated: does nothing until shadow compare has proven structural
   parity in the current session; migrated tokens always fall back.
9. **`timelineSlotSampling`** — adds slot-at-arrival to timelines (one extra
   cheap RPC call per candidate).

## Paper-mode flags (no capital at risk — enable these first)

- **`honestPaper`** — paper fills price against the real bonding curve / AMM
  pool and pay the full fee stack; unpriced positions hold flat and time out
  instead of riding an invented uptrend. **Paper P&L only means something with
  this on.** Expect paper results to get much worse and much more truthful.
- **`playbookRouting`** — entries routed by measured curve position:
  - `BLOCK_0` (<2 min): never enter — insider exit window.
  - `EARLY_CURVE` (<30%): never enter — highest rug density.
  - `MID_CURVE` (30-60%): **Play 2, the early entry you actually want.**
    Requires ≥10 min age, ≥20 unique buyers/5m, ≥60% buy pressure, score ≥71.
  - `LATE_CURVE` (60-99%): refused — crowded, symmetric downside.
  - `MIGRATION` (≤90s after graduation): Play 3, MC ≤ $250k.
  - `POST_MIGRATION` (90s-24h): Play 4, needs ≥25 unique buyers/5m.

  This also enrolls promising creates in a **curve watchlist** subscribed to
  their trade streams. Without it the bot sees each token exactly once, at 0%
  progress, so mid-curve entry is not merely untuned but impossible.
- **`enforceTradeEconomics`** — refuse trades whose round-trip cost exceeds
  `maxBreakevenPct` (default 6%) of position size.

## Ops notes

- `npm test` — unit tests, including reproductions of the old bugs.
- `npm run replay [YYYY-MM-DD] [--divergences]` — offline re-evaluation of
  recorded candidates through both gates. No network, no orders.
- `HELIUS_API_KEY` env var overrides the key baked into source. **Rotate the
  baked-in key** — it is exposed in source history.
- `jitoTipSol` in config remains unwired (no Jito bundle path exists yet).

# Second audit — 2026-08-07

The first audit's fixes were correct but **never enabled**: no `flags.json`
existed, so the bot still ran 100% legacy behavior. `flags.json` now ships with
the paper-safe set ON (honestPaper, playbookRouting, enforceTradeEconomics,
shadowGateV2, strictMigrationDetect, killSwitch, concurrentExits,
honeypotChecks, devSellStop, dynamicPriorityFee). `entryGateV2` and
`localTxBuild` remain OFF pending shadow evidence.

Fixed unconditionally this round:

1. **RugCheck pool filter matched program IDs, not the per-mint bonding-curve
   PDA** — the curve counted as a ~93% "holder", so concentration gates
   rejected every fresh launch. Now computes `bondingCurvePda(mint)`.
2. **Play 2 and Play 4 were dead code on the free data tier**: the router
   demanded unique-buyer counts only the paid trade feed provides. Now falls
   back to curve fill velocity (Play 2) and DexScreener 5m buys (Play 4).
3. **35 free score points** (demand base 20 + narrative constant 15) meant a
   zero-data token scored 65 and out-scored badly-measured ones. All points
   are now earned from measured signals; velocity substitutes for buyers.
4. **On-curve positions had no working price** (no DexScreener pair
   pre-migration) — no stop-loss or take-profit until the 30-min time stop.
   CurveWatcher now feeds live curve prices into the exit ladder, and every
   on-curve position gets a curve subscription (not just with devSellStop).
5. **A failed DexScreener batch call cached zeros over good prices** for every
   open position at once. Transport failures now serve stale data.
6. **Unknown pair age was treated as 0 seconds** — tokens of unknown age were
   routed into Play 3's 90-second migration window. Unknown now classifies as
   POST_MIGRATION.
7. **Migration liquidity is asserted, not polled**: a graduation moves ~79 SOL
   by construction; waiting for the indexer made Play 3 unreachable inside its
   own window.
8. **Buy pressure is notional-weighted** (SOL flow), not event-counted —
   twenty dust sells no longer outvote one 5-SOL buy.
9. **Watchlist eviction leaked curve subscriptions**; eviction now reports the
   victim and the engine unsubscribes it. Positions release their slot on close.
10. **Defaults**: buyAmountSol 0.05→0.3 SOL (breakeven 11.1%→~4.2%),
    maxActivePositions 99999→5, maxBreakevenPct 15→6, strict LP-lock floor 50%.
11. **API binds loopback only** — it previously listened on all interfaces
    while holding a signing key, despite a comment claiming otherwise.
