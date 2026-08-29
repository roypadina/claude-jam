# AGENTS.md — working **on** claude-jam

For an agent changing this repository. If you were sent here to *install and run* the tool
instead, the page you want is the wiki's
[Agent-Install](https://github.com/roypadina/claude-jam/wiki/Agent-Install).

Read this whole file before the first edit. It is short on purpose.

---

## 0. The rules that are not negotiable

Breaking one of these destroys somebody else's live work, and no test can undo it.

1. **Never `tmux kill-server`.** Not to clean up, not to recover, not "just this once". Other
   people's sessions live on this machine.
2. **Never kill a process by name or pattern** — no `pkill`, no `killall`, no
   `kill $(pgrep …)`, no filtered sweep over a process list. Kill only a PID your own run
   spawned, by PID.
3. **Only ever kill a tmux session you created, by exact name, on your own socket.** Always
   `-t =name` (the `=` is tmux's exact-match prefix; a bare `-t jam` prefix-matches `jamboree`).
   The same rule holds for `git worktree remove`: an exact path your run created, never a
   filtered list.
4. **A live jam may be running on this machine right now** — typically the Homebrew install on
   the **default** tmux socket, session `jam`, port 7777. It is mid-task and it is not yours.
   Read it if you must; never write to it, attach to it, or end it. Every smoke that touches it
   does so read-only and says so in its own output.
5. **Never push, amend, force or rebase the code repository.** Commit on `main` and stop.
   Releases are a human's call. (The *wiki* repo is the one exception, and only when the human
   asked for the wiki.)
6. **Do not create anything net-new outside the repo** — no new remote branch, tag, package,
   release or repository — without being asked for that specific thing.

---

## 1. Layout

| file | what it is |
| --- | --- |
| `claude-jam` | the launcher (bash). Owns the usage text; `host`/`adopt`/`join`/`sessions`/`end`/`clean`/`invite`/`invites`/`remote` dispatch from here. No arguments → `menu.mjs`. |
| `jam` | a deprecated four-line alias that execs `claude-jam`. Never printed, never extended. |
| `lib.mjs` | **pure functions only.** No fs, no spawn, no network, no clock it did not receive. Nearly every test is against this file. If a decision can be made here, it is made here. |
| `host.mjs` | the launcher's other half (builds the tmux session) **and** the daemon (WS server, frame pipeline, injection, hooks endpoint, relays). |
| `sessions.mjs` | tmux + fs lifecycle: list, end, clean, invite, remote, **adopt**. The only caller of `kill-session`. Imported by `host.mjs`, so there is exactly one "end". v0.33: `adopt` is the one place that talks to a tmux server jam does not own, and every call it makes there is a read. |
| `client.mjs` | the guest/host entry point; validates argv and hands off. |
| `client-ink.mjs` | the real client (ink). `client-basic.mjs` is the `--basic` readline fallback. |
| `menu.mjs` | the no-argument launcher menu. **Builds argv and shells into `claude-jam <subcommand>`** — it never re-implements one. |
| `xfer.mjs` | file transfer, both directions. Pure fs; spawns nothing. |
| `platform.mjs` | the platform seam. The **only** module allowed to spawn a platform binary (`osascript`, `pngpaste`, `afplay`, `pbcopy`, `open`, …) or to decide where `$TMPDIR`/`~/.config` are. |
| `popup.mjs` | the one-key `tmux display-popup` approval. |
| `hooks.sh` | the Claude Code hooks the daemon generates a `settings.json` for. |
| `peer.mjs` | v0.29: running ONE peer task on this machine — the scratch dir, the generated settings, the spawn, the caps and the killing. Imported by both clients so there is one place a peer task is built and stopped. |
| `test.mjs` | the unit suite. `scripts/` holds the eighteen end-to-end smokes and `fixtures/pane/` the real `capture-pane` corpus. |
| `integrations/claude-plugin/` | the OPTIONAL `/jam` Claude Code plugin: a command, a skill, a manifest. **No code** — everything it does, it does by running the `claude-jam` on `PATH`. `.claude-plugin/marketplace.json` at the repo root points at it; a test asserts the two manifests agree. |

**tmux, claude, git, curl, cloudflared, tailscale and ttyd are not platform binaries** — they are
the tool's dependencies, spelled the same everywhere, and they stay where they are used.

---

## 2. The tests

```sh
node --test test.mjs      # the whole unit suite; must be green before every commit
```

356 tests, all against pure functions, all fast (< 1 s). There is no watch mode and no
framework. Add tests to `test.mjs` next to the ones for the same version heading.

Two of them are lints rather than assertions about behaviour, and both exist because the thing
they check cannot be caught by running the program once:

- **no user-visible string emits a bare `jam ` command form** — the product is `claude-jam`
  everywhere a human or an agent reads. It scans string literals in every module in the repo
  root plus the launcher's `echo` lines.
- **no module outside `platform.mjs` spawns a platform binary** — the Windows seam only pays for
  itself if it is the only door. `dns-sd` and the avahi tools are in that list too (v0.23).

**`tmux`, `claude`, `git`, `curl`, `cloudflared`, `tailscale` and `ttyd` are NOT platform
binaries** and stay where they are used — see §1.

If you add a module to the repo root, both lints pick it up automatically. That is deliberate.

### The eighteen smokes, and the order

They are end-to-end and they are the only thing that proves the tmux/injection/WS half works.
The full recipe — driver session, ports, arguments — is in `SPEC.md` under **"Running the
end-to-end smokes"**; run it from there rather than from memory.

Six need a daemon of yours, and the order between them matters:

1. `smoke-ink.mjs` — **first, against a fresh daemon.** It asserts on what is on screen, and
   replayed history puts an older turn's collapsed-tool line there.
2. `smoke-xfer.mjs`
3. `smoke.mjs`
4. `smoke-mirror.mjs`
5. `smoke-popup.mjs`
6. `smoke-slash.mjs` — **last, and once per daemon.** It grants Guest a standing approval that
   lives in daemon memory, so a second run against the same daemon gets no request to answer.

Then, in any order, the ones that bring their own everything:

7. `smoke-knock.mjs` — needs a **knock-only** daemon (no `--token`).
8. `smoke-transport.mjs` — no arguments, own daemons on 7811/7813. Needs `cloudflared`. ~2 min.
9. `smoke-replay.mjs` — no arguments, own daemons on 7823/7825. Needs `git`. ~1 min.
10. `smoke-perm.mjs` — no arguments, own port 7831, but **needs a real claude** and costs a
    haiku turn. Runs the claude window with `--permission-mode manual`, because a machine whose
    `settings.json` says `bypassPermissions` never asks and there is no prompt to relay.
11. `smoke-lifecycle.mjs` — no arguments, own `$TMPDIR`, ports 7851/7853/7855, sessions
    `jamlife*`. ~20 s. Starts with the refusals, including a read-only proof about the live jam
    on :7777.
12. `smoke-invite.mjs` — no arguments, own `$TMPDIR`, port 7861, session `jaminvite`. ~10 s.
13. `smoke-answer.mjs` — no arguments, no real claude at all (the pane is
    `scripts/fake-tui.mjs`, painted with the real captures from `fixtures/pane/`). Own `$TMPDIR`,
    port 7871, session `jamanswer`. ~1 min, costs nothing.
14. `smoke-discover.mjs` — no arguments, no real claude. Own `$TMPDIR`, ports 7891/7893/7895,
    sessions `jamdisco*`. ~1 min, costs nothing. **It really does advertise on the local network
    while it runs** — that is the thing under test. Every registration is a child of a daemon it
    started, its teardown FAILS the run if anything is left advertising, and it needs
    `/usr/bin/dns-sd` (it skips cleanly when there is none). Step 9 counts the `dns-sd -R`
    processes for one port across a real re-announce, because a leaked advertisement is the one
    failure this project can inflict on somebody else's network.

15. `smoke-nudge.mjs` — no arguments, no real claude. Own `$TMPDIR` **and own cwd** (so
    `jam-uploads/` is the smoke's), port 7881, sessions `jamnudge*`. ~15 s, costs nothing. It
    proves the v0.25 sounds **through the platform seam**: each client gets a directory in front
    of its `PATH` holding a stub `afplay` and `osascript` that append to a log of that client's
    own, so "a knock and an auto-join are two different calls" and "only the addressed client was
    interrupted" are facts on disk. Also the nudge round trip and its refusals, idle in `/who`,
    the three notification tiers (including a real `/menu` keypress in a tmux pane), and the whole
    v0.27 upload policy including the caps that must not move and the quota fallback.

    Note for anyone writing a smoke that starts more than one jam: `tmuxSocketFor()` gives each
    jam a tmux server named for its **port**, so a session and its socket are a pair. Killing
    `=name` on the wrong socket silently does nothing and leaves the daemon running — which, in
    this smoke's case, leaves an advertisement on somebody's network. Ask for the socket by
    session name.

16. `smoke-scroll.mjs` — no arguments, no real claude. Own `$TMPDIR`, port 7901, sessions
    `jamscroll` and `jamscrollink`. ~90 s, costs nothing. The pane is a shell stub that prints
    400 numbered lines and then one `TICK` per change of a control file, so "the screen moved" is
    something the smoke decides rather than waits for — which is what makes the held-frame count
    assertable. It runs a REAL ink client on a real pty as a GUEST, and compares what that guest
    sees, scrolled back, against `capture-pane -S` on the host pane row for row. Its last step
    kills that client while the mirror is up and watches tmux's `#{alternate_on}` go 1 → 0 — by
    the exact pid of a process this smoke started, found by parent pid, never by name.

17. `smoke-adopt.mjs` — no arguments, no real claude. Own `$TMPDIR`, own **`$HOME`** (so the
    `~/.claude/projects` transcripts it invents are the only ones adoption can find), ports
    7921/7923/7925, sessions `jamadopt*` on a socket of its own — plus **exactly one session on
    the DEFAULT tmux socket**, named `jamadopt-<random>` and removed by that exact name, because
    the user's own server is the case v0.33 exists for and the one it must be most careful with.
    ~6 s, costs nothing. Most of it is refusals; the load-bearing steps are S6 (the ownership
    marker is on jam's own session and NOT on the adopted one, no status option, no root F3
    binding on the adopted server) and S11/S12 (after `claude-jam end` the adopted session still
    exists and the process in its pane has the SAME pid).

    Note: the fixtures are **realpathed**. On macOS `$TMPDIR` is a symlink, and both a real claude
    (which files its transcript under its own `process.cwd()`) and tmux (`#{pane_current_path}`)
    report the resolved path — a fixture under the unresolved one slugs to a directory adoption
    can never find. The first run of this smoke failed exactly that way.

18. `smoke-peer.mjs` — no arguments, no real claude AND no real peer executor. Own `$TMPDIR`,
    a second `$TMPDIR`+`$HOME` for the guest, ports 7941/7943, sessions `jampeer` and
    `jampeeroff`. ~40 s, costs nothing. It is the trust-boundary smoke: the executor is
    `scripts/fake-claude.mjs`, which emits the same `stream-json` shapes and writes down the
    argv, the cwd, the stdin and its own pid — so "no `bypassPermissions` in the argv", "the
    prompt never reached an argv", "the cwd was a fresh scratch dir and it is gone" and "the wall
    clock killed that pid" are facts on disk rather than claims. It runs a REAL `--basic` client
    as the guest, because the guest half is the half that spawns.

    Note: it asserts the scratch directory by BASENAME. On macOS `$TMPDIR` is a symlink, so the
    argv carries `/var/folders/…` and the child's own `process.cwd()` reports
    `/private/var/folders/…` — the same trap `smoke-adopt`'s fixtures hit.

Prefer 8–18 while iterating: they are self-contained, deterministic and free. 1–6 and 10 spend
real tokens, so run them once, at the end, and use `--model haiku`.

---

## 3. How a change is made

1. **Read before you write.** Trace the whole path the change touches — `lib.mjs` for the
   decision, `host.mjs`/`sessions.mjs` for the effect, both clients for the surface. A small
   diff in the wrong place is a second bug, not a lazy fix.
2. **Put the decision in `lib.mjs`** as a pure function, and the effect in the impure file. That
   is what makes it testable, and it is why the suite is 338 fast tests and not a mock farm.
3. **One commit per discrete change**, on `main`, with a message that says what changed and why
   it is that way. No amend, no rebase, no push.
4. **The docs are part of the change, not after it** (see §4).
5. **Green before commit**: `node --test test.mjs`, plus the smokes that cover what you touched.

### Things this codebase does on purpose — match them

- Comments explain **why**, and name the measured fact behind a decision ("measured on tmux 3.7c:
  `show-options -t` does not honour the `=` prefix"). Do not delete them; they are the record.
- A refusal carries **its own reason**. Never a bare `false`, never "probably fine".
- Anything destructive is **verified immediately before it happens**, one exact name at a time.
- Secrets go on **stdin or in a 0700 directory**, never on an argv (an argv is in `ps`).
- Injection into the pane goes through a **file and `paste-buffer`**, never a shell string.
- The `JAM_*` environment variables (`JAM_CLAUDE`, `JAM_TMUX_BIN`, `JAM_TAILSCALE`,
  `JAM_INSTALLED`, `JAM_HOOK_SECRET`), the `x-jam-secret` header and the `--jam-addresses` flag
  are **internal** and keep their names. Everything a human reads says `claude-jam`.

---

## 4. The standing doc rule

**Every change that alters a user-visible surface — a flag, a command, a key, an access mode, an
install step — updates all of these in the SAME change:**

- `README.md`
- `MANUAL.md` (the copy **claude itself is given**, so a wrong line becomes a wrong answer to a
  participant)
- `CHANGELOG.md` (the `## Unreleased` section)
- the affected **wiki** page(s)

Before a release, every command printed in `README.md`, the wiki's `Install` and the wiki's
`Agent-Install` is actually run. **Stale docs are a defect**, reported and fixed like any other.

The wiki lives in a separate repository (`…/claude-jam.wiki.git`), cloned as a sibling of this
one. Do not push it unless the human asked for a wiki change.

---

## 5. Where `SPEC.md` fits

`SPEC.md` is the design record, not a plan: the wire protocol and frame shapes, the smoke recipe,
the deliberate ceilings, and one section per version saying what was asked for, what shipped, and
what it cost. Read the section for the version you are implementing **and** the "what shipped"
note under it, because the note is what is true.

When a version's behaviour and its `SPEC.md` section disagree, the code is what ships and the
spec section is what was intended — say which one you changed, and why, in the commit.

---

## 6. Before you report done

- `node --test test.mjs` is green, with the count.
- The smokes that cover what you changed have run, and you say which and what they printed.
- Every claim you make was **observed**, not inferred. "Verified on" with a date beats a
  confident sentence.
- Nothing was pushed, amended or released.
- Temporary files, worktrees and stub directories your run created are named, so the human can
  decide whether to keep them.

## Testing policy (read TESTING.md)

Small verification per batch, one big campaign at the end — Roy's call, 2026-08-29.

- Per batch: `node --test test.mjs` green with a test per new pure helper, plus only the two or
  three smoke suites covering what you changed. Not the full sweep.
- Fixtures beat live `claude` turns whenever they prove the same thing (they also spend no quota).
- Live pty evidence only for what a human must look at; logic that a unit test pins does not need
  a pty capture.
- **Anything you skip goes in TESTING.md's "Deferred" list in the same commit** — what, why, and
  how it will be proven. An unrecorded skip is the failure this policy is designed to avoid.
- The full sweep is the release gate, and TESTING.md's campaign section is the end-game.

## Docs are part of the change, not a follow-up (Roy, 2026-08-29 — restated)

README, MANUAL.md, the wiki, the `--help` usage text and `/menu` must be true at ALL times.
A change that alters any user-visible surface — a flag, a command, a key, an access mode, an
install step, a default — updates in the SAME commit series:

1. `--help` usage in the launcher (the most-missed one: `--resume` shipped and went undocumented
   there for two releases),
2. `/menu` — the completeness test fails a command with no menu entry; keep flags in step too,
3. `MANUAL.md` — this is the text claude itself is given, so a stale line makes the agent lie,
4. `README.md`,
5. the affected wiki page(s) in ../claude-jam.wiki (pushing the wiki is approved),
6. `CHANGELOG.md` (Unreleased).

A doc-drift check belongs in the release step: before tagging, run every command that README,
the wiki `Install` page and `Agent-Install` claim, and fix what does not run. Stale docs are a
defect, reported like any other — not a tidy-up for later.
