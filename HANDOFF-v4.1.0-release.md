# Handoff — cut v4.1.0 to master

Paste the fenced block below into a fresh agent session on this repository. It is
self-contained and assumes no prior context. Everything outside that block is
background for you, not for the agent.

Every fact below was read out of the repo, the workflow YAML, or
`node_modules/electron-publish`, and then independently re-verified.

---

## State at handoff

| | |
|---|---|
| Repo | `jgouiza-debug/pumpfun-sniper-bot` |
| Branch to release | `claude/bot-trading-audit-fix-oevctr` at `b9b3775` |
| `origin/master` | `97ea5da` (tag `v4.0.1`) — **already merged into the branch** |
| Local `master` | `eaf34d8` — **stale, 3 behind origin.** Do not build on it |
| `package.json` | `4.0.1` — must become `4.1.0` **before** anything is tagged |
| Verified on `b9b3775` | `tsc --noEmit` clean · 894 checks / 13 suites green under **both LF and CRLF** · `vite build` clean |

Three commits go to master:

```
b9b3775 Merge remote-tracking branch 'origin/master' into claude/bot-trading-audit-fix-oevctr
a6a8344 fix(scout): give the wallet finder a source that works out of the box
8992549 fix(copy): settle every leader signal, not just the copied ones
```

Master is already an ancestor of the branch, so master fast-forwards. Nothing here
needs a rebase or a force-push, and neither is permitted.

---

## The four ways this goes wrong

Not hypothetical. The first two already happened on v4.0.0.

**1. electron-builder ignores the git tag and reads `package.json`.** This is worse
than a naming problem. `electron-publish/out/gitHubPublisher.js:35` computes
`this.tag = \`v${version}\`` from the package version. `release.yml` stamps the
version from the tag and is self-correcting; `desktop.yml` has no such step. So
tagging `v4.1.0` while `package.json` still says `4.0.1` does not just produce
mis-named installers — **it uploads them onto the already-published `v4.0.1`
release**, and leaves `v4.1.0` with no Windows installer at all.

**2. Three publishing jobs write to one release and none gates the others.**
`release.yml` (macos-14) plus `desktop.yml`'s windows-latest and macos-latest legs,
with `fail-fast: false`. Whichever finishes first *creates* the release, published
and non-draft. On v4.0.0 the Windows leg failed at `npm run test:all`, so no NSIS
installer, no blockmap and no `latest.yml` were ever published — while macOS
published fine and the page looked complete. Windows clients had no upgrade path
onto 4.x at all. **A created release is not evidence of success. Read the asset
list.**

**3. `git push --tags` will be rejected, and forcing it would destroy a published
release.** Local `v4.0.0` is a lightweight tag on `3a31d4d`; remote `v4.0.0` is an
annotated tag object (`e669cbec`) targeting `eaf34d8`. They are different commits.
Push exactly one new tag by name. Never `--tags`, never `--force` on a tag.

**4. Tagging off the branch instead of master breaks the updater's lineage check.**
`release.yml` stamps `buildCommit=${{ github.sha }}` into package.json, and
`src/services/updaterService.ts` asks the GitHub compare API whether a candidate
release descends from the installed build, refusing a divergent lineage. Merge to
master first, then tag the commit *on master*.

---

## The prompt

```
Cut and publish release v4.1.0 of jgouiza-debug/pumpfun-sniper-bot.

ENVIRONMENT
The `gh` CLI is NOT installed. Use the GitHub MCP tools (mcp__github__*) for
every GitHub operation: actions_list, actions_get, get_job_logs,
list_releases, get_release_by_tag. Use plain git for git.

REPO STATE
- Branch `claude/bot-trading-audit-fix-oevctr` is at b9b3775 and is ready.
- `origin/master` is at 97ea5da (tag v4.0.1) and is already an ancestor of that
  branch, so master fast-forwards.
- Your LOCAL master is stale at eaf34d8. Do not use it without fetching.
- package.json says 4.0.1.
- Verified on b9b3775: `npx tsc --noEmit` clean; `npm run test:all` = 894 checks
  across 13 suites, 0 failed, under both LF and CRLF working trees;
  `npx vite build` clean.

WHY 4.1.0 AND NOT 4.0.2
It adds a capability that did not exist (src/services/walletDiscovery.ts, a new
candidate source for the trader scout) and adds two fields to a public payload
type (CopyFeedEvent.leaderSignature, .leaderStatus). New backwards-compatible
functionality is a minor bump. Do not ship it as a patch.

WHAT IS IN IT

1. fix(copy) — settle every leader signal, not just the copied ones.
   The copy trader's fast lane subscribes to leader wallets at commitment
   'processed': a node has executed the transaction, nothing has voted on it.
   That is where the speed comes from, but a processed transaction can be
   dropped on a fork, and then the leader never traded at all while the feed has
   already said they did. Verification existed and ran in exactly one place —
   after a successful real BUY — so a leader trade that was skipped by a gate,
   mirrored as a sell, paper-traded, or copied unsuccessfully was displayed as
   fact and checked against nothing. Reported from the field: the panel showed a
   wallet making a buy that the wallet's own public history did not.
   Now every feed line registers its leader signature for settlement from
   `pushFeed`, the single place all 43 feed call sites pass through. The
   per-signal poll loop (capped at 4 concurrent, so it had to drop
   verifications) is replaced by one batched `getSignatureStatuses` tick
   covering every outstanding signature — the same single round trip, complete
   instead of partial. The verdict is a pure function, `leaderSignatureVerdict`
   in src/services/txSettlement.ts, unit-tested directly. An RPC failure judges
   nothing. A signature is judged once and remembered, otherwise the warning's
   own feed line re-queues the signature it is warning about. Feed lines carry
   the leader's transaction and its status: 'unconfirmed' while provisional,
   'DROPPED', or 'LEADER TX FAILED'.

2. fix(scout) — give the wallet finder a source that works out of the box.
   Reported: the wallet finder never found anyone, it only reported a completed
   scan. That was structural. The scout had two candidate sources and on a
   default install both are empty: the leaderboards need a Solana Tracker API
   key, and the wallet ledger is filled by a harvester that runs only behind the
   `smartMoneySniper` flag (ships off) over mints the sniper's own lane feeds
   it — and the scout reads only its promoted/observed end, which a fresh
   install has none of. So runScout returned before making a single RPC call and
   the panel said "0 wallet(s) checked, none copyable — that is a normal
   result". Nothing had been checked.
   New src/services/walletDiscovery.ts needs no key, no flag, no vendor and no
   ledger. It reads pump.fun's recent program signatures (one call), samples
   transactions strided across that span, uses each TradeEvent's virtual SOL
   reserves to find tokens currently running on their curve, then walks those
   back to their first buyers. It produces addresses only — every one still goes
   through the existing verifyTrader pass. A walk that cannot reach a token's
   first transactions credits nobody rather than the oldest addresses it
   reached; failed transactions are not evidence a token is running; nothing
   here writes ledger promotion state. The panel no longer calls an empty scan a
   normal result: zero candidates is named as such, with each source's reason.

BEHAVIOUR CHANGE ON UPDATE — put this on the release page, do not bury it
Both changes are ON by default and need no opt-in.
- Leader-signal settlement runs for every copy-trading signal; existing feed
  lines gain a status badge.
- The trader scout already ran hourly and unconditionally (server.ts calls
  startScoutSchedule with no flag). It now additionally performs chain
  discovery on the user's own configured RPC endpoint: up to ~237 reads per
  discovery pass at 120ms spacing, inside the scout's existing 6,000-read
  budget. Anyone on a metered RPC plan should be told this plainly.
- Neither change adds a spending path, and neither touches the launch sniper.
  The smart-money lane and the learned entry profile remain behind
  `smartMoneySniper`, still off.

KNOWN LIMITS — state these honestly in the notes, do not omit them
- Feed corrections are in-memory only. A 'pending' line evicted before it
  settles is never corrected. There are two eviction paths: the 120-line
  FEED_LIMIT and a timestamp cutoff filter.
- Once 2,000 signatures are outstanding, new arrivals are not tracked; those
  lines display 'unconfirmed' with no later correction.
- Slow-lane and manual feed lines get the Solscan link but no status badge, by
  design: they were read from an already-confirmed transaction.
- Discovery structurally cannot see graduated tokens or their first buyers. It
  finds wallets early to what is running now, which is a lead, not a
  profitability ranking. Do not describe it as finding "proven winners" or
  "the most profitable traders" — the code refuses that framing and the notes
  must not contradict it.
- Do not claim mutation-test counts. Mutation testing was done by hand during
  development; there is no harness in the repo and nothing in it substantiates
  a number.

STEPS — in this order

1. `git fetch origin --tags` (never `git push --tags`). Confirm origin/master is
   still 97ea5da and origin/claude/bot-trading-audit-fix-oevctr is still
   b9b3775. If either moved, stop and report.
2. Check out the branch. Bump the version to 4.1.0 in BOTH package.json and
   package-lock.json:
       npm version 4.1.0 --no-git-tag-version --allow-same-version
   Do NOT use `npm install` for this — it can rewrite unrelated lockfile
   entries. Confirm package-lock.json's two version fields changed. This bump is
   mechanically required; see TRAP 1.
3. Write RELEASE-4.1.0.md at the repo root, following the shape of the existing
   RELEASE-4.0.0.md. (RELEASE-4.0.1.md is the wrong template — it is a
   no-product-change installer patch.) Content comes from "WHAT IS IN IT",
   "BEHAVIOUR CHANGE ON UPDATE" and "KNOWN LIMITS" above. Invent no numbers.
4. Commit as `release: v4.1.0 — <one line>` and push the branch.
5. Re-verify ON THE RELEASE COMMIT, before any tag exists:
       npx tsc --noEmit
       npm run test:all
       npx vite build
   All three clean. test:all must report 894 checks, 0 failed. Note the suites
   chain with `&&`, so a partial run's "N passed" is not a pass — check the
   count.
6. Fast-forward master and push it. Push the branch ref straight at master so a
   stale local master cannot get involved:
       git push origin claude/bot-trading-audit-fix-oevctr:master
   This is a fast-forward. If the server rejects it as non-fast-forward, master
   moved — go back to step 1. Never force it.
7. Confirm origin/master now points at your release commit, then tag THAT commit
   and push the tag by name:
       git fetch origin
       git tag -a v4.1.0 -m "v4.1.0" origin/master
       git push origin v4.1.0
   Tag master, not the branch — see TRAP 4.
8. Watch all three publishing jobs to completion. A v* tag fires two independent
   workflows with no `needs:` between them:
     - .github/workflows/release.yml — one macos-14 job. Stamps the version from
       the tag, stamps buildCommit, runs test:all then `npx tsc --noEmit`,
       builds the pkg standalone binary via `npm run build:pkg-mac`, ad-hoc
       codesigns it, writes a .sha256sum, and uploads via
       softprops/action-gh-release@v1 (draft: false, prerelease: false).
     - .github/workflows/desktop.yml — a 2-runner matrix, windows-latest (--win,
       NSIS) and macos-latest (--mac, .dmg), fail-fast: false. Each runs
       `npm run build` then `npm run test:all`, then
       `electron-builder --publish always`.
   Use mcp__github__actions_list / actions_get / get_job_logs. If any job fails,
   fix forward and cut v4.1.1 — a published release cannot be given a missing
   platform afterwards, which is the entire reason v4.0.1 exists.
9. VERIFY THE ASSETS on the v4.1.0 release, by name. All of these must be there:
     - the Windows NSIS installer, named for 4.1.0 (NOT 4.0.1)
     - its .blockmap
     - latest.yml            <- without it, installed Windows clients cannot see
                                the release at all; electron-updater reads it
     - the macOS .dmg and latest-mac.yml
     - pumpfun-sniper-bot-macos-arm64
     - pumpfun-sniper-bot-macos-arm64.sha256sum
   Then re-check the v4.0.1 release: if any 4.x installer landed there instead,
   step 2 was skipped and the tag is mis-built. Do not hand-upload assets to
   paper over it, and never add a second asset ending in .sha256* — the updater
   matches the first one and refuses a release with no checksum.
10. LAST, only after all three jobs have finished: set the release title to
    4.1.0 and write the body. Earlier than this and it gets overwritten —
    release.yml passes its own `body:` plus generate_release_notes: true, and
    nothing in CI reads RELEASE-*.md. Preserve the macOS first-launch note that
    step adds: it tells macOS users to run
    `xattr -dr com.apple.quarantine "/Applications/Pumpfun Sniper Bot.app"`.
    The build is ad-hoc signed but not notarized, so without that note every
    macOS user hits "the application is damaged" and has no way to know the
    download is fine.

TRAPS

TRAP 1 — electron-builder ignores the git tag. electron-publish's
gitHubPublisher computes its target release as `v${package.json version}`
(gitHubPublisher.js:35). release.yml stamps the version from the tag;
desktop.yml does not. Tagging v4.1.0 with package.json at 4.0.1 therefore
uploads the Windows and macOS installers ONTO THE EXISTING v4.0.1 RELEASE and
leaves v4.1.0 with no installer. Step 2 is not cosmetic.

TRAP 2 — nothing gates the three publishing jobs, and whichever finishes first
creates the release, published and non-draft. On v4.0.0 the Windows leg failed
at test:all and the release shipped with no NSIS installer, no blockmap and no
latest.yml while looking complete. Verify the asset list, not the page.

TRAP 3 — `git push --tags` will be REJECTED: the local lightweight v4.0.0 tag
points at 3a31d4d while the remote annotated v4.0.0 targets eaf34d8. Resolving
that with --force would overwrite a published tag that shipped real downloads.
Push one tag, by name, never --tags and never --force.

TRAP 4 — tag master, not the branch. release.yml stamps
buildCommit=${{ github.sha }} and updaterService.ts asks the GitHub compare API
whether a candidate release descends from the installed build, refusing a
divergent lineage. A release cut off the branch followed by one cut off master
is exactly that divergence.

TRAP 5 — CRLF. .gitattributes carries `* text=auto eol=lf` and it is
load-bearing: several suites assert against .ts sources as text on disk, and a
trailing \r defeats comment-stripping regexes. That is what broke the Windows
leg on v4.0.0. Do not remove or weaken it.

TRAP 6 — no CI has ever run on this branch. Neither workflow has a
pull_request trigger; desktop.yml runs only on a v* tag or manual dispatch.
Pushing to master gives a macOS-only smoke build that publishes nothing. The
Windows lane is first exercised at tag time, when it also publishes.

PROHIBITED
- Never force-push master or rewrite published history.
- Never delete, move or re-point v4.0.0 or v4.0.1. They are published releases
  with assets people have downloaded.
- Do not open a pull request. Work goes to master directly, as the last two
  releases did.
- Do not put any model identifier in commit messages, tag messages, the release
  body, or any other pushed artifact.
- If any check in step 5 fails, stop and report. Never tag a red tree.

REPORT BACK
The release URL, the complete asset list with exact file names, the conclusion
of all three jobs, and confirmation that the v4.0.1 release gained no new
assets.
```

---

## If it goes sideways

- **Master moved.** Re-merge `origin/master` into the branch, re-run the
  verification, push the branch, and retry step 6. Never rebase — the branch is
  published.
- **A job fails after the tag is pushed.** The tag stays. Fix forward and cut
  `v4.1.1`. A published release cannot be given a missing platform afterwards —
  that is exactly why `v4.0.1` exists.
- **Installers landed on `v4.0.1`.** Step 2 was skipped. Do not hand-upload to
  `v4.1.0` to cover it. Bump `package.json`, cut `v4.1.1`, and leave the stray
  assets alone rather than deleting things off a published release.
- **`npm ci` fails on a runner with "Missing: utf-8-validate from lock file".**
  Both workflows pin `npm i -g npm@11` before `npm ci` for exactly this. If that
  pin has been removed, restore it.
