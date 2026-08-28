# Kill criteria

Written 2026-08-21, **before** any capital is exposed and while nobody is holding a losing position.
That timing is the whole point: these numbers are worth exactly as much as your willingness to honour them
on the day they trigger, and the day they trigger is the day you will least want to.

Current standing recommendation is **NO EDGE — do not run this with money**. This document exists because
the decision is yours, and because a decision made in advance is worth more than one made at 3am.

---

## Rule 0 — the precondition

**Nothing below applies until the bot has run 30 continuous days on paper with the forward-outcome tracker
active, one fixed policy, no tuning during the run.**

Anything shorter cannot distinguish a strategy from noise. At the observed trade rate, 30 days is roughly
the minimum for ~200 trades under one policy — and 200 is the point at which a win rate has a confidence
interval narrow enough to act on.

Tuning mid-run resets the clock. Every parameter change makes the preceding days a different strategy.

---

## Hard stops — any ONE of these ends the run

Stop means: disable the bot, do not re-enable, come back to the data. Not "reduce size and continue".

| # | Trigger | Why this number |
|---|---|---|
| **1** | **Cumulative net P&L ≤ −25%** of starting capital, after all fees, tips and failed-transaction costs | Below this, recovery needs a +33% gain. The measured distribution does not produce those reliably. |
| **2** | **60 taken trades with net P&L below zero** | At 60 trades a genuinely +EV strategy has had a fair chance to show it. Sustained negative here is evidence, not variance. |
| **3** | **Any single day worse than −10%** of starting capital | Single-day damage of that size means position sizing is wrong regardless of edge. |
| **4** | **Two consecutive weeks both net negative** | Consistency of loss across independent weeks rules out the "bad week" explanation. |
| **5** | **A position is discovered on-chain that the bot did not know it held** | Direct evidence the crash-recovery path failed. Money is moving outside the system's awareness — nothing else matters until it is fixed. |
| **6** | **The failed-transaction breaker trips twice in one week** | Five consecutive failures means the execution path is broken. Twice means it is broken systemically, not transiently. |
| **7** | **Realized slippage exceeds the modelled assumption by >2× on 10+ trades** | The cost model is the foundation of every projection here. If it is wrong by 2×, every result above is void. |

---

## Soft stops — investigate, do not continue blindly

These do not automatically end the run, but continuing without an explanation is how a hard stop arrives by
surprise.

| Trigger | What it means |
|---|---|
| Win rate above 60% while net P&L is negative | The scalp trap. Measured directly: 86.7% win rate at −7.4% total. A high win rate is not progress. |
| Top 3 trades exceed 50% of gross positive P&L | The result is a lottery ticket, not an edge. Report it and discount accordingly. |
| Fewer than 10 trades in a week | The filters are too tight to generate a testable sample. The run is not producing evidence. |
| Rejection lift (passed-vs-rejected run rate) stays within its confidence interval after 30 days | Screening still cannot be distinguished from chance. Currently 1.93× at **p = 0.277**. |
| Median trade return worse than −80% for two weeks | The body of the distribution has not improved; any positive result is coming entirely from outliers. |

---

## What is explicitly NOT a reason to continue

Written down because these are the arguments that will present themselves.

- **"It's up this week."** One week is inside the noise of a distribution with a −100% median.
- **"The win rate is good now."** Measured: 86.7% win rate, −7.4% return. Win rate is not P&L.
- **"One more parameter change."** 648 configurations were tested. The best was −3.1%, inside a 12.1-point
  luck band. The parameter space has been searched.
- **"It just needs a bigger wallet."** Size changes fee drag, not the sign of the expectancy. A −52% edge at
  0.1 SOL is a −52% edge at 10 SOL.
- **"The last trade would have been a winner if I'd held."** Six hold policies were tested from 15 minutes
  to 24 hours. Longer holds performed worse.
- **"Someone else is making money doing this."** Possibly true and irrelevant. The published claim closest
  to verifiable (+117.7% over 15 days, 190 trades) **flips to unprofitable when its top 3 trades are
  removed** — by its own author's admission.

---

## Restart criteria — what would justify trying again

Not a countdown. Each of these is a structural change, and at least one must be true and *demonstrated*
before capital returns.

1. **The create lane works.** 17,083 of 17,100 creates currently score exactly 30 against a 52 floor. Entry
   at 25% curve progress needs a 19.9% graduation rate versus 85.8% at 90% — that is where the arithmetic
   stops being hostile. This requires scoring rebuilt on inputs that exist at age zero.
2. **A selection signal survives out-of-sample.** One filter, pre-registered before the test, showing lift
   with a confidence interval that excludes 1.0 on 30+ days of held-out data. `socialCount` is the current
   candidate (23→32→41→76% survival by quartile, corroborated at 8.94×–17.4× in published work).
3. **The latency question is answered with data.** Slot-level instrumentation showing where your submissions
   actually land relative to competing buys. Until then, every execution decision is guesswork.
4. **Both Phase B DIE-class attacks are fixed** — on-chain pool verification, and `peakLiquidityUsd` seeded
   from on-chain reserves at entry.

---

## The commitment

If a hard stop triggers, the bot goes off and stays off until a restart criterion is *demonstrated* — not
argued.

The reason to write this today is that on the day it triggers, you will have a position open, a reason why
this time is different, and a strong preference not to stop. Today you have none of those.
