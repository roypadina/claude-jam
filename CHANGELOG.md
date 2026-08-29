# Changelog

## 0.21.0

Two feature batches, and both of them are about a boundary rather than a screen.

**v0.33 adopt** shares the claude you are **already** in — the pane it is already running in, no
restart, no lost context — which is the first time claude-jam has pointed tmux at a server it does
not own. **v0.29 peer tasks** lets the host's agent hand work to a guest's own Claude Code, on that
guest's machine, account and quota, and only ever with that guest's per-task yes.

Also in this release: the npm packaging prep, the upstream Funnel risk written down, and the W3
Windows decision.

### The ceilings, in one place

Both batches ship with limits that were designed rather than discovered, and the release entry is
the wrong place to be vague about them.

**On an adopted jam:**

- **The pane is never resized.** It is somebody's own window with a human probably looking at it,
  so a guest on a smaller terminal sees it letterboxed. That is a decision, not a bug to file.
- **tmux popups never fire.** The one-key `display-popup` approval needs a client attached to the
  session it draws on; on an adopted jam the only session claude-jam owns holds the daemon log and
  nobody attaches to it. Approvals arrive in the client and `/accept` still works — the same
  behaviour as `--no-popup`. Nothing is written to the adopted server: no status line, no option,
  no key binding.
- **No new hooks.** `--settings` is read once at claude's startup, so turn-end and permission-wait
  on an adopted session come from the v0.31 pane classifier — the authoritative source anyway. For
  the same reason an adopted jam cannot have the peer-task MCP tools, and says so out loud.

**On peer tasks:**

- **The turn cap is counted, not enforced by a flag.** `--max-turns` **does not exist** on claude
  2.1.251 (checked in its `--help`, 2026-08-29), so jam counts `{"type":"assistant"}` events in the
  stream and kills the child by pid. That one such event is one turn comes from the documented
  event shape and has not yet been measured against a real stream.
- **`--max-budget-usd` was deliberately NOT adopted.** It exists and it is a real spend cap, but it
  cannot be tested without spending, and a flag that turns out to be inert or refusing would break
  every task. So the honest statement stands: **a turn cap is a proxy for spend, not a spend cap.**
- **The executor has never been a real `claude`.** `smoke-peer` drives `scripts/fake-claude.mjs`,
  which proves the argv, the stdin, the scratch dir and the kill are what they claim — but nobody
  has yet watched `--restricted` refuse a read outside the scratch directory. `TESTING.md` carries
  that, and the rest of what is owed, as named deferrals rather than silence.

### Packaging (prepared, not published)

- **A `files` allowlist and a `prepublishOnly` test gate** in `package.json`, plus a `node >=22`
  engine floor. Without the allowlist npm would pack the smokes, the pane fixtures, `test.mjs` and
  the design docs into a package guests install; the tarball is now the two bin entries, the
  runtime modules, `hooks.sh` and `MANUAL.md` (which `lib.mjs` points the session's system prompt
  at by name, so it is runtime data rather than documentation).
- **Nothing has been published to npm.** This is preparation only. Homebrew remains the install
  path this release ships.

### Docs

- **`--funnel` carries an upstream risk, not merely an unverified path.**
  [tailscale/tailscale#18827](https://github.com/tailscale/tailscale/issues/18827) (open) reports
  WebSockets through `tailscale serve`'s HTTP reverse proxy — the layer Funnel rides — closing
  every 10–40 s with code 1001. A 30 s heartbeat cannot save a 10 s drop. Until one real session
  has run over it, `--funnel` is a stable-URL convenience with an unproven long-session story, and
  the docs no longer imply otherwise.
- **W3 decided**: no native Windows host. WSL2 is the Windows host path (`SPEC.md` W2/W3).
- **Found by this release's own doc gate**, and fixed here: `--help` and `/menu` had drifted apart
  on three real flags (`--invite-only` and `--funnel` printed by neither; `--resume` missing from
  the menu); `SPEC.md`'s smoke recipe invoked sixteen of the eighteen suites, silently skipping the
  mDNS leak check and the whole peer trust boundary; `MANUAL.md`'s command overview — the text
  claude itself is given — was missing six commands including `/peer` and `/peers`; and the wiki's
  entry page still listed five long-shipped features as "not built yet". Two new lints now fail on
  the first two classes of drift, so the next release cannot repeat them.

### v0.29 — peer tasks: the wire (step 1 of 5)

The protocol half of "the host's agent can dispatch to a guest's own Claude Code". Nothing spawns
yet — this is the switch, the opt-in, the roster fields and the four frames.

- **`claude-jam host --peer-tasks`** — off unless you pass it. Even with it, nothing can be
  dispatched to anybody until that guest types `/peer on`, and every individual task still waits
  for that guest's yes.
- **`/peer on | off | never | reset | status`** — a decision about YOUR machine, made in YOUR
  client. `never` is a one-way door for the life of that client process, and no host can clear it.
  `reset` zeroes your own daily task counter.
- **`/peers`** lists who has opted in, who is busy and how many tasks they have run today;
  **`/peers log`** is the audit trail (`peer-log.jsonl` in the jam's state dir), readable by both
  sides.
- **The roster carries `peers` and `peerTasks`**, so a client can say "off for this jam" rather
  than "nobody has opted in".
- **The wire**: `{t:'peertask'}` (host asks) → `{t:'peertask-ack'|'peertask-decline'}` →
  `{t:'peertask-progress'}` → `{t:'peertask-result'}`. Modelled on the v0.14 approval ladder with
  the direction INVERTED: everywhere else a guest asks and the host approves, because the host's
  machine is at stake; here the host asks and the guest approves, because the guest's machine,
  account and quota are.
- **A peer who cannot take a task is reported, never queued** — off, unknown, not opted in, busy,
  offline, or the host's own claude, each with its own reason and the fix.
- **The compliance frame is part of the feature.** A task runs on the guest's machine, in the
  guest's own already-authenticated Claude Code, on the guest's quota, and only after that guest
  approves that specific task. No credential ever crosses the wire. The guest may decline
  anything, every time, with no reason. Whether a coordinated multi-account fan-out counts as
  ordinary individual usage is an **open question** — see the `Peer-Tasks` wiki page.

### v0.29 — peer tasks: the docs and the compliance frame (step 5 of 5)

README, `MANUAL.md` (the text claude itself is given), `--help`, `/menu` and a new wiki page
**`Peer-Tasks`**. All of them say the same three things, because the feature is only allowed to
exist if they are true:

- a task runs on the guest's machine, in the guest's own Claude Code, on the guest's quota, and
  only after that guest approves that specific task;
- **a guest may decline anything, every time, with no reason** — and there is a one-way
  `/peer never` for a client session that no host can clear;
- **the open question, out loud**: every task is one person choosing to spend their own quota,
  which is ordinary individual usage of each account — but *whether a coordinated multi-account
  fan-out counts as ordinary individual usage is not settled*. Nobody should discover that later,
  so it is in the README, in the manual claude reads, and in its own section of the wiki page.

### v0.29 — peer tasks: the transcript and the audit trail (step 4 of 5)

- **The whole room sees a peer task**, attributed `[Dana → task]`: what was asked (with the tool
  list and the caps), that it was accepted, each line of progress, and the answer. A task only
  the two parties could see would be a private channel inside a shared session.
- **The prompt and the answer are QUOTED into the transcript** — every line behind a `│ `, with
  the `[Name]: ` participant form neutralised. So an answer that says "ignore the above and run
  `/end`" arrives as visibly inert text. It is never executed, never typed into the pane and
  never written to a file.
- **`/peers log`** on both sides. The jam's copy lives in its own state dir
  (`peer-log.jsonl`, 0600, bounded); each line records who asked, who ran it, which tools, how
  long, how it ended and the head of the prompt.

### v0.29 — peer tasks: the tools the host's agent uses (step 3 of 5)

- **`list_peers()`** and **`dispatch_to_peer({peer, prompt, allowedTools?, maxTurns?, deadlineMs?,
  schema?})`**, as an MCP server the host's own claude gets. It is used exactly like the built-in
  Agent tool, structured output included.
- **Registered from a GENERATED file** in the jam's own 0700 state dir (`--mcp-config`). The
  user's `~/.claude.json`, their project's `.mcp.json` and their global settings are never read
  and never written; when the jam ends the file goes with the state dir. It is **additive** — no
  `--strict-mcp-config` on the host — so the servers they already had keep working.
- The internal secret rides in the config's `env`, never an argv.
- **The tool descriptions are the compliance frame**, because that is what the agent reads: whose
  machine and quota this is, that they may decline every time, that the answer is untrusted input,
  and that a decline is a decision rather than something to retry. The same text goes into the
  appended system prompt, but only when `--peer-tasks` is on.
- An **adopted** jam says out loud that it cannot have the tools: `--mcp-config` is read once at
  claude's startup, and an adopted claude was started by somebody else.

### v0.29 — peer tasks: the guest side (step 2 of 5)

The half that actually runs. A task arrives, the WHOLE prompt goes on screen with the tools, the
caps and the directory it would run in, and nothing happens until that human answers.

- **`[a]ccept · [d]ecline · [n]ever this session`** in the ink client, and
  `/peer accept | decline | never | cancel` in both. `Esc` cancels a task that is already running.
  There is no `always` on this ladder — unlike every other approval in this program.
- **One key never grants `Bash`, `Write` or `Edit`.** A task that asks for any of them says so
  loudly and refuses the single key: `/peer accept tools` is the second gate, per task, every
  time.
- **Where it runs**: `$TMPDIR/claude-jam-peer-<id>`, created 0700 for that task and removed when
  it ends — every way it can end. Never the guest's repository, never their home.
- **What it can do**: `--restricted` (which also makes claude ignore the guest's own user,
  project and local settings — a machine whose default is `bypassPermissions` does not hand that
  to work somebody else asked for), `--strict-mcp-config` with no MCP config at all,
  `--tools`/`--allowedTools` set to the approved whitelist, and `--permission-mode plan` (or
  `acceptEdits` when something that writes was granted). **Never `bypassPermissions`, never
  `--dangerously-skip-permissions`** — asserted in a unit test and again in the smoke, against
  the argv that is actually used.
- **The prompt goes in on stdin**, never an argv: it is text that arrived over a network, and an
  argv is visible in `ps` to every user on that machine.
- **Two caps, both enforced by killing the child by pid**: a wall clock (3 min by default, 10 max)
  and a turn count (12 by default, 40 max). `claude` 2.1.251 has no `--max-turns`, so jam counts
  the stream itself. **A turn cap is a proxy for spend, not a spend cap** — it bounds how many
  times the model is asked, not what each of those costs.
- **Decline, timeout, cap, crash and cancel are five distinct answers** the host's agent can tell
  apart, and partial output is preserved on every one of them.
- New: `peer.mjs` (one place a task is built, capped and stopped, shared by both clients) and
  `scripts/smoke-peer.mjs`, the eighteenth smoke — the trust boundary proved positively, against
  a fake executor that spends nothing.

### v0.33 — adopt a running session (share the jam you are already in)

Sharing used to mean `claude-jam host --resume <id>`, which RESTARTS the conversation in a pane of
claude-jam's own. `claude-jam adopt` shares the claude that is **already running**, in the tmux
pane it is already in, without restarting it.

It works because claude-jam has only ever driven claude through `capture-pane` out and
`paste-buffer`/`send-keys` in, against a tmux target — and nothing in that required claude-jam to
have created the target.

- **`claude-jam adopt`** — run it from inside the session (claude can run it from the Bash tool:
  it inherits `$TMUX_PANE`), or from another terminal with `--pane %23 [--socket <name>]`. It
  takes any `claude-jam host` flag as well, so `claude-jam adopt --tunnel --token …` works.
- **It resolves and SHOWS before it shares**: the pane and the tmux server it is on, what is
  running in it, the directory, the session id (newest live transcript for that cwd) — and that
  session's **first message and last answer**, because the failure this guards against is sharing
  the wrong conversation with the room. `--yes` skips the question for scripting and refuses
  outright when the transcript it picked is stale.
- **Adoption works on your OWN default tmux server**, which is the first time claude-jam has
  pointed tmux at a server it does not own. The rule is narrow and total: on that server the
  daemon only READS (`capture-pane`, `display-message`, `list-panes`) and TYPES INTO THE ADOPTED
  PANE. No `new-session`, no `kill-session`, no `set-option`, no `-g` anything, no key binding.
- **claude-jam never ends a session it did not start.** The daemon still runs in a tmux session of
  claude-jam's own, so the v0.18 ownership pair is unchanged: `claude-jam end` stops the daemon and
  its children (ttyd, the relay, the mDNS announcement) and leaves the pane, the tmux session and
  claude exactly as they were. `claude-jam sessions` marks the row `adopted`; `claude-jam clean`
  never touches it. The ownership marker is written on the state dir only — never as a tmux option
  on somebody else's session.
- **Not inside tmux** — a bare terminal, an IDE terminal, a cmux pane — is a refusal with the
  whole alternative and the id already in it:
  `claude-jam host --resume <session-id> --cwd <dir>`.
- **claude is told it is now shared.** At adoption one message is injected, prefixed
  `[claude-jam:tool]:` so it is visibly from the tool rather than from a participant: the
  shared-session protocol, the two standing rules, the condensed digest, who is here, and where
  `MANUAL.md` is. `--no-brief` skips it (and the client then says claude has not been told). It is
  re-sent after a `/compact` or `/clear`, and on a meaningful roster change while the session is
  idle — at most one every ten minutes; `--brief-updates off` disables that.
- **A `/jam` plugin** (`integrations/claude-plugin/`) maps `/jam`, `/jam invite <Name>` and
  `/jam end` to the CLI. Installing it is entirely optional — `claude-jam adopt` from the Bash
  tool works without it.

**Two ceilings, inherent and not worked around.** A running claude cannot be given new hooks
(`--settings` is read once at startup), so on an adopted session **turn-end and permission-wait
come from the v0.31 pane classifier**, which is the authoritative source anyway. And the adopted
pane is **not resized** to fit a guest's terminal — it is somebody's own window with a human
probably looking at it — so a guest on a much smaller terminal sees it letterboxed.

## 0.20.0

### v0.28 — real scrollback ("I can only see very little")

Three separate ceilings made the client feel amnesiac next to an ordinary Claude Code session.
All three are gone.

- **The live TUI renders in the terminal's alternate screen buffer** (`\x1b[?1049h`), the way
  `less`, `vim` and tmux do. The transcript keeps the normal buffer, so its lines ARE the
  terminal's own scrollback and flipping F2 ⇄ mirror loses nothing in either direction. What it
  fixes, measured in ink 5.2.1: once the live region is as tall as the terminal, ink writes
  `ansiEscapes.clearTerminal` — whose `\x1b[3J` clears the terminal's saved lines — and then
  reprints its entire `<Static>` log. A full-screen mirror frame is exactly that tall, so every
  flip did it. The alternate buffer has no `<Static>` at all, so it cannot happen.
- **The client now opens on the transcript** and turns the mirror on once the welcome block is
  printed, so the block a first-time guest needs is in their own scrollback rather than in a
  buffer that is thrown away. The mirror then covers it, so one row sits over the mirror saying
  where it went — `the welcome block, the keys and the history are in the transcript — F2 shows
  it · /help reprints the keys` — because losing the block that teaches F2 exists would be the
  v0.10c complaint in a new costume.
- **The F3 attach re-feed is gone**, with the README ceiling that named it: tmux draws on the
  alternate screen and hands the normal one back untouched, so the transcript is exactly where it
  was. It used to re-feed the last 40 lines and drop the rest.
- **The mirror scrolls, and what it scrolls is the host's REAL pane history.** `PgUp`/`PgDn`
  page, `Shift+↑/↓` (and `Ctrl+↑/↓`) move a line, the wheel moves three *if the terminal sends
  wheel events* — claude-jam never turns mouse reporting on, because that takes text selection
  away from the human. `End`, `G` or `Esc` returns to live. The client asks
  `{t:'screen-history', before, rows}` and the daemon answers from
  `tmux capture-pane -e -p -S … -E …` on the claude pane: the actual scrollback, colours
  included, the last 2000 lines, in pages of at most 200 rows, one capture per range per 2 s.
  **Guests get this exactly as the host does** — it is a capture, there is no path from it back
  into the pane, and a guest who could not look back was the complaint.
- **Live frames are held, not dropped, while somebody is scrolled**, and the status row says how
  many are waiting: `⧉ mirror · scrolled back 40 lines · 3 live frames waiting — End/G returns
  to live`.
- **The transcript history is no longer a 300-event stump.** `--history <N>` sizes the daemon's
  ring (2000 by default, 20000 cap) and `--replay <N|all>` decides how much of it a joiner is
  shown — `min(--replay, --history)`, with `all` meaning everything the ring can hold. New
  `/history [n|all]` re-prints further back on demand, a page at a time, under a dim divider
  saying what is still behind it. `/export` remains the exact, complete record.
- **No silent truncation anywhere.** The welcome says how many earlier events are still kept; the
  first scroll to the very top prints, once, `— that is as far back as this jam kept (N events ·
  host pane 2000 lines) · /export for the full transcript`; and a `--replay` bigger than the ring
  is one line at boot rather than a short replay nobody can explain.
- The terminal is restored on exit, on SIGINT/SIGTERM and on an uncaught error — and the error is
  printed *after* leaving the alternate screen, or the stack trace goes into a buffer nobody sees.
- `--basic` gets `/history` (it is all transcript already); scrolling the mirror stays ink-only.
- **13 new unit tests (338 green)** and a sixteenth end-to-end smoke, `scripts/smoke-scroll.mjs`:
  self-contained, free, no real claude, and it proves on a REAL pty that a scrolled-back mirror
  is row-for-row what `capture-pane -S` returns, that a guest can scroll, that End returns to
  live with the held frames, that three F2 round trips leave the transcript intact and
  un-duplicated in native scrollback, that `/history all` goes from 5 replayed lines to all 30,
  and that the top-of-history line appears exactly once. Step 12 kills the client while the
  mirror is up and watches tmux's own `#{alternate_on}` go 1 → 0, with the transcript still on
  screen underneath — a terminal nobody has to `reset` their way out of.

### v0.25 — audible join events

Two distinguishable sounds, so the host knows **without looking** whether somebody needs
approving.

- **Knock** — somebody is waiting for you: `Submarine.aiff`, a slow low tone, plus the terminal
  bell and a macOS notification `⚑ <Name> wants to join`. It repeats **once** after 30 s if
  nobody has answered, and then stops for good. Never a loop.
- **Auto-join** — a token or an invite link, so they are already in: `Glass.aiff`, one short
  chime, `<Name> joined`, no repeat.
- **Leave** — no sound at all. The roster line is enough.
- Host clients only: a guest has nobody to approve, so a guest hears no arrivals.
- **Three independent toggles**, per client, in the new `/menu → Notifications`: **sound**,
  **desktop notification**, **terminal bell**. `--no-sound` on `claude-jam host` or
  `claude-jam join` starts silent, `/sound on|off` flips the sound from the keyboard and a bare
  `/sound` reports all three. `--no-sound` silences the **sound only** — the line and the
  notification still arrive, which is the whole reason there are three switches. They are
  honoured everywhere, including the v0.17 `waiting` bell.
- Everything audible goes through `platform.mjs`, which is still the only module allowed to spawn
  a platform binary. It stats each sound **once** and remembers the answer (including a
  remembered *no*). Linux tries `paplay`, then `aplay`, with per-player candidate files; that
  branch is marked UNVERIFIED in the source because there is no Linux machine here to check it
  against. Windows is a `TODO(W1)` next to the others.

### v0.26 — nudges: any human can get another's attention

- **`/ping <Name|all> [message]`** (alias **`/nudge`**), from **anyone** — host and guest alike.
  It is deliberately *not* on the approval ladder: getting a colleague to look at the screen is
  not a privilege the host grants.
- The person addressed gets a highlighted `👋 Roy is asking for you: <message>` — not a chat
  line — plus their own bell, sound (`Hero.aiff`) and notification. **Everybody else sees a dim
  `* Roy nudged Yossi`**, so a nudge is never secret.
- The daemon validates the target is really in the roster, rate-limits **one per sender per
  target per 30 s** (per sender to everyone per 60 s) with a refusal that says how long is left,
  and **never queues**: `Yossi is not connected` instead.
- **`/ping <Name> !`** repeats the nudge **once** after a minute, and only if that person has
  still not become active.
- **Idle awareness.** Each client reports one number — whole seconds since *its own* human last
  typed or submitted. There is no key, no text and no window title anywhere in that path.
  `/who` now reads `Roy (active), Dana (idle 4m), Yossi (away 20m+), Kobi (you)`, the roster
  frame carries the map, `/menu → Notifications` counts the buckets, and the confirmation after a
  nudge says which state the target was in. A client too old to report shows `idle unknown`
  rather than being called active. The push happens only when the bucket changes, and on a path
  that does not write history.
- **Phone tier, opt-in and recipient-only.** If your own `~/.config/claude-jam/config.json` has
  `{ "ntfy": { "server": "https://ntfy.sh", "topic": "…" } }`, **your own client** POSTs a nudge
  addressed to you to that topic. The topic is a bearer secret: it stays on your machine, it is
  never sent to the host, never put in an invite link, never in the protocol and never in a log,
  and the `/menu` row says "configured" rather than *what*. A failed POST is one dim line.

### v0.27 — upload policy: auto-allow files from already-admitted guests

- **`--uploads ask|auto|off`** (default `ask`, unchanged), switchable at runtime from
  `/menu → Access → Uploads`.
  - `ask` — today's behaviour: every transfer hits the approval ladder.
  - `auto` — anyone already admitted (knock-approved, token, or invite link) may send files and
    pasted images with no prompt. The transfer is still announced to everybody and still logged;
    it just is not a question.
  - `off` — every upload refused with a clear reason, **including the host's own `/paste`**, and
    a standing `always` grant does not override it.
- **Nothing that actually protects anything moves with the policy**: sanitized basename with
  traversal refused, the 20 MB per-file cap, one transfer in flight per client, writes only under
  `<cwd>/jam-uploads/`, nothing executed or auto-opened, and an announced-vs-actual byte mismatch
  still dropping the upload. All of them are checked *before* the policy is consulted, and
  `scripts/smoke-nudge.mjs` proves each one still refuses while the policy is `auto`.
- **A session quota, which `auto` makes necessary**: 40 files or 200 MB, whichever comes first,
  after which the policy falls back to `ask` with one line — `upload quota reached — asking
  again`. `--upload-quota <n>[MB|files]` changes it and the menu row resets it, so an `auto` jam
  cannot quietly fill a disk.
- **Export keeps its own toggle and its own default.** `--export ask|auto|off` and
  `/menu → Access → Export the transcript`, still `ask` in a jam whose uploads are `auto`, and no
  quota. The docs say plainly why: a file is one file, a transcript is the whole conversation.

### Fixed

- **`claude-jam join` with no argument exited 0 on a non-tty.** It falls through to the usage
  text, which is right — but a missing argument is a usage error, so it now exits **2**. A bare
  `claude-jam` is a question and still exits 0, and the interactive behaviour (open the Join
  screen, which lists the jams on this network) is unchanged.
- The `👋` glyph is double-width, so the nudge line needed a leading space or the emoji and the
  name ran together in the gutter.
- Both clients now report their idle state when the welcome arrives instead of at the next
  30-second tick, so `/who` is useful from the first second.
- **A re-announce could orphan an mDNS advertisement** (v0.23, found during a smoke sweep on
  2026-08-29: a `dns-sd -R` for a jam that had been gone for minutes was still up, ppid 1, still
  telling the LAN the jam existed). A re-announce is stop-then-start, and the "we killed it" flag
  was one variable shared by every child the daemon ever spawned — so the old child's `exit`
  arrived after the flag had been cleared for the new one, read its own death as a crash, and
  respawned. That respawn overwrote `announceProc`, leaving the first child untracked and
  therefore unkillable on shutdown. The flag now belongs to the child, where a successor cannot
  clear it, and `scripts/smoke-discover.mjs` gained a step that counts the `dns-sd -R` processes
  for one port across a real re-announce: it sees 2 on the old code and 1 on the new.
- **A `/c` mention never rang the bell in `--basic`** (found during the 0.20.0 release gate,
  2026-08-29). The sound/notification rework renamed `nudge()` to `alert()` everywhere except one
  call site — the readline client's `chat` case still called `nudge()`, a `ReferenceError` at
  runtime, so the bell, the notification and the sound were all silently lost for a mention in a
  humans-only line. `node --check` does not catch a dead reference reached only at runtime;
  `smoke-perm.mjs`'s P3 step does, and did.
- **`--resume <session-id>` was missing from the launcher's own `--help` text.** `claude-jam host`
  has supported it since before v0.19.0 (README, MANUAL, and `host.mjs` itself all already had
  it) — the usage block just never said so.

### Internal

- `accessFrame()` — the three places that pushed a `{t:'token'}` literal (a token rotation, a
  relay/view/announce change, a policy toggle) now share one builder. That is how `announce` came
  to be missing from one of them.
- `sendAll()` — a broadcast that does **not** write history, for the two live things that must
  not evict the transcript from the replay ring: nudges and the idle-driven roster refresh.
- **325 unit tests** (was 306) and a **fifteenth smoke**, `scripts/smoke-nudge.mjs`: ~15 s, no
  real claude, no network, no tokens. It asserts the sounds **through the platform seam** — each
  client gets a directory in front of its `PATH` holding a stub `afplay` and `osascript` that
  append to a log of that client's own — so "a knock and an auto-join are two different calls"
  and "only the addressed client was interrupted" are facts on disk rather than inferences.
- **`smoke-lifecycle.mjs`'s `FAKE_CLAUDE` stub wrote its one line of content at row 0** of an
  otherwise blank pane — a shape no real claude ever has. The v0.28 mirror's 45 s "welcome block
  moved" notice reserves one row, and `fitFrame` crops the OLDEST row to make it — correct for a
  real TUI, whose newest content is always at the bottom, but it silently ate this stub's only
  line for the first 45 s of every attach. Caught by the 0.20.0 release gate (three of the
  smoke's steps failing identically at two different system loads, root-caused with a raw WS
  probe against the daemon); the stub is now bottom-anchored (padded to the pane height with
  `tput lines`), immune to a top-crop of any depth rather than just today's one reserved row.

## 0.19.0

### v0.23 — named jams, and finding one on your network

A jam has a name, and by default it says so on the local network, so a guest on the same LAN
stops needing a URL.

- **`--jam-name "reeco debugging"`**, defaulting to the **directory's own name**, so a jam is
  never nameless. It shows in the client's welcome, in `claude-jam sessions` (a column of its
  own), at the top of `/menu`, in the launcher menu and in discovery. It is cosmetic: never used
  for auth, never used to build a path. It is **not** `--tmux <name>`, which stays the tmux
  session and the identifier `claude-jam end` takes — the Host screen now has a row for each,
  labelled for what it is, because the old single "jam name" row meant only the second.
- **`claude-jam find`** (alias `discover`) browses `_claude-jam._tcp` for ~3s and prints jam,
  host, access mode, view and address, plus the exact join command per row — the listing teaches
  the join. `--json` for scripting, `--for N` for a flaky network. It talks to no daemon and
  holds no credential.
- **`claude-jam join` with no argument** opens the launcher's Join screen, which now leads with
  the discovered list. **"paste a link or URL" is the last row and never disappears** — a link is
  still how you join a jam that is not on your LAN or is deliberately silent. Picking a jam asks
  for what is actually still missing: a name always, the token only for a token jam; an
  invite-only jam is refused there, with the reason, instead of connecting and being turned away
  at the door. Each screen says what happens next before it happens, because a knock is a wait
  and an unannounced wait reads as a hang.
- **Discovery never bypasses a gate.** Finding a jam tells you it exists and where; every door is
  as shut as it was. The `find` table states this on every listing it prints, and
  `scripts/smoke-discover.mjs` proves it against a real daemon: a found token jam refuses a
  connection that only knows its address.
- **The advertisement carries six fields and nothing else**: jam name, host display name, eight
  characters of the session id, the access mode, whether a browser view exists, and the version.
  Never the token, never an invite secret, never the cwd, never any path. Enforced **by
  construction** — the record is built from an allow-list, so handing the builder a whole session
  object still publishes six fields — and asserted against the real wire, with a token set and an
  invite minted, in the smoke.
- **`--no-announce`**, plus `/menu → Access → Announce on the network` at runtime. Announcing is
  on by default because being findable is the point of naming a jam, and it is a real disclosure
  — everyone on the LAN learns the jam exists, its name and the host's name — which is exactly
  what you want at home and a leak on café wifi. The menu row shows whether the LAN is actually
  being told, not merely whether it was asked for. **Tunnels are never advertised**: mDNS is
  link-local by design and a tunnel is for people who are not here.
- **The advertisement is a tracked child with cloudflared's discipline** — killed by its own pid
  on every exit path, respawned on death with the same 1s→30s backoff, our own SIGTERM never
  treated as a death. Deregistering is not optional, and killing the child is what does it;
  verified live, and asserted by the smoke, that a jam which ended stops advertising.
  Re-announcing compares the record it would publish against the live one first, so a token
  rotation re-registers and a relay flap does not.
- **mDNS lives behind the platform seam.** `dns-sd` is a platform binary like `osascript` and
  `pbcopy`, so it sits in `platform.mjs` with them and the lint that keeps every other module
  away from them now covers it. A machine with no mDNS tool skips discovery with one line naming
  the fix for all three platforms; nothing else changes and it is not an error.
- The `dns-sd` output parser was written against the **real binary** (macOS 26, 2026-08-29), not
  from a man page. `-Z` is used rather than `-B`/`-L` because it returns the instance name, port,
  target host and whole TXT record together, in one child, in a stable layout. The parser is
  total: a half-written line at the tail of a stream, dns-sd's banner and comment block, another
  service's records and a nonsense port all produce no row rather than a wrong one.
- `scripts/smoke-discover.mjs` is the **fourteenth smoke**, and it costs nothing (no real claude,
  no ttyd, no cloudflared). It advertises on your network for about a minute, which is the thing
  under test, and says so on the way in.

### One name: `claude-jam`

The product, the executable, the tmux session and the ownership marker all say **claude-jam**
now. `jam` survives only as an installed alias — nothing prints it.

- **`claude-jam` is the real executable.** `jam` is a four-line shim that execs it, so an
  install or a habit from 0.18.0 keeps working. It appears in no usage text, no error and no
  hint; the README names it once, as deprecated. Both bins are installed.
- **The default tmux session is `claude-jam`** (a second one is `claude-jam-2`), from one
  `DEFAULT_TMUX` constant rather than the five places that each spelled it out.
- **The ownership marker is `@claude-jam-owned`**, and the old `@jam-owned` is still **read** —
  newest name first — so a jam created by 0.18.0 stays listable and endable. An old marker
  grants nothing a new one would not: the value still has to resolve to a `session.json` that
  names the session back.
- Every usage, help, error, hint, attach line, `sessions`/`end`/`clean` row, menu label, the
  tmux status line and the shared-session contract in claude's system prompt say `claude-jam`.
  The NOUN is unchanged — "this jam is still running" is what the product is called.
- Internal `JAM_*` environment variables are unchanged on purpose (`JAM_CLAUDE`, `JAM_TMUX_BIN`,
  `JAM_TAILSCALE`, `JAM_INSTALLED`, `JAM_HOOK_SECRET`), as are the `x-jam-secret` header and the
  `--jam-addresses` internal flag. They are documented as internal rather than churned.
- **A test asserts no user-visible string emits a bare `jam ` command form** — a lint over the
  string literals of every module plus the launcher's `echo` lines, so it catches the string
  nobody happened to render in a test.

### Docs an agent can install from

- **`AGENTS.md`** — how an agent works ON this repo: layout, `node --test test.mjs`, the 13
  smokes and the order to run them in, commit-per-change, the hard rules, where `SPEC.md` fits.
- **A repo wiki** — Home, Install, Agent-Install, Hosting-a-Jam, Joining-a-Jam, Remote-Access,
  Files-and-Export, Security-Model, Architecture, Troubleshooting. `Agent-Install` is the page
  another person's agent is pointed at: numbered non-interactive commands, what to verify after
  each, what needs a human, what must never be done, ending in a self-test.
- **README** gains a short "For agents" section linking both.
- **Standing rule** (extends the MANUAL.md one): a change that alters a user-visible surface —
  flag, command, key, access mode, install step — updates `README.md`, `MANUAL.md`,
  `CHANGELOG.md` and the affected wiki page(s) **in the same change**. Stale docs are a defect.

### `platform.mjs` — the platform seam (v0.32 W0)

Groundwork for Windows, with no Windows code in it yet. One module now owns every call that
only means something on one operating system: `clipboardImage()`, `notify()`, `playSound()`,
`stateDir()`, `configDir()`, `historyFile()`, `secureWrite()`, `openExternal()` and `copyText()`.

- The macOS implementations moved behind it **unchanged**: pngpaste-then-osascript for `/paste`,
  the argv-only `osascript` notification, `$TMPDIR`, `~/.config` (XDG-aware), 0600 files inside
  0700 directories.
- **A test asserts no module outside `platform.mjs` spawns a platform binary** — checked at the
  spawn and as a bare string, so the `const cmd = ['pbcopy', []]` shape is caught too. tmux,
  claude, git, curl, cloudflared, tailscale and ttyd are not platform binaries and stay put.
- `playSound()` and `openExternal()` have no caller yet; they exist so the batch that needs them
  does not also have to build the seam. Each function carries the TODO naming what W1 fills in.

### The menu is the product surface

`claude-jam` **with no arguments** is now a launcher menu, and **`/menu`** inside a client is a
live control panel. Neither is a feature of its own: both are renderers over one tree of data,
and every row builds a command that already existed.

- **The launcher** (`claude-jam`, no arguments — `@inkjs/ui` on the ink 5 + React 18 stack
  already shipped, no other new dependency): Host a jam · Join a jam · My jams · End a jam. The
  Host screen collects the directory, name, jam name, access mode (knock / token /
  invite-only), remote relay, browser view and extra claude args, and **prints the exact
  `claude-jam host …` command line before it runs it** — so the menu teaches the CLI instead of
  hiding it. A relay that cannot run here is greyed with the reason and the exact fix. Join
  takes an invite link *or* a `ws://` URL, and the name/token fields appear only for the URL,
  because a link already carries both. My jams is the v0.18 table with attach / copy-an-invite
  (minted and put on the clipboard) / end. `--no-menu` or any argument keeps today's behaviour;
  a non-tty prints the usage.
- **`/menu`**: People (who is here, everything pending, and the standing `always` grants —
  **listed and individually revocable for the first time**, they were invisible once given —
  plus `/kick`), Invites, Access, Session, and Help & guides (MANUAL.md rendered inline and
  scrollable, the keyboard reference, the wiki pages, and every command with a one-line
  description and one key to run it). It shows the jam's current state next to every toggle, so
  it doubles as the status page. A guest's `/menu` lists exactly what a guest may do.
- **Completeness is a test, not a habit.** A unit test asserts every `JAM_COMMANDS` entry and
  every documented `host` flag appears in the menu tree with a description, and that the guest
  menu lists exactly the guest commands. Adding a command without a menu entry fails the suite.

### Relays are runtime-controllable

- `/menu → Access → Remote`, `/remote off|tunnel|funnel` in a client, and
  `claude-jam remote <off|tunnel|funnel> [--jam NAME] [--reissue]` from a shell (loopback
  control endpoint, same guard as `/admit`). One code path: the relay mode is runtime state and
  the same `startTunnels`/`stopTunnels` the launcher uses do the work. **Nobody already
  connected is dropped** — a relay change touches the relay children and the URLs, never a
  socket. Preconditions are re-probed in the daemon and shown inline with the exact fix.
- **Re-issuing every invite link** is offered in the same step, and says how many were
  re-issued. A re-issue mints a new link per name and revokes the old one (the daemon keeps only
  the hash of each secret, so an old link cannot be re-encoded) — and it **waits for the relay's
  hostname**: doing it at switch time, as the first cut did and a live run proved, mints links
  carrying exactly the address the re-issue exists to replace.

### A relay coming up is now said out loud

Observed live: the host's welcome printed only the LAN invite line, nothing announced the tunnel
~10 s later, and a later `/join` left three near-identical blocks with no way to tell which was
current.

- **Reproduced, and it was not the push.** Against a stub daemon: the `{t:'token'}` frame *does*
  reach a connected host client. The client rendered it into the **mirror view's three-row
  deferred strip** — the mirror is the default view — where the next three system lines pushed it
  off within 1.5 s. So the line arrived and then scrolled away unseen.
- A relay that comes up is now its own event: `tunnel ready: <the whole join command>`, rendered
  where the host is actually looking (and repeated in the daemon log). A respawn to the same
  hostname stays quiet; a change says `moved`.
- At boot with `--tunnel`/`--funnel` the welcome says **`tunnel: starting…`** under the LAN line
  instead of printing a set that is about to be wrong.
- `/join` (and every `{t:'token'}` refresh) prints **one dated block** — `── invite 17:29 ───` —
  with `(earlier invite lines above are stale)` when the log already holds some.

### Also

- **`--invite-only`** (and `/token invite-only on|off` at runtime): a knock is refused outright
  with "ask the host for a claude-jam invite link", rather than left waiting for a host who has
  decided not to be asked. A valid token and the host's own client still come in above it.
- The **browser view (ttyd)** can be turned on and off while the jam runs, from
  `/menu → Access`, not only with `--view` at launch.
- `claude-jam remote` with no mode is a question, not a mistake: it prints what is running and
  what could be, with the reasons for what cannot.

## 0.18.0

### A message is never lost, and big pastes stop failing

Observed live (15:20): a nineteen-line message failed with `injection failed: pasted text never
appeared in the claude pane`, and `Ctrl-U` then wiped it out of the input box.

- **Cause, measured:** Claude Code 2.1.x does not echo a multi-line paste — from three lines up it
  collapses the whole thing to `[Pasted text #N +M lines]` — so the echo probe (the payload's first
  40 characters) could never match. Every multi-line message had this failure available to it.
- **A landed paste is now accepted in all three of its shapes**: the probe, a paste placeholder
  (matched on the family, not one spelling), or the input box simply not being what it was
  immediately before. A rule only counts as evidence if it was not already true.
- **Nothing is ever destroyed.** Every payload is written to `<state>/outbox/<when>-<who>.txt`
  (0600) *before* it is pasted and deleted only once the input box is seen to empty. On a failure
  the box is captured and cleared **only if something is actually in it**, the payload stays, and
  the sender is told: `couldn't confirm your message reached claude — kept at <path> · /retry to
  send it again`. **`/outbox`** lists what is kept; **`/retry`** sends the newest again, under the
  original sender's name.
- **`↑`/`↓` recall your own last 50 submissions** in both clients, persisted 0600 in
  `~/.config/claude-jam/history`. In passthrough an arrow still belongs to claude's TUI.
- **Long messages go in as pieces.** Found while testing: a pty hands a TUI 1022 bytes at a time,
  and an 8 KB `paste-buffer` into a pane that is mid-redraw arrives **silently short** — 4.2 KB of
  one chunk vanished. So pastes are 2 KB, on line boundaries, Enter only after the last, and each
  piece is checked against the count in claude's own `[Pasted text +N lines]` marker. A piece that
  arrives short is a truncation, so the message is kept rather than half-sent.
- Honest limits: a message is capped at 20 000 characters on the wire, so chunking covers ~2 KB to
  20 KB — a bigger brief goes in as a file. The outbox keeps the last 20 payloads and goes with the
  state dir when the jam ends.

### Questions are not permissions

Observed live (15:26): the status row said `⚠ waiting for permission` while the pane was showing an
**AskUserQuestion** picker, and stayed up after the questions had been answered.

- **The status is read off the screen, not from an event.** The daemon classifies the current pane
  — `none` · `question` · `permission` · `dialog` — 2.5 times a second while anybody is connected.
  The Notification hook no longer sets anything (it just makes the poll look sooner), the Stop hook
  no longer clears the flag, and neither does the first assistant record. All three were guesses
  about a screen none of them could see, and the stale `⚠` was the result.
- **Distinct wording, and the question itself.** A permission names its tool
  (`⚠ waiting for permission (Bash command)`), a question shows what is being asked
  (`⚠ claude is asking: Do you prefer tabs or spaces?`) with its numbered options rendered as a
  block **in every client, in both views**, and a dialog says `claude needs the host at the
  keyboard — F3`.
- **Anyone may answer a question; only the host may grant a permission.** A question is a product
  decision: `/answer <n>` goes straight through, validated against the options in the current
  frame, digit-only, **first answer wins** (anybody slower is told `already answered by Dana`), and
  the room sees `* Dana answered: 2. Spaces`. Permissions keep the v0.17 ladder exactly.
  **`--answers host`** puts questions back on the ladder; the default is `anyone`.
- **Free text stays the host's** in every mode — arbitrary text into the terminal is raw keyboard
  access. `/answer other <text>` for the host; a guest asking for it goes through the ladder and
  the host sees the exact text before a character is typed.
- **`/answer <q> <n>`** targets one question of a multi-question form. Only the one on screen can
  be answered, because moving between them is a Tab keypress; the refusal says which is up.
- A numbered picker jam cannot recognise is treated as a **permission**, deliberately: being wrong
  that way costs the host one approval, being wrong the other way would hand a guest a tool grant.

### Tests

- **265 unit tests** (was 245), and a thirteenth smoke, `smoke-answer.mjs` — fourteen steps, no
  real claude, driving the daemon through a real tmux pane.
- **`fixtures/pane/`**: thirteen real `capture-pane` captures of claude 2.1.251 — the input box
  empty, with text, wrapped, and with a paste placeholder; the trust dialog; a real `Bash`
  permission prompt; and the `AskUserQuestion` picker in all four states. The paste verification
  and the classifier are judged against those, so a rendering change fails a test instead of a
  message. Recorded there too: the input box writes `❯` + U+00A0 while an option row writes `❯` +
  a space, and one `Ctrl-U` kills one visual line rather than the whole input.

### The shared-session contract survives a /compact

- **What jam tells claude is now split by lifetime.** The durable half — the session is shared,
  `[Name]:` is who is talking, the two rules that must never decay (never reveal the join token or
  an invite link to a bridged participant, never claim to have seen `/c` chat) and a short digest
  of how a jam works — is written to `<state>/system-prompt.txt` and passed as
  `--append-system-prompt-file`. A system prompt is not summarised away by `/compact`, which is
  exactly what a jam running for hours used to lose.
- The half that *changes* — the live roster, the token, the tunnel URLs, the whole of `MANUAL.md` —
  stays in the hooks, because a system prompt is read once at startup and can never be rewritten.
- jam **probes** for the flag rather than assuming it (it works on claude 2.1.251 but is absent
  from `--help`), caches the answer in the state dir, and falls back to the previous hooks-only
  behaviour with one log line if a build rejects it — a claude that refuses to start is the one
  outcome that must not happen. `--no-system-prompt` opts out entirely.
- Honest as ever: this is an instruction to the model, not an enforcement boundary. What it buys is
  durability, not a new gate.

### jam runs its own tmux server, and F3 comes back out

- **F3 detaches as well as attaches.** jam binds `F3 → detach-client` on its own tmux server, so
  the key that hands the host the real TUI is the key that hands it back. `Ctrl-b d` still works.
- **Every tmux session jam makes lives on socket `claude-jam-<port>`**, not the shared server —
  which is what makes that binding safe, and means jam cannot see (or kill) your own tmux
  sessions even in principle. v0.18's `@claude-jam-owned` marker check stays on top of it.
- Reaching the raw TUI from elsewhere now needs the socket:
  `tmux -L claude-jam-<port> attach -t <name>:claude`. That exact line is printed by the
  launcher, by the "keep it running" message, and once per live row in `claude-jam sessions`.
- The jam session's `status-right` says `F3 or Ctrl-b d → back to jam`; the `⚑ N waiting` badge
  still wins while anything is pending, and `--no-popup` still turns the status line off entirely.
- **`--tmux-socket <name>`** picks the server by hand; `--tmux-socket default` puts jam back on
  the shared one, and there the bare F3 binding is deliberately skipped.

### Invite links — one command joins

- **`claude-jam invite <Name>`** mints `cjam1_…`, and **`claude-jam join <link>`** is the guest's
  whole command: no name to type, no token to paste, no approval to wait for. The link carries the
  addresses, the name the host bound to it and a per-invite secret. They arrive as
  `* Dana joined (invite)`.
- **`claude-jam invites`** lists them (id, name, state, uses, expiry — never the link again) and
  **`claude-jam invite revoke <Name|id>`** takes one back. The same three from inside the client as
  `/invite`, `/invites`, `/invite revoke` (host-only), so a link can be minted mid-session.
  `--uses N` and `--expires 30m|24h|7d` on either surface; the default is multi-use for 24 hours,
  so a guest whose laptop slept can reconnect.
- **A link is a credential and is treated as one.** The daemon stores only a hash of each secret,
  in its 0700 state dir, and reloads them on restart — a restarted daemon does not lock out the
  people it already invited, and a copy of the state dir cannot hand anybody a working link.
- **Nothing fails silently.** A link that is tampered with, from a newer format, expired, revoked,
  used up, or whose name is already connected is refused *with its own reason* and then falls
  through to an ordinary knock, so the host can still wave the person in.
- A link carries the tunnel address first and the LAN address second; the client tries them in
  order with a 3-second timeout each.
- **`/kick <name> [revoke]`** (host) removes somebody who is already in — the one thing `/deny`
  never could. Their socket closes 4406, they drop out of the roster, everybody is told, and if
  they came in on a link the host is offered its revocation in the same breath.
- **`claude-jam --help`, `-h`, `help`** print usage and exit 0. `node host.mjs --help` used to
  swallow the next argument and start a real jam.
- **Fixed: a knock-mode host had no address to hand out.** The invite line used to print nothing
  at all unless a token was set, so the default (knock) mode showed the "friends knock" hint with
  no address to knock on. The address is now always in the line; only the `--token` part and the
  knock hint vary.

### jam owns its tmux sessions

- **`claude-jam sessions`** (`claude-jam ls`) lists the jams jam itself started — name, port, state, uptime,
  session id, who is connected, which relays are on, cwd — with a `!` against an orphaned state
  dir or a session whose daemon has died. `--json` for scripting.
- **`claude-jam end [name]`** (`claude-jam kill`) ends a jam properly: every client is told and exits cleanly
  instead of trying to reconnect, the daemon stops its children (ttyd, tunnel, popups), the tmux
  session is killed and its state dir removed. `--all` ends every one, after confirmation.
- **`claude-jam clean`** removes leftover state dirs from sessions that are gone, and nothing else.
- **`/end` in the host's client** ends the jam for everybody, after a `[y/N]` confirmation.
- **Closing the host's client now asks** `keep it running · end it · cancel` instead of silently
  leaving a daemon, a TUI and a browser view running with no hint of how to stop them.
  `--no-prompt`, `--keep-on-exit` and `--end-on-exit` answer it up front; a non-interactive stdin
  keeps the jam.
- **`claude-jam host --attach`** reopens your client on a jam that is already running, and `claude-jam host` on
  a name that is already a jam offers to attach, start a second one (auto-named, on a free port),
  end it and start fresh, or cancel — instead of the old flat refusal.
- **jam ends only what jam created.** Every session it starts is stamped with an `@claude-jam-owned`
  marker pointing at its own state dir, and nothing is ever killed unless that marker and the
  `session.json` in that directory agree, for the exact name given. No name patterns, no sweeps
  over `tmux list-sessions`, no `kill-server`: your other tmux sessions are invisible to jam and
  stay that way.

## 0.17.0

### Host TUI control
- **Native-speed F3 attach.** F3 in the host client now suspends the client and runs a real
  `tmux attach` to the claude window, instead of proxying each keystroke over the network.
  Full native latency, colors, mouse and pickers; `Ctrl-b d` returns to the client.
- **One-key approval bar.** Pending knocks, commands, exports and file offers now surface as
  an approval bar above the status row (`[a]ccept [d]eny [i]gnore`, with a countdown), so a
  single keypress answers them without leaving the client — the popup feel from before the
  host session went fully detached.
- **Adaptive mirror frames.** The live TUI mirror now polls at 40ms while a client is watching
  and the pane is active, backing off to 250ms when idle, instead of a fixed 250ms poll —
  noticeably snappier during a busy turn, and zero polling cost once nobody is watching.

### Transport reliability
- `cloudflared`/Tailscale Funnel tunnels now auto-restart on failure with exponential backoff,
  so a dropped tunnel recovers on its own instead of leaving the session unreachable.
- The host/guest connection now uses WebSocket ping/pong heartbeats to detect and clean up
  dead sockets before they go stale.
- After repeated failed reconnect attempts, the client tells you the tunnel URL may have
  changed and to ask the host for a new one.
- New `--funnel` flag: host over **Tailscale Funnel** instead of `cloudflared` for a stable
  public hostname across restarts, real TLS, and nothing for guests to install.

### History and orientation for guests
- Joining a session now backfills recent history from the transcript on daemon boot, instead
  of guests landing in a blank room on a resumed or long-running session.
- A `── history above · live from here ──` divider marks where replayed history ends and the
  live session begins.

### Guests see the actual work
- Edit/Write/MultiEdit tool calls now render the real diff (file path plus `-`/`+` lines),
  instead of a truncated summary.
- New `/files` command: lists every path this session has touched, newest first, with a
  per-path change count.
- New `/diff [path]` command: `git diff --stat` by default, or a full diff for one path.
- Best-effort secret masking (AWS keys, private key blocks, API tokens, `.env`-style
  `KEY=value`) is now applied to tool output and the mirror view before it reaches guests.

### Guest parity and polish
- Guests can request to answer a pending permission prompt; the host approves, and only a
  validated digit (never raw keystrokes) is sent to the real prompt.
- Read-only commands (`/cost`, `/status`, `/context`) now run for guests without a host
  round-trip.
- A bell rings when the host has a permission prompt waiting, and when your name is mentioned
  in chat; a matching macOS desktop notification fires alongside it.
- The status bar now shows a live connection-quality indicator (round-trip time, or a
  staleness warning).
- Slash commands now autocomplete: typing `/` shows a filtered list of claude-jam's own commands.
- Fixed a color in the per-user palette that was too close to the "you" color, making another
  participant's name easy to mistake for your own.

## 0.14.0

Baseline for this changelog.

- **Mirror-first client.** Every participant, host included, uses the same client view: the
  live TUI mirror is the default, with the transcript view as an F2 alternate.
- **Knock and token access.** Friends join with a shared token, or knock and wait for the
  host to accept or deny them from inside the client.
- **Built-in tunnel.** `--tunnel` stands up a `cloudflared` quick tunnel automatically, so the
  host doesn't need to open an inbound port or set one up by hand.
- **Session export.** A guest can request the session transcript; the host approves, and it's
  sent over the existing connection for a `claude --resume`.
- **Remote files.** Guests can send files (and pasted images) to the host, and the host can
  send files back — both gated by host approval.
