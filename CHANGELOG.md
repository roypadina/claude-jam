# Changelog

## Unreleased

### jam runs its own tmux server, and F3 comes back out

- **F3 detaches as well as attaches.** jam binds `F3 → detach-client` on its own tmux server, so
  the key that hands the host the real TUI is the key that hands it back. `Ctrl-b d` still works.
- **Every tmux session jam makes lives on socket `claude-jam-<port>`**, not the shared server —
  which is what makes that binding safe, and means jam cannot see (or kill) your own tmux
  sessions even in principle. v0.18's `@jam-owned` marker check stays on top of it.
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

### jam owns its tmux sessions

- **`jam sessions`** (`jam ls`) lists the jams jam itself started — name, port, state, uptime,
  session id, who is connected, which relays are on, cwd — with a `!` against an orphaned state
  dir or a session whose daemon has died. `--json` for scripting.
- **`jam end [name]`** (`jam kill`) ends a jam properly: every client is told and exits cleanly
  instead of trying to reconnect, the daemon stops its children (ttyd, tunnel, popups), the tmux
  session is killed and its state dir removed. `--all` ends every one, after confirmation.
- **`jam clean`** removes leftover state dirs from sessions that are gone, and nothing else.
- **`/end` in the host's client** ends the jam for everybody, after a `[y/N]` confirmation.
- **Closing the host's client now asks** `keep it running · end it · cancel` instead of silently
  leaving a daemon, a TUI and a browser view running with no hint of how to stop them.
  `--no-prompt`, `--keep-on-exit` and `--end-on-exit` answer it up front; a non-interactive stdin
  keeps the jam.
- **`jam host --attach`** reopens your client on a jam that is already running, and `jam host` on
  a name that is already a jam offers to attach, start a second one (auto-named, on a free port),
  end it and start fresh, or cancel — instead of the old flat refusal.
- **jam ends only what jam created.** Every session it starts is stamped with an `@jam-owned`
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
- Slash commands now autocomplete: typing `/` shows a filtered list of jam's own commands.
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
