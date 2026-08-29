# claude-jam

Share **one real, interactive Claude Code session** with other humans on other machines.

The host keeps the native `claude` TUI — their own plugins, skills, MCP servers, `CLAUDE.md`,
hooks, account. Everyone, host included, joins from a terminal client whose default view is
that TUI, streamed live. The agent is told the session is shared and sees **who wrote each
message**. Humans also get a side channel the agent never sees.

```
        Roy (host)            Dana                 Eli
        client  ─────┐        client ────┐         client ────┐
                     └──────── WS ───────┴─────────────┘
                                  │
                     host.mjs daemon ── types into ──▶ the real `claude` TUI
                                  └── capture-pane ──▶ the live view everyone watches
```

## Requirements

- node ≥ 22, tmux, and the `claude` CLI on PATH
- optional: `ttyd` for the browser view (`--view`), `cloudflared` for `--tunnel`,
  `tailscale` for `--funnel`, `git` for `/diff`,
  `pngpaste` for `/paste` (macOS falls back to `osascript`)

macOS and Linux. No Windows. The bell is portable; the desktop notification beside it is macOS
only (`osascript`), exactly like `/paste`.

## Install

```sh
brew install roypadina/tap/claude-jam
```

Or from source:

```sh
git clone https://github.com/roypadina/claude-jam
cd claude-jam && npm install
./jam host --name You --cwd .
```

## Host quickstart

```sh
jam host --name Roy --cwd ~/Code/some-project -- --model sonnet
```

That builds a **detached** tmux session `jam` (two windows: `daemon` log, `claude` the real
TUI) **on a tmux server of jam's own** — socket `claude-jam-<port>` — and runs your own jam
client full-screen in the terminal you launched from. Nothing is attached to tmux, so the window
size is jam's to pick and the mirror fills your screen exactly.

Because it is jam's own server, jam can bind a bare **F3** to `detach-client` without touching
your tmux config, and it literally cannot see your own sessions. The flip side: reaching the raw
TUI from another terminal needs the socket —
`tmux -L claude-jam-7777 attach -t jam:claude`, which `jam sessions` prints for you.
`--tmux-socket default` puts jam back on your shared server (and then F3-out is not bound).

```
┌ your terminal ─────────────────────────────────────────────┐   ┌ tmux session `jam` ──────┐
│  ▐▛███▛█   Claude Code v2.1.251                            │   │ daemon  (log)            │
│ ▝▜██████▀  Haiku 4.5                                       │   │ claude  (the real TUI)   │
│ ❯ [Dana]: rerun the tests                                  │   │                          │
│ ⏺ All 71 pass.                                             │   │ detached — nothing is    │
│ ──────────────────────────────────────────────────────     │   │ attached to it           │
│ ❯                                                          │   └──────────────────────────┘
│ [Dana]  [humans-only] nice                                 │     tmux attach -t jam
│ ⧉ live TUI                       Dana is typing…           │     for the raw TUI
│ Roy ❯                                                      │
└────────────────────────────────────────────────────────────┘
   the mirror of the claude window · chat strip · status · input
```

Closing your client does not end the jam: you are asked
`this jam is still running (2 guests connected) — [k]eep it running · [e]nd it · [c]ancel`.
Keep it and the daemon, the TUI and every guest stay exactly where they were —
`jam host --attach` reopens your client, `jam sessions` lists what is running, `jam end` stops
it. See **Session lifecycle** below.

Useful flags: `--port`, `--tmux <name>` (a second jam), `--token <value>`, `--view`,
`--tunnel`, `--funnel`, `--resume <session-id>` (continue an existing session),
`--replay <N>` (how much of an existing transcript a joining guest is shown, default 300 events,
`0` for none), `--config-dir <dir>` (run
the TUI as another claude profile), `--no-attach`, `--attach`, `--no-prompt`,
`--keep-on-exit`, `--end-on-exit`, `--no-token-in-context`, `--no-popup`,
`-- <extra claude args>`. `jam` with no arguments prints the usage line; `MANUAL.md` explains
the ones you will actually reach for.

## Guest quickstart

```sh
# an invite link — the whole command. No name to type, no token, no approval to wait for.
jam join cjam1_eyJ2IjoxLCJqYW0iOiJhYmMx…
# knock-only host: no token, you wait to be accepted
jam join ws://<host-ip>:7777 --name Dana
# host handed you a token: straight in
jam join ws://<host-ip>:7777 --name Dana --token abc123…
```

You land on the live TUI — the host's real Claude Code screen, plus the backlog of what
happened before you arrived (up to `--replay` events, with a
`── history above · live from here ──` divider under it). A plain line goes to the agent
as `[Dana]: …`; `/c <text>` is human-only chat; **F2** flips to the transcript; `/files` and
`/diff` say what the session has changed; `/answer` answers a permission prompt (the host still
approves); `/help` reprints the onboarding block. Typing `/` raises a dim list of jam's own
commands. `--basic` swaps ink for a plain readline client (transcript
only, no live view, no F2/F3, no command list) and is picked automatically when stdin is not a tty.

## Access: token, knock, tunnel, funnel

Three ways to let someone in. All of them end in the same welcome.

| mode | how | who decides |
| --- | --- | --- |
| **token** | `--token <value>` at startup (8–64 chars of `[A-Za-z0-9_-]`), or `/token set` later. One shared secret; anyone holding it joins immediately | whoever has the string |
| **invite link** | `jam invite Dana` mints `cjam1_…`, and `jam join <link>` is the guest's entire command — the link carries the addresses, their name and a per-invite secret, so they are admitted with no approval | the host, per person, in advance — and revocably |
| **knock** | no token at all. The guest connects without one, sees `waiting for host approval…`, the host gets `⚑ Dana wants to join (100.86.8.97)` and answers `/accept Dana` | the host, per person |
| **tunnel** | `--tunnel` spawns two Cloudflare quick tunnels (needs `cloudflared`) and prints `wss://<words>.trycloudflare.com` join/view URLs — for a friend who is not on your LAN or tailnet | still the token or the knock; the tunnel only moves the bytes |
| **funnel** | `--funnel` runs Tailscale Funnel instead (needs `tailscale`, and Funnel enabled for the tailnet). Same job, but the URL is your node's own name — `wss://<machine>.<tailnet>.ts.net` and `https://…:8443` for the view — so it is the **same every run**, unlike a quick tunnel's random words. Your guest still installs nothing | as above; mutually exclusive with `--tunnel` |

### Invite links

```sh
jam invite Dana                          # multi-use, 24h — prints the guest's whole command
jam invite Dana --uses 1 --expires 30m   # one shot, half an hour
jam invites                              # id, name, state, uses, expiry (never the link again)
jam invite revoke Dana                   # or revoke <id>
```

The same three from inside the client: `/invite Dana`, `/invites`, `/invite revoke Dana`
(host-only, like `/token`).

**An invite link IS a credential.** Anyone holding it joins as that name with no approval —
treat it like a password, send it over a private channel, and `/invite revoke` when you are
done. It is still strictly better than the shared `--token`: it is revocable on its own,
bound to one name, expiring, and countable (`--uses`). The shared token stays for quick
throwaway cases.

Defaults are multi-use and 24 hours, because a guest whose laptop slept has to be able to
reconnect. The daemon stores only a **hash** of each secret, in the 0700 state dir, and reloads
them on restart — so a daemon that came back does not lock out the people it already invited, and
a copy of the state dir cannot hand anybody a working link. A revoked or expired link disconnects
nobody who is already in; they stay until they leave.

Anything wrong with a link — tampered, expired, revoked, used up, or its name already connected —
is said out loud and then **falls through to a knock**: the guest is never silently rejected, and
the host can still wave them in. A link from a future format (`cjam2_…`) is a clean "update
claude-jam", not a crash.

A link carries the tunnel address first and the LAN address second, and the client tries them in
order with a 3-second timeout each. That is also the ephemeral-tunnel caveat: a `cloudflared`
respawn changes the hostname, so links minted before it keep working only over their LAN address —
mint fresh ones, or use `--funnel`, whose hostname never changes.

Rotating a token (`/token new` / `set` / `off`) never disconnects anyone already in — the token
is checked at join time only. A *wrong* token knocks, so rotating strands nobody. Knocks expire
after 2 minutes, at most 10 wait at once, and two live participants can never share a name
(attribution is by name). A knock — and every other request on the ladder — raises a one-row
**approval bar** just above the host's status row: `⚑ Dana wants to join (100.86.8.97) ·
[a]ccept [d]eny [i]gnore · 2:00`, counting down to that request's own expiry, with `+N more`
when several wait. One key answers it, and only while the input line is empty: the first
character you type disarms the keys until Esc, so a message that starts with `d` can never deny
anybody. Anyone attached to the jam session still gets the one-key `tmux display-popup` too —
whoever answers first wins and the other closes.

`--view` (needs `ttyd`) additionally serves the live TUI read-only in a browser at
`http://jam:<token>@<host>:7778`. Each tab gets its own grouped tmux session, so viewers never
move each other's screen.

**Bind is `0.0.0.0` and the only auth is the token plus your own `/accept`** — expose this over
Tailscale, a LAN you trust, an SSH tunnel (`ssh -L 7777:127.0.0.1:7777 host`), or a Cloudflare
quick tunnel whose URL you keep private. Never a public IP you advertise. If Tailscale is
installed the printed join line already uses the Tailscale IP.

## Session lifecycle

jam creates the tmux session, so jam cleans it up — no `tmux kill-session` line to remember.

| command | what it does |
| --- | --- |
| `jam sessions`, `jam ls` | jam's own sessions: name, port, state, uptime, session id, who is here, which relays are on, cwd. `--json` for scripting. A `!` marks an `orphan` state dir (its tmux session is gone) or a `no-daemon` session (nothing answers on its port) |
| `jam end [name]`, `jam kill` | end one jam: every client is told and exits 0, the daemon stops its children (ttyd, tunnel, popups), the tmux session is killed and its state dir removed. No name and one jam → that one; several → a numbered picker; `--all` after an explicit confirmation |
| `jam clean` | remove state dirs whose session is gone, and only those, after listing exactly what will go |
| `jam host --attach` | reopen your client on a jam that is already running |
| `/end` (host, in the client) | the same end, from inside, after `really end this jam for everyone? [y/N]` |

Closing the host's client asks `[k]eep it running · [e]nd it · [c]ancel`; `--no-prompt`,
`--keep-on-exit` and `--end-on-exit` answer it up front, and a stdin that is not a terminal
counts as **keep**. `jam host` on a name already held by one of jam's own offers
`[a]ttach as host · [n]ew session (jam-2) · [e]nd it and start fresh · [c]ancel`.

**jam only ever ends a tmux session it created.** On creation it stamps
`@jam-owned <state-dir>` on the session and writes `session.json` into that dir; ending anything
requires that pair to line up, for the exact name you gave (or picked out of jam's own list).
There is no name pattern, no filtered sweep over `tmux list-sessions`, no `kill-server`, and
`--all` re-verifies every session it touches. Your own tmux sessions — and a session carrying a
hand-written `@jam-owned` marker — are refused, never listed, and never touched; a session
started before v0.18 has no marker, so it is jam's to leave alone too
(`tmux kill-session -t <name>` remains yours to run).

Since v0.20 that is structural as well as checked: jam's sessions live on **its own tmux server**
(socket `claude-jam-<port>`, recorded in `session.json`), so `list-sessions` there cannot return
one of yours even in principle. The marker check stays anyway, and `killOwned` additionally
refuses a session whose recorded socket is not the one it was asked about.

## Commands

jam owns the commands below; **everything else starting with a slash belongs to claude** — from
the host it is typed into the real TUI verbatim, from a guest it becomes a request the host
approves.

| command | who | effect |
| --- | --- | --- |
| *(plain line)* | anyone | goes to claude as `[Name]: …` — attribution is symmetric, the host is a `[Name]` too |
| `/c <text>` | anyone | human-only chat; the agent never sees it |
| `/who`, `/help`, `/quit` | anyone | roster · reprint onboarding · leave (session keeps running) |
| `/mirror`, **F2** | anyone | swap live TUI ⇄ transcript |
| **F3** | host | **attach** the real TUI — `tmux attach` takes the terminal, so permission prompts, pickers, the mouse and Ctrl-C all work at native speed. **F3 again** (or `Ctrl-b d`) comes back. Host **and** loopback only |
| `a` `d` `i`/Esc | host | answer the approval bar above the status row — accept · deny · dismiss. Only while the input line is empty |
| `/tools`, `/tools on\|off` | anyone | reprint the last turn's full tool log · stop/resume collapsing tool lines |
| `/files` | anyone | every path this session read, wrote or edited — newest first, with a count |
| `/diff [path]` | anyone | `git diff --stat` of the host's working tree, or the real hunks for one path |
| `/answer`, `/answer <n>` | anyone | list the options on claude's permission prompt · offer one of them (the host approves before a key is typed) |
| `/join`, `/token new\|set\|off` | host | reprint the invite lines · rotate or drop the token |
| `/invite <Name> [--uses N] [--expires 24h]` | host | mint a link that joins as that name with no approval |
| `/invites`, `/invite revoke <Name\|id>` | host | list the links (never reprinting one) · take one back |
| `/kick <name> [revoke]` | host | remove somebody already in: their socket closes 4406, they drop out of the roster, everybody is told — and you are offered their invite link back |
| `/end` | host | end the jam for everybody — asks `[y/N]` first, then every client prints `<Host> ended the jam` and exits |
| `/accept [name]`, `/deny <name>` | host | answer a knock |
| `/allow-cmd [name] [always]`, `/deny-cmd <name>` | host | answer a guest's claude command |
| `/allow-perm [name] [always]`, `/deny-perm <name>` | host | answer a guest's permission answer |
| `/send <path>`, `/paste [caption]` | anyone | guest uploads a file to `<cwd>/jam-uploads/` (host approves); host **offers** one instead |
| `/get [name]` | guest | save a host offer into `./jam-downloads/` |
| `/export` | guest | take the session transcript home as `./jam-session-<id>.jsonl`, with the recipe to `claude --resume` it (host approves) |
| `/allow-export`, `/deny-export`, `/accept-file`, `/deny-file` | host | the other two approval ladders |

Every guest-initiated command, transfer, export and permission answer goes through the same
ladder: **default deny**, one request in flight per person, a two-minute expiry, and `always` for
standing approval that lives in daemon memory and dies with it. `/exit`, `/clear` and `/resume` are
refused outright — they would end or wipe the session for everyone.

Three of claude's own commands are the exception: **`/cost`, `/status` and `/context` run for a
guest with no round trip at all**, because they print a panel and change nothing. Exactly those
three, and exactly bare — `/cost --json` is an argument this list has not read, so it asks like
anything else. Their output lands on the shared screen like any other command, so a guest can put
the host's `/status` panel in front of everybody; that is the whole cost of it.

**Answering a permission prompt** (`/answer`) is the one guest action that reaches the real TUI, so
it is the narrowest: only while claude is actually waiting, only a digit the daemon can see on the
screen, only after the host approves that digit, and only if the screen still says the same thing
when the key is typed. A guest never gets raw keys — that is F3, and it stays host-only.

Multi-line input: `Shift+Enter` (kitty/CSI-u), `Option/Alt+Enter`, or a trailing `\` (works
everywhere).

## How it works

The daemon injects messages into the real TUI with `tmux load-buffer` + `paste-buffer -p`
(bracketed paste, so multi-line stays one message), waits for the text to actually appear in
the pane, and only then sends Enter — text never passes through a shell or argv. Output comes
back by tailing `~/.claude/projects/*/<session-id>.jsonl`. Turn boundaries come from `Stop` /
`Notification` hooks in a generated `settings.json` passed with `--settings`, so nothing global
is touched. The live view is `tmux capture-pane -e`, only for clients that
asked, never stored, at an adaptive cadence: 40 ms while somebody is watching *and* something
moved in the last 2 s (a message, a turn, typing, the screen itself), 250 ms once it goes quiet,
and no polling at all with nobody watching — capped at 25 frames a second per client, with an
unchanged screen still sending nothing. Everything a guest can send is either sanitized (messages,
chat, captions) or gated (commands, keys, resize, transfers).

Everything the other direction — tool calls, tool results, diffs and every mirror row — goes
through a small best-effort secret mask on the way out. An `Edit`/`MultiEdit`/`Write` call is
rendered as a real `-`/`+` diff rather than truncated JSON, because its arguments already are
the diff. And at boot the daemon seeds its 300-event history ring from the transcript already on
disk, so the first guest to join a `--resume`d session gets the conversation, not a blank room.

Two moments ring your terminal's bell (`\x07`, plus a macOS notification): claude waiting for a
permission answer — the host's client only, since the host can always answer — and anybody saying
your own name in a message or in `/c` chat. At most one per three seconds. The status row also
carries this connection's own round trip, measured by the 30 s heartbeat: a dim `~120ms`, or
`⚠ stale Ns` once a pong is overdue.

`node --test test.mjs` covers the pure functions in `lib.mjs` — **221 tests**. Eleven
end-to-end smokes live in `scripts/`; the recipe for driving them against a throwaway daemon is
in `SPEC.md` (`smoke-transport.mjs`, `smoke-replay.mjs`, `smoke-perm.mjs` and
`smoke-lifecycle.mjs` bring their own — the last of those runs under a `TMPDIR` of its own and
starts by proving it will not touch a session it did not create).

## Known ceilings (deliberate)

- tmux slightly degrades Claude Code visuals — paler colors, OSC notifications lost.
- Claude Code's JSONL format is officially unstable. All parsing lives in one function
  (`parseJsonlLine`), so a format change is a one-place fix.
- A message injected mid-response is queued by Claude Code as the next turn, not merged.
- Guests can now answer a permission prompt, but only through the relay: the daemon reads the
  prompt's numbered options off the screen, the host approves one, and the daemon types that one
  digit. It refuses anything it cannot read cleanly (it wants the picker's own `❯` or a question
  line above the options, and a 10-option prompt is more than one digit can pick), and a prompt
  that changed between the request and the approval is refused rather than answered. Guests still
  never get raw keys.
- The host answers a prompt with F3 — which *is* a `tmux attach`.
  While the host is attached their own mirror is paused, and coming back re-feeds only the last
  40 transcript lines to the client: the rest stays in the terminal's own scrollback, because
  ink's `<Static>` would otherwise reprint the whole session on every return.
- The frame signal is a poll, not `tmux pipe-pane`: the cadence adapts (40 ms active, 250 ms
  idle) but an active mirror still costs one `capture-pane` per tick.
- **An invite link is a bearer credential.** It joins as that name with no approval, so whoever
  holds it is that person as far as jam is concerned — there is no second factor and no device
  binding. What you get instead is per-person revocation (`/invite revoke`), an expiry, a use
  count and a name binding, which the shared `--token` has none of. Send links privately.
- A link's addresses are fixed the moment it is minted. A `cloudflared` respawn changes the
  tunnel hostname, so older links reach the jam only over their LAN address; `--funnel` has a
  stable hostname and does not have the problem. There is no "re-issue all links" action yet —
  mint fresh ones.
- Revoking a link, or letting it expire, does **not** disconnect anybody already in on it; it only
  stops the next join. `/kick` is what removes somebody who is already here — and `/kick` plus its
  revoke is the pair that actually keeps them out.
- Admission is per person, and since v0.22 there are per-person credentials — but once in,
  everybody is still equally trusted: an invite grants exactly the same abilities a knock does.
- The token-in-context guard ("reveal only to the host") is an instruction to the model, not a
  boundary. If the token must not leak, run knock-only.
- **Export scrubbing is best effort.** A transcript is everything claude saw — file contents,
  tool output, the whole context. jam strips its own token block and the raw token, nothing
  else. Run `/token new` after an export.
- **Secret masking is best effort too, and is a deny-list, not a scanner.** It knows five
  shapes — AWS key ids, PEM `PRIVATE KEY` blocks, `sk-`/`gh?_`-style tokens, bearer
  credentials, `.env`-style UPPER_CASE secret `KEY=value` — applied to tool calls, tool
  results, `/diff` output and every mirror row. Anything else goes through untouched, and on a
  mirror row a value split across colour escapes will not match. Never plan around it: it is a
  seatbelt on the way out, not a boundary.
- `/files` only knows what a tool call announced (an Edit/Write/Read `file_path`), so a file
  changed by a shell command inside a `Bash` call is invisible to it — that is what `/diff` is
  for. `/diff` is `git diff`, i.e. the **unstaged** working tree only, capped at 120 lines, and
  any participant may run it.
- The history a joiner is shown is `--replay` events (300 by default) parsed out of the last
  8 MB of the transcript. Everything older is only in `/export`, and a replayed event is
  stamped with the daemon's boot time, not the moment it originally happened.
- Nothing scans an uploaded file. It is written 0644, never executed, never opened — but the
  moment claude `Read`s it, its contents are in the context, and therefore in anybody's later
  `/export`.
- Standing approval (`always`) is per name, in daemon memory, with no way to revoke short of a
  restart. On the permission ladder that means a named guest may answer prompts unasked — still
  only a digit that is on the screen, still re-checked every time, but it is the widest grant in
  the tool. A one-key `a` on the approval bar never grants it; only the typed
  `/allow-perm <name> always` does.
- Participant colours are hashed per name from a fixed palette of eight. It is contrast-checked
  (every one clears 4.5:1 on a dark terminal) and no longer holds a green that could be mistaken
  for your own name's green — but eight fixed hues cannot all stay distinct for a dichromat, so two
  pairs read alike under deuteranopia. The `[Name]` label beside the colour is the identity; the
  colour is a hint.
- The bell and the macOS notification are per-client and cannot be turned off short of your
  terminal's own bell setting.
- A transfer is held whole in memory at both ends and has no resume; uploads cap at 20 MB, the
  transcript and offers at 50 MB.
- A dead relay child (`cloudflared`, `tailscale funnel`) IS restarted now, 1s doubling to 30s,
  forever — but a cloudflared respawn hands out a **new random hostname**, so guests on the old
  URL have to be sent the new join line (`/join`). Their client says so after five failed
  reconnects. `--funnel`'s hostname is stable, which is the reason it exists.
- Sockets are pinged every 30 s and a peer that misses a round is dropped, so a half-dead
  client no longer holds its name in the roster. That is also what keeps a quiet session under
  Cloudflare's 100 s WebSocket idle cap; nothing here has been proven over a full two hours yet.
- `--funnel` is **unverified end to end**: it is implemented, tested and its startup check is
  real, but Funnel is not enabled on the tailnet it was written against (an admin adds a
  `funnel` node attribute in Access Controls), and the macOS App Store build of Tailscale.app
  cannot change funnel config at all — its CLI answers `The Tailscale GUI failed to start …
  (Tailscale.CLIError error 3.)`. Use the standalone build from tailscale.com.
- **jam's ownership of a session is a marker on disk, not a capability.** `@jam-owned` plus a
  matching `session.json` is what authorises an end, so anybody who can already set a tmux
  option on their own session and write a directory can make jam end *that* session — which
  they could have killed themselves anyway. What the pair rules out is the accident: a name
  pattern, a session jam did not create, a stale marker, a `session.json` copied in from
  somewhere else.
- `jam sessions`/`end`/`clean` enumerate jam's OWN namespace — the `$TMPDIR/claude-jam-<port>`
  state dirs — so a jam-owned session whose state dir was deleted by hand is invisible to them
  (and `tmux kill-session` is then the way out). A jam started before v0.18 has neither, and is
  likewise none of their business.
- `jam clean` decides "the session is gone" from `tmux has-session` plus a TCP probe of that
  port. A state dir whose port is held by something else is flagged, not deleted.
- The exit prompt is the launcher's, so it exists only for the host client the launcher spawned.
  A `jam join --host` client started by hand just closes, and the jam keeps running.
- The live view, tool collapse, F2/F3 and the newline keys are ink-only — `--basic` is a
  transcript-only client.
- No rate limiting, no web client, one session per host, no Windows.

`README` keeps the short list; `SPEC.md` has the full one, plus every wire frame and the
phase-2 relay sketch that removes the inbound port.

## Docs

| file | what it is |
| --- | --- |
| `MANUAL.md` | the manual **claude itself is given** — so a participant can just ask "how does this jam work?" and get an accurate answer |
| `SPEC.md` | protocol, frames, design decisions, the full ceiling list |
| `PRIOR-ART.md` | the ~40-project survey the credits below summarize |

## Prior art & credits

`PRIOR-ART.md` is a survey of ~40 projects that put two or more humans into one live AI coding
session, scored against the same five-part bar claude-jam aims at (multi-human, attribution to
the agent, human-only channel, presence, native env preserved). Nothing found hits all five,
and the closest work is worth your time:

- [manycode / ccshare](https://github.com/unworld11/ccshare) — real PTY around the real agent
  binary, join code + bundled Cloudflare quick tunnel, genuine human-only chat
- [claude-threads](https://github.com/anneschuth/claude-threads) — a real local `claude` per
  Slack/Mattermost thread, with `Co-Authored-By` attribution
- [claude-duet](https://github.com/EliranG/claude-duet) — host/partner approval mode, WebRTC
  transport, the `@claude`-prefix convention
- [multAIplayer](https://github.com/maddiedreese/multAIplayer) — the same idea for Codex CLI,
  with MLS end-to-end encryption and teammate input framed as untrusted
- [claude-code-collab](https://github.com/jxandery/claude-code-collab) — the same tmux
  architecture, sketched in a weekend and abandoned

Ideas borrowed from them are credited in `PRIOR-ART.md` §4.

## License

MIT — see `LICENSE`.
