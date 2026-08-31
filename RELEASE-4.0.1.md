# v4.0.1 — the Windows installer

**No product changes from v4.0.0.** This release exists because v4.0.0 shipped
without a Windows build, and there is no way to publish one into a release that
has already gone out.

If you are on macOS, v4.0.0 was complete and this changes nothing for you.
If you are on Windows, this is your 4.x — v4.0.0 had nothing you could install.

---

## What went wrong with v4.0.0

The release workflow builds Windows and macOS as two independent jobs. The
macOS job passed and published; the Windows job failed at `npm run test:all`
and so never reached the step that builds the installer. Because the two jobs
do not gate each other, the release page came out looking complete while
carrying only half of what it should.

Three files were missing: the NSIS installer, its blockmap, and `latest.yml` —
the manifest the Windows updater reads. That last one is why an existing
install could not even *see* v4.0.0, let alone fetch it.

## Why the tests failed only on Windows

Part of the suite asserts against the source as text on disk — reading
`sniperEngine.ts` and checking that no early `return` sits between the `finally`
and the balance-staleness stamp. It strips line comments before looking, so
that prose describing the old bug cannot be mistaken for the bug.

On Windows, git checks files out with CRLF line endings. In a JavaScript regex
`.` never matches `\r`, and `$` without the `/m` flag only matches at true
end-of-string — so the comment strip silently did nothing, and the check then
found the word "return" inside the comment that explains the release runs on
"every exit path — return, throw, or fall-through". A correct guard, failing on
the sentence that documents it.

The suite had already been bitten by this once and carried a fix in one place;
this was the site that was missed.

## The fix

- Strip `\r` before splitting, matching the fix already carried elsewhere in
  the suite.
- `.gitattributes` now sets `* text=auto eol=lf`, so every platform checks the
  repository out with the same line endings and this class of failure cannot
  come back one site at a time.

Verified by converting the working tree to CRLF and running the whole suite:
876 checks pass under both LF and CRLF, and `tsc --noEmit` is clean.

Worth noting for anyone reading the old CI logs: the suites are chained with
`&&`, so on Windows the four suites after the failing one never ran at all.
They are green under CRLF too — nothing was hiding behind the first failure.
