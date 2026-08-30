# Testing policy and the deferred-verification list

Roy's decision (2026-08-29): **small verification per batch, one big verification campaign at
the end.** Batches were spending most of their wall-clock on full smoke sweeps; that moved to
the release gate and, finally, to the overnight campaign described below.

## Per batch (what an implementing agent owes)

1. `node --test test.mjs` — green, with a test for every new pure helper.
2. The two or three smoke suites that cover what changed. Not the full sweep.
3. Fixtures over live `claude` turns wherever a fixture proves the same thing.
4. Live pty evidence only for things a human must *look* at (UI), not for logic a test pins.
5. **Anything skipped goes in "Deferred" below, in the same commit.** Silence is the failure
   mode this file exists to prevent.

## At each release

The full smoke sweep (all suites, documented order) is the release gate. A red suite stops the
release; it is never released over.

## The end-game campaign (overnight, whole app)

Run when the feature list is done. Not a smoke re-run — an adversarial pass over the product:

- Every suite, repeated, on a fresh machine state (no leftover state dirs, no stale sockets).
- Long-run soak: a jam left up for 2+ hours with a guest attached, over `--tunnel` and over LAN,
  measuring reconnects, memory, frame cadence, and whether the relay survives (the 2-hour claim
  has never actually been run).
- Multi-guest: 3+ clients, mixed host/guest actions, races on the approval ladders (two people
  answering the same question, a knock arriving mid-`/kick`, an invite used twice at once).
- The trust boundary, deliberately attacked: forged invite blobs, replayed secrets, traversal and
  oversized uploads under every policy, a guest attempting F3/raw keys/`/exit`, prompt injection
  in both directions (host prompt → guest machine, guest result → host context).
- Failure injection: kill cloudflared mid-session, kill the daemon, kill tmux's server, fill the
  disk on an upload, drop the network mid-transfer, hit a Claude usage limit mid-turn.
- Cross-platform matrix (once Windows lands): every combination in `docs/COMPATIBILITY.md`,
  recorded with build and date, no "should work" entries.
- Fresh-install rehearsal: `brew install` and `npm i -g` on a clean machine, following the wiki's
  `Install` and `Agent-Install` pages literally, including the agent-driven path.

## The nineteenth suite — `smoke-view` (added 2026-08-30, not yet in a release gate)

`scripts/smoke-view.mjs`, six steps, ~25 s, added by the adversarial review of `--view`. It is the
**first behavioural test the browser view has ever had**: through v0.23.0 the read-only claim was
carried entirely by a comment in `host.mjs`, and the review reproduced two ways in which the
comment was wrong (a read-only viewer resizing the host's real claude window 150x44 → 12x4, and
keystrokes landing in the pane under a writable ttyd, which is what ttyd ≤ 1.6.3 is by default).

It needs a **real ttyd** — it is the binary under test — and skips cleanly with a SKIP line when
there is none, so it is safe to add to the gate on any machine. Everything else is real: a real
daemon, a real tmux server, a real host client attached in a real pty at 150x45, and real frames in
ttyd's own websocket protocol. The pane is `cat >> <log>` rather than claude, which makes "a viewer
typed into the host" a byte in a file.

**Step 4 is the canary**: it runs the same `VIEW_SH` the daemon runs (which is why `VIEW_SH` moved
to `lib.mjs`) under `ttyd -W`. Verified 2026-08-30 by removing `-f read-only,ignore-size`: steps 3
and 4 go red — `got "30x8", want "150x44"` and `got "OLD_TTYD_PWN\n", want ""` — and the other four
stay green, which is the right shape. Ports 7951/7952/7953, clear of every other suite (smoke-peer
already holds 7941/7943).

Not yet run as part of a release gate; the gate record below is 0.23.0's, which predates it.

## The v0.34.1 security review — two findings, and what carries them (2026-08-30)

An adversarial pass over four surfaces nothing had attacked: transcript resume/replay, the hook
callback endpoints, the launcher's own input handling, and profiles / `--config-dir`. Two findings,
both in shipped code, both in the CHANGELOG's `Unreleased` section. What proves each fix:

| finding | unit tests | behavioural |
| --- | --- | --- |
| the `--resume`/`--replay` seed was an unscrubbed FIFTH funnel | the registry walk now walks `backfillHistory` on five real transcript shapes; the `host.mjs` funnel lint counts it | `smoke-replay` 17/17 (unchanged suite, re-run); the finding itself was reproduced with a throwaway daemon before the fix and the same probe comes back clean after |
| a transcript could forge WHO SPOKE in the replay | `v0.34.1 backfillHistory: a transcript cannot forge WHO SPOKE in the replay` — six bad `from` shapes, ESC included, plus both bent-body cases | same probe: `from` is the host's, the second `[Roy]:` line arrives bent |
| the state dir's privacy was assumed, never checked (a local user could become the host) | `pathPrivacy` (three reasons × both kinds × the Windows skip), its **fail-closed** branch (a POSIX stat reporting no usable owner/mode), `assumePrivate`'s fail-closed branch (an `lstat` that is not ENOENT/ENOTDIR, EACCES measured against a real unsearchable parent), `assumePrivate + secureWrite` against the real filesystem, and a `host.mjs` lint for both gate call sites | **`smoke-lifecycle` S4 and S4b are new** — see below |

`smoke-lifecycle` is 17 steps → **19**. The two new ones are there because the unit half can only
lint that `host.mjs` *calls* `assumePrivate`, and this project has already been bitten twice by a
test that could not fail:

- **S4** runs the real launcher against a `0777` state dir holding a planted `host.key`, and against
  a **symlink** where the state dir belongs (the case `stat` cannot see and `lstat` can). Both must
  exit non-zero with the refusal — and the load-bearing half is that **nothing was written into
  either one** (no `session.json`, `settings.json` or `token.json`) and **no tmux session was
  built**. A refusal that still left files in somebody else's directory would prove nothing.
- **S4b** is the second, independent gate: a `0700` state dir that is genuinely ours, holding a
  `0644` planted key. The launcher starts (the directory is fine), the daemon logs
  `[host-key] REFUSING …`, and a socket presenting that key over loopback gets a welcome with
  **no host-only fields**. Fail closed: the jam has no host at all.

**Canary, verified 2026-08-30.** Replace the state-dir gate with `null` → S4 fails
(`the launcher STARTED on a state dir that is 0777, with a planted host.key`). Replace the key-file
gate → S4 fails (`a tmux session was built anyway`). Both also fail the `host.mjs` lint in
`test.mjs`. Removing `token.json`'s `secureWrite`, or `secureWrite`'s chmod, each turns one unit
test red. Ports 7845/7847, session `jamlifepriv`, all inside the suite's own `$TMPDIR`; the first
canary run showed S4's failure leaving a session behind and cascading into S4b, so S4 now removes
it by exact name before it throws.

**What this review did NOT prove, and it matters for finding 3:** the state-dir takeover was
reproduced **as one uid**, by pre-creating the directory and the key exactly as a second uid would
have left them. Nobody ran it as two real users on a real Linux box. The two facts the Linux claim
rests on are `/tmp` being mode `1777` (universal) and `os.tmpdir()` returning `$TMPDIR || '/tmp'`
(node, POSIX) — neither measured here, because this is macOS, where `$TMPDIR` is a per-user `0700`
directory and the attack does not apply at all. The *fix* is measured on macOS and is
platform-independent (`lstat` + `st.uid` + `st.mode`). See the Deferred list.

## `--attach` on Linux — the question the CI leg opened, ANSWERED (0.23.4, 2026-08-30)

`.github/workflows/tests.yml` wired `smoke-lifecycle` to the `ubuntu-latest` leg, watched it fail
three `--attach` steps twice in a row (deterministically, and again under a real pty via
`script -e -q -c`), took the step back out and left the question here: *is `claude-jam host --attach`
broken on Linux?* It matters more than one CI step, because WSL2 is the documented Windows host path
(SPEC W2) and WSL2's platform is Linux.

**No. `--attach` works on Linux. The trigger was the `CI` environment variable, on every platform.**

ink asks [`is-in-ci`](https://github.com/sindresorhus/is-in-ci) whether it is running in CI, and when
it decides yes it writes ONLY its `<Static>` output and returns — the dynamic region is never painted
until unmount (`node_modules/ink/build/ink.js`: `if (isInCi) { … this.lastOutput = output; return; }`).
Both of jam's ink surfaces are dynamic-only: the client's **mirror view mounts with no `<Static>` at
all**, deliberately (`client-ink.mjs` — the alternate screen has no scrollback to reprint), and the
**launcher menu has none anywhere**. So under `CI` both draw a completely blank screen while still
reading keys. `smoke-lifecycle`'s three `--attach` steps wait for the stub's `fake claude` to appear
in the mirror; it never arrives, they time out at 25 s each, and step 3 then fails as a cascade off
the `jamlife` session the timeouts leave behind. That is exactly the four-failure shape the runner
reported, and the `CI=true` that GitHub Actions sets is the whole of "Linux" in it. macOS never saw
it because the suite had only ever been run from a developer shell, where `CI` is unset.

The experiments, all in one Debian bookworm container (`node:22-bookworm-slim`, node 22.23.2,
tmux 3.3a, aarch64/linuxkit, as the non-root user `runner` with passwordless sudo — a runner's shape,
and **`docker run --init`**, see the note below):

| environment | before the fix | after |
| --- | --- | --- |
| Linux, no CI markers | **19/19, 22 s** | 19/19, 22 s |
| Linux, `CI=true` + `GITHUB_ACTIONS=true` | **4 failed, 88 s** — steps 5, 6, 5 timing out on the client, step 3 cascading. Identical to the runner, which took ~91 s | **19/19, 22 s** |
| Linux, `CI=0` + `CONTINUOUS_INTEGRATION=true` + `GITHUB_ACTIONS=true` | **19/19, 22 s** | — |
| macOS, `CI=true` | **8 failed** (the same three, plus step 2's client, plus cascades) | 19/19, 23 s |
| `CI=true node menu.mjs`, captured with `capture-pane` | **nothing. A blank pane** where the unset run paints the five-row menu | paints, byte-identical to the unset run |
| `CI=true node scripts/smoke-scroll.mjs` | 1 step failed | 13/13 |

The third row is the control that isolates the mechanism: `CI=0` is `is-in-ci`'s own "not CI" value
and it short-circuits before `CONTINUOUS_INTEGRATION` or any `CI_*` key is read, so that run has
every other CI marker still set and differs from row 2 in `is-in-ci`'s verdict and nothing else.

**So this is a product defect, not a harness assumption — it just is not a Linux one.** Anyone whose
shell exports `CI`, `CONTINUOUS_INTEGRATION` or *any* `CI_*` variable (GitLab exports a dozen) got a
client and a launcher that painted nothing and still swallowed keys. Fixed in `ink-ci.mjs`: one
assignment, made before ink is first imported, which is why it is a module of its own — `import`
declarations are hoisted above the module body, so the same statement written at the top of a file
that imports ink runs too late, every time. `menu.mjs` imports it above its ink import; `client.mjs`
awaits it immediately before its renderer, which is already a dynamic import for this reason.

What carries it: `v0.23.4 ink-ci.mjs makes the REAL is-in-ci say no…` (asks the actual dependency, not
a re-implementation of its rule, with `CI`, `CONTINUOUS_INTEGRATION` and a `CI_*` key all set) and
`v0.23.4 every ink entry point neutralises CI ABOVE its ink import` (the hoisting trap, plus a sweep
so a future ink surface cannot skip the guard). **Canaried both ways, 2026-08-30:** removing
`ink-ci.mjs` reds the first; moving `menu.mjs`'s guard one line below its ink import reds the second
with `menu.mjs imports ink (line 22) before ./ink-ci.mjs (line 23)`. Unit suite 455 → **457, 0 fail,
and byte-identical on Linux**.

**W2 is unaffected.** Nothing platform-dependent is involved, and the same container is 19/19 with
`CI` unset both before and after the fix.

**Two things this did NOT settle, one of them now closed.** (1) The cascade — one failed step leaving
`jamlife` behind and later steps failing on the leftovers — **is fixed in 0.23.4; see the section
below for the before/after numbers.** (2) `smoke-lifecycle` never injects a keystroke, so injection
on Linux remains unproven — see the Linux-host entry in Deferred, which this narrows rather than
closes.

**A container note worth more than it looks.** `docker run` without `--init` gives PID 1 = the
command you named, which does not reap. Killed children stay as **zombies**, `ps -p <pid>` still
succeeds for a zombie, and `smoke-lifecycle`'s `running()` was `ps -p` — so the suite reported the
daemon's children as still alive and timed out on `ttyd (107) to exit`. Measured: `ps -eo pid,stat`
showed `107 Z`. Use `docker run --init`, and `docker exec -u <user>` rather than `su -c`. **The
harness half of this is fixed in 0.23.4** — `running()` reads the state column now — so a container
run no longer disagrees with a runner for this reason; the `--init` advice stands anyway, because an
unreaped tree is a bad model of a runner in every other way too.

**And one dependency this container run turned up, which is a real portability fact:** `host.mjs`'s
`waitForHealth()` shells out to **`curl`**. `node:22-bookworm-slim` has none, and the whole suite
then reads as six `daemon did not come up` failures while the daemon is up, listening and logging
normally (measured 2026-08-30 — the fix was `apt-get install -y curl`). `ubuntu-latest` and macOS
both ship curl, so CI and every developer box are unaffected; a slim container is not. Listed in
Deferred as a product nit rather than fixed here. **Fixed in 0.23.5** — `waitForHealth()` is node's
own `fetch` now, and the same container runs `smoke-lifecycle` 19/19 with no curl installed.

## Release gates that have actually run

- **0.23.2 — 2026-08-30. The second security patch in a row, gated on all nineteen.**
  All nineteen suites plus the unit suite (**453 tests, 450 pass, 3 skipped, 0 fail**) and
  `check-terminal-gate`, on node 24.15 / tmux 3.7c / claude 2.1.251 / ttyd 1.7.7 /
  cloudflared 2026.8.2, and `npm pack --dry-run` clean at 21 files. Suites 1–6 shared one
  `--model haiku` daemon on :7799 in the documented order (`smoke-ink` first against a fresh
  daemon, `smoke-slash` last and once), suite 7 its own knock-only daemon on the same port after
  that one was torn down, `smoke-perm` its own, suites 8–19 self-contained. **19/19, every suite
  green.** `smoke.mjs`'s `--- RESULT ---` block was read rather than counted, as the 0.23.1 gate
  established: `pong` returned, the jsonl `[Tester]:` line found, the system prompt in effect, and
  the v0.30 big paste whole at 7650 chars / 120 marked lines.

  Two results in this gate are load-bearing for the release itself, not just green rows:
  - **`smoke-lifecycle` is 19 steps now** (S4/S4b, new), and it is the only behavioural proof of
    the state-dir gate. It passed twice, and each of its two canaries was run.
  - **The false-positive check that macOS *can* answer.** The gate daemon on :7799 logged
    `[host-key] wrote …/claude-jam-7799/host.key (0600)` and started normally, and `smoke-slash`
    step 12 re-verified `host.key is 0600 and the only file holding the key`. So the new gate does
    not refuse an ordinary jam on this platform. The Linux/WSL2 equivalent is the deferral below.

  Cleanup verified rather than assumed: every session killed by exact name on its own socket, no
  `dns-sd`/`ttyd`/`cloudflared`/daemon child left (checked by listing processes, never by pattern
  kill), no state dir left under `$TMPDIR` except **Roy's dormant 7777 and 7873, untouched
  throughout**, and `jam-uploads/` removed from the repo cwd.

  **Not measured here, and it is the honest gap for this release:** the takeover finding 3 fixes
  cannot occur on macOS at all, so this gate proves the fix does not regress a macOS host and does
  not prove it stops the attack on the platform where the attack exists. See the Deferred entry
  naming the three Linux/WSL2 experiments.

- **0.23.1 — 2026-08-30. The security patch, and the first gate with nineteen suites.**
  All nineteen in the documented order, one at a time, plus the unit suite (**446 tests, 443 pass,
  3 skipped, 0 fail**) and `check-terminal-gate`, on node 24.15 / tmux 3.7c / claude 2.1.251 /
  ttyd 1.7.7 / cloudflared 2026.8.2 / git 2.50.1, from a verified-clean machine state (**no live
  tmux server on any socket** — checked by listing sessions on every socket under
  `$TMPDIR/../tmux-501`, not by assuming — and Roy's dormant state dirs at 7777 and 7873 left
  untouched). Suites 1–6 shared one `--model haiku` daemon on :7799, suite 7 its own knock-only
  daemon, suites 8–19 self-contained.
  **19/19, exit 0 on every suite, 241 PASS, 0 FAIL.** That is the 0.23.0 gate's 235 plus
  `smoke-view`'s 6, so nothing that was running steps stopped running them.
  `smoke.mjs` contributes 0 PASS lines **by format, not by vacuity** — it is the field report, and
  its `--- RESULT ---` block was read for this gate: `pong` returned, the system prompt in effect
  (it refused a paraphrase of the token to a prefixed participant), and the v0.30 big paste whole
  at 120/120 marked lines.
  Sessions killed by exact name on their own sockets throughout; nothing left advertising on the
  network (smoke-discover's own teardown check), no orphan `ttyd` or `cloudflared`, no listener
  left on any port the gate used.

  **Both findings were also reproduced against the INSTALLED 0.23.0** — the Homebrew artifact
  users actually have (`/opt/homebrew/opt/claude-jam/libexec`), not the tree — because "affects
  released versions" is a claim that deserves a measurement rather than a code reading:
  - the browser view: a real host client attached at 150x45, a browser opening the view at 30x8
    took the jam's claude window to **30x8**, and one resize message took it to **12x4**;
  - the hook secret: a guest's mirror frame came back carrying
    `FILEROUTE "secret": "HOOKSECRETinstalled99"` in clear.

  After the tap bump, the same two probes are the acceptance check on the upgraded binary: the
  host window must not move, and that row must come back masked.

  **Re-gated after the registry's hot-path cache.** The needle list is built per secrets object
  rather than per row, which changes every mirror frame, so the whole gate ran again rather than a
  subset: **19/19, exit 0, 241 PASS, 0 FAIL** a second time, 447 unit tests 0 fail. Frame cost
  measured either side of the cache on a 40-row, 100-column coloured frame with all three needles
  set (20k iterations after a 2k warm-up): **18.5 → 13.0 µs/frame** clean, 23.8 → 18.8 µs carrying
  all three secrets, against 8.1 µs with an empty registry — 0.20 ms/s at 15 fps.

- **0.23.0 — 2026-08-30. The first gate with a Windows leg, and the leg is what it was for.**
  All eighteen suites in the documented order plus the unit suite (**441 tests, 438 pass, 3 skipped,
  0 fail**), on node 24.15 / tmux 3.7c / claude 2.1.251 / cloudflared 2026.8.2 / ttyd 1.7.7, from a
  verified-clean machine state (no live tmux server on any socket, no jam process, the only state
  dirs Roy's two dormant ones at 7777 and 7873). Suites 1–6 shared one `--model haiku` daemon on
  :7799, suite 7 its own knock-only daemon, suites 8–18 self-contained. **18/18, exit 0 on every
  suite, 235 PASS lines, 0 FAIL** — the same 235 as the 0.22.1 gate, so the repaired suites are
  still running the steps they claim. `$TMPDIR` held 100 `jam-*` directories before and 100 after
  (F10 holds). `smoke.mjs`'s field report had every field present, `system prompt IN EFFECT`, and
  the 121-line paste WHOLE in the transcript.

  **The CI gate, which is the new half.** Run
  [33291176434](https://github.com/roypadina/claude-jam/actions/runs/33291176434), both legs green:

  | leg | tests | pass | fail | skipped |
  | --- | --- | --- | --- | --- |
  | `windows-latest` | 441 | **441** | 0 | **0** |
  | `macos-latest` | 441 | 438 | 0 | 3 |

  Zero skipped on Windows is the point: the three `{ skip: process.platform !== 'win32' }` tests —
  the real `icacls` ACL, the real `%WINDIR%\Media` lookup, `/paste`'s failure path through real
  PowerShell — execute only there, and this is the first time they have executed at all. Both legs
  also ran `scripts/check-terminal-gate.mjs` and `npm pack --dry-run`.

  **It went red three runs running, and all four reds were real.** Two were tests asserting POSIX
  facts (a `/tmp/…` literal against a `path.join` result; `mode & 0o777 === 0o600` on NTFS) —
  exactly the class AGENTS.md §2 warns about. One was **flaky on both platforms**: `pumpFrames`
  slept a flat 50 ms for progress needing two event-loop turns, and failed on windows-latest twice
  AND macos-latest once, always at the same 8 of 20; it waits on a deadline now. The fourth is the
  one TESTING.md had said would matter — the directory ACL — and it is its own deferral above:
  a FILE reduces to one entry, a directory does not, measured with `icacls` exiting 0 twice.

  **What this gate does and does not discharge.** It converts "the Windows client is unverified"
  into a measurement *for the parts a program can decide* — every argv, path, principal, `.wav`
  choice, refusal and key-sequence decode. It discharges **nothing** that a person has to see, hear
  or type; the nine W1 deferrals below stand except where noted, and the sound-mode table's *file
  list* half is now measured (`{"knock":"wav","join":"wav","nudge":"wav"}` on 10.0.26100, no beep
  fallback) while the "a human heard it" half is not.

  No product code changed between the 18-suite sweep and the shipped tag: the diff is tests, docs
  and one comment block, verified with `git diff 68bb69d..HEAD`.

- **0.22.1 — 2026-08-30.** All eighteen suites, in the documented order, plus the unit suite
  (**427/0**), on node 24.15 / tmux 3.7c / claude 2.1.251, from a verified-clean machine state (no
  tmux server on any socket, no jam process, the only state dirs the two dormant ones that pre-date
  the run). Suites 1–6 shared one `--model haiku` daemon on :7799, suite 7 its own knock-only
  daemon, suites 8–18 self-contained. Logs and `results.tsv` in
  `~/ClaudWork/2026-08-30-jam-security-review/gate/`.

  **The gate went red on the first pass, and it caught something standalone runs had not.**
  `smoke-invite` step 9 failed — *"timed out waiting for close 4409"* — because the roster-oracle
  fix moved the knock path's name check below authentication, and an **invite** whose bound name is
  already connected had been relying on that check for its 4409 close. The refusal itself was
  unaffected (immediate, by name — the holder authenticated); what changed is that the socket now
  falls through to a knock like the other four invite refusal reasons, which is the invite design's
  own rule. That is better, not merely different: reconnecting on your own link while your stale
  socket is still in the roster used to be a lockout. Step 9 now asserts the new shape, including
  that exactly one Yossi is in the roster while the duplicate waits.

  **Second pass, on the tree that shipped: 18/18, exit 0 on every suite, 235 PASS lines, 0 FAIL.**
  `smoke-mirror` and `smoke-xfer` were run against a real claude rather than deferred again (both
  green), which discharges the two deferrals the security review opened. `smoke.mjs`'s field report
  had every field present, `system prompt IN EFFECT`, and the 121-line paste WHOLE in the
  transcript. Machine clean afterwards: no tmux server on any socket, no jam process, no
  `jam-uploads/` in the repo, and `$TMPDIR/claude-jam-7777` and `-7873` untouched.

  **What this gate means that the last one did not.** `smoke-nudge` had been reporting green
  without running a step, and `smoke.mjs` could report green with two checks MISSING — both fixed
  before this gate ran, and all eighteen suites swept for the class first (see the vacuity audit
  below). So the 235 PASS lines are steps that actually executed.

- **0.22.0 — 2026-08-30.** All eighteen suites, in the documented order, one at a time, on node
  24.15 / tmux 3.7c / claude 2.1.251 / ttyd 1.7.7 / cloudflared 2026.8.2, from a verified-clean
  machine state (no tmux server on any socket, no jam daemon anywhere, the only state dirs the two
  dormant ones that pre-dated the run). Unit suite **424/0**.

  **The gate went red, and that is the whole story of this release.** `smoke-adopt` **S7c** failed
  on the first run — *"the key came back in a frame to Roy"* — and then passed five times running.
  A one-in-six flake on the assertion that guards the release's headline feature. Two real defects
  behind it:

  1. **The product.** `stripTokenBlock` had exactly one call site, `/export`. Every
     transcript-derived frame passes through one line in `onTranscript` and was broadcast
     unscrubbed, for all four kinds; the mirror rows were unscrubbed too (`maskSecrets` runs there,
     but `SECRET_HINT` needs a word like SECRET/TOKEN, so a bare 64-hex key matches nothing). The
     v0.34 comment asserting the key "has no route into a transcript" was the assumption it rested
     on — and there is a route: claude runs as the host user with file tools, so **any participant
     can ask it to read `<state>/host.key`**. Fixed with one shared helper (`scrubSecrets`) on both
     funnels, by known literal rather than by pattern. No released version was affected: none has a
     host key to leak.
  2. **The test.** S7c planted the key in the transcript the daemon tails and then asserted no
     frame held it — so the tailer's poll interval decided the result. It now **waits** for the
     planted line to come back and asserts it arrives scrubbed.

  Both canaries were run, because neither claim is worth anything unproven. Neutering
  `scrubSecrets` turns the two new unit tests **and** both pre-existing `stripTokenBlock` tests red
  (420/4), which is what proves the refactor actually routes through the shared helper. Reverting
  `scrubSecrets` out of `onTranscript` turns S7c red on **2 of 2** runs rather than 1 of 6, quoting
  the leaked value — the flake is gone, not merely re-hidden. Post-fix, `smoke-adopt` ran green
  five times, printing `transcript funnel: "and the host key is [host key removed]"` on each.

  **Host-still-host, on every launch surface**, since this release changes that gate:
  `smoke-slash` (*"the host's own loopback client is still the HOST — flag, F3 keys, host-only
  report"*), `smoke-lifecycle` 5 and 6 (`host --attach` and the launcher menu's attach — the
  assertion names `--host-key-file` by name), `smoke-adopt` S6 (`claude-jam adopt`), and
  `smoke-knock`'s three v0.34 refusals, each naming which condition failed.

  **The 0.21.1 → 0.22.0 upgrade path, measured rather than reasoned** (a real 0.21.1 daemon from
  `git archive 9e64c63`, confirmed to contain no host-key logic, with the real 0.22.0 client):

  | probe | result |
  | --- | --- |
  | 0.22.0 client, `--host`, no key file | prints `hostKeyNotice` with the path, joins as a **guest** — `host:false`, `tmux:null`, `join:null` |
  | a client still CLAIMING `host:true`, no key, vs the 0.21.1 daemon | **granted host on address alone**, handed `tmux` and the join line |

  So the client is correct and never falls back to address-only host — but the *daemon* decides,
  and an unrestarted jam keeps 0.21.1's gate. That is now an **Upgrading** section in the
  changelog rather than a footnote.

  Nothing was left behind: `$TMPDIR` held 100 `jam-*` directories before the sweep and 100 after
  (F10 holds across sixteen suites), no `dns-sd` child still advertising, no tmux server on a
  socket the gate created.

- **0.21.1 — 2026-08-30 (the security release).** All eighteen suites, in the documented order,
  one at a time, on node 24.15 / tmux 3.7c / claude 2.1.251 / ttyd 1.7.7 / cloudflared 2026.8.2,
  from a verified-clean machine state (no live tmux server on any socket). Every one green; unit
  suite **405/0**.

  The gate carried one extra question, because the release's own fix narrows the loopback gate
  and the host reaches its own daemon over loopback: **is the host still the host?** No suite
  asserted it directly — the pieces were scattered (`smoke-knock` S1 proved the flag on a
  token-less jam, `smoke-slash` used the host's F3 keys only as setup, `smoke-perm` proved the
  approval ladder), and none of them would have failed on a silent demotion. `smoke-slash` now
  has one step that asserts all three surfaces in one place: the host-only payload in the welcome
  (`session.tmux` and `session.join`, with the guest as the control), an F3 keystroke typed into
  the real claude pane and read back off it, and a `trusted()`-gated `/grants` report the guest is
  refused.

  It has a canary: with `localSocket()` forced to `false` — the shape of an over-tightened gate —
  the new step is the **only** one of the fifteen that goes red. Everything else still passed,
  including "host slash: /cost is typed into the real TUI", because a demoted host falls straight
  through to the read-only allowlist and the pane looks the same. That is exactly the blind spot
  the step exists to close, and it was measured rather than argued.

  **And then the RELEASE itself was probed, not just the tree.** The campaign's `check-released.sh`
  found Homebrew 0.21.0 vulnerable; the same shape was re-run on 2026-08-30 against the installed
  `claude-jam 0.21.1` (`/opt/homebrew/bin/claude-jam`, `brew test` exit 0, libexec `package.json`
  at 0.21.1) — a throwaway jam with a fake pane, a real `--tunnel`, a real `trycloudflare.com`
  hostname:

  | probe | result |
  | --- | --- |
  | stranger over the public URL, `host: true`, no token | **no welcome** — knocked, `pending` |
  | ... the join token / tmux session handed over | **null / null** |
  | relay guest WITH the token | admitted as an ordinary guest; no host payload |
  | ... their raw keys, their `/end` | both refused, jam still alive |
  | loopback socket carrying forged `x-forwarded-for` / `cf-connecting-ip` / `cf-ray` | **no welcome** — knocked (the test fails closed) |
  | the host's own plain loopback client | admitted as host, `session.tmux` + join line, keystrokes landed in the real pane, `/grants` answered, **zero error frames** |
  | a plain loopback client not claiming host | ordinary guest, no host payload |

  Still unproven, and unchanged by this: `--funnel`. See the deferral below.

- **0.21.0 — 2026-08-29.** All eighteen suites, in the documented order, one at a time, on node
  24.15 / tmux 3.7c / claude 2.1.251 / ttyd 1.7.7 / cloudflared 2026.8.2. Every one green; unit
  suite 389/0. Nothing was left behind: no tmux server on a socket the gate created, no `dns-sd`
  child still advertising, no state dir but the two that pre-dated the run.
  This discharges four of the deferrals below — the v0.28, v0.33 and v0.29 "not re-run, prove at
  the next release gate" entries, and the 0.20.0 one. They are kept, struck through, because what
  a skip cost is only visible next to what it was.
  It also found real drift no suite covers: `--help` and `/menu` disagreeing on three flags,
  `SPEC.md`'s recipe invoking sixteen of eighteen suites, and `MANUAL.md` missing six commands.
  Two new lints now fail on the first two.

## Deferred (owed to the campaign)

Append one line per skip: what, why, and how it will be proven. Newest last.

- ~~2026-08-29 · smoke.mjs, smoke-xfer, smoke-popup, smoke-slash, smoke-perm, smoke-knock not
  re-run after the v0.28 scrollback batch (judged unaffected; token cost). Prove: full sweep at
  the 0.20.0 release.~~ **DISCHARGED — 0.21.0 gate, 2026-08-29: all six re-run, all green.**
- ~~2026-08-29 · Linux sound path (`paplay`/`aplay`) never executed — no Linux box. Prove: a Linux
  run in the campaign, or mark the platform unsupported in the docs.~~
  **RE-SCOPED AND MOSTLY DISCHARGED — 0.23.3, 2026-08-30.** The deferral was unprovable as written,
  and the reason was a code shape rather than a missing machine: the decision (which player, which
  file, in which order) was a `for` loop inside `platform.mjs`'s `soundFile`, closed over
  `fs.existsSync`, so the only thing that could ever check it was a Linux desktop with a sound theme
  installed. That is exactly what AGENTS.md §2 tells you not to do, and `winSoundPlan` was already
  the counter-example sitting next to it. So the decision moved to `lib.mjs` as `linuxSoundPlan(kind,
  exists)` — no behaviour change, a pure extraction — and it is asserted on **every** CI leg: paplay
  before aplay, the per-kind candidate order, the second-choice-within-a-player fallback, the
  `.oga`/`.wav` split (aplay cannot play an `.oga` at all, so handing it one is not a fallback), three
  distinct files per player, and "nothing installed → `null`", which is silence and a correct answer.
  Canary run: swapping the player order turns the new test red and nothing else (checked 2026-08-30).
  The `ubuntu-latest` leg additionally **prints** what a real Linux box resolved to, rather than
  asserting a branch — a headless runner has no sound theme and no audio device, and resolving to
  silence there is correct.

  **What still needs a Linux DESKTOP, and it is the only thing left:** that the three sounds are
  audibly *distinguishable* — that a knock does not sound like a join. Nobody has heard one. Prove:
  one person at a Linux desktop with `paplay` and the freedesktop theme, a knock and a join, and a
  report of whether they can be told apart without looking. Also named there: the CEILING recorded in
  `linuxSoundPlan`'s own comment — the chain keys on the FILE, not on the BINARY, so a box with the
  freedesktop theme and no `paplay` on `PATH` gets silence instead of falling through to `aplay`.
  That is pre-existing behaviour kept deliberately (a PATH probe is a second seam, and `spawn`'s own
  `error` handler makes a wrong guess cost one silent child); if a real desktop shows it biting, the
  fix is an `onPath` argument, not a loop back in `platform.mjs`.
- 2026-08-29 · The nudge phone tier (ntfy) has no end-to-end run — the URL matcher is https-only,
  so there is no local stand-in server. Prove: one real ntfy topic in the campaign.
- ~~2026-08-29 · avahi (Linux mDNS) fallback not built and not tested; `dns-sd` is required.
  Prove: decide in the campaign whether Linux discovery is supported or documented as absent.~~
  **DECIDED AND DISCHARGED — 0.23.3, 2026-08-30. Linux mDNS discovery is UNSUPPORTED, it is
  documented as absent, and the refusal is now asserted rather than assumed.** The decision half was
  the easy one and it goes the way `platform.mjs`'s own comment already argued: avahi-browse prints a
  completely different format, there is no avahi on this project's machines to verify a parser
  against, and a parser written from a man page is precisely the confident-wrong-fix that
  `parseDnssdZone` (written against the real binary, with its `\032` escapes and duplicated
  per-interface records) exists as the counter-example to. Building it would owe a second parser AND
  a second lifecycle for a capability nobody has asked for. `docs/COMPATIBILITY.md` says ❌
  unsupported in those words, with the `avahi-utils` route for somebody who wants the compat `dns-sd`.

  The half that was actually missing is that "unsupported" must not mean "silently reports an empty
  network" — *nobody is hosting* and *this machine cannot look* are different answers, and conflating
  them sends somebody hunting for a jam that is announcing perfectly well. All three surfaces were
  read and all three were already correct (`cmdFind` refuses with the reason and exits 1, `--json`
  gives `{ok:false,error,jams:[]}`, the menu's Join screen shows the reason in an `Alert` and keeps
  the paste row, and the daemon logs `announce: off — <why>` once and hosts anyway) — but only the
  PURE half had a test, so a regression to a silent empty listing would have gone unnoticed.
  `scripts/check-discovery-refusal.mjs` now runs the real `sessions.mjs find`, both plain and
  `--json`, and asserts the refusal. On the Linux leg it runs the NATIVE case too, because there
  really is no `dns-sd` there — the branch is not hypothetical on that platform, it is the only one.
  Canary run 2026-08-30: replacing the refusal with an empty result turns both checks red (`exit
  status 0, wanted 1`), and on macOS the check asserts the opposite direction as well — a machine
  that HAS `/usr/bin/dns-sd` must not be refused.

  **0.23.3 — the decision is now DISCOVERY IS macOS-ONLY, and the two unbuilt paths are recorded
  here so it is revisitable from evidence rather than re-argued.** The `windows-latest` leg made this
  concrete: Windows has no `dns-sd` either, so "Linux discovery is unsupported" was the wrong scope.

  | unbuilt path | what it would take | why not now |
  | --- | --- | --- |
  | **avahi (Linux)** — `avahi-publish-service` + `avahi-browse` | a SECOND parser, written against the real binary the way `parseDnssdZone` was (its `\032` escapes and duplicated per-interface records were measured, not guessed), plus a second spawn/respawn lifecycle beside the `dns-sd` one | no avahi on any machine this project can reach, so the parser would be written from a man page — precisely the confident-wrong-fix `parseDnssdZone` exists as the counter-example to. **And `avahi-utils` does not provide a `dns-sd` at all** — measured 2026-08-30 in a Debian bookworm container: it ships `avahi-browse`, `avahi-publish`, `avahi-publish-service`, `avahi-resolve`, `avahi-set-host-name` and no `dns-sd`. The old `DNSSD_MISSING` told Linux users to install it, which did nothing; that message is corrected |
  | **Bonjour for Windows** — `%PROGRAMFILES%\Bonjour\dns-sd.exe` | one path probe added to `DNSSD_PATHS` and nothing else: it is the same CLI with the same output, so no second parser and no second lifecycle | it would be an unverifiable claim on a platform nobody has run. This project's rule is that no doc says a thing works until somebody has seen it work, and the `-Z` output would be parsed by a parser verified only against macOS. Roy's call, 0.23.3: do not wire it up |

  So `DNSSD_MISSING` now names what DOES work (an invite link, or the `ws://` address — which is the
  path 0.23.1 pointed discovered-jam users at anyway) instead of sending people to install something
  that would not have helped. Prove/revisit: if either path is ever wanted, the entry above says
  exactly what it costs, and the discipline is unchanged — measure the real binary's output first.

  Not covered, and small: the MENU's `Alert` is React in an ink tree, so "the reason is on screen"
  is asserted by nothing. `smoke-nudge` already drives a real `/menu` in a tmux pane; prove it there
  if the Join screen is next touched.
- 2026-08-29 · Invite links have never been used by a real remote guest on another machine —
  only by scripted clients here. Prove: the friend test, and the campaign's multi-guest pass.
- ~~2026-08-29 · The 2-hour remote-session claim is unproven: the keepalive, relay auto-restart
  and reconnect tiers exist but no long run has happened. Prove: the soak above.~~
  **DISCHARGED — campaign, 2026-08-30. The claim holds, on both transports.** Two runs of
  **130 minutes**, concurrent, one over LAN loopback and one over a live `--tunnel` (a real
  `trycloudflare.com` hostname, so every frame crossed the public internet), a guest client
  attached in mirror mode throughout, one sample every 30 s.

  |  | LAN | `--tunnel` |
  | --- | --- | --- |
  | duration | 130.1 min | 130.2 min |
  | reconnects | **0** | **1** (at t=0 only — see below) |
  | samples disconnected | 0 of 260 | 0 of 260 |
  | heartbeat terminations | 0 | 0 |
  | relay respawns | — | **0** |
  | frames delivered | 3878 | 3877 |
  | cadence per 30 s | 14.9 (ceiling is 15) | 14.9 |
  | ping RTT | mean 0.9 ms | mean 86.6 ms |
  | daemon RSS start → end | 77.9 → 88.7 MB | 77.9 → 88.8 MB |
  | alive at the end | yes | yes |

  The tunnel's single reconnect was at t=0: the daemon publishes the join line ~2.5 s before
  Cloudflare's edge will route to it, so the first connect gets one `1006` and the second
  succeeds. After that it held for 2 h 10 m with no relay respawn and no heartbeat termination.
  Cadence over the relay is indistinguishable from loopback — 3877 frames against 3878.

  RSS is a working set, not a leak: flat, a GC dip, one step up while four smoke sweeps and two
  live claude sessions shared the machine, then **flat for the last four deciles**. A 40-minute
  run on the POST-fix tree ended *lower* than it started (77.9 → 76.9 MB), which also confirms
  the two security fixes cost nothing measurable.

  Harness and raw samples: `~/ClaudWork/2026-08-30-jam-campaign/` (`soak.mjs`, `soak-*/`).
- 2026-08-29 · `--funnel` (Tailscale) live path unverified — Funnel is not enabled on this
  tailnet and the installed Tailscale is the sandboxed App Store build. Prove: after Roy enables
  Funnel and installs the standalone build, or record it as unsupported here.
- ~~2026-08-29 · A mention in `/c` chat never rang the bell in `--basic` clients: `client-basic.mjs`
  still called `nudge()` after the v0.25 rename to `alert()` — a ReferenceError at runtime, caught
  by the 0.20.0 release gate (smoke-perm P3), not by any unit test. Prove: a lint or test that
  every client call site resolves (no undefined identifiers) — a `node --check` passes this file,
  so it needs more than syntax. Owed to the campaign.~~
  **DISCHARGED — campaign, 2026-08-30.** `unresolvedCalls()` in `test.mjs` and the lint "every
  call site in every module resolves to something", over every `.mjs` in the repo root. It has a
  canary of its own — a lint that has never gone red proves nothing — driving the real bug from
  both directions (definition renamed, and one call site renamed) plus nine shapes that must NOT
  fire. The canary immediately earned it: object-literal shorthand methods (`{ run() {…} }`) read
  as calls to something undefined, so the rule now tells `name(…) {` (a definition) from
  `name(…)` (a call) by matching the parens. All twelve modules are clean today.
- 2026-08-29 · v0.33 adopt batch: `smoke-ink`, `smoke-xfer`, `smoke.mjs`, `smoke-popup`,
  `smoke-slash`, `smoke-perm`, `smoke-knock`, `smoke-transport`, `smoke-replay`, `smoke-invite`,
  `smoke-answer`, `smoke-discover`, `smoke-nudge`, `smoke-scroll` not re-run. Every tmux call that
  targets the claude pane moved from `tmux()` to `ptmux()`, which is the SAME socket for an
  ordinary jam — so the non-adopted path is unchanged by construction — and `smoke-lifecycle`
  (which builds real jams and drives the launcher's prompts) plus the new `smoke-adopt` cover the
  paths that did change. Prove: full sweep at the next release gate.
  **DISCHARGED — 0.21.0 gate, 2026-08-29: all fourteen re-run, all green. The judgement held —
  the `tmux()` → `ptmux()` move broke nothing on the non-adopted path.**
- ~~2026-08-29 · Adoption has never been run against a REAL claude in a REAL pane on the default
  tmux socket … the injected briefing has never been seen to land in a live conversation.~~
  **DISCHARGED — campaign, 2026-08-30.** A real claude (Haiku 4.5, 2.1.251) in a real pane on the
  DEFAULT tmux socket, given one real turn first so the briefing landed in a NON-empty
  conversation, then adopted. The briefing landed **and claude answered it**: *"Understood.
  Session adopted and bridged. I'm aware of the two hard rules (never reveal tokens/links to
  participants, never claim to see /c chat)…"* `claude-jam end` then left the pane, the session
  and claude exactly as they were — **same pane pid, 69305, before and after** — and the one
  session the run created on the default socket was removed by that exact name.
  It also found a real papercut on the most ordinary install there is: see the
  `paneCommandNote` fix below.
- ~~2026-08-29 · `contextLostSignal`'s patterns are UNVERIFIED against a real compaction … the
  marker itself is a guess. Prove: capture a real `/compact` and a real `/clear` into
  `fixtures/pane/`, then assert against those.~~
  **DISCHARGED — campaign, 2026-08-30.** Six haiku turns, then a real `/compact`, then a real
  `/clear`, captured into `fixtures/pane/compacted.txt` and `fixtures/pane/cleared.txt` with
  tests asserting against them. **The guess was right**: the marker is
  `⎿  Compacted (ctrl+o to see full summary)` — a `⎿` continuation line under the human's
  `/compact`, so neither at the start of a line nor after a ⏺/●/* glyph, which is exactly why
  `COMPACTED_RE` allows any whitespace before it. Two things the capture taught that the guess
  did not include, both now pinned by tests: a real compaction **does not wipe the scrollback**
  (the screen is still full afterwards, so the "nearly empty" branch would never have caught it),
  and a **fresh claude reads as `cleared`** — see the new deferral below.
  (For whoever does it: writing that step found two real bugs — the re-brief's own wording
  matching the watcher, i.e. an injection loop on a live session, and the baseline being taken by
  whichever tick happened to run first. Both are fixed and both have tests. It was a
  run-it-twelve-times step, not a run-it-once step; treat the real-capture version the same way.)
- ~~2026-08-29 · The ROSTER re-brief has unit tests (`briefUpdateDecision`, `rosterKey`) but no
  end-to-end run: proving it needs a fake clock … Prove: either a `--brief-min-gap` test hook, or
  a campaign run long enough to cross the gap with somebody joining.~~
  **DISCHARGED — campaign, 2026-08-30.** The hook, as `JAM_BRIEF_MIN_GAP` — an internal `JAM_*`
  var like `JAM_HOOK_SECRET`, deliberately NOT a flag, so `--help`, `/menu`, `MANUAL.md`, the
  README and the wiki gain nothing. `smoke-adopt` S13 adopts a pane of its own with the gap at 0,
  waits for the adoption briefing, has somebody JOIN, and asserts the re-brief lands in the pane
  naming them, keeps the standing rules, and is logged on the `roster` path rather than the
  compaction one. Ignoring the hook makes S13 time out, which was checked — so the deferral's own
  claim (the gap made this unreachable in a smoke) is now measured rather than assumed.
  S13 runs LAST on purpose: adoption names its own session `claude-jam`, so two adopted jams at
  once make `claude-jam end <name>` ambiguous — found the hard way while writing it.
- 2026-08-29 · v0.29 peer tasks: of the other seventeen smokes, four were re-run and thirteen were
  not. RE-RUN and green: `smoke-lifecycle` (real jams through the launcher, and `writeSystemPrompt`
  took a new argument), `smoke-answer` (the daemon's frame dispatch plus a real ink client),
  `smoke-nudge` (the `/menu` tree gained a section, and the platform seam), `smoke-scroll` (a real
  ink client on a real pty — the stdin key chain gained `peerKeys` in front of the approval bar).
  NOT re-run: `smoke-ink`, `smoke-xfer`, `smoke.mjs`, `smoke-mirror`, `smoke-popup`, `smoke-slash`,
  `smoke-perm`, `smoke-knock`, `smoke-transport`, `smoke-replay`, `smoke-invite`, `smoke-discover`,
  `smoke-adopt` — judged unaffected (no existing code path was edited; the daemon gained frame
  types and one loopback endpoint, the clients gained commands and a frame case, `peer.mjs` and
  `peer-mcp.mjs` are new files) and six of them spend tokens. Prove: full sweep at the next
  release gate.
  **DISCHARGED — 0.21.0 gate, 2026-08-29: all thirteen re-run, all green. The judgement held.**
- ~~2026-08-29 · The peer executor has NEVER been a real `claude`. … nobody has SEEN
  `--restricted` refuse a read outside the scratch directory.~~
  **DISCHARGED — campaign, 2026-08-30.** One live run, the SHIPPED `peerSpawnArgs`, real claude
  2.1.251, `--model claude-haiku-4-5-20251001`, $0.012. All five flags accepted (exit 0, empty
  stderr). `--restricted` refused the read in its own words, and the refusal is quoted here
  because that is the whole point of the deferral:
  `/Users/roypadina/.ssh is outside /private/var/folders/…/jam-livepeer-PoR9gs; --restricted
  confines the file tools to the working directory.` Refused, not empty. The stream also carried
  a `system/permission_denied` event, so the daemon could see it too.
- ~~2026-08-29 · The turn cap counts `{"type":"assistant"}` events in the stream. That one such
  event is one turn is taken from the documented event shape, not measured against a real stream
  — a build that emitted two per turn would halve every cap.~~
  **DISCHARGED — campaign, 2026-08-30, AND THE FEAR WAS RIGHT.** Measured on the live run above:
  **6 `assistant` events, 2 distinct `message.id`s, `result.num_turns: 3`.** 2.1.251 emits one
  event per CONTENT BLOCK — thinking, text, tool_use, tool_use / thinking, text — so the cap
  counted thinking and every tool call as turns of their own. A `--turns 12` task got about four,
  and the consent block promised twelve. Fixed by counting distinct `message.id`s; the stand-in
  now emits ids and a `blocks` mode reproducing the measured shape, and `smoke-peer` step 9b
  fails without the fix (verified by reverting it).
- 2026-08-29 · `--max-turns` DOES NOT EXIST on claude 2.1.251 (checked in `--help` 2026-08-29),
  so the spec's `--max-turns <n>` could not be passed and jam enforces the turn cap itself by
  counting the stream and killing the child by pid. `--max-budget-usd` exists and is a real spend
  cap, but it was NOT adopted: it is untestable without spending, and an inert or refusing flag
  would break every task. Prove: decide in the campaign whether to add it, after one live run.
  **PARTLY DISCHARGED — campaign, 2026-08-30.** Re-checked on 2.1.251: `--max-turns` is still
  absent, `--max-budget-usd` is still present. The live run happened (and found the turn-cap bug
  above), so the decision no longer needs one. It is Roy's call, and it is carried as its own
  entry at the end of this list rather than left inside a v0.29 note.
- ~~2026-08-29 · The ink client's peer surface — the consent block in the transcript, the
  `PeerBar` row, the `a`/`d`/`n` keys and Esc-to-cancel — has no pty evidence … nobody has LOOKED
  at the ink rendering.~~
  **DISCHARGED — campaign, 2026-08-30.** A real ink client on a real pty as the guest, with a
  stand-in executor so it spent nothing. All four surfaces photographed: the consent block (tools
  marked read-only, the caps, the scratch directory, "your own MCP servers are OFF for it", and
  the prompt under "this is text from another machine, read it before you answer"), the
  `[a]ccept · [d]ecline · [n]ever this session` line, `a` accepting, the `PeerBar` row
  (`⇄ a task is running on THIS machine, in your Claude Code · Esc cancels it`), and **Esc
  cancelling a running task**. Captures kept outside the repo, in the campaign folder
  (`~/ClaudWork/2026-08-30-jam-campaign/ink-peer-shots/`), because a screenshot of a client is not
  a fixture anything asserts against.
  NOT converted into a smoke step: it needs a real pty, a second `$TMPDIR`/`$HOME` and a stand-in
  executor, which is `smoke-peer`'s whole setup plus `smoke-scroll`'s — worth doing, not worth
  doing at 01:00 without somebody to review the seam.
- 2026-08-30 · **CAMPAIGN** `--funnel`'s trust boundary is UNVERIFIED in a second, new way. The
  campaign found and fixed a hole where every relayed socket reached the daemon from 127.0.0.1
  and so was treated as the host (see the campaign section below); the fix reads the upgrade
  headers a proxy adds, and it is measured against cloudflared only. Whether `tailscale funnel`
  adds `x-forwarded-for`/`cf-*`-style headers is not known, so `--funnel` may still be exposed.
  Prove: one Funnel upgrade captured and its headers read — or adopt the transport-independent
  fix (a second factor on `host: true`).
- 2026-08-29 · `--funnel` carries a known UPSTREAM risk, not merely an unverified path:
  tailscale/tailscale#18827 (filed 2026-02-27, open) reports WebSockets through `tailscale
  serve`'s HTTP reverse proxy — the same layer Funnel rides — closing every 10–40 s with code
  1001 "Going Away". Our 30 s heartbeat cannot save a 10 s drop; the reconnect tiers would just
  churn. Prove: one real WS session over Funnel before `--funnel` is recommended anywhere in the
  docs. Until then it is a stable-URL convenience with an unproven long-session story, and the
  docs must not imply otherwise.


- ~~2026-08-30 · **CAMPAIGN, NEW.** A just-STARTED claude and a just-`/clear`ed one draw the same
  screen — same banner, same emptiness — so `contextLostSignal` returns `cleared` for both …
  a later `/clear` does not change the signature — so no re-brief fires and the agent has
  silently lost the two standing rules.~~
  **FIXED — 2026-08-30 (F7).** They are distinguishable from the pane after all, and the campaign's
  own captures are what say so: `/clear` prints its own echo where the transcript it wiped used to
  be (`❯ /clear`, row 8 of `fixtures/pane/cleared.txt`) and neither `startup.txt` nor
  `startup-one-turn.txt` has such a row. The signature carries it — `cleared:/clear` against
  `cleared` — so F7's exact repro (adopt at the startup screen, one short turn, then `/clear`)
  now fires. Pinned by `F7: a STARTUP screen and a /clear are different signatures`, which asserts
  against all three real captures and replays the repro as the watcher walks it; with the echo
  term reverted it is one of exactly two tests that go red (checked, 403/2). `smoke-adopt` S7b
  re-run and green — its `[brief] compacted:` assertion also covers the daemon log line, which
  now prints the signature rather than the kind.
  What is NOT covered, and why it is not: the `cleared` branch has no end-to-end smoke step. S7b
  proves the watcher → decision → injection plumbing with the compaction marker, and nothing in
  that plumbing changed — only the value of one signature, which the unit test pins against the
  measured corpus. An end-to-end version needs a second adopted jam (adoption names its own
  session `claude-jam`, so two at once make `claude-jam end <name>` ambiguous — S13's note) or a
  restructure of S7b's guest lifetime, for a third proof of a path already proven twice. Prove:
  fold a `cleared`-mode paint into S7b when that step is next touched.
- 2026-08-30 · **F10 — the suites clean up after themselves now.** `smoke-peer` (4 dirs),
  `smoke-answer` (3), `smoke-discover` (2) and `smoke-xfer` (1) removed nothing, so `$TMPDIR` grew
  by ~10 per full sweep forever; 158 `jam-*` directories were counted. A PASSING run now removes
  exactly the paths its own `mkdtempSync` returned, one `rmSync` each, after its daemons are dead;
  a FAILING run keeps them and says where. No pattern, no glob, no sweep — the same rule AGENTS.md
  §0 states for processes and tmux sessions, and it is written down in §2 now.
  Measured, 2026-08-30: `$TMPDIR` held 104 `jam-*` directories; `smoke-peer`, `smoke-answer` and
  `smoke-discover` were run back to back (all green) and it held **104** afterwards. Before this
  change those three runs would have left nine.
  ~~NOT run: `smoke-xfer`. It is one of the six that need a daemon of yours with a real claude, so
  it spends tokens, and this batch's guardrail was not to. Its change is the same shape as the
  other three — one `rmSync` of one `mkdtempSync` path at the end of the script — and `node
  --check` passes it, which is not the same as having run it. Prove: the next full sweep; watch
  for `(cleaned up: …/jam-xfer-smoke-…)` on its last line.~~
  **DISCHARGED — 0.22.0 gate, 2026-08-30.** `smoke-xfer` ran and its last line read
  `(cleaned up: /var/folders/…/jam-xfer-smoke-eB7uZB)`, exactly the string this entry said to watch
  for. Across the whole sixteen-suite sweep `$TMPDIR` went 100 `jam-*` directories in, 100 out.
- 2026-08-30 · **F6 — said rather than waited for, deliberately.** The tunnel-ready line now ends
  `· give it a few seconds — the edge needs a moment before the first join works`, because
  cloudflared reports its hostname ~2.5 s before Cloudflare will route to it (soak log,
  21:10:51.616 published → 21:10:54.142 connected, one `1006` at 21:10:51.922 in between). Waiting
  for the edge instead would mean polling the public URL until it answers — a health check with a
  timeout, a retry policy and a failure mode of its own — for a race a human never loses. The
  sentence is on `relayReadyLine` only, and there is a test asserting `tunnelJoinLines` does NOT
  carry it, since those strings are reprinted by `/join` hours later. `smoke-transport` (a real
  cloudflared, a real `trycloudflare.com` hostname, the relay respawn and the reconnect ladder)
  re-run twice and green.
  NOT proven: nothing asserts the 2.5 s number in CI — no smoke measures the gap between the
  hostname landing and the first successful connect, and doing so would need exactly the probe
  this change avoids building. The number is the campaign's measurement, cited with its log
  timestamps in the code, the wiki and here. Prove: if it ever looks wrong, re-time it the same
  way — `soak.mjs` with a client connecting at t=0.
- 2026-08-30 · **F8 — the invisible state dir is visible.** A `claude-jam-<port>` directory with no
  `session.json` used to be skipped by `listRows`, so it could be neither listed nor cleaned. It is
  a new state, `incomplete`, listed and cleanable while nothing holds its port (and `no-session`,
  untouched, while something does — a `--daemon` with no `session.json` is what every smoke runs).
  Pinned by `F8 a state dir with no session.json is listed and cleanable — and nothing else
  changed`, which also asserts the half that must NOT move: no name, so `resolveTarget` cannot
  reach it and the v0.18 pair is never consulted. `smoke-lifecycle` — the suite that owns
  list/end/clean, including the two decoys and the planted real-TMPDIR orphan — re-run and green
  in 22s.
  End to end as well as in the unit suite: `smoke-lifecycle` step 3 now PLANTS one — a state dir
  with a `token.json` and no `session.json`, on a port below the range so nothing can ever be
  listening on it — and asserts the whole path, `readdir` → row → offered by `clean` → `rmSync`,
  alongside the orphan and the live jam that must survive. It also asserts the refusal:
  `claude-jam end 7849` exits non-zero, because there is no name for `resolveTarget` to find.
  Verified by hand on the real machine too, 2026-08-30: `claude-jam sessions` now shows
  `! 1 — — 7777 incomplete` with its explanatory note, where it previously showed nothing.
  **Not cleaned** — that directory is Roy's, and only he decides.
- 2026-08-30 · **F5 — fixed, and still unrunnable on the platform it is for.** `safeBaseName` now
  renames the Windows device names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`, with
  any extension) and strips trailing dots. Pinned by `safeBaseName: the Windows device names,
  which are not files at all`, including the near-misses that must NOT be renamed (`console.log`,
  `com10.txt`, `lpt0.txt`, `CONIN$.txt`) and idempotence. `smoke-nudge` (the upload-policy suite)
  re-run and green in 13s. The skip that remains is the platform itself: **no Windows box**, so
  "the file is now usable there" is reasoned from the API contract, not observed. Prove: the
  Windows run in the W3 work — send `con.txt` into a jam from a Windows client and open it.
- 2026-08-30 · **F4 — the stand-in was not the thing it stood in for.** `scripts/fake-claude.mjs`
  emitted one stream event per turn; 2.1.251 emits one per CONTENT BLOCK under a shared
  `message.id`, so the only path `smoke-peer` could reach was the no-id fallback and the turn-cap
  bug survived eighteen runs. Fixed: `turn()` emits the measured shape in EVERY mode (the `blocks`
  mode is now just two ordinary turns — thinking + text + two tool_use, then thinking + text: six
  assistant events, two ids), and a finished run writes a `receipt` line saying what it actually
  emitted, which step 9b asserts (`events: 6`, `ids: 2`) instead of trusting a mode name. The
  result frame carries the measured `num_turns`, `duration_ms` and `total_cost_usd`.
  **Proved by reverting the fix**, 2026-08-30: with `peer.mjs` counting events again
  (`turns++` unconditionally), step 9b goes red — *"it ran to completion instead of hitting the
  cap: 'cap': got false, want true"* — and every other step still passes, which is the point.
  Restored and re-run: all 16 steps green, 405/0 unit.
  NOT done, and named here rather than left implicit: the other stand-ins were not re-derived from
  a fresh measurement. `fake-tui.mjs` is built from the real `fixtures/pane/` corpus and its one
  known infidelity (its command name is `node`, which is what hid F9) is a property of running it
  under node at all, not something a rewrite fixes. Prove: when a stand-in's behaviour is next
  relied on for a new assertion, measure that behaviour first and say so in the file.
- 2026-08-30 · **F7's remaining ceiling, accepted and documented** (`host.mjs` `watchContext`,
  the wiki's Hosting-a-Jam). The watch is edge detection over a screen signature, so two identical
  losses with nothing observable between them read as one: `/clear`, then exchanges short enough
  that the screen never leaves `cleared:/clear`, then `/clear` again. The roster re-brief is the
  backstop. Prove/fix: something other than the pane for "the context went" — the transcript's own
  file is still the obvious candidate — if it ever actually bites.
- 2026-08-30 · **CAMPAIGN, NEW.** `--max-budget-usd` DOES exist on 2.1.251 (checked in `--help`,
  2026-08-30) and is a real spend cap, unlike the `--max-turns` the spec wanted. It is still not
  adopted, and the campaign did not adopt it: it is untestable without spending, and an inert or
  refusing flag would break every peer task. Now that a live run exists ($0.012, `total_cost_usd`
  on the result frame), the decision is cheap to make. Prove: Roy's call — one live run with the
  flag set below the task's cost, checking it refuses rather than truncating silently.

- ~~2026-08-30 · **v0.34 batch (host identity is a local secret).** Run per the batch policy, not
  the full sweep: `node --test test.mjs` (407 → 422, green) plus `smoke-slash`, `smoke-lifecycle`,
  `smoke-knock`, `smoke-adopt` and `smoke-transport`, all green. **Not re-run:** `smoke-ink`,
  `smoke.mjs`, `smoke-mirror`, `smoke-popup`, `smoke-xfer`, `smoke-perm`, `smoke-replay`,
  `smoke-invite`, `smoke-answer`, `smoke-discover`, `smoke-nudge`, `smoke-peer`, `smoke-scroll`.
  Every one of them that connects a scripted host was edited in the same commit to read
  `<state>/host.key` and present it, and `node --check` passes on all of them — but an edit that
  compiles is not a run, and a host peer that silently became a guest would fail those suites
  loudly rather than subtly (a demoted host gets no join line, no F3 and no host-only report).
  Prove: full sweep at the next release gate.~~
  **DISCHARGED — 0.22.0 gate, 2026-08-30: all thirteen re-run, all green.** The judgement held for
  twelve of them. It did NOT hold for `smoke-adopt`, which was in the re-run half and passed there:
  its S7c step was flaky, and the 0.22.0 gate is where it finally went red and gave up a real
  scrub gap. "An edit that compiles is not a run" was the right instinct; the missing half is that
  a suite that RAN is not the same as a suite that ran deterministically.
- ~~2026-08-30 · **v0.34: the `/export` leak proof did not run in `smoke-slash`.** Its jam's claude
  had never taken a turn, so there was no transcript on disk and the daemon refused the export
  with "there is no transcript on disk yet" — which the step now prints rather than failing on.
  The export half is proven instead in `smoke-adopt` S7c, against the transcript that suite
  plants under a `$HOME` of its own, with the key written INTO it first so the scrub is not
  vacuous (`[host key removed]` present, key absent, 501 bytes). `smoke-xfer` asserts the same
  thing against a REAL claude transcript and was not run (it costs a turn). Prove: `smoke-xfer`
  at the next release gate.~~
  **DISCHARGED — 0.22.0 gate, 2026-08-30.** Both halves ran. `smoke-xfer` green against a real
  claude transcript, and `smoke-slash`'s own step ran this time too — its jam HAD taken turns by
  then — reporting `/export: 5 chunk(s), 311203 bytes, no key in them` plus `daemon window: 241
  line(s) captured, no key in them` and `host.key is 0600 and the only file holding the key`.
- 2026-08-30 · **Funnel: the transport is still unverified; the HOST GATE no longer depends on
  it.** Whether a Tailscale Funnel upgrade carries any proxy header was never measured (Funnel is
  not enabled on this tailnet and the installed Tailscale is the sandboxed App Store build), and
  that is unchanged. What changed is that it no longer matters for host authority: since v0.34 a
  socket is the host only if it presents the daemon's `0600` `host.key`, which a process on
  another machine cannot read — so a funnel-relayed socket is not the host whether or not
  Tailscale sets a header we would have recognised. The **relay itself** (does `--funnel` carry
  bytes at all, end to end, from another machine) remains unproven and `smoke-transport`'s T4
  still runs against a stub CLI. Prove: after Roy enables Funnel and installs the standalone
  build — the same condition as the 2026-08-29 entry above.
- 2026-08-30 · **SECURITY REVIEW, NEW: `smoke-mirror` not re-run against a real claude after the
  wrapped-row scrub.** The change touches both pane funnels. `screen-history` is covered —
  `smoke-scroll` ran green, 13/13, and it asserts the rows are *row for row identical to
  `capture-pane`*, so it would fail on any over-masking. The live frame path was exercised by a
  purpose-built probe (a real daemon, a real mirror guest at 80 columns, the key printed on the
  pane, scrubbed in both the whole-row and the wrapped case) and by the new unit lint that fails if
  either funnel loses the join scrub. What was NOT run is `smoke-mirror` itself: it needs a real
  claude to answer an injected prompt (three of its eight steps assert `ok` came back and one
  asserts SGR the stand-in does not emit), and this review was instructed not to spend quota.
  Driven against a `fake-tui` daemon it is 5/8, with the three failures attributable to the
  stand-in by their own text. Prove: `smoke-mirror` in the next release gate's shared-daemon block,
  where a real claude is up anyway.
  **DISCHARGED — 0.22.1 gate, 2026-08-30: run against a real claude in the shared-daemon block,
  7/7 green.**
- 2026-08-30 · **SECURITY REVIEW, NEW: `smoke-xfer` not re-run after the upload write changed to
  `flag: 'wx'`.** Same reason — it takes a live jam with a real claude (its last step reads the
  pane for claude's reaction to an uploaded image). `smoke-nudge` covers the same
  `onUpload → writeUpload` path end to end for free, and now runs 16/16 including the two new
  steps. Prove: `smoke-xfer` in the next release gate.
  **DISCHARGED — 0.22.1 gate, 2026-08-30: run against a real claude, 12/12 green.**
- 2026-08-30 · **SECURITY REVIEW, NEW: the pre-auth roster oracle is REPORTED, not decided.**
  A hello with a name somebody already holds is refused `the name "X" is already taken here` and
  closed 4409 **before** any admission, so a stranger with no token can enumerate who is in a jam,
  unlimited (the close happens above `pending`, so `MAX_PENDING` does not apply). Invite-only mode
  does not leak — its refusal is above that line. The two answers are both defensible (a joiner
  who is told "that name is taken" can fix it in one go; a joiner who is not is left guessing why
  they were refused), so it was left for Roy rather than picked. Prove/decide: either accept it in
  `Security-Model` as the cost of name-based attribution, or move the name check below admission
  and give a knocker a generic refusal.
  **DECIDED AND DISCHARGED — 0.22.1: Roy chose ordering over silence.** The name check moved below
  the authentication gate, a knocker's clash is settled at admission by `resolveJoinName`, and a
  source lint fails if it ever moves back. See the CHANGELOG's 0.22.1 section.
- 2026-08-30 · **The Linux/WSL2 leg of the state-dir gate has never been run on Linux, and it is a
  precondition for SPEC v0.32 W2 (the WSL2 Windows host), not a footnote to it.** The 0.23.2 takeover
  was reproduced **as one uid** on macOS — the directory and the planted `host.key` created first,
  exactly as a second uid would leave them — never as two real users. The exposure itself rests on
  two facts not measured here: `/tmp` is mode `1777`, and `os.tmpdir()` is `$TMPDIR || '/tmp'`. This
  machine is macOS, where `$TMPDIR` is a per-user `0700` directory and the attack does not apply at
  all, which is exactly why it went five reviews unnoticed. The FIX is measured on macOS and is
  platform-independent (`lstat` + `st.uid` + `st.mode`).

  Three experiments settle it, all on one Linux box (or one WSL2 install), and W2 should not ship
  without them:
  1. **The attack.** As user B, `mkdir -m 777 /tmp/claude-jam-7777` and plant a 64-hex `host.key`.
     As user A, `claude-jam host`. It must refuse and exit 2, naming the mode.
  2. **The false positive.** As user A alone, `claude-jam host` on a clean `/tmp`. It must start
     normally — the gate must not refuse an ordinary Linux jam, which is the regression this fix
     could plausibly cause and macOS cannot detect.
  3. **W2's own case: a `--state` (or `$TMPDIR`) on a mounted Windows drive under WSL2.** DrvFs
     without `metadata` reports one uid and mode `0777` for everything, so experiment 1's branch
     should fire; a mount reporting no usable owner/mode at all should hit the fail-closed branch.
     Either refusal is correct, but which one fires is unknown until somebody runs it, and a WSL2
     host whose `$TMPDIR` is on `/mnt/c` would refuse to start at all — that is the outcome W2 has
     to design around, and the reason this is a precondition.

  **0.23.3 — EXPERIMENTS 1 AND 2 ARE MEASURED ON REAL LINUX, INCLUDING TWO REAL UIDS. 3 IS NOT.**
  Run 2026-08-30 in a Debian bookworm container (linuxkit kernel, aarch64, node 22.23.2), **as a
  non-root user `jamci` (uid 1001) with passwordless sudo — deliberately, because that is the shape
  of a GitHub `ubuntu-latest` runner** and because root defeats two of the branches. It is a real
  Linux userland with a real `1777` `/tmp` and real uids; it is **not** the GitHub runner and **not**
  a Linux desktop, and the rows below say which claims depend on that.

  What the run printed, verbatim on the two lines that matter:

  ```
  os.tmpdir() = /tmp · mode 1777 · uid 0 · world-writable: true · TMPDIR unset
        two real uids: nobody is uid 65534, this process is uid 1001
  ```

  All six checks passed, and the unit suite is **454 tests, 451 pass, 3 skipped, 0 fail on Linux —
  byte-identical to macOS**, which is the answer to "what will the leg find": nothing. No assertion
  in the suite encoded a macOS fact. That is a different result from the Windows leg (four genuine
  reds on first contact) and the reason is visible in the diff history: the Windows leg already
  taught this suite to use `path.join` and to pass the platform as an argument.

  The three experiments were
  the reason a Linux leg was added, and `scripts/check-state-privacy.mjs` is where they live. It runs
  on every leg, needs no tmux, no claude and no network (the gate is the FIRST thing `host.mjs` does
  after argument parsing, so a refusal costs one node start), and it prints `NOT EXERCISED` with a
  reason for every branch it could not reach rather than counting it as a pass.

  | experiment | where it stands |
  | --- | --- |
  | **2 — the false positive** | **MEASURED ON LINUX, 2026-08-30**, against the real `/tmp` at mode `1777`, and on macOS as well. It did not need Linux after all, and that realisation is the useful part: the gate `lstat`s the state DIR, never its parent, so a `1777` parent is irrelevant to it — and `/private/tmp` on macOS is really mode `1777`, so the shape is reproducible here. An ordinary `secureDir`'d state dir under a genuinely world-writable parent is NOT refused, and the check `chmod`s the parent to `1777` and asserts it took, so the check cannot go vacuous. The whole unit suite was also re-run with `TMPDIR=/private/tmp` — the Linux `$TMPDIR` shape — and is unchanged at 451/0/3. |
  | **1 — the attack, as ONE uid** | **MEASURED ON LINUX AND macOS, 2026-08-30**, against the real `host.mjs`: a `0777` state dir with a planted 64-hex `host.key` exits 2, the refusal names `mode is 777`, it does not quote the key, and **nothing was written into the directory**. Plus the symlink case, and `EACCES` on an unsearchable parent — which the Linux run DID exercise, because it ran as a non-root user. Also **`smoke-lifecycle` S4 passed on Linux**, which is the launcher-level version of the same refusal (see the smoke assessment below for why the rest of that suite did not). |
  | **1 — the attack, as TWO REAL UIDS** | **MEASURED ON LINUX, 2026-08-30. This is the branch macOS cannot reach and it is the whole point of the exercise, and it is now run.** `nobody` (uid 65534) creates `/tmp/…/claude-jam-7997` at **mode 0700 on purpose** — a `0777` dir is refused by the mode branch before owner is ever asked, so only a tidy-umask plant exercises the OWNER branch at all — and the real `host.mjs`, as uid 1001, exits 2 with `owned by uid 65534`. Canary run on Linux too: neutering `assumePrivate` turns this check red along with two others, and no jam is built. On a machine with no passwordless sudo it reports `NOT EXERCISED` naming that, which is what this Mac prints. **On the macOS CI runner it should now RUN**: the first CI run failed there because the plant used `os.tmpdir()`, which on macOS is a per-user `0700` directory `nobody` cannot even traverse into — the base is `/tmp` now, which is `1777` on macOS as well (verified: every component of `/private/tmp/...` is `o+x`, where the old base was blocked at the `0700` `$TMPDIR`). |
  | **3 — WSL2 on a DrvFs mount** | **UNCHANGED, and still a W2 precondition.** No CI runner has a `/mnt/c`, so neither the `0777`-for-everything shape nor the reports-no-usable-metadata shape can be reached. `pathPrivacy`'s fail-closed branch is unit-tested against synthesised stats and nothing more. Prove: one WSL2 install, `--state /mnt/c/tmp/jam`, and a report of WHICH refusal fired. |

  **Two things the CI leg will not close, said here so nobody reads the green as more than it is.**
  A Linux HOST has never existed: the nineteen smokes need a real tmux and six of them a real
  `claude`, and none has run on Linux, so `tmux`, injection, `capture-pane` framing and F3 are
  untested there (see the smoke assessment below). And a CI container commonly runs as **root**,
  where `EACCES` is unreachable — a GitHub `ubuntu-latest` runner is the non-root user `runner`, so
  the branch does run there, but the check detects uid 0 and says it did not exercise it rather than
  reporting a pass it did not earn.
- 2026-08-30 · `pathPrivacy`'s Windows branch (uid `null` → the owner and mode questions are skipped
  and only the symlink check runs) is asserted by unit test and has never executed on Windows. It is
  reached there through `assumePrivate`, whose `process.getuid` check is the only thing selecting it.
  Prove: the `windows-latest` CI leg runs the unit test; a human at a Windows keyboard starting a jam
  is what would prove `assumePrivate` does not refuse a normal `%TEMP%` directory. Until then the
  honest line is "green on macOS, and the Windows leg will say".

- 2026-08-30 · **0.23.3, THE SMOKE ASSESSMENT: no smoke suite was added to CI, and this is the
  reasoning rather than an omission.** The task was to assess and not to promise, so here is the
  assessment, with the measurement it rests on.

  **Nine of the nineteen need only `tmux`, `bash` and node.** That was worth checking rather than
  assuming, and it is better than expected: `smoke-adopt`, `smoke-answer`, `smoke-discover`,
  `smoke-invite`, `smoke-lifecycle`, `smoke-nudge`, `smoke-peer`, `smoke-scroll` and `smoke-view` all
  point `JAM_CLAUDE` at a stub, and the ttyd/cloudflared they name are `stub()`ed shell scripts that
  hold a pid and sleep — not the real binaries. So "they need a real `claude`" is true of six suites
  (1–6 and `smoke-perm`), not of the free twelve, and a headless Linux runner is not disqualified.

  **The one worth wiring is `smoke-lifecycle`, and it is worth wiring.** It is the ONLY behavioural
  proof of the state-dir gate (S4/S4b), Linux is the platform where that gate's attack exists, it
  costs no tokens, and it is 23 s. `apt-get install -y tmux` plus one `run:` line is the whole diff.
  Two things were checked and are not blockers: S3 is guarded on *"the live `jam` session on :7777,
  **if one is running**"*, so a runner with no jam on 7777 is fine; and it brings its own `$TMPDIR`,
  its own ports (7845–7855) and its own sessions (`jamlife*`).

  **AND IT WAS RUN, WHICH IS WHY IT IS NOT WIRED: 13 of 19 steps FAILED on Linux.** Debian bookworm
  container, tmux 3.3a, node 22.23.2, as the non-root user `jamci`, 2026-08-30. Wiring it on a
  prediction would have put a 13-red suite into the gate. The failures, and what they are not:

  - **The two that looked like tmux-version differences are NOT.** `F3 is not bound to
    detach-client on jam's socket`, and an `invalid option: @claude-jam-owned` from the S1 decoy
    plant, both smelled like tmux 3.3a vs the 3.7c this repo's comments cite by name. Probed
    directly on tmux 3.3a: `bind-key -T root F3 detach-client` exits 0 and `list-keys -T root` shows
    F3, and `set-option -t <session> @foo bar` + `show-options` round-trips. **Both work.** So tmux
    version is not the cause, and that hypothesis is closed rather than left hanging.
  - **The real cluster is the jam not fully coming up in a container**: two launches reported
    `daemon did not come up`, and `pids: daemon 329 · claude 0` — the pane's process was never seen
    at all, which is also what un-bound F3 and the pty timeouts follow from. The container had no
    controlling tty (`su jamci -c`), and four of this suite's steps drive real ptys. This is
    evidence about the environment, not about Linux hosting: it is neither a demonstration that
    Linux hosting works nor that it is broken.
  - **A CASCADE turned 2 failures into 13, and that is a suite bug worth fixing on any platform.**
    A failed launch leaves the `jamlife` session behind, and five later steps then fail with
    `tmux session "jamlife" is already a jam.` The first genuine failure is therefore the only one
    worth reading, and the RESULT line overstates by about 6×.
  - **What DID pass is the part this batch cares about**: S1, S2b, **S3** (read-only against the
    live jam), **S4** — the launcher-level state-dir refusal, printing both the `mode is 777` and
    the symlink refusals and *"nothing was written into either one, and no tmux session was
    built"* — step 1, and the closing decoy check.

  So: wiring `smoke-lifecycle` to the Linux leg is still the right next step and still cheap, but it
  needs an environment triage pass first, which is a batch of its own. Prove/do, in order: (1) find
  out whether the launch failures are the missing tty by re-running under a real pty (`script -qec`
  or a container with `-t`), (2) fix the cascade so one failed launch cannot poison five later steps
  — it removes the session it created before it throws, which is what S4 already does, (3) then
  `apt-get install -y tmux` + `node scripts/smoke-lifecycle.mjs` behind `if: runner.os == 'Linux'`,
  on a branch, read once before it goes near `main`'s gate. If it goes green, `smoke-nudge` (the
  platform seam, and the suite that would catch a Linux SOUND regression) is the obvious second,
  then `smoke-scroll`.

  **0.23.4, 2026-08-30 — (1) IS ANSWERED AND THE SUITE IS 19/19 ON LINUX. (2) IS STILL OWED.**
  It was neither the tty nor tmux 3.3a. Two things were wrong with that container, and both are
  written up in the `--attach` section above: PID 1 was not a reaper, so the daemon's killed children
  stayed as **zombies** that `ps -p` — i.e. this suite's `running()` — reports as alive; and the real
  failure the CI leg later saw was `is-in-ci`, a product defect in every ink surface, not a platform
  one. With `docker run --init` and `docker exec -u runner`, the same Debian bookworm/tmux 3.3a
  container runs **19/19 in 22 s, with `CI=true` and with it unset**. The cascade (2) is unchanged and
  still worth fixing on any platform. Re-adding the CI step is now a decision about gate policy
  rather than an open question — it is Roy's to make, and it is not wired.

  **0.23.4, second pass, 2026-08-30 — (2) IS DONE AND THE STEP IS WIRED. This entry is closed.**
  The cascade fix, its canary numbers and the `running()`/zombie decision are their own section
  ("The cascade — a red RESULT line that overstated by 8×"). `.github/workflows/tests.yml` now
  carries `sudo apt-get install -y tmux` plus `node scripts/smoke-lifecycle.mjs` behind
  `if: runner.os == 'Linux'`, with no retry and with the reason it is back written above it. Proved
  before wiring, not predicted: 19/19 on macOS and in the container, with `CI=true` and with it
  unset, four runs. The next two candidates named above stand as they were — `smoke-nudge` then
  `smoke-scroll` — and `smoke-adopt` is now known NOT to be a candidate until the tmux 3.3a
  `PANE_SEP` bug below is fixed.

  What ran for this batch on macOS 2026-08-30: the unit suite **454 tests, 451 pass, 3
  skipped, 0 fail** (and again at `TMPDIR=/private/tmp`, the Linux `$TMPDIR` shape, unchanged);
  `check-terminal-gate`, `check-state-privacy` and `check-discovery-refusal` all clean; `npm pack
  --dry-run` 21 files; `smoke-nudge` **16/16 in 18 s** (the sound seam, which is what this batch
  changed — its log line `knock → afplay Submarine.aiff` is the seam being exercised) and
  `smoke-lifecycle` **19/19 in 23 s** (the state-dir gate, S4 and S4b green, and its S3 re-confirmed
  Roy's live jam on :7777 untouched). Not re-run, and judged unaffected: the other seventeen. Nothing
  in the frame pipeline, the WS admission path, transfers, invites, discovery's parser, adoption or
  the peer executor was touched — the diff is one pure function extracted, four prototype-key guards,
  two new check scripts and CI. Prove: the full sweep at the next release gate.

- 2026-08-30 · **0.23.3: a Linux HOST is still unproven, and the CI leg does not change that.**
  Said as its own entry so it cannot be read out of the rows above. `ubuntu-latest` runs pure
  functions and three real-entry-point checks that all exit before tmux is reached. The one attempt
  at more — `smoke-lifecycle` in a container — got 6 of 19 steps and is written up above: a jam
  *partly* came up on Linux (a daemon answered `/health`, two jams listed `live`, the state-dir gate
  refused correctly at the launcher level) and the parts needing a pane process and a pty did not.
  Nobody has pressed F3, seen a `capture-pane` frame or watched an injection land on Linux.
  Prove: the triage in the entry above, and then one person hosting a real jam on a real Linux box
  and joining it from a mac.

  **0.23.4, 2026-08-30 — NARROWED, not closed.** The triage above is done and `smoke-lifecycle` is
  **19/19 on Linux** (Debian bookworm container, `--init`, non-root, tmux 3.3a, node 22.23.2). So
  three of the four things this entry says nobody has done ARE now done on Linux, by that suite: F3
  has been pressed on a real pty (step 7 attaches, sends `F3`, and the client detaches without
  killing the session), a `capture-pane` frame has been rendered — the mirror is how steps 5 and 6
  find the stub's `fake claude` at all — and a real host client has attached over `--attach` and run
  `/quit` and `/end`. **Still not done on Linux:** an INJECTION landing in the pane (this suite never
  injects — see its header), a real `claude`, and sound on a desktop. And it is a container, not a
  Linux desktop and not the GitHub runner. Prove, reduced to: one person hosting a real jam with a
  real `claude` on a real Linux box, typing into it from a mac.

- 2026-08-30 · **0.23.3: the Linux sound resolution on a HEADLESS box, measured — and it is
  `null`.** All three kinds resolve to no sound in a Debian bookworm container, because there is no
  `/usr/share/sounds` directory at all (checked: the path does not exist). That is the correct
  answer and the one `playSound` turns into `false` without spawning anything, so it confirms the
  "nothing installed → silence" branch against a real box rather than a stubbed `exists`. It also
  means the `ubuntu-latest` leg's printed sound line will read `[["knock",null],…]` and that is not
  a failure. What it does NOT do is exercise `paplay`/`aplay` at all — that still needs a Linux
  desktop with the freedesktop theme, and so does "the three are distinguishable by ear".

### v0.32 W1 — the Windows client (2026-08-30)

Nine deferrals in one batch, and they are large. Roy has no Windows machine, so the entire client
was written and tested without one; CI on `windows-latest` closes the parts a program can decide
and closes **nothing** that a person has to see, hear or type. Each entry names the experiment.

The first one is the umbrella, and no row of `docs/COMPATIBILITY.md` may be upgraded past it.

- 2026-08-30 · **W1: the state dir's ACL keeps SYSTEM and Administrators, and the split call is
  unmeasured.** The first Windows CI run measured what `icacls <dir> /inheritance:r /grant:r
  <user>:(OI)(CI)F` actually leaves on a directory: exit 0, and three principals — the owner,
  `NT AUTHORITY\SYSTEM`, `BUILTIN\Administrators` — none carrying the `(I)` inherited marker, with
  a second uncached apply changing nothing. A FILE reduces to one entry; a directory does not. Not
  an exposure (both extra principals read anything on the machine regardless, no wider principal
  appears, and with no Windows host there is no state dir on Windows today), so the test asserts
  the true guarantee and the docs say it. What is NOT known is whether **splitting** the call —
  `icacls <dir> /inheritance:r`, then a separate `icacls <dir> /grant:r <user>:(OI)(CI)F` — would
  reduce it to one entry, i.e. whether this is Windows' behaviour or this call's shape. Not probed
  from `test.mjs` on purpose: platform binaries belong to `platform.mjs`. Prove: one CI run of the
  two-call form on a scratch directory, printed and not asserted, the way the sound-mode line is.
- 2026-08-30 · **W1, THE BIG ONE: no human has ever run the Windows client.** Not once, not
  partially. It has never been installed on Windows, never started, never joined a jam. Everything
  claimed about it is either a unit test on a `windows-latest` runner or a reading of Microsoft's
  documentation. Prove: one person, one Windows 11 machine, Windows Terminal, `npm i -g
  claude-jam`, then `claude-jam join <invite-link>` against a mac host — and report what happened
  including what looked wrong. That single run discharges or refutes most of what follows.
- 2026-08-30 · **W1: no key has been pressed in Windows Terminal.** The decoder is asserted against
  the xterm-compatible sequences WT is *documented* to send (F2 as SS3 `\x1bOQ`, PgUp/PgDn
  `\x1b[5~`/`\x1b[6~`, Shift+arrows `\x1b[1;2A/B`, Ctrl+arrows, Home/End, CSI-u). Nobody has seen
  the bytes. Prove: run `node -e "process.stdin.setRawMode(true);process.stdin.on('data',d=>console.log(JSON.stringify(d.toString())))"`
  in Windows Terminal, press each key once, and paste the capture into a fixture — the same
  discipline `fixtures/pane/` already has for `capture-pane`.
- 2026-08-30 · **W1: Shift+Enter is documented, not delivered.** WT's default Shift+Enter is a bare
  CR, indistinguishable from Enter, so the docs offer `\` at end of line and a `sendInput` binding
  to `\\u001b[13;2u` in `settings.json`. The binding recipe has never been applied to a real
  `settings.json`. Prove: apply it, press the key, see a newline in the input field.
- 2026-08-30 · **W1: no toast has been seen.** `notify()` on Windows spawns a PowerShell script
  that tries BurntToast and falls back to the WinRT `ToastText02` notifier under PowerShell's own
  AppId. Unit tests cover the argv and that title and body are never inside the script; whether a
  toast APPEARS is untested, and the AppId trick is the part most likely to be wrong. Prove: knock
  on a jam from a Windows client and watch the notification centre — with BurntToast installed and
  again without it, because those are two different code paths.
- 2026-08-30 · **W1: no sound has been heard, and the `%WINDIR%\Media` file list is a guess.**
  `WIN_MEDIA_SOUNDS` names three candidates per kind from what Windows has historically shipped.
  The CI test resolves them against a real runner's `%WINDIR%\Media` and PRINTS which branch each
  kind took (`# v0.32 W1 sound modes on <release>: {...}`) rather than asserting a branch, because
  falling back to the beep is a correct answer. Prove: read that line from the first Windows CI
  run, and separately have a person hear a knock and a join and confirm they are distinguishable.
- 2026-08-30 · **W1: `/paste` has never moved a real image on Windows.** The CI test proves the
  whole FAILURE path (powershell.exe found, the script parsed and ran, "no image on the clipboard"
  surfaced, the temp directory removed) because a CI runner's clipboard is empty. The success path
  — `Get-Clipboard -Format Image` returning a bitmap and `$img.Save(...)` writing a PNG — is unrun.
  Prove: copy a screenshot on Windows, `/paste` into a jam, and check the host's `jam-uploads/`.
- 2026-08-30 · **W1: the ACL is verified only by a test nobody has watched pass.** The Windows-only
  test writes a real file with `secureWrite`, runs the real `icacls`, and asserts the grant list is
  exactly the current user — but `parseIcaclsPrincipals` was written to the documented output shape,
  never seen beside a real console, and the `/inheritance:r /grant:r` ordering within one icacls
  invocation is assumed. Prove: the first green Windows CI run. **If that test is red, the ACL is
  not being applied and `docs/COMPATIBILITY.md`'s "private files" row must go back to unverified**
  — a failure there is a security fact, not a test nit.
- 2026-08-30 · **W1: `npm i -g claude-jam` has never been run on Windows** — nor anywhere else, and
  the package has never been published. `npm pack --dry-run` (both CI legs) shows the tarball holds
  every module a client imports, which is not the same as a shim that works. Prove: publish, or
  `npm i -g ./claude-jam-<v>.tgz` on a Windows machine, then run `claude-jam` and `claude-jam join`.
- ~~2026-08-30 · **`claude-jam adopt` is BROKEN on tmux 3.3a, and the message blames the wrong thing.**
  `PANE_SEP` is U+0001; tmux 3.3a replaces it with `_` in `display-message -p` output where 3.7c
  passes it through, so `parsePaneInfo` sees 1 field of 8 and `cmdAdopt` prints `no tmux pane %0 on
  socket <s>` for a pane that exists. Measured both ways on 2026-08-30 (3.7c → 8 of 8, 3.3a → 1 of
  8), which is also why `smoke-adopt` is 13-red at `HEAD` in a Debian bookworm container. Every
  Debian/Ubuntu box with the packaged tmux is affected, not just the suite. Fix: a separator tmux
  does not rewrite (or one `display-message` per field), a unit test over `parsePaneInfo` fed real
  3.3a output, and `smoke-adopt` green on Linux — then it can join the CI leg. Prove: that suite
  green in the container, and `claude-jam adopt` by hand on tmux 3.3a.~~
  **DISCHARGED — 0.23.5, 2026-08-30. The fix is one `display-message -p` PER FIELD, and the reason
  it is not a cleverer separator is a measurement rather than a preference.** The same probe on both
  versions asked for the eight fields in one call three times over, joined by U+0001, by a newline
  and by a tab. tmux 3.3a came back with `%0_620_node_/home/runner/claude-jam_jamfx605_0_0_claude`
  for **all three** — it filters every non-printable byte out of `display-message -p` output and
  writes `_` — where 3.7c passed all three through. So "one field per line" loses on 3.3a exactly as
  U+0001 does, and the per-field read is the only shape with no separator to rewrite. It also
  survives a VALUE that contains a newline, which no separator can. Cost: 7.0 ms against 1.2 ms on
  3.3a (mean of 5), once per adoption.
  Both captures are committed as `fixtures/pane/display-message-tmux-3.3a.json` and
  `-3.7c.json` — the eight raw per-field stdouts, the parse they must produce, and the three broken
  `joined` forms — and two unit tests read them, so a future change cannot regress one tmux version
  while passing on the other. Canaried both ways 2026-08-30: joining the queries back into one
  format string reds the shape test; putting the old joined-string parse back reds the fixture test
  with `3.3a: per-field parse`.
  **Proved, not predicted, in the Debian bookworm container (tmux 3.3a, node 22.23.2, `--init`,
  non-root):** `smoke-adopt` **6 FAIL + 7 BLOCKED at `HEAD` → 16/16 in 8 s** after, and 16/16 again
  with `CI=true`; on macOS/tmux 3.7c 16/16 both ways. S12 is the load-bearing one — a session on the
  container's DEFAULT tmux socket, adopted and released with the pane's pid unchanged. And by hand
  on 3.3a, which is what the deferral asked for: `claude-jam adopt --pane %0 --socket <s>` now prints
  `pane %0 (handadopt1864:0.0 "claude") / running node (pane pid 1874) / directory /home/runner` —
  all eight fields — where it printed `no tmux pane %0 on socket <s>` before.
  **Still not done:** `smoke-adopt` is not wired to the Linux CI leg. It is now a candidate (that
  was the blocker this entry named), but wiring it is a gate-policy decision, and Roy's.
- 2026-08-30 · **`smoke-transport` and `smoke-replay` have the unguarded-setup shape** — the sibling
  of the cascade, found while checking the other eighteen suites for it, recorded rather than fixed
  because both need restructuring rather than a declaration. `smoke-transport`: no top-level
  `try`/`catch`/`finally` at all, T2 reuses T1's port 7811, and a throw from `daemon()` (104, 162,
  287) skips every remaining T-group with no PASS/FAIL for them and skips the `daemons` cleanup at
  371, leaking a child and a state dir. `smoke-replay`: `PANE_SESSION` (164) and the main daemon
  (168) are built before the guarding `try` (174), and a second daemon block (374-406) runs after
  that `try`'s `finally` has closed. Fix: the same `try`/`catch` + per-step `cleans` treatment the
  other two got. Prove: break each one's first daemon on purpose and read the RESULT line.
- ~~2026-08-30 · **`host.mjs` needs `curl` on `PATH` to start** (`waitForHealth()` shells out to it).
  A slim container without curl reports `daemon did not come up` six times while the daemon is up
  and listening — measured. macOS, `ubuntu-latest` and Debian-with-curl are all fine, so this is a
  portability nit, not a live bug: node's own `fetch` would remove the dependency. Prove: replace
  the `spawnSync('curl'…)` poll with `fetch` and re-run `smoke-lifecycle` on both platforms.~~
  **DISCHARGED — 0.23.5, 2026-08-30.** `waitForHealth()` is node 22's global `fetch`, and the two
  `spawnSync`es (`curl`, and a `sleep` for the retry gap) are gone with it. The timing is unchanged
  on purpose: a 10 s total deadline, `AbortSignal.timeout(1000)` per attempt where curl had `-m 1`,
  300 ms between attempts. `connection: close` is on the request because undici would otherwise hold
  a keep-alive socket and delay the launcher's own exit.
  Measured on the same curl-less Debian bookworm container, before and after, with `smoke-lifecycle`:
  **`HEAD` = 6 FAIL + 9 BLOCKED with `daemon did not come up` printed exactly 6 times, in 69 s →
  19/19 in 22 s** after, and 19/19 again with `CI=true`. macOS (which has curl, so this half is the
  no-regression check) 19/19 both ways.
  **The failure path was measured too, rather than reasoned about**, because a health check that
  reports a fetch stack trace would be worse than the shell-out: a jam launched on a port already
  held by another listener, on the curl-less box, exits **1** after **10.54 s** with the same single
  line `daemon did not come up; check the tmux daemon window` and **zero** stack-trace frames.
  **Two `curl` shell-outs are left, both deliberately out of scope for that batch** and neither on
  this code path. (1) `hooks.sh` line 85 — the `stop`/`notification` hooks POST to the daemon with
  `curl … || true`, so on a box with no curl a jam runs but every stop/notification hook is silently
  dropped (no idle signal, no turn-finished nudge). It is the bigger of the two, because it is
  runtime rather than launch and it fails **silently**; the fix is cheap — the same file's
  `SessionStart` branch already runs node, and `JAM_NODE` is exported into the hook environment for
  exactly this reason. (2) `scripts/smoke-perm.mjs` line 108 polls `/health` through `curl` in the
  harness. Prove: a jam hosted on a curl-less box, `/who` showing a participant going idle.
- 2026-08-30 · **W1: `smoke-ink` and `smoke-xfer` were not re-run for this batch.** Both need a
  daemon with a real `claude` and spend tokens, and this batch was told not to. What did run:
  `smoke-nudge` 16/16 (the platform seam's sounds through stub binaries, real clients, the whole
  upload ladder) and `smoke-scroll` 13/13 (a REAL ink client on a REAL pty as a guest — the thing
  most at risk from a new gate in `client.mjs`), plus a hand check of `clipboardImage()` on macOS
  both ways (a real PNG on the clipboard round-tripped; an empty clipboard refused with
  `no image on the clipboard (…)`; no temp directory left behind). The macOS `/paste` code path
  moved (`clipboardPngMac()` was extracted so both platforms share one tail), which is what
  `smoke-xfer` step "a clipboard PNG round-trips" covers. Prove: `smoke-ink` + `smoke-xfer` at the
  next release gate.
- 2026-08-30 · **0.23.5: seventeen of the nineteen suites were not re-run.** What ran, on BOTH
  platforms and both with and without `CI=true`: the unit suite (**459 tests, 456 pass, 3 skipped,
  0 fail**), `smoke-adopt` (the suite that owns the changed read path — 16/16 on macOS/3.7c and
  16/16 in the 3.3a container) and `smoke-lifecycle` (the suite that launches real jams through
  `waitForHealth` — 19/19 on both). The judgement: the diff is one pure function's INPUT SHAPE
  (`parsePaneInfo` takes an array of per-field stdouts instead of one joined string), its one caller
  in `sessions.mjs`, and the health poll in `host.mjs`. Nothing in the frame pipeline, the WS
  admission path, the trust boundary, transfers, invites, discovery, the peer executor or either
  client was touched, and every jam any suite starts goes through `waitForHealth`, so a regression
  there would have shown as a dead suite rather than a subtle one. Prove: the full sweep at the
  release gate.

- 2026-08-30 · **0.23.6 (the hook-delivery fix): eighteen of the nineteen suites were not re-run.**
  What ran, on macOS, with and without `CI=true`: the unit suite (**462 tests, 459 pass, 3 skipped,
  0 fail**), the new `scripts/check-hook-post.mjs` (5/5), and the other three `check-*.mjs`. The
  judgement: the diff is `hooks.sh`'s stop/notification branch, one new pure function
  (`hookErrorNote`), one new 5 s poll in `daemon()`, and a `curl` → `fetch` swap in
  `smoke-perm`'s own health wait. Nothing in the frame pipeline, the WS admission path, the trust
  boundary, transfers, invites, discovery or either client was touched.
  **What the new check does NOT cover, and it is the honest gap**: no suite drives a REAL claude
  through a real turn against the new hook, so "a turn ends and `busy` clears" is still carried by
  `smoke.mjs` and `smoke-perm`, neither of which was re-run (both cost tokens). The pieces are each
  measured — the POST arrives at `/hook/stop` with the right secret and the exact payload, and
  `onHook` is unchanged — but the seam between them is not. Prove: `smoke.mjs` and `smoke-perm` at
  the next release gate; a red there would show as a turn that never stops being busy.
  Also not covered: the marker file is only ever read by `startHookWatch`'s 5 s poll, so a jam whose
  daemon dies before the poll never prints the line. That is deliberate (the daemon is the only
  reader there can be), and the file is still on disk for whoever looks.

## The 2026-08-30 vacuity audit — every suite, for tests that cannot fail

Ordered by the 0.22.1 review after `smoke-nudge` was found printing **"all steps passed" having
run none of its steps**, through every release gate including the 0.22.0 one. A suite that cannot
fail is worse than a missing suite: it buys false confidence at every gate. So all eighteen were
swept for the class, statically and by running them and counting what they actually printed.

**One class was real, and it was structural.** Seven of the eighteen wrap their whole body in
`try { … } finally { … process.exit(failed ? 1 : 0) }` with **no `catch`**. An exception anywhere
between steps — a setup gate, a fixture, a teardown — is swallowed by the `finally`, whose exit sees
`failed === 0` and reports success. `smoke-nudge` was the one where it had actually fired; the other
six were sound in practice and one string-drift away from the same silence.

| suite | verdict |
| --- | --- |
| `smoke-nudge` | **WAS VACUOUS — repaired.** Setup waited for `host Roy` in the host client's pane; that moved behind F2 when the ink client began opening on the live TUI (`grep -c "host Roy"` over 400 rows of a real client: **0**). Threw every run, reported green, ran 0 of 16 steps. Verified pre-existing against `git archive v0.22.0`. Also step 6c navigated `/menu` by counting four Downs, and v0.29 inserted a section in front of the target. Fixed: a `catch`, a gate on the roster line that IS on screen, and navigation by row name off the `Select`'s own `❯`. Now 16/16 in 18 s. |
| `smoke.mjs` | **WAS VACUOUS (partly) — repaired.** It PRINTS five checks and exited on **two** of them, so it could print `agent event : MISSING` and `status busy:false: MISSING` and still exit **0** — and `results.tsv` is exit-code driven, so a regression in either path passed the gate in silence. Every check it prints now decides the exit, and a failing one is named on a `FAILING CHECKS` line. `sysprompt` stays non-fatal, for the reason already in the code. |
| `smoke-adopt`, `smoke-ink`, `smoke-invite`, `smoke-lifecycle`, `smoke-perm`, `smoke-replay` | **LATENTLY VACUOUS — repaired.** Same missing `catch`; each verified to really run its steps (`smoke-invite` 15, `smoke-replay` 17, `smoke-adopt` 16, `smoke-lifecycle` 17 PASS lines), so nothing was being hidden today. A `catch` added to each. |
| `smoke-answer`, `smoke-discover`, `smoke-peer`, `smoke-scroll` | **SOUND.** Top-level `catch` already present. (`smoke-answer` had the other shape — one assertion was `ok(… \|\| … \|\| true)`, a tautology that can never fail; repaired in the same release.) |
| `smoke-knock`, `smoke-mirror`, `smoke-popup`, `smoke-slash`, `smoke-transport`, `smoke-xfer` | **SOUND.** No top-level `try` at all, so an exception between steps crashes with a stack and a non-zero exit — the failure mode this audit exists to prevent cannot occur. |

**The other axes, checked and clean.**

- *Tautological assertions.* One, in `smoke-answer` step 9 (`ok(… || … || true)`), already repaired.
  A sweep for `|| true`, `ok(true`, `!== false`, and `=== true` over all eighteen found nothing else
  (`f.waiting === true` in `smoke-perm` is a deliberate strict comparison, not a tautology).
- *Assertion-free steps.* A scan for step bodies with no assertion helper returned 13 candidates,
  every one a false positive: they assert through `want` / `wantFrom` / `wantClose` / `none` /
  `never`, which throw on timeout.
- *Unconditional PASS.* `PASS` is printed only inside each suite's `step()` helper, after `await
  fn()` returned — correct in all eighteen. Every `all steps passed` line is `failed ? … : …`, so
  with the `catch` in place the wording now follows the truth.
- *Positional navigation.* One instance, `smoke-nudge`'s counted Downs, repaired. No other suite
  navigates a list by count.
- *Step counts vs. what runs.* `await step(` calls match the PASS lines in every suite that was run
  (`smoke-scroll` is 12 calls / 13 steps because one runs for two roles — correct).
- *Swallowed awaits.* Every `.catch(() => {})` / `catch { }` outside teardown was read; all are
  best-effort `fs.rmSync` cleanups or a `fetch` whose result is then asserted.

## The cascade — a red RESULT line that overstated by 8× (0.23.4, 2026-08-30)

The sequel to the vacuity audit above, and the same principle from the other end: a suite may not
report a pass it did not earn, **and it may not report four failures for one broken thing.** A number
that overstates by 8× stops being read at all, and the next real multi-failure gets waved off.

**The defect.** `smoke-lifecycle`'s steps share fixtures — the jam S2 launches is read by five later
steps, and eight steps launch a jam under a name an earlier step used. A failing step left its
`jamlife` session and its state dir behind, so the next `launch` of that name failed with
`tmux session "jamlife" is already a jam` — a true sentence about a false situation. Worse: two of
the reads happened BETWEEN steps (`main = JSON.parse(readFileSync(…session.json))` at what was line
399), where the only handler was the outer `catch`, so one missing fixture could end the run with
thirteen steps never run and nothing in the RESULT line saying so.

**The fix, in two halves, and neither of them is a sweep.** A step now declares:

- `cleans` — the exact sessions and ports **it** created, torn down when it fails, so its successors
  meet the world they would have met anyway. Exact quoted names only (`killMine` still enforces the
  `jamlife`/`jamadopt` prefix, and a jam is ended by the name its own `session.json` records — never
  the adopted session, and never a pattern).
- `needs` — the ids of the steps whose fixtures it reads. If one of those failed, the step is
  **BLOCKED**, printed with the id that blocked it, and counted apart from FAILED in the RESULT line.
  A blocked run is still non-zero: it proved nothing.

Plus the between-steps reads moved inside the steps that need them, S2b's marker swap-back moved into
a `finally` (it borrows a fixture it does not own), and the closing decoy check learned that if S1 or
S2 failed there may be no decoy to still be standing — which is not this step killing one.

**Measured, both suites, by breaking one step on purpose** (`git show HEAD:` copy versus the patched
one, same injected throw, same machine, macOS):

| canary | before | after |
| --- | --- | --- |
| `smoke-lifecycle`, step 2 dies *after* it was handed a jam (so the jam is left behind) | **8 FAILED**, 42 s | **1 FAILED**, 23 s |
| `smoke-lifecycle`, S2 dies *before* it builds the shared jam | **3 FAILED and 6 of 19 steps ran** — the between-steps read threw, so thirteen steps silently never ran, 2 s | **1 FAILED · 5 BLOCKED**, all thirteen others ran and passed, 19 s |
| `smoke-adopt`, S6 dies before it adopts anything | **8 FAILED**, 46 s | **1 FAILED · 7 BLOCKED**, 6 s |

And once on a real failure rather than an injected one: the same Debian container **without `curl`**
(see the `--attach` section) gave `smoke-lifecycle` **6 FAILED · 9 BLOCKED**, where every one of the
six says the same true thing (`daemon did not come up`) instead of five of them lying about a session
name. `smoke-adopt` in that container went from **13 FAILED in 42 s** at `HEAD` to **6 FAILED · 7
BLOCKED in 6 s** — the 20× speed-up is the blocked steps not burning 40-second timeouts on fixtures
that were never built.

**Which suites have this shape — checked, not assumed.** All eighteen others were read for two
questions: does a step create a durable named resource a later step needs (present or absent), and is
there any per-step teardown at all?

| suite | verdict |
| --- | --- |
| `smoke-lifecycle` | **HAD IT, FIXED.** Nineteen steps, thirteen resource creations, teardown only in the final `finally`. |
| `smoke-adopt` | **HAD IT, FIXED.** S6 builds the pane and daemon that S6b, S7, S7b, S7c, S8, S9 and S11 all read; no per-step teardown. Same treatment. |
| `smoke-transport` | **HAS A DIFFERENT ONE — recorded, not fixed** (Deferred). No top-level `try`/`catch`/`finally` anywhere in the file, and T2 reuses T1's port 7811 with only an in-step `d.stop()` between them: a throw from `daemon()` (lines 104, 162, 287) skips every remaining T-group with no PASS/FAIL for them and skips the `for (const d of daemons) await d.stop()` cleanup, leaking a child and its state dir. |
| `smoke-replay` | **HAS A DIFFERENT ONE — recorded, not fixed** (Deferred). `PANE_SESSION` (164) and the main daemon (168) are built BEFORE the guarding `try` (174), and a second daemon block (374–406) runs after that `try`'s `finally` has already closed. |
| `smoke-answer`, `smoke-discover`, `smoke-ink`, `smoke-invite`, `smoke-knock`, `smoke-mirror`, `smoke-nudge`, `smoke-peer`, `smoke-perm`, `smoke-popup`, `smoke-scroll`, `smoke-slash`, `smoke-view`, `smoke-xfer`, `smoke.mjs` | **NOT THIS SHAPE.** Each either drives a daemon it was handed on argv (so it owns no fixture at all) or builds its one shared daemon/session inside the same `try` that guards every step, and re-creates nothing a later step needs. |
| `check-state-privacy`, `check-discovery-refusal`, `check-terminal-gate` | **NOT THIS SHAPE, and the first two are the model:** every check builds its own `mkdtemp` dir and its own port, tears it down in its own `finally`, and reports PASS / FAIL / **NOT EXERCISED** as three different answers. |

### `running()` and the zombie — decided: FIXED, in all four suites that ask

`ps -p <pid>` **succeeds for a zombie**, and so does `process.kill(pid, 0)`. Every liveness check in
`scripts/` is used one of exactly two ways — "it was running before this" and "it has exited now" —
and a zombie (exited, unreaped, holding nothing but a pid entry) is not running by either. So the
question "should `running()` distinguish a zombie" has one answer, and it is not a container-only
one: the check was wrong on every platform, and the container just made it visible (13 false reds).

Fixed by reading the state column, which is the only thing that says `Z`: `ps -o stat= -p <pid>`,
BSD and GNU both, `Z`-prefixed for a zombie. `smoke-lifecycle` and `smoke-adopt` asked with bare
`ps -p`; `smoke-peer` (`alive`, three "the child is gone" assertions) and `smoke-view` (`running`,
"the daemon's ttyd outlived the jam") asked with `process.kill(pid, 0)` and keep that as the cheap
first question, asking `ps` only when it says yes.

Measured on macOS: a python parent that never reaps its child gives `ps -p <pid>` exit **0** and
`ps -o stat= -p <pid>` → **`Z`**. Canaried the other way too — reverting `smoke-view`'s helper alone
reds the new lint with `smoke-view.mjs: kill(pid, 0) succeeds on a zombie`.

**It fails closed without `ps`.** Measured in the container before `procps` was installed: `spawnSync`
returns `status: null, error: ENOENT`, so `running()` answers *not running* — which turns the "it was
running to begin with" assertions red rather than quietly passing the "it has exited" ones. A box
with no `ps` therefore gets a loud wrong answer, not a silent right-looking one.

The lint that keeps it: **`0.23.4 no smoke suite reports a ZOMBIE as a running process`** in
`test.mjs` — no file in `scripts/` may contain bare `ps -p` or `process.kill(pid, 0); return true`,
every file with a `(running|alive) = (pid)` helper must read `-o stat=` and test for `Z`, and the
count of such files is pinned at four so a rename cannot turn the lint into a no-op.

### What ran for this batch, and what did not

| suite | macOS | macOS `CI=true` | Debian bookworm, tmux 3.3a, node 22.23.2, `--init`, non-root | that, `CI=true` |
| --- | --- | --- | --- | --- |
| unit (`node --test test.mjs`) | **458 tests, 455 pass, 3 skipped, 0 fail** | — | **same, byte-identical counts** | — |
| `smoke-lifecycle` | **19/19, 23 s** | **19/19, 23 s** | **19/19, 22 s** | **19/19, 21 s** |
| `smoke-adopt` | **16/16, 9 s** | **16/16, 10 s** | 6 FAILED · 7 BLOCKED — **pre-existing, and NOT this batch's**: `HEAD` gives 13 FAILED in the same container. Root cause found, see below | same |
| `smoke-peer` | **16/16** | — | **16/16 ("all steps passed")** | — |
| `smoke-view` | **6/6** | — | **SKIP** — `there is no ttyd on this machine, and this smoke is about ttyd`, exit 0, which is the suite saying so honestly | — |

**Not re-run, and judged unaffected:** the other fourteen suites. The diff is confined to two smoke
harnesses' step plumbing, two one-line liveness helpers, one new unit lint and one CI step; no
product file was touched at all (`git diff --stat` for this batch: `scripts/smoke-lifecycle.mjs`,
`scripts/smoke-adopt.mjs`, `scripts/smoke-peer.mjs`, `scripts/smoke-view.mjs`, `test.mjs`,
`.github/workflows/tests.yml`, `TESTING.md`, `CHANGELOG.md`, `package.json`). Six of the fourteen
need a real `claude` and spend tokens, and this batch was told not to. Prove: the full sweep at the
next release gate.

### The Linux finding this batch did not go looking for: `claude-jam adopt` is broken on tmux 3.3a

Running `smoke-adopt` on Linux for the first time (it is not in the CI leg, and nobody had) found it
**13-red at `HEAD`** with `no tmux pane %0 on socket jamadoptsock` — for a pane that demonstrably
exists. It is not the smoke and it is not the container. `PANE_SEP` is **U+0001**, and **tmux 3.3a
replaces it with `_` in `display-message -p` output** where tmux 3.7c passes it through, so
`parsePaneInfo` sees one field instead of eight and `cmdAdopt` reports the pane as missing.
Measured, same node script on both:

- tmux 3.7c (macOS): `"%062996sleep…"` → **8 of 8 fields**
- tmux 3.3a (Debian bookworm): `"%0_7484_sleep_/_psep_0_0_sleep"` → **1 of 8**

So `claude-jam adopt` fails on Debian bookworm's packaged tmux for every user, not just for the
suite, and the failure message points at the pane rather than at the separator. **Not fixed here** —
it is a product change in `lib.mjs` with its own unit and smoke surface, and it is not what this
batch was for. In Deferred, and flagged to Roy.

**Fixed in 0.23.5**, by reading one field per call rather than by picking a better separator: 3.3a
rewrites a newline and a tab exactly as it rewrites U+0001, which was measured before choosing. The
before/after numbers, the canaries and the two committed captures are in that Deferred entry.

## The 2026-08-30 campaign

The end-game campaign of the section above, run overnight on 2026-08-30. Node 24.15 / tmux 3.7c /
claude 2.1.251 / ttyd 1.7.7 / cloudflared 2026.8.2, from a verified-clean machine state (no live
tmux server on any socket, no jam daemon anywhere).

### What it found

- **A guest on the far side of `--tunnel` was the host.** The whole `trusted()` gate — F3 raw
  keys, `/end`, `/kick`, `/invite`, `/remote`, `/announce`, `/grants`, the browser view — plus
  `host: true` itself rested on the socket's address, and every relay proxies to loopback. A
  stranger with only the public URL and **no token** was admitted as host, handed the join token,
  typed into the real pane and ended the jam. Fixed: `localSocket()` in `lib.mjs`, applied to the
  WS admission path and all six loopback-gated HTTP endpoints, with five unit tests. Verified
  after the fix: the stranger knocks, a token-holding relay guest is still an ordinary guest, and
  the host's own loopback client is unchanged.

- **F1's fix was a blocklist, and v0.34 replaced it with proof.** The header test above holds for
  cloudflared, which was measured — but it enumerates what a relay looks like, so the next relay
  that proxies to `127.0.0.1` without a header on that list re-opens the hole silently. v0.34
  makes host authority a `0600` file in the `0700` state dir that only a local process can read,
  with the header test kept as a second, independent condition. Canary (2026-08-30, run twice):
  breaking `hostKeyMatches` turned **8** `smoke-knock` steps red including "loopback host hello is
  welcomed", and 5 unit tests; removing `--host-key-file` from the launcher's own client turned
  `smoke-lifecycle` steps 5 and 6 red ("the attached client did not join as the HOST", then a
  demoted host unable to `/end`) and the "every surface … hands it the key file" lint. Restored,
  both suites green again.

### Deferrals this campaign closes, and the ones it opens

Struck-through entries above are discharged. New ones are appended above in date order.
