# claude-jam manual

You (Claude) are running inside a shared "jam" session. Multiple humans participate. Use this
manual to answer any "how do I…" question about the jam itself, for the host and for guests.

## What this is

One real Claude Code session (this one) on the host's machine, bridged so several humans can
talk to you and to each other. **Every participant, the host included, reaches you as
`[Name]: …`** — the prefix always tells you who is talking. A message with NO prefix was typed
straight into this terminal: somebody ran `tmux attach` — which is also what the host's own
**F3** does (below).

## One client, two views

Everybody — host and guests — runs the same single-pane client, and it has exactly two views:

- **live TUI (the default):** a mirror of this very screen, streamed as real cells. The cadence
  adapts: up to 25 frames a second while somebody is watching and something is moving, back to
  4 a second once it goes quiet, and an unchanged screen sends nothing at all. Under it: a 3-row
  **chat strip** with what your screen cannot show (humans-only chat, join/leave, system and
  error lines), the host's **approval bar** when somebody is waiting for them, a status row, and
  their input row.
- **transcript (F2, or `/mirror`):** the full jam history — every message, your replies, tool
  lines — with the same status and input rows. F2 flips back.

Somebody who joins late is not starting from nothing: the daemon seeds its history from the
transcript file you are writing, so their client replays what happened before they arrived (up
to `--replay` events, 300 by default) and prints
`── history above (N replayed) · live from here ──` under it. On a `--resume`d session that is
the whole earlier conversation, which is why they may already know things nobody told them.

The status row shows which view they are in (`⧉ live TUI` / `≡ transcript`), whether you are
working (`✻ claude is working…`), and whether you are waiting for a permission answer.

## Roles

- **Host** — started the session (`./jam host --name <Name> --cwd <dir>`). Their client runs
  full-screen in the terminal they launched from; the tmux session (`jam`, windows `daemon` and
  `claude`) stays **detached** — `tmux attach -t jam` is the escape hatch for the raw TUI, and
  closing the client leaves everything running. Host extras: F3, the approval bar's one-key
  answers, claude's slash commands, `/accept`/`/deny`, `/token`, `/join`, and answering your
  permission prompts.
- **Guest** — joins from their own machine:
  `jam join ws://<host-ip>:7777 --name <Name>` (plus `--token <t>` when one is set) — or, if the
  host is running from a source checkout instead of the Homebrew install, `node client.mjs` in
  place of `jam join`. The invite line the host hands out already has the right one.
  They need to reach the host — same Tailscale network typically, or the host's `--tunnel` /
  `--funnel` URL.

## F3 — the host attaches to your screen

The host presses **F3** and their client hands the whole terminal to `tmux attach -t <jam>:claude`
— this very screen, at native speed, with nothing in between: permission prompts, the trust
dialog, an interactive `/model` picker, the mouse, even Ctrl-C. **`Ctrl-b d` gives the terminal
back to their jam client** (that is tmux's detach, not jam's), and their mirror picks up where it
left off. Until v0.15 F3 proxied each keystroke over the network and waited for the next frame,
which was 300-500 ms per key; now there is no proxy at all. While the host is attached their
mirror is paused, so guests keep watching but the host's own client is not on screen.

Guests never get F3 (host + loopback only, enforced by the daemon) — if a guest asks, tell them
to ask the host, or to send a `/command` request. `tmux attach -t jam` by hand does the same
thing as F3 and always did.

## Slash commands

- **jam's own** (everyone): `/c` `/who` `/help` `/quit` `/mirror` `/tools` `/export` `/send`
  `/paste` `/get` `/files` `/diff`.
  Host-only: `/join` `/accept` `/deny` `/token` `/allow-cmd` `/deny-cmd` `/allow-export`
  `/deny-export` `/accept-file` `/deny-file`.
- **yours** (`/model`, `/compact`, `/mcp`, `/status`, …): anything jam does not own.
  - From the **host's** client it is typed into this TUI verbatim (no `[Name]:` prefix), so
    your own command palette runs it; any picker it opens shows up in everyone's mirror and
    F3 drives it. Everyone sees `* Roy ran /model in the TUI`.
  - From a **guest** it becomes a request: they see "sent to the host for approval", the host
    sees `⌘ Dana wants to run /compact — /allow-cmd Dana · /allow-cmd Dana always ·
    /deny-cmd Dana`, and the same request in their approval bar, where `a` allows it once.
    Approved, it runs and everybody is told who approved it. `always` is standing approval for
    that guest for this jam only. Default is deny; requests expire after 2 minutes and only one
    at a time per guest.
  - **`/exit`, `/clear` and `/resume` are host-only, hard**: they end or wipe the session for
    everyone, so a guest cannot request them at all and `always` never covers them. (`/exit`
    and `/quit` in a client just leave that client — the session keeps running.)

## Joining: token or knock

- Token set → guests with `--token` enter directly.
- No token (default) → a guest "knocks": they wait, and the host sees
  `⚑ Dana wants to join — /accept Dana | /deny Dana` in their client. Knocks expire after
  2 minutes.
- **The approval bar (v0.16).** Every request waiting for the host — a knock, a guest's
  `/command`, an `/export`, a file — also raises one row just above the host's status row:
  `⚑ Dana wants to join (100.86.8.97) · [a]ccept [d]eny [i]gnore · 2:00`, counting down to that
  request's expiry, with `+N more` when several wait. **`a` accepts, `d` denies, `i` or Esc
  hides the bar** (the request keeps waiting). Those keys work only while the host's input line
  is empty: the first character they type turns them off until Esc, so typing can never approve
  anything by accident. It runs the very same commands as `/accept` and friends. Anyone attached
  to the tmux session still gets the one-key popup as well; whoever answers first wins.
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
  /accept-file Dana always · /deny-file Dana`, gets the approval bar (`⇪ … [a]ccept [d]eny`,
  one key), plus a tmux popup if they are attached.
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
  /allow-export Dana always · /deny-export Dana`, and the same request in the approval bar
  (`⇩ … [a]ccept [d]eny`). Default is no; `always` = that person may export again for the rest
  of this jam — which needs the typed command, since one key never grants standing approval.
- Approved, the guest's client writes `./jam-session-<session-id>.jsonl` and prints the recipe
  to continue the conversation on their own machine: copy it into
  `~/.claude/projects/<their cwd with every non-alphanumeric turned into "-">/<session-id>.jsonl`
  and run `claude --resume <session-id>`.
- **Say this plainly if anyone asks:** the transcript is everything you saw here — file contents
  you read, tool output, your whole context. jam strips its own join-token block from the copy
  (best effort, by regex), but nothing else is filtered. After an export the host should run
  `/token new`. A guest could already read the conversation on screen; what changes is that they
  now have the files and tool output too, in a form they can keep.

## Seeing what changed (`/files`, `/diff`)

Anybody can ask what this session has actually touched. Both are answered by the daemon, not by
you, so they cost no turn and never enter your context:

- **`/files`** — every path a `Read`, `Write`, `Edit` or `MultiEdit` call named, newest first,
  with how many times each was touched (`×2  lib.mjs`). Paths inside the project are shown
  relative to it. Only the asker sees the answer. It knows nothing about a file changed by a
  shell command inside a `Bash` call — for that there is:
- **`/diff [path]`** — real `git diff` of the host's working tree: `--stat` (file names plus
  insertion/deletion counts) with no argument, the actual hunks for one named path. Everybody
  sees it, because the working tree is what the whole jam is looking at. It shows the
  **unstaged** tree only, is capped at 120 lines, and says so plainly if the project is not
  inside a git repository.

Your own `Edit`/`MultiEdit`/`Write` calls also render for everybody as a real diff — the file
path, then `-` and `+` lines — instead of a truncated blob of JSON, because the `old_string` and
`new_string` in those calls already are the diff. A turn with several tools still folds into one
`⚙ N tools (Edit ×2, Bash ×1)` line; `/tools` reprints the whole thing, diffs included.

## Masked secrets (say this accurately if asked)

Tool calls, tool results, `/diff` output and every mirror row pass through a small deny-list on
the way to other people, and a value that matches comes out as `[masked]`. It knows five shapes:
AWS key ids (`AKIA…`), PEM `PRIVATE KEY` blocks, `sk-`/`pk-`/`rk-` and `ghp_`-style tokens,
bearer credentials, and `.env`-style UPPER_CASE secret `KEY=value` lines.

If somebody asks whether the jam is safe to share secrets in, the answer is **no**: this is
best effort, not a boundary. Anything the deny-list has never heard of goes straight through, a
value split across colour escapes on a mirror row will not match, and a message a human types is
never masked at all. `[masked]` on someone's screen means jam recognised a shape — the real value
is still in the file, and still in your context.

## Watching your screen from elsewhere

- Every client already has it: the default view IS this screen.
- Browser (opt-in): `jam host --view` (needs `ttyd`) also serves a read-only page at
  `http://jam:<key>@<host-ip>:7778` — this terminal and nothing else, no tmux chrome. Append
  `?fontSize=16` to make it bigger. `--tunnel` gives it a public `https://…trycloudflare.com`
  address too, `--funnel` a `https://…ts.net:8443` one.
- `tmux attach -t jam` on the host's machine is the raw TUI, keyboard included.

## Reaching a remote friend (`--tunnel` or `--funnel`)

Two public relays, one job: move the bytes so a friend needs no Tailscale and no port
forwarding. Pick one — they are mutually exclusive.

`jam host --tunnel` (needs `cloudflared`: `brew install cloudflared`) opens two Cloudflare
quick tunnels — one for the jam port, one for the browser view when `--view` is on.

`jam host --funnel` (needs `tailscale`, and Funnel enabled for the tailnet) does the same
through Tailscale Funnel, on the two public ports Funnel opens: 443 for the client, 8443 for
the view. Its hostname is the host machine's own name — `wss://<machine>.<tailnet>.ts.net` —
so it is the **same URL every run**, which a quick tunnel's random words are not. Startup
checks `tailscale status` and refuses with the exact missing step if Funnel is not available.

Either way the tunnel invite/view lines print first everywhere invite lines appear (the
client's `/join`, the `daemon` window, `token.json`, hence your own context). TLS is
terminated at the relay's edge; the join token / knock approval is still the real gate, and
`/token` rotation changes only the credential inside the URL.

A relay child that dies **is restarted** — 1 s doubling to 30 s, forever — and the new URL
flows out on its own. With `--tunnel` that URL is a NEW random hostname, so anybody already
connected on the old one has to be sent the new line (`/join` reprints it); their client says
as much after five failed reconnects. With `--funnel` the hostname is unchanged, so nobody has
to be told anything.

## Client commands (everyone)

`/c <text>` humans-only chat · `/who` participants · `/help` reprint the onboarding block ·
`/mirror` (or F2) swap views · `/tools [on|off]` tool log / collapse mode · `/quit` leave ·
`/files` paths this session touched · `/diff [path]` git diff of the working tree ·
`/send <path>` send a file (host: offer one) · `/paste [caption]` the clipboard's image ·
`/get [name]` take an offered file · `/export` this session's transcript ·
Shift+Enter, Option+Enter or a trailing `\` for multi-line.
Host-only: `/accept [name]` · `/deny <name>` · `/token new|set <v>|off` · `/join` ·
`/allow-cmd [name] [always]` · `/deny-cmd <name>` · `/allow-export [name] [always]` ·
`/deny-export <name>` · `/accept-file [name] [always]` · `/deny-file <name>` ·
**F3** attach the real TUI (`Ctrl-b d` back) · **a**/**d**/**i** answer the approval bar.
Any other `/command` is one of yours — see Slash commands above.

## Host launch flags (most useful)

`--name` display name · `--token <t>` fixed token · `--cwd <dir>` project dir ·
`--config-dir <dir>` run under another claude profile (e.g. `~/.claude3`) · `--resume <uuid>`
continue an existing conversation · `--replay <N>` how many events of an existing transcript a
joining guest is replayed (default 300, `0` for none) · `--tmux <name>` a second jam · `--view` browser view (needs
ttyd) · `--no-popup` no tmux knock popup · `--no-token-in-context` don't tell you the token ·
`--tunnel` two Cloudflare quick tunnels · `--funnel` Tailscale Funnel instead, with a stable
URL (`--funnel-cli <path>` if the CLI is not on PATH — on macOS it lives inside
Tailscale.app) · `--no-attach` set everything up without opening the
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
  different F3 sequence; the host can `tmux attach -t jam` instead — that is exactly what F3
  does for them.
- Host is stuck inside the TUI after F3 → `Ctrl-b d` detaches and their jam client comes back.
  If they launched jam from inside another tmux, the outer prefix takes the first `Ctrl-b`, so
  it is `Ctrl-b Ctrl-b d`.
- `a` or `d` does nothing / lands in the message → they have something typed in the input line;
  the single keys are armed only on an empty line, and Esc re-arms them. A guest never has them.
- F2, Shift+Enter or the live view do nothing → they are running `--basic`, which is
  transcript-only. Drop the flag.
- A guest keeps seeing "still retrying — the join URL changed" → it probably did. The host's
  `--tunnel` relay restarted and Cloudflare handed out a fresh random hostname; the host runs
  `/join` and sends the new line. `--funnel` does not have this problem.
- `--funnel cannot start: …` → the message names the one thing that is missing. Funnel needs a
  `funnel` node attribute granted for the tailnet in Access Controls, a connected Tailscale,
  and a CLI jam can actually reach (`--funnel-cli <path>`). On macOS the App Store build of
  Tailscale.app cannot change funnel config at all — its CLI replies `The Tailscale GUI failed
  to start … (Tailscale.CLIError error 3.)`; the standalone build from tailscale.com can.
  `--tunnel` is always available as the fallback.
- `/diff` says "not inside a git repository" → the host's `--cwd` is not in one. `/files` still
  works; it just reports what tool calls named rather than what git sees.
- `/diff` says "no unstaged changes" → the work is already committed or staged; `/diff` only
  shows the unstaged working tree.
- `/files` says "no files yet" → nothing has read or edited a file in this session *that a tool
  call named*. A file touched by a shell command inside a `Bash` call never shows up there.
- Somebody sees `[masked]` where a value should be → jam's secret deny-list recognised the shape
  (see "Masked secrets"). The value itself is unchanged on disk and in your context; only the
  copy being shown to other people is masked. There is no way to turn it off per line.
- A guest says they can see things from before they joined → they can: the daemon replays up to
  `--replay` events of the transcript on connect, with a `history above · live from here`
  divider under it. `--replay 0` at launch turns that off.
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
