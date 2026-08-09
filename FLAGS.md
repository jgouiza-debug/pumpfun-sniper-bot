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

# A one-row holder sample is not a distribution — 2026-08-09 (fifth round)

$TNOS was bought with every previous fix in place. What Gate 0 saw, versus what
the token actually was:

| | at screening | ~10 min later |
|---|---|---|
| top-10 | **2.01%** | **>70%** (RugCheck: danger) |
| largest holder | 2.01% | **79.34%** |
| holder rows sampled | **1** | 20 |
| totalHolders | **0** | 708 |
| RugCheck risk score | **13001** | 19320 |

Two holes, both now closed:

1. **`holderSampleSize > 0` accepted a sample of one.** One row is not a
   distribution — it is a single wallet that happened to be indexed first.
   Calibrated against 46 recorded graduations: genuine distributions arrive
   with 19 rows and 60-600 total holders, while every reading that let a rug
   through had 0-1 rows. Now requires **≥5 rows and ≥10 total holders**.
2. **Gate 0 never looked at RugCheck's own risk score.** $TNOS scored 13001 at
   the moment of purchase. Across those same 46 graduations the score is the
   sharpest single signal available: every cleanly distributed token scored
   **1**, everything RugCheck flagged danger-level scored **2011+**. Gate 0 now
   enforces the same 1000 ceiling EntryGateV2 already used.

Replaying the 65 recorded migrations through both: **19 pass**, every one with a
19-row sample, 67-607 total holders, top-10 between 7.9% and 29.6%, and a
RugCheck score of 1. **$TNOS is blocked.** Remaining refusals: 17 never indexed,
14 concentration over cap, 13 insufficient sample, 2 risk score.

Note on Play 3 generally: at the migration moment the AMM pool holds nearly the
entire supply, so holder concentration among real wallets is only just starting
to form. That is exactly why the sample-size floor matters — early readings are
not merely incomplete, they are systematically flattering.

# The verification gate was refusing clean tokens — 2026-08-09 (fourth round)

The third-round gate refused **every** migration, clean or not, always with
"Bundled supply unverified". The holder data was arriving fine; the fold that
copies it into `launchData` had a single wrong condition:

```
if (typeof meta.insiderPct === 'number' && meta.insiderPct > 0)   // <- the bug
```

**Zero insiders is a measured result — the best one — not missing data.** On a
clean token `insiderPct` is exactly 0, so `bundledSupplyPct` was never set, so
the verified-concentration rule refused it as unknown. The gate could not
distinguish a flawless distribution from no data at all: $Drage (top10 19.2%)
and TOADHOUSE (24.5%) were refused with the same message as genuine 79% and
89.7% rugs.

Replaying the 53 recorded migrations through the fixed fold: **0 passes before,
18 after.** Everything still refused is refused correctly — concentration rugs
at 34.7%, 44.2%, 63.6%, 78.1%, and tokens RugCheck never indexed (including
$GREEN, the token that started all this).

Also hardened here: a reading flagged `concentrationAnomaly` (holder
percentages summing past 100%, so the numbers are not what they claim) now
counts as unverified rather than being trusted as fact.

# Why the bot found nothing — 2026-08-09 (third round)

A 10-minute live run screened 347 tokens and passed **zero**. Two causes, one
of them self-inflicted the same evening.

1. **Verified-concentration rejected 100% of candidates.** Measured: 0 of 200
   timelines carried holder data at screening time. This is structural, not a
   RugCheck outage — a brand-new mint's only holder IS the bonding curve, which
   is correctly filtered as a pool, leaving a holder sample of zero. Querying
   the same mints moments later returns full distributions (one showed a 93.3%
   single holder — the exact rug shape the gate exists to catch).
   - For fresh creates this rejection is *correct and harmless*: the playbook
     refuses BLOCK_0 and EARLY_CURVE anyway, and rejected creates are still
     enrolled in the curve watchlist for a later Play 2 look.
   - For candidates we would actually trade (migrations, and watchlist tokens
     re-screened at mid-curve) the fix is to **wait** for the data:
     `getReportWithHolders()` retries briefly, well inside Play 3's window. If
     the holder list never lands the trade is still refused — waiting is not
     the same as assuming.
2. **`isFullConviction` made Play 3 mathematically unreachable.** Enforcing the
   documented "all-in takes full-conviction only" (score ≥ 71) looked prudent
   and was wrong: at the migration moment DexScreener has not indexed the pool,
   so demand and narrative points cannot be earned, and a **perfect**
   graduation — 15% top-10, 1% dev, completed curve — scores exactly **62**.
   The same token scores 82 once indexed, minutes after the window shuts. The
   playbook's own 55 half-unit floor exists precisely for this. Reverted; the
   ceiling is now pinned by a regression test.

Safety is unaffected by the revert: an unverified token scores **42**, below the
55 floor, *and* is refused by Gate 0. Both are tested.

Also added: `⛔ [REFUSED]` log lines for real trade candidates (fresh creates
stay quiet, or the feed is unreadable), and a live `sizing` block on
`/api/bot/status` so the dashboard's entry size is computed by the same maths
the buy path uses.

# Buy/sell decision fixes — 2026-08-09 (second round, $GREEN incident)

Live REAL-mode trade on `CK3CHsr…pump` ($GREEN) exposed four more bugs. All
fixed unconditionally; legacy behavior with `playbookRouting` off is unchanged.

1. **Every sell sold 100 tokens instead of 100%.** `String(amountPct).replace('%','')`
   stripped the percent marker, and PumpPortal reads a bare number as a literal
   token count. Measured: wallet held 2206.04 $GREEN, the "sell everything"
   order moved exactly 100.00. Fixed by `sellAmountParam()`, which always emits
   `"<n>%"`.
2. **A sliver fill was booked as a closed position.** The engine dropped the
   position regardless of what actually sold, pricing the full cost basis
   against 4.5% of proceeds — reported as a closed −96.8% while the wallet
   still held 2106 tokens. Exits now compare tokens-sold to tokens-held; under
   95% is recorded as a partial and the position stays OPEN.
3. **Unknown concentration counted as perfect concentration.** On the real-data
   path the engine passed `0` for unmeasured top10/dev/bundled percentages, and
   Gate 0's `|| 0` read that as "0% — perfectly distributed". $GREEN's RugCheck
   report was `isInferred` (no holder list at all), so it passed every
   concentration cap AND scored the maximum distribution (30) + deployer (20)
   tiers — 50 of its 62 points came from having no data. Unmeasured fields are
   now `undefined`, and Gate 0 rejects them under `requireVerifiedConcentration`
   (set whenever `playbookRouting` is on). This matches what Gate V2 already
   did: replaying 959 recorded candidates, 164 reject on exactly this rule.
4. **`isFullConviction` was imported but never called.** All-in sizing has no
   half position to take, so a 0.5-conviction signal spent the entire wallet —
   which is precisely what $GREEN was. The documented "full-conviction only"
   rule is now enforced.

Still asserted rather than measured: migration liquidity (`2 × 79 SOL`) when
DexScreener has not indexed the new pool. Defensible from graduation mechanics,
but it is an assumption, and fix 3 is what now stops it standing alone.

# Live-execution fixes — 2026-08-09

Fixed unconditionally after the first real all-in buy failed on-chain
(`Transfer: insufficient lamports 134695720, need 152605000`):

1. **All-in sizing overdrafted by construction.** The buy was sized to the full
   deployable balance, but the transaction reserves amount × (1 + slippage)
   lamports (measured: exactly 1.15× at 15% slippage) plus protocol fees,
   priority fee, base fees and ATA rent. Real-mode sizing now goes through
   `maxAffordableBuySol()`, which reserves that headroom; with dynamic priority
   fees it sizes against the worst-case `maxPriorityFeeSol`.
2. **A tx that failed on-chain still opened a position.** Confirmation now
   distinguishes a definitive on-chain rejection (rolled back, nothing moved,
   no position) from a confirmation timeout (funds may have moved — position
   opens on estimates, as before). Failed buys/sells log the Solscan link.

# All-In Trade Sizing — 2026-08-08

- **`allInSizing`** — Spends the entire deployable balance (`availableTradeSol` = `solBalance - 0.05` SOL gas float) on every entry.
  - **Single position cap**: Forces a maximum of 1 active or in-flight position at any time so concurrent signals cannot double-spend the wallet.
  - **Full-conviction only**: Skips borderline half-unit signals (`sizeMultiplier < 1`, e.g. score 50–64 in normal tier) entirely rather than sizing down.
  - **Economics floor**: Requires deployable SOL ≥ ~0.135 SOL to satisfy the 6% breakeven cost ceiling. Below that threshold, `enforceTradeEconomics` refuses entries to protect a damaged wallet from fee bleed.
  - **Kill switch integration**: Dynamic loss limits (`killSwitch`) remain active to stop trading if rolling hourly losses exceed threshold.
  - **Toggle**: `POST /api/flags {"flag":"allInSizing","value":true}`.
