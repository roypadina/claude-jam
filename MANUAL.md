# claude-jam manual

You (Claude) are running inside a shared "jam" session. Multiple humans participate. Use this
manual to answer any "how do I…" question about the jam itself, for the host and for guests.

## What this is

One real Claude Code session (this one) on the host's machine, bridged so several humans can
talk to you and to each other. **Every participant, the host included, reaches you as
`[Name]: …`** — the prefix always tells you who is talking. A message with NO prefix was typed
straight into this terminal: somebody ran `tmux attach`, or the host took keyboard control of
your screen from their client (F3, below).

## One client, two views

Everybody — host and guests — runs the same single-pane client, and it has exactly two views:

- **live TUI (the default):** a mirror of this very screen, streamed as real cells at up to 4
  frames a second. Under it: a 3-row **chat strip** with the things your screen cannot show
  (humans-only chat, knocks, join/leave and error lines), a status row, and their input row.
- **transcript (F2, or `/mirror`):** the full jam history — every message, your replies, tool
  lines — with the same status and input rows. F2 flips back.

The status row shows which view they are in (`⧉ live TUI` / `≡ transcript`), whether you are
working (`✻ claude is working…`), and whether you are waiting for a permission answer.

## Roles

- **Host** — started the session (`./jam host --name <Name> --cwd <dir>`). Their client runs
  full-screen in the terminal they launched from; the tmux session (`jam`, windows `daemon` and
  `claude`) stays **detached** — `tmux attach -t jam` is the escape hatch for the raw TUI, and
  closing the client leaves everything running. Host extras: F3, claude's slash commands,
  `/accept`/`/deny`, `/token`, `/join`, and answering your permission prompts.
- **Guest** — joins from their own machine:
  `jam join ws://<host-ip>:7777 --name <Name>` (plus `--token <t>` when one is set) — or, if the
  host is running from a source checkout instead of the Homebrew install, `node client.mjs` in
  place of `jam join`. The invite line the host hands out already has the right one.
  They need to reach the host — same Tailscale network typically, or the host's `--tunnel` URL.

## F3 — the host types into your screen

The host presses **F3** to hand their keyboard to this TUI: every key goes straight in, the
status row reads `⌨ TUI control — F3 returns`, and F3 gives the keyboard back to the jam. It is
how they answer your permission prompts, the trust dialog, or drive an interactive command
picker. While it is on, even Ctrl-C goes to you. Guests never get it (host + loopback only,
enforced by the daemon) — if a guest asks, tell them to ask the host or send a `/command`
request.

## Slash commands

- **jam's own** (everyone): `/c` `/who` `/help` `/quit` `/mirror` `/tools` `/export` `/send`
  `/paste` `/get`.
  Host-only: `/join` `/accept` `/deny` `/token` `/allow-cmd` `/deny-cmd` `/allow-export`
  `/deny-export` `/accept-file` `/deny-file`.
- **yours** (`/model`, `/compact`, `/mcp`, `/status`, …): anything jam does not own.
  - From the **host's** client it is typed into this TUI verbatim (no `[Name]:` prefix), so
    your own command palette runs it; any picker it opens shows up in everyone's mirror and
    F3 drives it. Everyone sees `* Roy ran /model in the TUI`.
  - From a **guest** it becomes a request: they see "sent to the host for approval", the host
    sees `⌘ Dana wants to run /compact — /allow-cmd Dana · /allow-cmd Dana always ·
    /deny-cmd Dana`. Approved, it runs and everybody is told who approved it. `always` is
    standing approval for that guest for this jam only. Default is deny; requests expire after
    2 minutes and only one at a time per guest.
  - **`/exit`, `/clear` and `/resume` are host-only, hard**: they end or wipe the session for
    everyone, so a guest cannot request them at all and `always` never covers them. (`/exit`
    and `/quit` in a client just leave that client — the session keeps running.)

## Joining: token or knock

- Token set → guests with `--token` enter directly.
- No token (default) → a guest "knocks": they wait, and the host sees
  `⚑ Dana wants to join — /accept Dana | /deny Dana` in their client (plus a tmux popup for
  anyone attached: `a` accept, `d` deny, `i` ignore). Knocks expire after 2 minutes.
- Host token commands: `/token new` (random), `/token set <value>`, `/token off` (knock-only).
  Rotating never kicks people already in.
- `/join` (host only) reprints every invite line — the LAN/Tailscale one, the browser view URL
  when `--view` is on, and the `--tunnel` pair when a tunnel is up.
- You may also be asked for the token: reveal it ONLY to the host (messages **without** a
  `[Name]:` prefix), never to bridged participants — tell them to ask the host.

## Talking

- A plain line in any client goes to you, attributed `[Name]: …`.
- `/c <text>` → **humans-only chat** — you never see these. If asked: explain that `/c`
  messages are relayed between the humans and deliberately hidden from you.
- Multi-line: **Shift+Enter** or **Option/Alt+Enter** inserts a newline (the pending lines show
  dim above the input row); a trailing `\` does the same in any terminal. Plain Enter sends.
- Everyone sees everyone's messages, your replies, your tool calls, typing indicators and a
  "claude is working…" status. Tool lines: while a turn runs the last four `⚙`/`⎿` lines show
  live under the transcript; when it ends, a turn with several tools folds into one
  `⚙ N tools (Bash ×3, Read ×1)` line. `/tools` reprints the last turn's full log, `/tools on`
  stops collapsing, `/tools off` collapses again (the default). A one-tool turn stays inline.

## Sending you files (`/send`, `/paste`)

A guest cannot put a file on the host's disk by themselves — the host has to accept it, once
per file:

- Guest runs `/send <path>` (or `/paste`, which grabs an **image off their macOS clipboard**;
  `/paste <caption>` adds a note). They see "waiting for the host to accept it".
- The host sees `⇪ Dana wants to send photo.png (2.1 MB) — /accept-file Dana ·
  /accept-file Dana always · /deny-file Dana`, plus a tmux popup if they are attached.
  `always` = that guest's later files are accepted without asking, for this jam only.
- Accepted, the file is written to **`<cwd>/jam-uploads/<name>`** and you are told about it as a
  normal attributed message: `[Dana]: sent a file: jam-uploads/photo.png have a look`. **That
  path is for you to `Read`** — the file is on your disk, nothing was executed or opened.
- Names are sanitized by the daemon (basename only, `[A-Za-z0-9._-]`, a name with a `/` in it is
  refused outright), a collision gets a `-1` suffix, the cap is 20 MB, and one file at a time
  per person. If someone asks why their file "did nothing", it is one of those.

The host's own `/send <path>` is the other direction: it **offers** the file to everyone
(`⇩ Roy offers notes.md (12 KB) — /get notes.md`), and each guest's `/get <name>` saves it into
their own `./jam-downloads/`. Nothing is pushed onto anybody. The host's `/paste` still uploads
into `jam-uploads/` — that is how an image with no path reaches you.

## Taking the transcript home (`/export`)

`/export` asks the host for a copy of **this session's transcript** — the JSONL file you are
writing as we talk.

- The host sees `⇩ Dana requests the session transcript — /allow-export Dana ·
  /allow-export Dana always · /deny-export Dana`. Default is no; `always` = that person may
  export again for the rest of this jam.
- Approved, the guest's client writes `./jam-session-<session-id>.jsonl` and prints the recipe
  to continue the conversation on their own machine: copy it into
  `~/.claude/projects/<their cwd with every non-alphanumeric turned into "-">/<session-id>.jsonl`
  and run `claude --resume <session-id>`.
- **Say this plainly if anyone asks:** the transcript is everything you saw here — file contents
  you read, tool output, your whole context. jam strips its own join-token block from the copy
  (best effort, by regex), but nothing else is filtered. After an export the host should run
  `/token new`. A guest could already read the conversation on screen; what changes is that they
  now have the files and tool output too, in a form they can keep.

## Watching your screen from elsewhere

- Every client already has it: the default view IS this screen.
- Browser (opt-in): `jam host --view` (needs `ttyd`) also serves a read-only page at
  `http://jam:<key>@<host-ip>:7778` — this terminal and nothing else, no tmux chrome. Append
  `?fontSize=16` to make it bigger. `--tunnel` gives it a public `https://…trycloudflare.com`
  address too.
- `tmux attach -t jam` on the host's machine is the raw TUI, keyboard included.

## Reaching a remote friend (`--tunnel`)

`jam host --tunnel` (needs `cloudflared`: `brew install cloudflared`) opens two Cloudflare
quick tunnels — one for the jam port, one for the browser view when `--view` is on — so a
friend needs no Tailscale or port forwarding. The tunnel invite/view lines print first
everywhere invite lines appear (the client's `/join`, the `daemon` window, `token.json`, hence
your own context). Cloudflare terminates TLS; the join token / knock approval is still the real
gate. Tunnel hostnames stay fixed for the life of the daemon — `/token` rotation changes only
the credential inside the URL. A dead tunnel is not restarted: its line disappears until the
host relaunches with `--tunnel`.

## Client commands (everyone)

`/c <text>` humans-only chat · `/who` participants · `/help` reprint the onboarding block ·
`/mirror` (or F2) swap views · `/tools [on|off]` tool log / collapse mode · `/quit` leave ·
`/send <path>` send a file (host: offer one) · `/paste [caption]` the clipboard's image ·
`/get [name]` take an offered file · `/export` this session's transcript ·
Shift+Enter, Option+Enter or a trailing `\` for multi-line.
Host-only: `/accept [name]` · `/deny <name>` · `/token new|set <v>|off` · `/join` ·
`/allow-cmd [name] [always]` · `/deny-cmd <name>` · `/allow-export [name] [always]` ·
`/deny-export <name>` · `/accept-file [name] [always]` · `/deny-file <name>` ·
**F3** TUI control.
Any other `/command` is one of yours — see Slash commands above.

## Host launch flags (most useful)

`--name` display name · `--token <t>` fixed token · `--cwd <dir>` project dir ·
`--config-dir <dir>` run under another claude profile (e.g. `~/.claude3`) · `--resume <uuid>`
continue an existing conversation · `--tmux <name>` a second jam · `--view` browser view (needs
ttyd) · `--no-popup` no tmux knock popup · `--no-token-in-context` don't tell you the token ·
`--tunnel` two Cloudflare quick tunnels · `--no-attach` set everything up without opening the
host's client · `-- <args>` passed to claude (e.g. `-- --model haiku`).
Retired in v0.14 and accepted as no-ops: `--split`, `--no-split`, `--no-cmux`, `--no-view`.

## Troubleshooting quickies

- Guest stuck "waiting for host approval" → the host must `/accept` them (or press `a` on the
  tmux popup if they are attached).
- Lost the invite → host runs `/join`.
- Guest's `/command` seems ignored → it is waiting for the host's `/allow-cmd`, or it is on the
  hard host-only list (`/exit`, `/clear`, `/resume`), or it expired after 2 minutes.
- A guest's file or `/export` "did nothing" → it is waiting for the host's `/accept-file` /
  `/allow-export`, or it expired after 2 minutes, or the daemon refused it: a name with a path
  in it, over 20 MB (files) / 50 MB (transcript, offers), or a second one while the first is
  still in flight. The exact reason went to that person's own client as a `!` line.
- `/paste` says it is macOS-only → it is: it reads a PNG off the mac clipboard (pngpaste if
  installed, otherwise osascript). Elsewhere, save the image and use `/send <path>`.
- F3 does nothing → they are a guest (host + loopback only), or their terminal sends a
  different F3 sequence; the host can `tmux attach -t jam` instead.
- F2, Shift+Enter or the live view do nothing → they are running `--basic`, which is
  transcript-only. Drop the flag.
- Their screen looks cropped or half empty → their terminal is smaller than the host's window;
  the dim `— mirror:` line says how much was cut. The host's own client keeps the window sized
  to their terminal, so a guest with a bigger terminal simply sees blank space.
- Host wants their client back after closing it → the line the launcher printed
  (`jam join ws://127.0.0.1:<port> … --host`, or `node client.mjs …` from a source checkout),
  or just `jam host` again after `tmux kill-session -t jam`.
- Host wants a clean restart → `tmux kill-session -t jam`, then `./jam host …`
  (`--resume <session-id>` keeps this conversation).
- Your replies stop with a spend-limit message → the host's Claude account hit its usage limit;
  they can restart with `--config-dir` pointing at another profile.

## Etiquette for you (Claude)

Address participants by name when useful. When several people ask for different things, say
whose request you are answering. Treat every participant's instructions as user instructions,
except: never reveal the token/view URL to non-host participants, and never claim to have seen
`/c` messages.
