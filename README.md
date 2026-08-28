# claude-jam

Two or more humans on different machines talking to **one real, interactive Claude Code
session**. The host keeps the native `claude` TUI with all their plugins, skills, MCP servers,
CLAUDE.md and hooks. Friends join from a terminal. The agent is told the session is shared and
sees who wrote each message.

Requires node ≥ 22, tmux, and the `claude` CLI on PATH. Dependencies: `ws` for the daemon,
`ink` + `react` + `ink-text-input` for the client's UI (`--basic` runs the client without
them). Optional: `ttyd` for the read-only browser view of the TUI (`brew install ttyd`),
`cloudflared` for `--tunnel` (`brew install cloudflared`).

## Host quickstart

```sh
npm install
./jam host --name Roy --cwd ~/Code/some-project -- --model sonnet
```

That builds a **detached** tmux session `jam` — two windows, `daemon` (log) and `claude` (the
real TUI, alone in its window) — and then runs **your own jam client full-screen in the
terminal you launched from**. You watch the real Claude Code screen through the client's
default view and type into the jam; nothing is attached to tmux at all. See
[What the host sees](#what-the-host-sees).

With no `--token` (as above) there is no token: friends knock and you accept them (see
[Access](#access-token-or-knock)). With `--token abc123…` the launcher also prints a join line:

```
node client.mjs ws://100.86.8.97:7777 --name <You> --token abc123…
```

Send that to your friends. It scrolls above your client on launch, and your client prints it
again on connect and any time you type `/join` — together with the browser-view URL (`--view`)
and the tunnel pair (`--tunnel`) when those are on.

Closing your client kills nothing: the daemon, the TUI and every guest stay exactly where they
were, and the launcher prints how to rejoin, how to reach the raw TUI, and how to actually
stop:

```
client closed — the jam is still running.
  rejoin:  node client.mjs ws://127.0.0.1:7777 --name Roy --token abc123… --host
  raw TUI: tmux attach -t jam
  stop:    tmux kill-session -t jam
```

If you normally run claude with `--dangerously-skip-permissions` through a shell alias, note
that aliases do not apply here — pass it explicitly after `--` — and think twice before doing
that in a session where friends can send instructions the agent treats as yours.

Useful flags: `--port`, `--host`, `--tmux <name>` (run a second jam), `--token <value>`,
`--no-attach` (build everything but do not open your client), `-- <extra claude args>`,
`--resume <session-id>` (continue an existing session instead of starting fresh — wins over
`--session-id` if both are given; see below), `--view` (opt-in browser view; `--view-port` /
`--view-ttyd <path>`, below), `--no-token-in-context` (keep the token out of claude's context,
below), `--no-popup` (no in-TUI knock popup, below), `--config-dir <dir>` (run the TUI as
another claude profile, below), `--tunnel` (two Cloudflare quick tunnels so a remote friend
needs no Tailscale/LAN access at all, below).
`--split`, `--no-split`, `--no-cmux` and `--no-view` are retired in v0.14 and accepted as
no-ops, so an old command line still runs (the launcher says so).
The `claude` binary is resolved as `--claude <path>` / `JAM_CLAUDE=<path>`, then
`~/.local/bin/claude` if it exists, then plain `claude` from PATH — the resolved path is
printed at launch. (PATH `claude` can be a wrapper shim from another terminal app.)

### What the host sees

```
┌ your terminal ─────────────────────────────────────────────┐   ┌ tmux session `jam` ──────┐
│  ▐▛███▛█   Claude Code v2.1.251                            │   │ daemon  (log)            │
│ ▝▜██████▀  Haiku 4.5                                       │   │ claude  (the real TUI)   │
│ ❯ [Dana]: rerun the tests                                  │   │                          │
│ ⏺ All 71 pass.                                             │   │ detached — nothing is     │
│ ──────────────────────────────────────────────────────     │   │ attached to it            │
│ ❯                                                          │   └──────────────────────────┘
│ [Dana]  [humans-only] nice                                 │     tmux attach -t jam
│ ⧉ live TUI                       Dana is typing…           │     for the raw TUI
│ Roy ❯                                                      │
└────────────────────────────────────────────────────────────┘
   the mirror of the claude window · chat strip · status · input
```

One surface, the same one guests get: the live TUI fills the terminal, the chat strip under it
carries what that screen cannot show (humans-only chat, knocks, system lines, errors), then the
status row and your input row. **F2** swaps to the transcript and back; **F3** hands your
keyboard to the TUI (below).

The `claude` window holds exactly one pane and nothing else ever moves into it — that is what
keeps the mirror (and an optional browser viewer) free of host chrome. The whole v0.9 host-chat
machinery — the 9-row `--split` pane, the cmux split, the `chat` window — is gone with it.

Because nothing attaches to tmux, the window size is jam's to choose: the launcher creates the
session at your terminal's size minus the client's five chrome rows, your client re-sends its
size whenever the terminal resizes, and the daemon puts that size back if somebody attaches,
takes the window with them and leaves again. So the mirror fills your screen exactly, with
nothing cropped.

### Resume an ongoing session

```sh
./jam host --name Roy --resume <session-id> --cwd <same cwd as the original session>
```

Find the id with `/status` inside claude, or with `ccsm`. If that session is currently open
somewhere else (say, a cmux pane), exit it first — the daemon drives the tmux pane directly
and needs to own it. Claude Code keeps the full conversation history; friends who join only
see new turns from this point on, not what happened before the resume.

## Access: token or knock

Two ways in, both ending in exactly the same welcome. You decide which are open.

**Token.** `--token <value>` at startup (8–64 chars of `[A-Za-z0-9_-]`) hands out one shared
secret: anyone who has it joins immediately. From your own client, at any time:

| command | effect |
| --- | --- |
| `/token new` | fresh random 16-char token; the old one stops working |
| `/token set friends-only-1` | your own value, 8–64 chars of `[A-Za-z0-9_-]` |
| `/token off` | no token at all — knocking is the only way in |
| `/join` | reprint the current join line (or the "friends knock" note) |

Rotating never disconnects anyone already in: the token is checked only at join time. All of
your host clients get the new join line, and the `daemon` window logs it too.

**Knock.** With no token there is nothing to hand out. A friend runs the join command without
`--token`, sees `waiting for host approval…`, and your client flags it:

```
⚑ Dana wants to join (100.86.8.97) — /accept Dana | /deny Dana
```

`/accept Dana` lets her in; `/accept` with no name admits the only person waiting (and errors
if there are several). `/deny Dana` closes her socket. A *wrong* token knocks as well, so
rotating or switching a token off never strands anybody — they just wait for you.

Limits: a knock expires after 2 minutes, at most 10 people can wait at once, and two live
participants can never share a name (attribution is by name, so `Dana` is refused while a
`Dana` is here or waiting). While waiting, a knocker is not in the roster, not in
`roster.json`, cannot chat, and nothing it sends reaches claude.

`/token`, `/accept`, `/deny` and `/join` are host-only — a friend running them gets
"host only". Your own client is trusted because the launcher spawns it on loopback; a `host`
claim from any other address is treated as an ordinary friend.

### Approving a knock (and a command request) from the TUI

Your own client shows every knock, so this is for the case where you are attached to tmux
instead. On every knock — and on every guest command request — the daemon opens a small
`tmux display-popup` over the claude window, on the clients attached to the jam session:

```
  ⚑ Dana wants to join (100.86.8.97)

  [a]ccept · [d]eny · [i]gnore/Esc
```

A command request renders the same way — `⌘ Dana wants to run /compact` with `[a]llow` — and
grants that one command only, never standing approval.

One key, no Enter: `a` admits her exactly as `/accept Dana` would, `d` denies her (socket
closed 4403). Anything else — `i`, Esc, Ctrl-C — closes the popup and leaves the knock
pending, so `/accept` in a client still works. The popup takes itself off the screen when
the knock's two minutes run out, and if somebody answered the knock in a client first it
says `too late (404)` and disappears. It talks to the daemon over loopback with the internal
hook secret, so a rotated or switched-off friend token never affects it.

While anyone is waiting, the jam session's status line ends in `⚑ N waiting`. That is a
**session** option: the daemon snapshots whatever `status-right` your own config had when it
started and puts it back the moment the last knock is answered (and again when it exits).
Your global tmux config is never written to.

Popups appear only on clients attached to the jam session itself — ttyd viewers sit on
grouped sessions and never see them, and in the normal v0.14 case (you in your client, tmux
detached) there is no attached client at all: the daemon logs `[knock] no client attached — no
popup for Dana` and moves on, because your client already has the knock. Requests queue: one
popup at a time, the next opening when the previous closes. `--no-popup` turns off both the
popup and the status line.

## Live view in a browser (`--view`, opt-in)

Every participant already watches the real TUI in their own client, so the browser view is a
nice-to-have now: **`--view`** turns it on (needs `ttyd` — `brew install ttyd`, probed at
`/opt/homebrew/bin/ttyd` or wherever `--view-ttyd <path>` points). Ask for it without ttyd
installed and the launcher says so instead of quietly running without it; `--no-view` is
accepted and is what happens anyway.

```
view: http://jam:abc123…@100.86.8.97:7778
```

Append `?fontSize=16` (a ttyd client option) if the TUI comes out too small in the tab.

The password is the friend token while one is set (so a friend needs no second secret), and
a generated 16-char key while there is none. Every `/token new|set|off` rotates it — ttyd
cannot change its credentials while running, so the daemon kills its own ttyd child (by the
pid it spawned, nothing else) and starts a fresh one on the same port. The old URL 401s from
that moment on.

Each browser connection gets a tmux session of its own, grouped with the jam session (the
same live windows) but pinned to the `claude` window with `destroy-unattached on` **and
`status off`**: viewers never move each other's or your screen, they see no tmux chrome at
all, and their session disappears when they close the tab. Read-only is ttyd's default (1.7+),
and nothing in the view can type into the pane. A viewer whose browser is bigger than the
window gets blank padding rather than tmux's `·` fill (the window carries
`fill-character ' '`), and the daemon puts your own size back once they are gone.

The ttyd child dies with the daemon (SIGINT/SIGTERM/SIGHUP and `tmux kill-session` are all
handled). A `kill -9` of the daemon is the one case that leaves it orphaned — the pid is
logged as `live view on :7778 (ttyd pid NNNN)`.

## Public tunnel (`--tunnel`)

`--tunnel` (needs `cloudflared` on PATH — `brew install cloudflared`, checked at launch;
missing it exits 2 with that same hint before anything is built) spawns two Cloudflare quick
tunnels from the daemon, tracked by pid exactly like the ttyd child:

```sh
./jam host --name Roy --tunnel --cwd .
```

One tunnels the WS/HTTP port (`cloudflared tunnel --url http://localhost:7777`), the other
the view port (`--url http://localhost:7778`, skipped when there is no view server to tunnel —
i.e. unless `--view` is on and ttyd was found). Each prints a boxed banner with a
`https://<random-words>.trycloudflare.com` URL once it connects (typically a few seconds);
the daemon parses that line out of `cloudflared`'s own stderr and derives:

```
tunnel invite: node client.mjs wss://<random-words>.trycloudflare.com --name <You> --token abc123…
tunnel view: https://jam:abc123…@<random-words-2>.trycloudflare.com
```

No port on either — Cloudflare terminates TLS at the edge and proxies to :443 — and `wss://`
instead of `ws://`. These are what you hand to a friend who is not on your Tailscale/LAN. The
`daemon` window's log is the place to copy them from: it reprints the whole console block
— tunnel lines **first**, the LAN `invite:`/`view:` lines below — every time a tunnel
resolves, dies, or `/token` changes. Nothing prints for a tunnel that has not resolved yet
(or, for the join line, while no token is set — same "nothing to hand out while knocking"
rule as the LAN line). The same values ride along on `token.json` (as `tunnelJoin` / `tunnelView` — hence claude's
own context, below), a host client's `welcome` and the `{t:'token'}` frame, and **your client
prints them** on connect and on `/join`, tunnel pair first:

```
* tunnel invite: node client.mjs wss://<random-words>.trycloudflare.com --name <You> --token abc123…
* tunnel view: https://jam:abc123…@<random-words-2>.trycloudflare.com
* invite: node client.mjs ws://100.86.8.97:7805 --name <You> --token abc123…
* view: http://jam:abc123…@100.86.8.97:7806
```

`/token new|set|off` rotates the *token/key embedded in the URL* only — the tunnel hostnames
themselves never change, so a friend who bookmarked a tunnel URL keeps reaching the right
daemon even after a rotation; the credential in the URL is just no longer valid for the old
value. Knock-only hosts still get a `tunnel view:` line (the view key exists independent of
any token, same as the LAN one) but no `tunnel invite:` line, for the same reason there is no
plain `invite:` line when knocking.

**Lifecycle.** Both `cloudflared` children die with the daemon (SIGINT/SIGTERM/SIGHUP,
`tmux kill-session`, a `kill -9` of the daemon is the one case that orphans them — same
caveat as ttyd). If one dies on its own — network hiccup, `cloudflared` crash — the daemon
logs `tunnel (ws|view) exited (cloudflared code …) — its join/view URL is cleared`, drops
that line from every place it was printed, and rebuilds `token.json`. **No auto-restart in
v0** (ceiling): get a new tunnel by restarting the host with `--tunnel` again.

## Token in claude's context

The daemon writes `<state>/token.json` (`{token, join, viewUrl, tunnelJoin, tunnelView}` —
the last two null unless `--tunnel` resolved one) on boot, on every `/token` change, and on
every tunnel URL resolving or dying, and `hooks.sh` folds it into the `SessionStart` context
(and into the next `UserPromptSubmit` context whenever it changed). So you can just ask, in
the TUI: *"what's the join token?"* — the agent has it, together with the tunnel join
command and view URL when `--tunnel` is up, and the instruction to reveal it only to
messages **without** a `[Name]:` prefix (i.e. yours, typed straight into the TUI) and to send
bridged participants back to you. With no token set the block says so, and points at
`/accept`.

`--no-token-in-context` omits the block: no `token.json` is written at all (an old one from a
previous run on the same port is deleted), so the token never reaches the transcript.

**Ceiling:** that "host only" rule is an instruction to the model, not a boundary. An
admitted participant can still socially-engineer the token out of the agent — they are
talking to the same context you are. If the token must not leak, run knock-only
(`/token off`): then there is nothing to hand out and `/accept` is the hard gate.

## Running as another claude profile (`--config-dir`)

```sh
./jam host --name Roy --cwd . --config-dir ~/.claude3
```

That sets `CLAUDE_CONFIG_DIR` for the claude window only — nothing global, and your own
shell keeps whatever profile it had. The path is expanded and normalised (`~` resolved, no
trailing slash: a trailing slash changes claude's keychain hash and forces a fresh login).
With no flag, whatever `CLAUDE_CONFIG_DIR` you started `jam host` with is forwarded instead,
so `CLAUDE_CONFIG_DIR=… ./jam host` keeps running as that account. The resolved profile is
printed at launch and in the `daemon` window as `claude profile: <dir>`.

The JSONL tail then globs `~/.claude/projects/*` **and** `<config-dir>/projects/*` (on one
machine those are often the same directory via a symlink; the hit is realpath'd so either
route settles on one path). The globs are logged next to `claude profile:`.

Three things to know before you use it:

- A different profile is a different account: **separate usage limits**, separate billing.
- That profile answers **its own trust dialog** the first time it runs in a given cwd (and,
  on a brand-new profile, the whole first-run onboarding — theme, login). The daemon can
  answer the trust dialog, not a login.
- **Remote-MCP connectors are per-profile.** A connector you authorised in `~/.claude` is
  not there under `~/.claude3` until you authorise it again.

## Friend quickstart

```sh
# knock-only host: no token, wait to be accepted
node client.mjs ws://<host-ip>:7777 --name Dana
# host handed you a token: straight in
node client.mjs ws://<host-ip>:7777 --name Dana --token abc123…
```

You land on the **live TUI** — the host's real Claude Code screen, streamed — with a short dim
onboarding block printed above it (what a plain line does, `/c`, `/who`, `/quit`, F2,
multi-line, and the reminder that claude itself knows the whole manual and can be asked "how
does this jam work?"). `/help` reprints it.

- A plain line goes to the agent, prefixed as `[Dana]: …` so attribution survives. The host's
  messages are prefixed too — attribution is symmetric.
- `/c <text>` is human-only chat: other humans see it, the agent never does.
- `/who` lists who is connected, `/help` reprints the onboarding block, `/quit` leaves (the
  session keeps running without you).
- **F2** swaps between the live TUI and the transcript, `/mirror` does the same.
- Any other `/command` is one of claude's — it goes to the host for approval, see
  [claude's own commands](#claudes-own-commands-host-passthrough-and-guest-requests).
  `/join`, `/token`, `/accept`, `/deny`, `/allow-cmd` and `/deny-cmd` are host-only — a friend
  running them gets "host only", never the token. **F3** is host-only too.
- **Multi-line:** `Shift+Enter` (kitty/CSI-u `ESC[13;2u` or xterm's `ESC[27;2;13~`) and
  `Option/Alt+Enter` (`ESC CR`) insert a newline; plain Enter sends. A trailing `\` does the
  same in any terminal. Pending lines show dim above the input row and the prompt shows
  `Dana … ❯`.
- **`/tools`** reprints the last completed turn's full tool log; `/tools on` stops collapsing
  tool lines, `/tools off` (default) collapses them — see below.
- The client has four regions, bottom-up: the input row (`Dana ❯ …`), a status row of its own,
  the 3-row chat strip, and the live TUI (or, after F2, the transcript). The status row carries
  the view chip (`⧉ live TUI` / `≡ transcript`), `✻ claude is working…` and
  `⚠ waiting for permission` on the left and `Dana is typing…` (or `Dana, Eli are typing…`) on
  the right. Nothing status-ish ever lands in the input row.
- `--basic` swaps the UI for the old readline renderer — one prompt row with the status text
  inside it, no `ink`/`react` needed. For a terminal ink misbehaves in; it is also picked
  automatically when stdin is not a tty (a pipe, a heredoc), since ink needs raw mode. It is
  **transcript-only**: no live TUI view, no F2/F3, no Shift+Enter, no tool collapse (every
  `⚙`/`⎿` line goes straight to the log). The onboarding block's footer says so.

## The two views

The client is one pane with two views, and F2 (or `/mirror`) swaps them:

| | live TUI (default) | transcript (F2) |
| --- | --- | --- |
| what fills the pane | the host's real claude pane, actual cells and colors, ≤4 frames/s | every jam message, reply and tool line, append-only |
| under it | 3-row chat strip: humans-only chat, knocks, system lines, errors | in-progress tool lines (last four `⚙`/`⎿`) |
| what it is for | watching claude work exactly as the host sees it | reading back what was said, and by whom |

The daemon runs `tmux capture-pane -e` for the live view: only for clients that asked, only
when the screen changed, at most four frames a second, and never stored in history — a mirror
is a live view, not a log. Lines that arrive while you are on the live TUI wait for you: the
last three chat/system ones show in the strip, and flipping to the transcript flushes all of
them in order, so nothing is lost. A guest whose terminal is narrower than the host's window
gets the rows cropped at the right, and a shorter terminal keeps the **bottom** of the window
(where a TUI's live part is); a dim `— mirror: host pane is 142 cols wide, yours is 110 · 23
row(s) above cut off` line says exactly what was dropped.

Typing always goes through the jam protocol — the live view is read-only for everybody. The
one exception is the host's F3.

## F3: the host's keyboard, straight into the TUI

Permission prompts, the trust dialog, an interactive `/model` or `/compact` picker — some
things want a keyboard on the real TUI. The host presses **F3**:

- every key from then on is forwarded raw to the claude pane (base64 on the wire, typed in with
  `send-keys`), the view switches to the live TUI if it was not there, the status row reads
  `⌨ TUI control — F3 returns`, and the input row is replaced by the same hint;
- Ctrl-C goes to claude too — that is the point;
- F3 again gives the keyboard back to the jam.

When claude asks for permission, the status row says `⚠ waiting for permission — F3 to answer`
(guests are told "the host answers" instead).

**Guests never get it.** The daemon accepts `{t:'key'}` frames only from a socket that is both
`--host` and on loopback — the client the launcher itself spawned — and refuses everything else
with `F3 TUI control is the host's, on loopback only`. The frames are size-capped, encoded as
tmux `send-keys -H` hex (ASCII) or one `-l` literal run (anything above 0x7f), and never touch
a shell. This is the one path that is deliberately *not* sanitized: answering a prompt means
sending exactly the bytes you pressed.

## claude's own commands (host passthrough and guest requests)

jam owns `/c` `/who` `/help` `/quit` `/mirror` `/tools` `/join` `/accept` `/deny` `/token`
`/allow-cmd` `/deny-cmd`. **Everything else that starts with a slash belongs to claude.**

From the **host's** client it is typed into the real TUI verbatim — `send-keys -l` then Enter,
no `[Name]:` prefix — so claude's own command palette runs it. `/model`, `/compact`, `/mcp`,
`/status`, a plugin's `/foo:bar`: all of them work, any picker they open renders in everyone's
live view, and F3 drives it. Everybody sees `* Roy ran /model in the TUI`.

From a **guest** it is a request:

```
guest:  /compact — sent to the host for approval
host:   ⌘ Dana wants to run /compact — /allow-cmd Dana · /allow-cmd Dana always · /deny-cmd Dana
```

| host answers | effect |
| --- | --- |
| `/allow-cmd Dana` | runs it once; the next command asks again |
| `/allow-cmd Dana always` | runs it, and that guest's later commands run without asking, for this jam only (daemon memory, gone on restart) |
| `/allow-cmd` / `/allow-cmd always` | same, for the only request waiting (errors if several are) |
| `/deny-cmd Dana` | refused; the guest is told who denied it |
| nothing | the request expires after 2 minutes |

Default is deny, nothing is ever auto-approved, and a guest can have only one request in
flight. **`/exit`, `/clear` and `/resume` are refused outright** — they end or wipe the session
for everyone, so there is no approval path at all and standing approval never covers them
(server-side list, re-checked on every command). `/exit` and `/quit` typed in a client mean
"leave my client"; ending claude itself is `tmux attach -t jam` and typing it there.

Before anything reaches the pane the command is validated: one `/name` of letters, digits and
`:._-`, optional single-line arguments, control characters stripped, length capped — so a
newline cannot smuggle a second line in behind it.

## How the client reads

Every line is `[Label]` padded to one column, then either a glyph or two blank spaces where
one would go, then the text. Speech (a human talking to claude, and claude's own replies) has
no glyph at all — `[Name]  text`. The glyph column survives only for the rest:

| line | how it reads |
| --- | --- |
| a human talking to claude | `[Name]  text`, no glyph — your own name green, everybody else's a color hashed from their name (stable across reconnects and roster changes, not tied to join order) |
| claude | `[Claude]  text`, no glyph — the label orange, the text in the default color, with `**bold**` and `` `code` `` rendered |
| `⚙` | a tool call claude just started |
| `⎿` | that tool's result, first line only — more than five in a turn collapse to `⎿ …` |
| `⚙ 4 tools (Bash ×3, Read ×1)` | a finished turn's tool run, folded into one line (`/tools` expands it) |
| human-only `/c` chat | `[Name]  [humans-only] text`, no glyph — label, prefix and text all in one magenta no other line uses; claude never sees these |
| `⚑` | somebody knocking |
| `⌘` | a guest asking to run one of claude's commands (host clients only) |
| `*` | system: joins, leaves, invite lines, who ran what in the TUI, the welcome |
| `!` | an error, in red |

The label column is as wide as the longest name in the room (`Claude` always counted) and is
recomputed whenever the roster changes, so text lines up down the pane whether or not that
line has a glyph. Agent text is word-wrapped to the pane with continuation lines indented to
match the text column. Every message block — a say, a claude turn, a `/c` chat line — gets a
blank line before it, even two in a row from the same sender; a tool call and its result(s)
glue to the claude turn that follows them as one block (the blank line lands before the first
`⚙`, not before each `⎿`), and system/join/typing-expiry lines stay compact with no forced
blank. While claude is working the status row carries a `✻ ✼ ✽` spinner — on a timer that runs
only while busy, and unref'd, so an idle client is completely quiet.

The transcript is append-only (ink's `<Static>`): a line is drawn once and then belongs to the
terminal's own scrollback, so scrolling back is the normal mouse wheel / `Ctrl-b PgUp` and
nothing is ever redrawn under you. Only the live region — mirror frame, chat strip,
in-progress tool lines, status row, pending input lines, input row — is redrawn. The connect
block (welcome, invite lines, onboarding, history replay) is printed into the transcript even
though the live TUI is the opening view, so a first-time guest is not staring at a bare screen
with the instructions hidden behind a keypress.

### Tool collapse

While a turn is running, its `⚙`/`⎿` lines are **live**: the last four of them sit under the
transcript and above the status row, and nothing is written to the transcript yet. When the
turn ends (`busy` goes false, or claude starts a new text block) they fold into one dim line:

```
         ⚙ 7 tools (Bash ×7)
[Claude]  done
```

A turn with a single tool call keeps the old inline `⚙` + `⎿` pair — collapsing one line into
a summary of one line would be silly. `/tools` reprints the last completed turn's full log
into the transcript, `/tools on` switches to always-expanded (every `⚙`/`⎿` goes straight to
the transcript, as before v0.10) and `/tools off` collapses again.

## Tailscale

Bind stays on `0.0.0.0`, and the only auth is the shared token plus your own `/accept` — so
only expose this over Tailscale, a LAN you trust, or an SSH tunnel. Never a public IP: on an
open port, knock-only means every stranger who finds it can make your client flash `⚑ … wants
to join`, and a shared token is one paste away from whoever a friend forwards it to. If
Tailscale is installed the
join line already uses the Tailscale IP (`tailscale ip -4`); friends need to be on your tailnet.
`ssh -L 7777:127.0.0.1:7777 host` works just as well.

## How it works

The daemon injects friend messages into the real TUI with `tmux load-buffer` +
`paste-buffer -p` (bracketed paste, so multi-line stays one message), waits for the text to
actually appear in the pane, and only then sends Enter. Text never passes through a shell or
argv. Output comes back by tailing `~/.claude/projects/*/<session-id>.jsonl`. Turn boundaries
come from `Stop` / `Notification` hooks in a generated `settings.json` passed with `--settings`,
so nothing global is touched. Those hooks authenticate with `JAM_HOOK_SECRET` — an internal
secret generated per run and handed to `claude` in its env, never to a friend — so `/token
new|off` cannot break the turn-status round trip. The hook endpoint is loopback-only on top.

Three more paths reach the pane, all of them typed in by the daemon and never through a shell:
a slash command (`send-keys -l` + Enter, host+loopback, or a guest's after approval), F3 raw
keys (`send-keys -H` hex / `-l` literal, host+loopback only, size-capped) and the window resize
the host's client asks for (`resize-window`). The live view reads it back with
`capture-pane -e`. Everything a guest can send is either sanitized (messages, chat) or gated
(commands, keys, resize) — the wire frames are `say`/`chat`/`typing`/`mirror`/`slash`/`cmd`/
`key`/`resize`/`admit`/`token` in, and `welcome`/`roster`/`say`/`chat`/`typing`/`agent`/
`status`/`screen`/`knock`/`cmdreq`/`token`/`sys`/`error` out.

## Testing

`node --test test.mjs` covers the pure functions in `lib.mjs` — 99 tests: JSONL classification
including tool results, sanitizer, name, prefix, UUID and token-value validation, hello
classification, join/view line building, view-key rule, ttyd resolution, `token.json` shape,
client command parsing (`/mirror`, `/tools`, `/help` included), settings builder, popup
argv/badge/keypress rules, config-dir normalisation, the JSONL glob list, the claude pane
target, the cmux client command, the rendering logic (label-column width, word wrap,
markdown-lite, the tool-result cap, per-name color hashing and its palette exclusions, the
message-block separation rule, screen-row sanitising, the frame diff/coalesce decision, the
mirror's fit-to-terminal rule, tool-name extraction and turn summaries, the key-sequence
extractor and the onboarding block), and the tunnel URL parser / join-line derivation
(`parseTunnelUrl` against a real cloudflared banner, `buildTunnelJoinLine`,
`buildTunnelViewUrl`, `tunnelJoinLines`).

Five end-to-end smokes, all verified 2026-08-28 on node 24 / tmux 3.7c / claude 2.1.251 /
ttyd 1.7.7. The first talks to the agent through a token, the second drives the real ink
client on a pty and asserts what tmux captured, the third streams the terminal mirror, the
fourth exercises admission with no token at all, the fifth the in-TUI popup path (the last two
need no claude turn). Run `smoke-ink.mjs` against a **fresh** daemon: it asserts on what is on
screen, and a daemon with replayed history puts an older turn's collapsed-tool line there.
`--tunnel` was verified separately, end to end, over the real internet — see the
"Public tunnel" testing notes below.

```sh
# zsh: `command -v claude` prints the alias text, not a path — ask for the binary.
JAM_CLAUDE=$(whence -p claude 2>/dev/null || command -v claude) node host.mjs --tmux jamtest --port 7799 \
  --view-port 7801 --name Host --token smoketoken --cwd "$PWD" --no-attach -- --model haiku
node scripts/smoke-ink.mjs ws://127.0.0.1:7799 smoketoken jamtest   # first: needs empty history
node scripts/smoke.mjs ws://127.0.0.1:7799 smoketoken
node scripts/smoke-mirror.mjs ws://127.0.0.1:7799 smoketoken
tmux kill-session -t jamtest          # exact name only, never a pattern
rm -rf "$TMPDIR/claude-jam-7799"

JAM_CLAUDE=$(whence -p claude 2>/dev/null || command -v claude) node host.mjs --tmux jamtest --port 7799 \
  --name Host --cwd "$PWD" --no-attach -- --model haiku      # no --token: knock-only
node scripts/smoke-knock.mjs ws://127.0.0.1:7799
tmux kill-session -t jamtest
rm -rf "$TMPDIR/claude-jam-7799"

# in-TUI knock approval; --hook-secret so the smoke can POST /admit like the popup does
JAM_CLAUDE=$(whence -p claude 2>/dev/null || command -v claude) node host.mjs --tmux jamtest --port 7799 \
  --name Host --hook-secret smokehooksecret --cwd "$PWD" --no-attach -- --model haiku
node scripts/smoke-popup.mjs ws://127.0.0.1:7799 jamtest 7799 smokehooksecret
tmux kill-session -t jamtest
rm -rf "$TMPDIR/claude-jam-7799"
```

`smoke-ink.mjs` runs a second client ("Dana") in a 120x40 tmux session of its own (created and
killed by the script — never the host's), drives a scripted peer ("Eli") over raw WS, and
asserts on `capture-pane` output — 13 steps, all passing: the welcome block plus a clean
`Dana ❯` row; the onboarding box above the roster line, with `/c`, `F2 or /mirror`,
`Shift+Enter or \`, `just ask claude` and `attributed [Dana]` in it; `Eli joined`;
`[Eli]  [humans-only] …` in its own block; `Eli is typing…` right-aligned on the status row
(and NOT in the prompt row); four captures 300 ms apart showing the spinner move on the status
row while the prompt row stays put; a `⚙ Read` + `⎿` + `[Claude]` block glued together and
NOT collapsed (one tool call); a seven-`Bash` turn showing ≤ 4 live tool rows just above the
status row while it runs and exactly one `⚙ 7 tools (Bash ×7)` line after it, with no `⚙ Bash`
left in the transcript; `/tools` bringing all seven back (`last turn's tools (7)`); the raw
bytes `ESC[13;2u` and `ESC CR` sent mid-composition adding pending lines instead of submitting
(`Dana … ❯` with the lines dim above it) and plain Enter then sending all three as one
`first line\nsecond line\nthird line`; `/help` printing a second onboarding box; a real `F2`
keypress bringing up the host TUI (matched on `❯ [Eli]: …`, which only claude's own screen
renders) with `[mirror]` on the status row, a chat line arriving during the mirror showing in
the overlay and landing in the transcript after `F2` back; and finally the v0.9 layout — one
pane in the `claude` window, a `chat` window, `Host ❯` last in it.

`smoke-mirror.mjs` drives two scripted clients and asserts: a client that never subscribes
gets no frames; `{t:'mirror',on:true}` delivers the current screen at once (142x50, 50 rows,
SGR sequences intact, i.e. `capture-pane -e`); an injected marker shows up in the mirrored
rows (`❯ [Watcher]: mirrormark-… `); the stream stays at 1.3–2 frames/s with no two frames
closer than 200 ms while the TUI animates; `{t:'mirror',on:false}` stops it dead (zero frames
in the next 2 s, including after a chat line changes the screen); and `hello {mirror:true}`
subscribes from the first frame.

`smoke-popup.mjs` runs knock-only and asserts: a knock sets `status-right` to `⚑ 1 waiting`
and takes the popup decision (spawned, or skipped with nobody attached); `POST /admit` with a
wrong secret is a 403 and admits nobody; with the right secret it welcomes the knocker and
puts `status-right` back to exactly the value it had before; an unknown name is a 404;
`popup.mjs` exits by itself when its TTL elapses; `a` on its stdin admits through the real
daemon, `d` denies (close 4403), `i` leaves the knock pending so a later `/admit` still
works, and a popup for an already-answered knock prints `too late (404)`.

The popup itself needs a real tmux client attached, which a `--no-attach` smoke has not got.
Verified by hand with a pty client attached to `jamtest`: the box renders over the claude
window (`⚑ Ruth wants to join (127.0.0.1)` / `[a]ccept · [d]eny · [i]gnore/Esc`), `a` typed
into it admits Ruth and restores `status-right`; two knocks show `⚑ 2 waiting` with exactly
one popup open, and answering the first immediately opens the second (`[knock] popup for
Bar`). `--no-popup` on the same setup spawns no popup process, draws nothing and never
touches `status-right`, while `/admit` keeps working.

**The popup needs `-c` (v0.9 finding).** With a viewer's grouped session attached as well,
`display-popup -t <session>` let tmux 3.7c pick *the viewer's* client — the knock box was
drawn in the browser and never on the host's terminal (reproduced with a pty client on
`jamtest` plus a `VIEW_SH` session: `host popup=false badge=true / viewer popup=true`). The
daemon now asks `list-clients -t <session> -F '#{client_name}'` (which lists clients of the
base session only, never of a grouped one) and passes the first as `-c`, logging
`[knock] popup for Bar on /dev/ttys028`. Re-verified after the fix: `host popup=true
badge=true / viewer popup=false badge=false`, and pressing `a` on the host's client still
admits the knocker (`[admit] Bar accepted`) and clears the badge.

**v0.9 viewer surface**, verified with the daemon's own `VIEW_SH` run in a tmux session of its
own against `jamtest` (100x26): the capture holds the Claude Code screen and nothing else —
`status=off` and `destroy-unattached=on` on the viewer session, no session-level `status`
option written on `jamtest` itself, and exactly one pane in the `claude` window. `ttyd` on
`--view-port 7801` serves the page with `-u jam:smoketoken` and 401s on a wrong password.

**v0.9 host chat surface**, both paths: the tmux fallback comes up as `windows: daemon,
claude, chat — window 'chat' — Ctrl-b n toggles chat` with one pane in `claude`; `--split`
gives back `claude` with two panes (52-row TUI + 9-row client, no `chat` window) and
`smoke.mjs` still round-trips through it, so the `claude.{top}` target is right. The cmux path
was exercised against a stub `cmux` on `$JAM_CMUX` with `CMUX_SURFACE_ID` set (no real panes
opened): the launcher calls `identify --json`, then `--json new-split down --surface <id>`,
then `send --surface surface:99 -- '<node>' '<client.mjs>' 'ws://127.0.0.1:7805' --name 'Host'
--token 'smoketoken' --host`, reports `your client is the cmux split below this surface`, and
creates no `chat` window. A stub that fails `new-split` falls back to the `chat` window, as
does a host who is not inside cmux (no `CMUX_SURFACE_ID`) or passes `--no-cmux`.

**`--basic`** was checked against the same daemon: the onboarding block prints on connect with
its `(--basic: F2/Shift+Enter and /tools are ink-only …)` footer, `/help` reprints it,
`/mirror` answers `the mirror view is ink-client only — run without --basic` and `/tools`
`tool lines are always inline in --basic`.

`--config-dir` verified the same way: `--config-dir "$TMPDIR/jam-cfg-test/"` (trailing slash
on purpose) beats the launcher's own `CLAUDE_CONFIG_DIR`, logs
`claude profile: …/jam-cfg-test` with no trailing slash plus both `tail globs:`, and `ps eww`
on the claude process shows `CLAUDE_CONFIG_DIR=…/jam-cfg-test`. That fresh profile opens its
own first-run onboarding, as documented. Dropping a transcript at
`<config-dir>/projects/<slug>/<session-id>.jsonl` is picked up and broadcast, so the second
glob really is tailed.

The split layout (now `--split`, opt-in) and the restyle were verified by hand on the same
setup (pty client attached to `jamtest`, `--model haiku`): the `claude` window comes up with
two panes (TUI + a 9-row client, no third window), injection/capture/Enter all hit the top
pane, a knock popup draws over the split and `a` in it admits the knocker, and the resize
hooks hold the chat pane at 9 rows when a differently-sized client attaches. A turn with tool
calls renders `⚙` / `⎿` lines, seven results collapse to five plus one `⎿ …`, `**bold**` and
`` `code` `` come out as ANSI, prompt-row captures 300 ms apart show different spinner frames,
and admitting a `Konstantina` widens the label column live. Without `--split` the client gets
its own `chat` window (or a cmux split), no hooks are set, and `smoke.mjs` still passes.

The v0.5.1 rendering feedback round was verified the same way (`jamtest`, `--model haiku`, a
scripted two-friend exchange): `Ruth` and `Bar` render in two different hashed colors (183 and
81) that stay the same on every line they send; the `/c` line renders `[Ruth]  [humans-only]
psst, this line is humans-only` entirely in magenta 213; no line for a human or for `[Claude]`
carries a glyph, just `[Name]  text`; and a blank line lands before Ruth's first say, before
her chat line, before Bar's say, and before the `⚙ Bash: {"command":"pwd",…}` block — while the
`⚙`/`⎿`/`[Claude]` reply that follows stays glued as one block with no blank line inside it, and
the `* Ruth joined` / `* Bar joined` system lines forced none of their own.

The v0.6 ink client is covered by `smoke-ink.mjs` above plus a hand pass on the same setup
(`jamtest`, `--model haiku`, keys sent with `tmux send-keys -l`): `/quit` exits 0, Ctrl-C exits
0, a bad name closes 4400 and the client prints `! rejected: bad name` and exits 1, a dead port
logs `disconnected, retrying in 1s / 2s / 4s`, a trailing `\` turns the prompt into `Multi … ❯`
and the next line flushes both as one `[humans-only]` block with the second line hanging under
the first, `/token new` from a friend answers `! host only` and `/compact` answers `! slash
commands run only in the host TUI`, a knock renders `⚑ Konstantina wants to join (127.0.0.1) —
/accept …` and `/accept Konstantina` admits her while widening the label column live, `/join`
and `/token set` reprint the invite line unwrapped, and `--basic` (plus a piped stdin) falls
back to the readline renderer against the same daemon.

The live view and the token context are checked with curl and the hook script directly
(verified 2026-08-28 on ttyd 1.7.7 — note 1.7+ is read-only by default, so no `-R` flag):

```sh
curl -su jam:smoketoken     http://127.0.0.1:7800/ | head -c 40   # ttyd HTML
curl -so /dev/null -w '%{http_code}\n' -u jam:wrong http://127.0.0.1:7800/   # 401
cat "$TMPDIR/claude-jam-7799/token.json"                          # {token, join, viewUrl}
JAM_STATE="$TMPDIR/claude-jam-7799" JAM_PORT=7799 JAM_HOOK_SECRET=x \
  JAM_HOST_NAME=Host JAM_NODE=$(command -v node) ./hooks.sh session-start </dev/null
```

After a `/token set rotatekey-1` the old key 401s and `jam:rotatekey-1` 200s (the daemon
restarts its own ttyd child by pid); `tmux kill-session -t jamtest` takes that child with it.
A real ttyd websocket connection creates `jamtest-view-<pid>` pinned to the `claude` window
with `destroy-unattached on`, keeps that window while the host switches to another, ignores
anything the viewer types, and disappears on disconnect. Asking the agent *"what is the join
token?"* from the TUI answers with the token, join command and view URL.

`smoke.mjs` asserts the JSONL contains `[Tester]: …`, an `agent` text event contains `pong`,
and a `status busy:false` arrives after the Stop hook. `smoke-knock.mjs` prints PASS/FAIL per
step for: a loopback `host:true` hello welcomed with no token, a friend without a token
knocking, a pending socket refused when it tries to talk, `/accept` welcoming it into the
roster, a duplicate name closed 4409, `/token set` replying with the new join line, a friend
with that token admitted directly, and a wrong token knocking then denied with 4403.

**Public tunnel**, verified 2026-08-28 on `cloudflared` 2026.8.2 against the real
`trycloudflare.com` edge (`jamtest` on port 7799, `--view-port 7801 --tunnel`): both quick
tunnels came up within 10 s of launch, logged as `tunnel (ws) up: <host>` / `tunnel (view) up:
<host>` in the daemon window, and the console block reprinted with `tunnel invite:` /
`tunnel view:` first, the LAN `invite:`/`view:` lines below. `token.json` held all five keys
including `tunnelJoin`/`tunnelView`, and `hooks.sh session-start` folded both into claude's
context (`tunnel join command: …; tunnel live view: …`). A scripted client dialed the real
`wss://<host>.trycloudflare.com` tunnel with the token and completed a `say` → `pong` round
trip indistinguishable from the LAN path (`smoke.mjs` unmodified, pointed at the tunnel URL);
`curl -u jam:<key> https://<host2>.trycloudflare.com/` returned the ttyd HTML (200) and a
wrong password 401'd, through the tunnel. `/token new` from a loopback host connection
rotated the token/key in both `join`/`view` and `tunnelJoin`/`tunnelView` while the tunnel
*hostnames* stayed byte-for-byte identical, confirming rotation never touches them.
`kill -9`ing the ws tunnel's own pid produced `tunnel (ws) exited (cloudflared code null) —
its join/view URL is cleared`, dropped `tunnel invite:` from the console block and
`tunnelJoin` from `token.json` (the view tunnel, untouched, kept working), and did not
respawn it. `tmux kill-session -t jamtest` took both remaining `cloudflared` pids and the
ttyd pid down with it (confirmed via `ps aux`), leaving the user's own unrelated `jam`
session on :7777 untouched throughout. `--tunnel` with `cloudflared` removed from `PATH`
exited 2 with `cloudflared not found on PATH. --tunnel needs it: brew install cloudflared`
before any tmux session was created. The plain LAN smoke (`smoke.mjs` against
`ws://127.0.0.1:7799`) still passed unmodified on the same `--tunnel` daemon.

## Known ceilings (deliberate)

- tmux slightly degrades Claude Code visuals — paler colors, OSC notifications lost.
- The JSONL format is officially unstable. All parsing lives in `parseJsonlLine` in `lib.mjs`,
  so a format change is a one-place fix.
- A message injected mid-response is queued by Claude Code as the next turn, not merged.
- `busy` is inferred; the `Stop` hook is the only authoritative end-of-turn signal. It fires
  before claude has flushed the turn's last record, so the `Stop` handler drains the JSONL
  tail until the file goes quiet (≤ 2 s) and only then pushes `busy:false` — so the final
  `agent` text now always arrives before `busy:false`, instead of ~300 ms after it.
- Injection verifies by looking for the message's own first visual line (up to 40 chars, less
  on a narrow pane) in the pane, so two identical consecutive messages could match a stale
  echo. Nonce-prefix it if that ever bites.
- Friends cannot answer permission prompts or run slash commands; only the host's TUI can.
- Admission is per person (`/accept`), but there are still no per-friend credentials: once in,
  everybody is equally trusted, and `/deny` cannot kick somebody who is already admitted.
- A knock popup that is answered elsewhere (a client's `/accept`, or the knock expiring) stays
  on screen until a key or its TTL closes it, and it holds the queue while it is there — the
  daemon is the source of truth, so it just gets a 404. A knock that arrives while nobody is
  attached gets no popup at all, and none is re-opened when a client attaches later.
- `status-right` is snapshotted once, when the daemon starts. Changing it yourself while jam
  is running means the next restore puts the daemon's snapshot back, not your newer value.
- The 9-row chat pane (`--split` only) is held by hooks on **client** events of the jam
  session. A ttyd viewer attaching at another size resizes the shared window from its own
  (grouped) session, whose hooks are not ours, so the split can drift until your own client
  next attaches or resizes — which puts it straight back. Resizing the pane yourself is undone
  the same way. Grouped sessions also shrink the shared `claude` window to the smallest
  attached client, viewers included — that is tmux, not jam, and it applies to the mirror too.
- The cmux split is opened once, at launch. Close it and the host has no chat client until the
  next `jam host` (the daemon does not watch for it); `cmux new-split` also has no
  "run this command" flag, so the client command is typed into the new shell — a shell that
  refuses to run it (a broken rc file) leaves an idle split behind.
- More than five tool results in one turn collapse to a single `⎿ …`; the full output is in
  the host's TUI, and the count resets on the next turn.
- The live tool region shows the last four `⚙`/`⎿` lines, and which of the two you see is up
  to the turn: seven `tool_use` blocks in ONE assistant record arrive together, so the four
  newest lines can all be `⎿` results. `/tools` after the turn has the whole list.
- `/tools` remembers one turn — the last completed one. A summary line scrolled off the screen
  cannot be expanded again; the host's TUI keeps everything.
- The mirror streams the pane as it is, so a guest with a shorter terminal sees the **bottom**
  of it and a host pane much taller than the guest's window looks half empty (that blank space
  is really there). Cropping is reported, never compensated for; the `⚙`/status rows and the
  input box are always in the kept part, which is what a watcher wants.
- Mirror frames are not history: a client that flips to the mirror before the first frame
  arrives sees `waiting for the host's screen…` for up to 250 ms, and a reconnect re-subscribes
  from scratch. Nothing older than "now" is ever streamed.
- The transcript printed before the mirror went up stays on screen above the frame (`<Static>`
  output belongs to the terminal, not to ink). Lines that arrive *during* the mirror are held
  back and flushed on the way out, so ordering survives, but the frame is drawn under whatever
  was already there.
- The key filter holds a partial escape sequence only when it is longer than one byte, so a
  chunk boundary falling exactly after the `ESC` of `ESC[13;2u` leaks `[13;2u` as text. A
  terminal writes a sequence in one `write()`, so this has not been observed; the alternative
  (holding a lone `ESC`) would swallow the Escape key.
- `Shift+Enter` needs a terminal that actually sends `ESC[13;2u` / `ESC[27;2;13~` (kitty,
  Ghostty, WezTerm, iTerm2 with CSI-u on, tmux passing them through); `Option+Enter` needs
  Alt-as-ESC. A trailing `\` is the mechanism that works everywhere, and `--basic` has only
  that one.
- The mirror, the tool collapse and the newline keys are ink-only: `--basic` appends lines and
  never redraws, and it reads stdin through readline instead of the key filter.
- Markdown-lite is applied per logical line, so a `**bold**` or `` `code` `` span that straddles
  an explicit newline renders with its markers visible instead of styled. (In `--basic` it is
  applied per already-wrapped line, so a soft wrap breaks a span there too.)
- The transcript is append-only, so a line keeps the label-column width and the terminal width
  it was drawn at: widening the column (a long name joining) or resizing the terminal aligns
  everything from that point on, not what is already on screen. Redrawing history is what
  `<Static>` exists to avoid.
- The invite/view lines are handed to the terminal unwrapped on purpose, so they stay one
  selectable run. On a pane narrower than the line (~85 columns) that means a soft wrap; the
  copy is still whole, but a terminal that does not reflow on copy will paste a newline into
  the command.
- ink needs raw mode on stdin. With a pipe or a heredoc the client falls back to `--basic`
  automatically; a terminal ink dislikes for any other reason needs the flag by hand.
- `--config-dir` picks the profile; it cannot log it in. A brand-new profile lands in claude's
  first-run onboarding, which only you can answer, in the `claude` window.
- The token-in-context guard ("reveal only to the host") is an instruction to the model, not
  a boundary — see [Token in claude's context](#token-in-claudes-context). And a `kill -9` of
  the daemon orphans the ttyd child — see [Live view](#live-view-ttyd).
- `--tunnel`: a dead `cloudflared` child is never auto-restarted (v0 ceiling) — its line just
  disappears from `/join`/the daemon log until the host restarts with `--tunnel` again. The
  tunnel hostnames are fixed for the daemon's whole life; only `/token` off/on can drop or
  regenerate the *credential* inside the URL, never the host itself. Cloudflare's edge
  terminates TLS, so it (and anyone who can see its logs) is a party to the connection the
  same way any TLS-terminating proxy is — the join token / knock approval is what actually
  gates who gets in, same trust model as the LAN case. No IP allow-listing on a quick tunnel:
  the URL itself is the only thing standing between a stranger and a knock/wrong-token attempt.
- No rate limiting, no web client, single session per host, no Windows.
- First run in a fresh directory hits claude's "is this a folder you trust?" dialog. Before
  every injection until one succeeds, the daemon waits up to 30 s for either that dialog (it
  answers it, moving off the "No, exit" default first) or the input prompt — so a message sent
  while claude is still booting still lands.

## Phase 2 sketch (not built)

Same protocol, no inbound port on the host. A small relay runs somewhere public; the host
daemon connects **outbound** with `{t:'hello', role:'host', room, token}`, friends connect to
the relay with the same `room`, and the relay just forwards frames both ways. Client and host
message handling stay exactly as they are — only the transport endpoint changes, plus a
`--relay wss://…/room` flag on both sides.
