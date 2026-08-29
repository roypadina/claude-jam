# Changelog

## Unreleased

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
