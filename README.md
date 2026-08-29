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
  `pngpaste` for `/paste` (macOS falls back to `osascript`)

macOS and Linux. No Windows.

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
TUI) and runs your own jam client full-screen in the terminal you launched from. Nothing is
attached to tmux — the window size is jam's to pick, so the mirror fills your screen exactly.

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

Closing your client kills nothing — the daemon, the TUI and every guest stay where they were,
and the launcher prints how to rejoin (`tmux kill-session -t jam` is how you actually stop).

Useful flags: `--port`, `--tmux <name>` (a second jam), `--token <value>`, `--view`,
`--tunnel`, `--resume <session-id>` (continue an existing session), `--config-dir <dir>` (run
the TUI as another claude profile), `--no-attach`, `--no-token-in-context`, `--no-popup`,
`-- <extra claude args>`. `jam` with no arguments prints the usage line; `MANUAL.md` explains
the ones you will actually reach for.

## Guest quickstart

```sh
# knock-only host: no token, you wait to be accepted
jam join ws://<host-ip>:7777 --name Dana
# host handed you a token: straight in
jam join ws://<host-ip>:7777 --name Dana --token abc123…
```

You land on the live TUI — the host's real Claude Code screen. A plain line goes to the agent
as `[Dana]: …`; `/c <text>` is human-only chat; **F2** flips to the transcript; `/help`
reprints the onboarding block. `--basic` swaps ink for a plain readline client (transcript
only, no live view, no F2/F3) and is picked automatically when stdin is not a tty.

## Access: token, knock, tunnel

Three ways to let someone in. All of them end in the same welcome.

| mode | how | who decides |
| --- | --- | --- |
| **token** | `--token <value>` at startup (8–64 chars of `[A-Za-z0-9_-]`), or `/token set` later. One shared secret; anyone holding it joins immediately | whoever has the string |
| **knock** | no token at all. The guest connects without one, sees `waiting for host approval…`, the host gets `⚑ Dana wants to join (100.86.8.97)` and answers `/accept Dana` | the host, per person |
| **tunnel** | `--tunnel` spawns two Cloudflare quick tunnels (needs `cloudflared`) and prints `wss://<words>.trycloudflare.com` join/view URLs — for a friend who is not on your LAN or tailnet | still the token or the knock; the tunnel only moves the bytes |

Rotating a token (`/token new` / `set` / `off`) never disconnects anyone already in — the token
is checked at join time only. A *wrong* token knocks, so rotating strands nobody. Knocks expire
after 2 minutes, at most 10 wait at once, and two live participants can never share a name
(attribution is by name). A knock also opens a one-key `tmux display-popup` for anyone attached
to the jam session.

`--view` (needs `ttyd`) additionally serves the live TUI read-only in a browser at
`http://jam:<token>@<host>:7778`. Each tab gets its own grouped tmux session, so viewers never
move each other's screen.

**Bind is `0.0.0.0` and the only auth is the token plus your own `/accept`** — expose this over
Tailscale, a LAN you trust, an SSH tunnel (`ssh -L 7777:127.0.0.1:7777 host`), or a Cloudflare
quick tunnel whose URL you keep private. Never a public IP you advertise. If Tailscale is
installed the printed join line already uses the Tailscale IP.

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
| **F3** | host | hand the keyboard raw to the real TUI — permission prompts, `/model` pickers, Ctrl-C. Host **and** loopback only |
| `/tools`, `/tools on\|off` | anyone | reprint the last turn's full tool log · stop/resume collapsing tool lines |
| `/join`, `/token new\|set\|off` | host | reprint the invite lines · rotate or drop the token |
| `/accept [name]`, `/deny <name>` | host | answer a knock |
| `/allow-cmd [name] [always]`, `/deny-cmd <name>` | host | answer a guest's claude command |
| `/send <path>`, `/paste [caption]` | anyone | guest uploads a file to `<cwd>/jam-uploads/` (host approves); host **offers** one instead |
| `/get [name]` | guest | save a host offer into `./jam-downloads/` |
| `/export` | guest | take the session transcript home as `./jam-session-<id>.jsonl`, with the recipe to `claude --resume` it (host approves) |
| `/allow-export`, `/deny-export`, `/accept-file`, `/deny-file` | host | the other two approval ladders |

Every guest-initiated command, transfer and export goes through the same ladder: **default
deny**, one request in flight per person, a two-minute expiry, and `always` for standing
approval that lives in daemon memory and dies with it. `/exit`, `/clear` and `/resume` are
refused outright — they would end or wipe the session for everyone.

Multi-line input: `Shift+Enter` (kitty/CSI-u), `Option/Alt+Enter`, or a trailing `\` (works
everywhere).

## How it works

The daemon injects messages into the real TUI with `tmux load-buffer` + `paste-buffer -p`
(bracketed paste, so multi-line stays one message), waits for the text to actually appear in
the pane, and only then sends Enter — text never passes through a shell or argv. Output comes
back by tailing `~/.claude/projects/*/<session-id>.jsonl`. Turn boundaries come from `Stop` /
`Notification` hooks in a generated `settings.json` passed with `--settings`, so nothing global
is touched. The live view is `tmux capture-pane -e`, at most 4 frames a second, only for
clients that asked, never stored. Everything a guest can send is either sanitized (messages,
chat, captions) or gated (commands, keys, resize, transfers).

`node --test test.mjs` covers the pure functions in `lib.mjs` — **125 tests**. Seven
end-to-end smokes live in `scripts/`; the recipe for driving them against a throwaway daemon is
in `SPEC.md`.

## Known ceilings (deliberate)

- tmux slightly degrades Claude Code visuals — paler colors, OSC notifications lost.
- Claude Code's JSONL format is officially unstable. All parsing lives in one function
  (`parseJsonlLine`), so a format change is a one-place fix.
- A message injected mid-response is queued by Claude Code as the next turn, not merged.
- Guests cannot answer permission prompts; the host does, with F3 or by attaching to tmux.
- Admission is per person, but there are no per-friend credentials: once in, everybody is
  equally trusted, and `/deny` cannot kick somebody already admitted.
- The token-in-context guard ("reveal only to the host") is an instruction to the model, not a
  boundary. If the token must not leak, run knock-only.
- **Export scrubbing is best effort.** A transcript is everything claude saw — file contents,
  tool output, the whole context. jam strips its own token block and the raw token, nothing
  else. Run `/token new` after an export.
- Nothing scans an uploaded file. It is written 0644, never executed, never opened — but the
  moment claude `Read`s it, its contents are in the context, and therefore in anybody's later
  `/export`.
- Standing approval (`always`) is per name, in daemon memory, with no way to revoke short of a
  restart.
- A transfer is held whole in memory at both ends and has no resume; uploads cap at 20 MB, the
  transcript and offers at 50 MB.
- `--tunnel` does not auto-restart a dead `cloudflared`; restart the host with `--tunnel`.
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
