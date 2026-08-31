# v4.0.0 — the settlement release

The bot now checks whether a trade actually happened before it believes it did.
Almost everything else in this release follows from that one change.

---

## What changed, mechanism by mechanism

### 1. Did the trade actually happen? — **the incident**

**Before:** it sent a transaction and assumed it worked. Nothing ever asked the
chain. A failed buy still created a position, that position was still
"managed", and the log line next to it was green. Every failed submission still
pays its fee, so the wallet drained while the screen said everything was fine.

**Now:** one settlement authority. A position exists only once the chain
confirms it. A failure is a failure, on screen and in the ledger.

> **Absent → present.** This is the defect that emptied the wallet.

---

### 2. Spending limits

**Before:** none. Nothing capped how much could be spent per hour or per day,
and nothing noticed a run of failures.

**Now:** hourly and daily ceilings, plus breakers that latch shut after
consecutive failed transactions — because a losing streak costs fees whether or
not any trade lands.

> **0 → 3 independent ceilings.**

---

### 3. Copy-trade speed

**Before:** roughly 250–600 ms from seeing the leader's buy to putting ours on
the wire — and it had never been measured, so no claim about it was checkable.
Three specific brakes: a forced balance read sat in the hot path, the whole UI
state was serialised to every browser tab before each decision, and the
priority fee was pinned with its ceiling equal to its floor, so the dynamic-fee
calculation ran and was thrown away.

**Now:** balance read moved off the path, UI updates coalesced, fee ceiling
unpinned, and the signed transaction is fanned out to several endpoints at
once. Every fill is timed in slots against the leader.

> **~75% faster — target, not yet confirmed live.** Honest ceiling from a home
> connection is landing 1–2 slots behind the leader (350–700 ms). Same-slot
> needs a machine next to the validator; anyone promising it is selling
> something.

---

### 4. Who to copy

**Before:** you pasted a wallet address. Nothing checked whether it was any
good, still active, or possible to follow.

**Now:** hourly, the bot pulls candidates from the free leaderboards — including
the named-KOL board — then **re-measures every one of them from chain data** and
ignores the leaderboards' own numbers entirely. It ranks the top 3 and names the
best, and it rejects five kinds of wallet that top a leaderboard and would still
hurt you: stopped trading, one lucky token, too big to copy, faster than you can
land, and insiders launching their own tokens.

> **0 → 8 verification bars.** Nothing auto-follows; the bot ranks, you press
> the button.

---

### 5. How the sniper picks tokens

**Before:** generic filters — a score, a liquidity floor, holder caps — applied
identically to every launch. Nothing to do with how any successful trader
actually decides.

**Now:** it photographs every token at the moment a proven wallet buys it, and
every token they walk past, then derives the numeric bands that separate the
two. It screens each new launch against those bands and buys on its own — no
waiting for anyone else to move first.

> **0 → 14 learned features**, kept only where they genuinely separate the two
> groups.

---

### 6. Time before the strategy is usable

**Before:** the profile needed 40 entries observed live. At a handful of smart
entries a day that is weeks of the feature doing nothing.

**Now:** those trades are already on the chain, so it rebuilds them from a
verified wallet's own history — with a matched control group read at the same
instants.

> **Weeks → minutes.**

---

### 7. The interface

**Before:** three typefaces (including a serif, in italic, for the headline
number), body text at 8–9.5 px, and 27 hardcoded colours doing the work of about
six meanings. Panels built at different times each brought their own accent.

**Now:** Windows Terminal's Campbell scheme, values unchanged, on Cascadia
Mono — the font that ships with it — so no webfont is fetched at all. One
typeface. Colour only where it means profit, loss, a fault or armed state. No
emoji. A status bar carries mode, port, RPC, wallet and uptime.

> **Colour vocabulary −81%** (27 → 5). **Smallest text +33%** (7.5 px → 10 px).
> **Fonts −67%** (3 → 1).

---

### 8. Testing

**Before:** 513 checks across 6 suites, and the release build ran only a subset
of them — so the binary that shipped was gated on tests that by construction
excluded the paths that lose money.

**Now:** 876 checks across 13 suites, all of them run at release. Around 60
mutation tests: each safety rule was deliberately broken to confirm a test
catches it. Four didn't, first time, and were fixed.

> **Checks +71%. Suites +117%.**

---

## Defects found and fixed *in this release's own work*

Worth listing, because they were all written during it and caught before shipping:

- A wallet that **never sells its rugs** read as a winner — only closed
  positions were scored, and not selling is exactly what a losing memecoin
  trader does.
- The chain-history rebuild **fabricated "this token was quiet"** for tokens it
  hadn't read far enough back to see. The error ran one direction — winners have
  long histories — so it would have taught the bot that good traders buy tokens
  nobody wants.
- **Curve position was on the wrong scale** — a token at 50% was filed as 77%.
- Copy exits **bid 10× too much** because the sell path passed no size hint.
- A raised fee ceiling **overcommitted the wallet**: 2.657 SOL staked on a
  2 SOL balance.

---

## Read this before you arm it

- Smart-money and the learned profile ship **behind a flag, off**. A strategy
  that starts spending the moment you update is not one you agreed to.
- Paste a free **Solana Tracker** key in Settings. Without it the scout still
  runs, but only over wallets the bot discovered on chain itself.
- Nothing here has traded live money yet. The speed figures are targets the new
  instrumentation will confirm or refute on your machine.
- The trader APIs could not be reached from the build environment, so their
  field names come from the vendors' own SDK source rather than a live
  response. The first real scan may need a one-line correction — the code prints
  exactly which fields came back, so it is a fix, not a mystery.

---

### Numbers at a glance

| Mechanism | Before | Now | Change |
|---|---|---|---|
| Trade settlement | assumed | chain-confirmed | absent → present |
| Spend limits | none | hourly + daily + breakers | 0 → 3 |
| Copy latency | 250–600 ms, unmeasured | 60–120 ms target, timed in slots | ~75% faster* |
| Copy target vetting | paste an address | 8 on-chain bars, top 3 ranked | 0 → 8 |
| Sniper selection | generic filters | 14 learned features | 0 → 14 |
| Strategy warm-up | weeks | minutes | weeks → minutes |
| Colour vocabulary | 27 ad-hoc | 5 semantic | −81% |
| Smallest text | 7.5 px | 10 px | +33% |
| Automated checks | 513 / 6 suites | 876 / 13 suites | +71% |

\* target, instrumented but not yet confirmed against live fills. Every other
row is measured.
