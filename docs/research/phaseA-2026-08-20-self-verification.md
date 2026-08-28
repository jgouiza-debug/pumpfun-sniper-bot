# Phase A — Verification of my own prior output

Date: 2026-08-20 · Method: treat every prior claim as unreliable; re-execute or reclassify.

**Six prior claims are now REFUTED or downgraded. Four of them were load-bearing.** They are listed first.

---

## 0. What I now believe was wrong

### 0.1 REFUTED — "roughly 89% of these trades go to −100% regardless of exit policy"

Where it came from: I read an 11.5% win rate off a table and wrote "89% go to −100%", conflating *loses*
with *total loss*. No code was ever run to check it.

What the code says, replaying 124 real price paths through the shipped policy
(`src/research/tmp/verify89.ts`):

```
replayed trades      : 124
net <= -95%          : 57 (46.0%)   <-- the claim was 89%
had NO pool at all   : 3
net > 0              : 18           (14.5% end positive)
```

**46.0%, not 89%.** This matters because the whole "you cannot exit your way out of a token that goes to
zero" argument rested on it, and 54% of these positions do *not* go to near-zero.

### 0.2 REFUTED — "the only lever with real effect is entry latency"

That came from a sweep on **n=26**. Re-run on **n=87** it inverts:

| Parameter | Range | Span at n=26 (claimed) | Span at n=87 (actual) |
|---|---|---|---|
| `maxHoldMinutes` | 15 → 1440 | 5.2 pts | **15.9 pts** |
| `trailingArmMultiple` | 1.5 → 10 | 1.6 pts | 3.6 pts |
| `trailingGiveBackPct` | 10 → 50 | 1.1 pts | **0.4 pts** |
| `entryDelayCandles` | 0 → 5 | **10.1 pts** | **3.1 pts** |

Hold time now has **five times** the leverage of entry latency. I had it backwards.

### 0.3 REFUTED — "a 30-minute time stop is fatal against a tail that takes days to develop"

The opposite is what the data shows. Shorter holds do better, and the **shipped 30-minute policy is the best
of the six tested** in both windows:

```
maxHoldMinutes  15 -> -61.3%     60 -> -65.7%    360 -> -77.2%   1440 -> -74.8%
shipped (30m stop, TP 100/400)   IS -65.4%   OOS -38.4%   <-- best OOS of six policies
hold 24h, trail from 3x          IS -83.6%   OOS -34.1%
dead-volume only, 24h ceiling    IS -85.0%   OOS -76.0%
```

I argued for holding longer to catch the tail. On this data that is worse, not better.

### 0.4 REFUTED — "Play 3 measures time-since-websocket-message, not time-since-graduation"

I reported this as **FATAL** in Phase 1. It came from a subagent and I never checked it.
`dexscreenerService.ts:282` reads:

```ts
const pairCreatedAt = Number(bestPair.pairCreatedAt || 0);
const pairAgeSeconds = pairCreatedAt > 0 ? Math.floor((Date.now() - pairCreatedAt) / 1000) : undefined;
```

**`pairAgeSeconds` is the real indexer pair-creation age.** The source comment even documents the older
default-to-zero bug and its fix. What remains true is the *data* observation — p90 pair age 96,418 s, max
35.3 M s — meaning the bot really did process migration events for pairs days-to-years old. But the cause is
**no age filter on migration entries**, not a mis-measured clock. Downgrade FATAL → MODERATE.

### 0.5 DOWNGRADED — "the exit parameters are inert"

Half right. `trailingGiveBackPct` (0.4 pts) and `trailingArmMultiple` (3.6 pts) are effectively inert.
`maxHoldMinutes` at 15.9 pts is **not** — it is the most consequential parameter measured. I over-generalised
from the weakest sample I had.

### 0.6 UNVERIFIED ATTRIBUTION — the break-even formula

I wrote that the condition `P(graduate) > (vSol/115)²` came "from the published pump.fun analysis"
(Marino et al., arXiv 2602.14860). **The paper is real and I verified it exists**, but fetching it did not
confirm that formula appears in it. I attributed a result to a source I had not read.

The formula's *validity* is unaffected: I derived it independently from constant-product mechanics
(`price = vSol²/k`, so the multiple between two curve points is `(vSol₂/vSol₁)²`) using this repo's own
`VIRTUAL_SOL_BASE = 30` and `GRADUATION_SOL = 85`. **The arithmetic stands; the citation does not.**

---

## 1. MEASURED — code executed against real data

Each row: the claim, the command, and the raw output.

| # | Claim | Produced by |
|---|---|---|
| 1 | 17,538 corpus rows · rejected 17,463 / passed_no_buy 70 / buy_confirmed 4 / buy_failed 1 | streaming `node` over `candidates-2026-08-13.jsonl` |
| 2 | Latency t1→t4: p50 **180 ms**, p90 540 ms, p99 1,937 ms (17,535 rows with a full timeline) | streaming `node`, timestamp diffs |
| 3 | **17,083 of 17,100 creates score exactly 30**; 5 distinct values, max 42 | streaming `node`, `gateV1.score` histogram |
| 4 | Migrations: 31 distinct scores, range 22–78 | same script |
| 5 | Migration `liquidityUsd` p50 = **11,963** (the assertion is the median) | streaming `node` over 438 migrate rows |
| 6 | 75/438 migrations already >+100% in 5 m; 47 >+300%; 29 >+600% | same |
| 7 | 3,778 mints labelled across four days; survival 97–98.6% dead | `src/research/labelOutcomes.ts` |
| 8 | Migration survival by day: 26.3 / 21.7 / 20.0 / 25.6 % | same |
| 9 | Buy-and-hold over 199 migrations: mean **−76.1%**, median **−100%**, 6 winners, top-3 = 43.0%, ex-top-3 −86.2% | `node` over labelled files |
| 10 | Graduation rate **0.46%** (16 of 3,480 creates reached a non-`pumpfun` venue) | `node`, `dexId` split |
| 11 | No screening rule statistically distinguishable; all Wilson CIs overlap baseline 23.3% [18.6, 28.8] | `node`, Wilson intervals |
| 12 | `socialCount` quartile survival 23 → 32 → 41 → 76 % | `node`, quartile split |
| 13 | Backtest, 130 paths (91 IS / 39 OOS): every policy loses both windows, −34.1% to −85.0% | `src/research/runBacktest.ts` |
| 14 | Sensitivity spans: hold 15.9 pts, arm 3.6, giveback 0.4, latency 3.1 | `runBacktest.ts --sweep` |
| 15 | **46.0%** of replayed trades ≤ −95%; 14.5% net positive | `src/research/tmp/verify89.ts` |
| 16 | **24 of 24 filters proven to fire** on known-bad input | `src/tests/filterProofs.ts` |
| 17 | 329 unit tests pass, 0 fail; `tsc --noEmit` clean | `npm test`, `npx tsc` |
| 18 | `npm audit --omit=dev`: 3 moderate, all `uuid` ← `jayson` ← `@solana/web3.js` | `npm audit` |
| 19 | Shipped exe contains the exit rewrite (11 occurrences each of `exitOnMaxHold`, `KINGLON`) | `grep -c` on the binary |
| 20 | Papers exist: Marino arXiv 2602.14860; Kamat arXiv 2607.02823. Kamat's Telegram **8.94×** and full-stack **17.4×** quoted **exactly** | `WebFetch` of both |

---

## 2. DERIVED — arithmetic on measured values

| Claim | The arithmetic |
|---|---|
| Break-even curve | `price = vSol²/k` ⇒ multiple = `(vSol₂/vSol₁)²`. With base 30, graduation 85 ⇒ vSol_grad = 115. At progress P: `vSol = 30 + 0.85P`; upside = `(115/vSol)² − 1`; required P(grad) = `(vSol/115)²`. At P=90: vSol 106.5, upside **+16.6%**, need **85.8%**. |
| Shortfall vs measured graduation | 19.9% (best point on curve) ÷ 0.46% (measured) ≈ **43×**. Already flagged as an **upper bound** — 0.46% is unconditional, and P(grad \| at progress P) is higher. |
| KINGLON exit fundability | start 0.10764 − invested 0.098338 = residual **0.009302** SOL. Exit cost = `min(0.005, 5% × 0.098338)` + 0.000005 = **0.004922** SOL ⇒ margin **1.89×**. Confirms the subagent's 1.9× exactly. |
| Fixed round-trip cost | `priorityFee×2 + networkFee×2 + ataRent` = 0.001×2 + 0.000005×2 + 0.00203928 = **0.004049** SOL |

---

## 3. ESTIMATED — inferred, with no execution behind it

Being brutal, as instructed.

| Claim | Status |
|---|---|
| "Not a competitive latency profile vs co-located bots" | **ESTIMATE.** I never measured a competitor, never measured the on-chain-creation → PumpPortal-delivery gap, and never populated `t5/t6/t7`. Pure inference from architecture. |
| "Play 2 curve watcher evicts in 66–106 s against a 600 s requirement" | **ESTIMATE.** `maxWatched = 40` and the 600 s bar are verified in code; the eviction *rate* was never measured. |
| Scam-repo findings (unsigned exe, key exfiltration, 98-second repo lifetime) | **SUBAGENT-SOURCED, UNVERIFIED BY ME.** Plausible and specific, but I did not open a single one of those repos. Treat as leads, not findings. |
| Graduation-regime series 0.63 → 0.198 → 0.84 → 2.5 → 6.7 % | **PARTLY VERIFIED.** 0.63% and 0.198% confirmed in the Kamat paper; the 0.84/2.5/6.7 figures were not. |
| "pos.venue frozen breaks every sell after graduation" | **CODE VERIFIED, CONSEQUENCE ESTIMATED.** Single write at :2752, reads at :3092/:3326 confirmed. The failure was never observed. |
| "Nothing reads an on-chain token balance" | **VERIFIED** — `grep` for `getTokenAccountBalance`/`getTokenAccountsByOwner`/`getParsedTokenAccounts` returns nothing outside tests. |
| "Sell retry ladder de-escalates above 30% configured slippage" | **VERIFIED.** `min(30, round(s×1.5+5))`. At the default s=15 ⇒ 28 (escalates correctly). Only de-escalates when configured slippage > 30, exactly as I stated. |

---

## 4. Filter proofs — 24 of 24 fire

`ts-node src/tests/filterProofs.ts` — every filter fed a known-bad token, rejection string printed.

**On-chain mint account (8):** mint authority live · freeze authority live · Token-2022 transfer fee ·
transfer hook · permanent delegate · default-account-state (the blacklist mechanism) · unexpected owning
program · RugCheck danger flag.

**Gate screening (16):** dev buy % too large · dev buy SOL too small · dev buy SOL too large · real SOL in
curve · market cap already pumped · RugCheck score · mint authority via RugCheck · freeze authority via
RugCheck · **bundled launch (top-10 = 90% across 20 wallets)** · largest holder · insider holdings · rugged
flag · concentration unverified · RugCheck not indexed · already-pumped migration (the exact $KINGLON input,
+362% on a 77 s pair) · no linked socials.

**One caveat about this suite:** its first run reported 4 filters as unproven. That was a **bug in my test
fixture** — spread order dropped `holderSampleSize`, so the concentration checks fell through to
"holder list empty". Fixed, re-run, 24/24. Worth stating because it is the precise failure mode this file
exists to catch, and it caught itself only because I looked at *why* the four failed rather than reporting
them as missing filters.

---

## 5. Data-coverage correction

The Phase 3 report implied a four-day walk-forward. **It does not yet exist.** All 130 collected price paths
are from **2026-08-13**; the collector is still working through that day's list and has not reached the
08-05 / 08-08 / 08-10 corpora. Every backtest number above therefore describes **one 8.6-hour window on one
day.** The four-day split is still pending, not achieved.

---

## 6. What survives unchanged

- 17,083/17,100 creates score exactly 30 — the create lane cannot trade. **Measured, unchanged.**
- Mean −76.1% / median −100% / 3.0% win rate over 199 migrations. **Measured, unchanged.**
- Top-3 concentration 43% of gross value; ex-top-3 −86.2%. **Measured, unchanged.**
- No screening rule statistically distinguishable from baseline. **Measured, unchanged.**
- Every backtested policy loses in both windows. **Measured, and now on 3.3× more data.**
- The break-even arithmetic. **Derived from this repo's own constants, unchanged.**
- `force` never passed by automatic exits; positions in-memory only; no on-chain balance read.
  **Code-verified, unchanged.**
