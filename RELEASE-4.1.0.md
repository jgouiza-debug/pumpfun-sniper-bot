# v4.1.0 — two things that said they were working

Both of these were reported from the field, one after the other, and they turned
out to be the same kind of defect in different places: **the screen stating
something as fact that nothing had checked.** That is the defect v4.0.0 exists to
fix, so it is worth being blunt that two more of it survived into 4.0.x.

---

## 1. The feed showed leader buys that never happened

**Reported:** "console is saying hes making a buy but photon history isnt".

**The mechanism.** The copy trader's fast lane subscribes to leader wallets at
commitment `processed` — a node has *executed* the transaction, nothing has voted
on it yet. That is deliberate, and it is the entire reason the fast lane is fast:
it sees a leader's trade roughly a second before anyone waiting for `confirmed`.

But a processed transaction can be dropped on a fork. When that happens the leader
never traded at all, while the feed has already told you they did. The wallet's
public history shows nothing, because there is nothing to show. The history was
right and the feed was wrong.

**Verification existed. It ran in one place.** After a successful real BUY, and
nowhere else. So a leader trade that was skipped by a gate, mirrored as a sell,
paper-traded, or copied unsuccessfully was displayed as fact and checked against
nothing at all.

**Now:** every feed line registers its leader signature for settlement, from
`pushFeed` — the single function all 43 feed call sites pass through. The old
per-signal poll loop was capped at 4 concurrent and had to *drop* verifications to
stay safe; it is replaced by one batched `getSignatureStatuses` tick that covers
every outstanding signature in the same single round trip. Cheaper and complete,
rather than a trade between the two.

The verdict is a pure function (`leaderSignatureVerdict`) tested directly, so the
rule the suite proves is the rule that ships. An RPC failure judges nothing —
declaring a leader's trade dropped because *our* node would not answer is the same
false report in the other direction. A signature is judged once and remembered,
because the warning is itself a feed line, and without that it would re-queue the
signature it was warning about, forever.

**And you can now check it yourself.** Every feed line carries the leader's own
transaction, one click to Solscan, with its status: `unconfirmed` while
provisional, `DROPPED` if it never confirmed, `LEADER TX FAILED` if it errored.
Previously the line carried *our* txid — which proves what we did, a different
question and the less doubtful one.

> **One place checked → every line checked.** The claim is now falsifiable from
> the panel.

---

## 2. The wallet finder could not find anybody

**Reported:** "the wallet finder isnt actually finding wallets to copy all it does
is say scan complete".

Correct, and it was structural rather than a quiet day.

**The mechanism.** The scout had two sources of candidate wallets, and on a default
install both are empty:

- the leaderboards need a Solana Tracker API key;
- the wallet ledger is filled by the harvester, which runs only behind the
  `smartMoneySniper` flag (ships **off**), only over mints the sniper's own lane
  hands it — and the scout reads only its `promoted`/`observed` end, which a fresh
  install has none of.

So `runScout` returned **before making a single RPC call**, and the panel reported
`0 wallet(s) checked, none copyable — that is a normal result, not a fault`.

It was not a normal result. Nothing had been checked. A feature that could not
succeed was reporting the same thing as a feature that had looked and found
nobody.

**Now:** a third source that needs no key, no flag, no vendor and no ledger — only
the RPC connection the bot already holds. It reads pump.fun's recent program
signatures (one call), samples transactions **strided across that whole span**
rather than the newest N — reading the newest forty back-to-back samples the last
few seconds, which is one hot mint and nothing else — and uses each trade event's
virtual SOL reserves to find tokens currently running on their curve. Then it walks
those back to their first buyers.

Tokens that are *running* rather than tokens that *ran*, for a structural reason: a
graduated curve stops trading, so it never appears in recent activity, and its first
buyers sit past any bounded walk. Mid-run is both visible and reachable — and it
answers the better question anyway.

**It produces addresses, not judgements.** Every one still goes through the same
`verifyTrader` pass as a leaderboard row: realized PnL, activity, hold time, fill
drag and queue position, all re-derived from chain. The front-of-queue bar already
removes a token's own launcher, so there is no separate insider case.

Three rules carried over deliberately, because each is a way to be confidently
wrong: a walk that cannot reach a token's first transactions credits **nobody**
rather than the oldest addresses it happened to reach (that is how a wallet
spraying dust into busy tokens earns a perfect record); a failed transaction is not
evidence a token is running; and nothing here writes ledger promotion state, which
is earned from a verdict about how a token actually turned out, not guessed from
curve position.

The panel no longer calls an empty scan a normal result. Zero candidates is named
as such, with each source's reason at the top instead of dim text at the bottom.

> **2 sources that are both empty by default → 3, one of which always works.**

---

## What changes when you update

Both are **on by default**. Neither adds a spending path, and neither touches the
launch sniper.

- Leader-signal settlement runs for every copy-trading signal. Existing feed lines
  gain a status.
- The trader scout already ran hourly and unconditionally. It now also does chain
  discovery **on your own configured RPC endpoint** — roughly 237 reads per
  discovery pass at 120 ms spacing, inside the scout's existing 6,000-read budget.
  If you are on a metered RPC plan, that is the number to look at.
- The smart-money lane and the learned entry profile stay behind
  `smartMoneySniper`, still off.

## What is still limited

Stated because the alternative is another line that sounds more certain than it is.

- Feed corrections are **in-memory only**. A `pending` line that leaves the feed
  before it settles is never corrected — there are two ways out, the 120-line cap
  and a timestamp cutoff.
- Past 2,000 outstanding signatures, new arrivals are not tracked, and those lines
  keep saying `unconfirmed` with no later correction.
- Slow-lane and manual lines get the Solscan link but no status badge, by design:
  they were read from an already-confirmed transaction.
- Discovery cannot see graduated tokens or their first buyers. It finds wallets
  early to what is running now. That is a **lead**, not a profitability ranking,
  and it is not a claim that anyone it surfaces is good — that is what the
  verification pass is for, and most candidates do not survive it.

---

### Numbers

| | Before | Now |
|---|---|---|
| Leader signals verified | only after a successful real buy | every displayed signal |
| Verification cost | one poll loop per signature, capped at 4 concurrent | one batched call per tick, unbounded coverage |
| Evidence on a feed line | our txid | the leader's tx + settlement status |
| Scout candidate sources | 2, both empty on a default install | 3, one needing no key or flag |
| Automated checks | 876 / 13 suites | 894 / 13 suites |

Verified on the release commit: `tsc --noEmit` clean, 894 checks green under both
LF and CRLF working trees, `vite build` clean.
