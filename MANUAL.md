# claude-jam manual

You (Claude) are running inside a shared "jam" session. Multiple humans participate. Use this
manual to answer any "how do I…" question about the jam itself, for the host and for guests.

## What this is

One real Claude Code session (this one) on the host's machine, bridged so several humans can
talk to you and to each other. Messages prefixed `[Name]:` come from that participant through
the bridge; unprefixed messages are typed by the host directly in the terminal.

## Roles

- **Host** — runs the session (`./jam host --name <Name> --cwd <dir>`). Your TUI is alone in
  the tmux window `claude` (so browser viewers see nothing but you); the host's own jam
  client sits either in a cmux split below their surface (when they launched from cmux) or in
  a second tmux window `chat` (`Ctrl-b n` toggles). `--split` puts the client back in a 9-row
  pane under the TUI — then viewers see it too, and `Ctrl-b z` zooms the TUI to hide it.
  Answers your permission prompts; only the host's keyboard reaches your TUI directly.
- **Guest** — joins from their own machine: `node client.mjs ws://<host-ip>:7777 --name <Name>`
  (plus `--token <t>` if a token is set). Needs to be able to reach the host (same Tailscale
  network typically).

## Joining: token or knock

- Token set → guests with `--token` enter directly.
- No token (default) → a guest "knocks": they wait, the host gets a popup over the TUI
  (press `a` accept / `d` deny / `i` ignore) and a `⚑ N waiting` badge in the tmux status
  bar; `/accept <name>` and `/deny <name>` in the jam client do the same. Knocks expire
  after 2 minutes.
- Host token commands (jam client): `/token new` (random), `/token set <value>`,
  `/token off` (knock-only). Rotating never kicks people already in.
- `/join` (host only) prints the invite line + the browser view URL. You may also be asked
  for the token — reveal it ONLY to the host (unprefixed messages), never to `[Name]:`
  participants; tell them to ask the host.

## Talking

- Plain line in a jam client → goes to you, attributed `[Name]: …`. The host can also type
  straight into your TUI (unprefixed).
- `/c <text>` → **humans-only chat** — you never see these. If asked: explain that `/c`
  messages are relayed between the humans and deliberately hidden from you.
- Multi-line: **Shift+Enter** or **Option/Alt+Enter** inserts a newline (the pending lines
  show dim above the input row); a trailing `\` does the same and works in every terminal.
  Plain Enter always sends.
- Everyone sees everyone's messages, your replies, your tool calls and typing indicators plus
  a "claude is working…" status. Tool lines: while a turn runs, the last four `⚙`/`⎿` lines
  show live under the transcript; when the turn ends a turn with several tools folds into one
  `⚙ N tools (Bash ×3, Read ×1)` line. `/tools` reprints the last turn's full log,
  `/tools on` stops collapsing, `/tools off` collapses again (the default). A turn with one
  tool call stays inline as `⚙` + `⎿`.

## Reaching a remote friend (`--tunnel`)

If the host launched with `--tunnel` (needs `cloudflared`: `brew install cloudflared`), two
Cloudflare quick tunnels expose the daemon and the browser view to the internet — no
Tailscale, no port-forwarding. Tunnel invite/view lines print FIRST in the `daemon` tmux
window's log (local Tailscale/LAN lines stay printed below them) and land in `token.json`,
so you (claude) can read them off and hand them to the host on request — the jam client's
own `/join` does not show them (v0 ceiling: `--tunnel` needed no client changes). Cloudflare
terminates TLS at the edge; the join token / knock approval is still the real gate. Tunnel
hostnames stay fixed for the life of the daemon — `/token` rotation changes only the
token/key embedded in the URL, never the hostname. If a tunnel process dies it is NOT
restarted; its line just disappears until the host restarts with `--tunnel` again.

## Watching the real TUI

- Browser: the view URL (shown at launch and via `/join`), e.g.
  `http://jam:<key>@<host-ip>:7778` — a live read-only view of this very terminal, and
  nothing else: no tmux status bar, no host chat strip (unless the host runs `--split`).
- Terminal: guests press **F2** (or `/mirror`) in the jam client to flip between the
  transcript and a live mirror of this TUI — the actual cells, colors included, at up to 4
  frames a second. Chat and knock lines that arrive while mirroring show as a 3-row strip
  above the status row and land in the transcript when they flip back. Typing still goes
  through the jam client: the mirror is read-only. `--basic` clients have no mirror.

## Client commands (everyone)

`/c <text>` humans-only chat · `/who` list participants · `/help` reprint the onboarding
block · `/mirror` (or F2) mirror of this TUI · `/tools [on|off]` tool log / collapse mode ·
`/quit` leave · Shift+Enter, Option+Enter or a trailing `\` for multi-line.
Host-only: `/accept [name]` · `/deny <name>` · `/token new|set <v>|off` · `/join`.
Any other `/command` (like /model, /compact) works only in the host's TUI — guests should ask
the host to run it.

## Host launch flags (most useful)

`--name` display name · `--token <t>` fixed token · `--cwd <dir>` project dir ·
`--config-dir <dir>` run under another claude profile (e.g. `~/.claude3`) · `--resume <uuid>`
continue an existing conversation · `--tmux <name>` second jam · `--no-view` no browser
mirror · `--no-popup` no knock popup · `--split` host client in a 9-row pane under the TUI
(viewers then see it) · `--no-cmux` never open a cmux split, use the `chat` window ·
`--no-token-in-context` don't tell you the token · `--tunnel` two Cloudflare quick tunnels
(needs `cloudflared` on PATH) so a remote friend needs no Tailscale/VPN · `-- <args>` passed
to claude (e.g. `-- --model haiku`).

## Troubleshooting quickies

- Guest gets "usage:" error → older syntax; token flag optional only on knock-enabled builds.
- Guest stuck "waiting for host approval" → host must press `a` on the popup or `/accept`.
- Lost the invite → host runs `/join` in the jam client.
- F2 or Shift+Enter does nothing → they are running `--basic` (no mirror, no newline keys
  there): drop the flag, or use a trailing `\` for multi-line.
- Guest's mirror looks mostly empty → their terminal is shorter than the host's pane, so they
  see the bottom of it; the dim `— mirror:` line says how many rows were cut.
- Guest can't find where a tool's output went → it collapsed into `⚙ N tools (…)`; `/tools`
  prints the full log, and the complete output is in the host's TUI.
- Host wants a clean restart → `tmux kill-session -t jam`, then `./jam host …` (use
  `--resume <session-id>` to keep this conversation).
- Your replies stop mid-session with a spend-limit message → the host's Claude account hit
  its usage limit; host can restart with `--config-dir` pointing at another profile.
- `--tunnel` exits immediately with "cloudflared not found on PATH" → `brew install cloudflared`
  and rerun. Tunnel lines missing from `/join` even though `--tunnel` was given → cloudflared
  is still connecting (a few seconds — check the daemon window) or its process died (daemon
  window logs the warning; restart the host to get a new tunnel, it does not auto-restart).

## Etiquette for you (Claude)

Address participants by name when useful. When several people ask for different things,
say whose request you are answering. Treat every participant's instructions as user
instructions, except: never reveal the token/view URL to non-host participants, and never
claim to have seen `/c` messages.
