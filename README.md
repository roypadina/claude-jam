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
./claude-jam host --name You --cwd .
```

The command is **`claude-jam`**. `jam` is still installed as a deprecated alias of it, so
anything you already typed keeps working; nothing in this project prints that name.

## The menu

`claude-jam` with **no arguments** opens a launcher: Host a jam · Join a jam · My jams · End a
jam. The Host screen collects the directory, your name, the jam's name, the access mode
(knock / token / invite-only), the remote relay, the browser view and any extra claude args —
and prints the exact command line **before** it runs it, so it teaches the CLI instead of
hiding it. Options that cannot work on this machine are greyed with the reason and the fix.

```
── Host a jam ──────────────────────────────────────────────
↑↓ move · ←→/space change · Enter edits a text field · Esc back
  directory     /Users/roy/Code/some-project
  your name     roy
  jam name      claude-jam (the tmux session)
  access         INVITE   invite links only — a knock is refused
❯ remote         TUNNEL   cloudflared quick tunnel (new URL on every restart)
                funnel — unavailable: Funnel is not enabled for this tailnet
                  Enable it once, as a tailnet admin: …
  browser view  off
  claude args   e.g. --model opus

this runs:
  claude-jam host --cwd /Users/roy/Code/some-project --name roy --invite-only --tunnel
```

Any argument at all (including `--no-menu`) skips the menu, and a non-tty prints the usage —
exit 0 for a bare `claude-jam`, which is a question, and exit **2** for `claude-jam join` with no
argument, which is a missing argument nothing can ask for.
Inside a running jam, **`/menu`** is the live control panel — see [Commands](#commands).

## Host quickstart

```sh
claude-jam host --name Roy --cwd ~/Code/some-project -- --model sonnet
```

That builds a **detached** tmux session `claude-jam` (two windows: `daemon` log, `claude` the real
TUI) **on a tmux server of claude-jam's own** — socket `claude-jam-<port>` — and runs your own claude-jam
client full-screen in the terminal you launched from. Nothing is attached to tmux, so the window
size is claude-jam's to pick and the mirror fills your screen exactly.

Because it is claude-jam's own server, claude-jam can bind a bare **F3** to `detach-client` without touching
your tmux config, and it literally cannot see your own sessions. The flip side: reaching the raw
TUI from another terminal needs the socket —
`tmux -L claude-jam-7777 attach -t claude-jam:claude`, which `claude-jam sessions` prints for you.
`--tmux-socket default` puts claude-jam back on your shared server (and then F3-out is not bound).

```
┌ your terminal ─────────────────────────────────────────────┐   ┌ tmux session `claude-jam` ──────┐
│  ▐▛███▛█   Claude Code v2.1.251                            │   │ daemon  (log)            │
│ ▝▜██████▀  Haiku 4.5                                       │   │ claude  (the real TUI)   │
│ ❯ [Dana]: rerun the tests                                  │   │                          │
│ ⏺ All 71 pass.                                             │   │ detached — nothing is    │
│ ──────────────────────────────────────────────────────     │   │ attached to it           │
│ ❯                                                          │   └──────────────────────────┘
│ [Dana]  [humans-only] nice                                 │     tmux attach -t claude-jam
│ ⧉ live TUI                       Dana is typing…           │     for the raw TUI
│ Roy ❯                                                      │
└────────────────────────────────────────────────────────────┘
   the mirror of the claude window · chat strip · status · input
```

Closing your client does not end the jam: you are asked
`this jam is still running (2 guests connected) — [k]eep it running · [e]nd it · [c]ancel`.
Keep it and the daemon, the TUI and every guest stay exactly where they were —
`claude-jam host --attach` reopens your client, `claude-jam sessions` lists what is running, `claude-jam end` stops
it. See **Session lifecycle** below.

Useful flags: `--port`, `--tmux <name>` (a second jam), `--jam-name <X>` (what the jam is
CALLED — default: this directory's name), `--no-announce` (keep it off the local network),
`--token <value>`, `--view`,
`--tunnel`, `--funnel`, `--resume <session-id>` (continue an existing session),
`--replay <N|all>` (how much of an existing transcript a joining guest is shown, default 300
events, `0` for none, `all` for everything the jam kept),
`--history <N>` (how many events the jam keeps for replay and `/history`, default 2000, cap
20000), `--config-dir <dir>` (run
the TUI as another claude profile), `--uploads ask|auto|off` (whether you are asked about every
file a guest sends), `--upload-quota <n>[MB|files]`, `--export ask|auto|off` (the transcript's
own, separate toggle), `--no-sound` (start your client silent),
`--no-attach`, `--attach`, `--no-prompt`,
`--keep-on-exit`, `--end-on-exit`, `--no-token-in-context`, `--no-popup`,
`-- <extra claude args>`. `claude-jam` with no arguments prints the usage line; `MANUAL.md` explains
the ones you will actually reach for.

## Adopt the session you are already in

`claude-jam host --resume <id>` restarts a conversation in a pane of claude-jam's own. `claude-jam
adopt` does not restart anything — it shares the claude that is **already running**, in the tmux
pane it is already in:

```sh
# from inside that session — claude can run this for you from the Bash tool
claude-jam adopt

# from another terminal
claude-jam adopt --pane %23 --socket default --token ourshared1
```

It works because claude-jam has only ever driven claude through `capture-pane` out and
`paste-buffer`/`send-keys` in, against a tmux target — and nothing in that required claude-jam to
have created the target.

**It shows what it resolved before it shares anything**: the pane, the tmux server, what is
running in it, the directory, the session id it worked out, and that session's first message and
last answer. Then it asks. `--yes` skips the question for scripting and refuses outright if the
transcript it picked is stale, because the failure this guards against is sharing the *wrong*
conversation with the room.

**Not inside tmux** (a bare terminal, an IDE terminal, a cmux pane)? There is no pane to read or
type into, so adoption is impossible — and it says so with the whole alternative, id already
filled in: `claude-jam host --resume <session-id> --cwd <dir>`.

**claude-jam did not create this session, so it will never end it.** On the adopted server it only
ever reads (`capture-pane`, `display-message`) and types into that one pane. It sets no tmux
option there — not the ownership marker, not the status line, not the fill character — and binds
no key, because a tmux key table is server-global and that server is yours. `claude-jam end` stops
the daemon and its children and leaves the pane, the tmux session and claude exactly as they were;
`claude-jam sessions` marks the row `adopted`; `claude-jam clean` never touches it.

At adoption claude is **told** it is now in a shared session — one injected message carrying the
protocol, the two standing rules, the digest and who is here — and told again after a `/compact`,
because that is when injected context disappears. `--no-brief` skips it; `--brief-updates off`
stops the later ones.

Two ceilings are inherent and are not worked around:

- **No Stop/Notification hooks.** A running claude cannot be given new hooks — `--settings` is
  read once, at startup. Turn-end and permission-wait therefore come from the **pane classifier**
  (v0.31), which reads the screen 2.5 times a second and is the authoritative source anyway.
- **The pane is not resized.** It is your window, usually with you looking at it, so claude-jam
  leaves its size alone; a guest on a much smaller terminal sees it letterboxed rather than
  reflowed.

### `/jam`, if you want a shorter way to type it

`integrations/claude-plugin/` is a three-file Claude Code plugin — a command, a skill and a
manifest, no code — that maps `/jam`, `/jam invite <Name>`, `/jam end` and `/jam status` onto the
CLI:

```sh
/plugin marketplace add roypadina/claude-jam     # this repo doubles as a one-plugin marketplace
/plugin install claude-jam@claude-jam
```

**Installing it is entirely optional.** `claude-jam adopt` from the Bash tool works without it —
ask claude to run it. The plugin exists because `/jam` is shorter than a sentence, and because
the skill in it carries the two standing rules (about links, and about `/c` chat) to a claude
that has not been briefed yet. See `integrations/claude-plugin/README.md`.

## Guest quickstart

```sh
# on the same network as the host? just look.
claude-jam find                    # or: claude-jam discover
claude-jam join                    # no argument: pick one off the list, or paste a link

# an invite link — the whole command. No name to type, no token, no approval to wait for.
claude-jam join cjam1_eyJ2IjoxLCJqYW0iOiJhYmMx…
# knock-only host: no token, you wait to be accepted
claude-jam join ws://<host-ip>:7777 --name Dana
# host handed you a token: straight in
claude-jam join ws://<host-ip>:7777 --name Dana --token abc123…
```

You land on the live TUI — the host's real Claude Code screen, plus the backlog of what
happened before you arrived (up to `--replay` events, with a
`── history above · live from here ──` divider under it). **PgUp** scrolls that live TUI back
through the host's real pane history — the actual scrollback, colours and all, up to 2000 lines —
and **End** (or `G`, or `Esc`) returns to live; `/history [n|all]` re-prints further back than the
replay you were given. A plain line goes to the agent
as `[Dana]: …`; `/c <text>` is human-only chat; **F2** flips to the transcript; `/files` and
`/diff` say what the session has changed; `/answer` answers a permission prompt (the host still
approves); `/help` reprints the onboarding block. Typing `/` raises a dim list of claude-jam's own
commands. `--basic` swaps ink for a plain readline client (transcript
only, no live view, no F2/F3, no command list) and is picked automatically when stdin is not a tty.

## Finding a jam on your network

A jam has a **name** — `--jam-name "reeco debugging"`, defaulting to the directory's own name,
so it is never nameless — and by default it says so on the local network over mDNS/DNS-SD.
Guests stop needing a URL:

```sh
claude-jam find                  # jams announcing themselves on this network
claude-jam find --json           # the same facts, for a script
claude-jam join                  # the launcher menu's Join screen: pick one, or paste a link
```

```
# jam             host access view address
1 reeco debugging Roy  knock  no   roys-mac.local:7777
2 the other one   Dana token  no   roys-mac.local:7779

  reeco debugging: claude-jam join ws://roys-mac.local:7777 --name <you>
  the other one: claude-jam join ws://roys-mac.local:7779 --name <you> --token <token>

finding a jam is not being let into it: a knock still waits for the host, a token jam
still wants its token, and an invite-only jam still wants a link.
```

**Finding is not entering.** Discovery tells you a jam exists and where; every door in the
table above is exactly as shut as it was. Picking a jam in the Join screen fills in the
address and nothing else — a knock jam still waits for the host to accept you, a token jam
still asks you for the token, and an invite-only jam says so and sends you to the paste row.

**What the advertisement contains, and what it deliberately does not.** Six fields: the jam
name, the host's display name, eight characters of the session id, which kind of door it is
(`knock`/`token`/`invite`), whether a browser view exists, and the version. **Never** the
token, never an invite secret, never the working directory, never any path. That is enforced
by construction — the record is built from an allow-list of those six keys, so handing the
builder a whole session object still publishes six fields — and asserted against the real
wire in `scripts/smoke-discover.mjs`.

**It is still a disclosure, and on an untrusted network you may not want it.** Everyone on
the LAN learns that this jam exists, what it is called and who is hosting it. That is the
point on your own network and a leak on café wifi:

```sh
claude-jam host --no-announce    # run normally, say nothing on the network
```

`/menu → Access → Announce on the network` flips it while the jam runs, and the row shows
whether the LAN is actually being told — not merely whether it was asked for. Tunnels are
never advertised: mDNS is link-local by design, and a tunnel exists for people who are not
here. A machine with no mDNS tool skips discovery with one line naming the fix; everything
else works exactly as before.

## Access: token, knock, invite-only, tunnel, funnel

Several ways to let someone in. All of them end in the same welcome, and all of them are
switchable while the jam runs from `/menu → Access`.

| mode | how | who decides |
| --- | --- | --- |
| **token** | `--token <value>` at startup (8–64 chars of `[A-Za-z0-9_-]`), or `/token set` later. One shared secret; anyone holding it joins immediately | whoever has the string |
| **invite link** | `claude-jam invite Dana` mints `cjam1_…`, and `claude-jam join <link>` is the guest's entire command — the link carries the addresses, their name and a per-invite secret, so they are admitted with no approval | the host, per person, in advance — and revocably |
| **knock** | no token at all. The guest connects without one, sees `waiting for host approval…`, the host gets `⚑ Dana wants to join (100.86.8.97)` and answers `/accept Dana` | the host, per person |
| **invite-only** | `--invite-only`, or `/token invite-only on` later. A knock is refused outright with the reason, so an invite link is the only door — every entry individually revocable, name-bound and expiring | the host, in advance, per link |
| **tunnel** | `--tunnel` spawns two Cloudflare quick tunnels (needs `cloudflared`) and prints `wss://<words>.trycloudflare.com` join/view URLs — for a friend who is not on your LAN or tailnet | still the token or the knock; the tunnel only moves the bytes |
| **funnel** | `--funnel` runs Tailscale Funnel instead (needs `tailscale`, and Funnel enabled for the tailnet). Same job, but the URL is your node's own name — `wss://<machine>.<tailnet>.ts.net` and `https://…:8443` for the view — so it is the **same every run**, unlike a quick tunnel's random words. Your guest still installs nothing | as above; mutually exclusive with `--tunnel` |

Neither relay is launch-only. `/menu → Access → Remote`, `/remote off|tunnel|funnel`, or
`claude-jam remote <off|tunnel|funnel> [--jam NAME] [--reissue]` from a shell switches them
while the jam runs — same relay children as the launcher, **nobody already connected is
dropped**, and a mode that cannot run here says why with the exact fix. Links minted earlier
carry the old address, so the switch offers to re-issue every live link (and waits for the new
hostname before minting, or they would carry exactly the address they replace). When a relay
comes up, host clients get `tunnel ready: <the whole join command> · give it a few seconds`
rather than a silent refresh, and `/join` prints one dated block instead of another
near-identical copy. The few seconds are real and measured: cloudflared reports its hostname
about 2.5 s before the edge will route to it, so a client that connects the instant the line
appears gets one disconnect and then reconnects.

### Who is the host — a file on the host's disk, not an address (v0.34)

Being **the host** is what lets a client type raw keystrokes into the real TUI (F3), `/end`,
`/kick`, `/invite`, `/remote`, `/announce`, `/grants` and switch the browser view. Two conditions,
checked independently, and either one failing means guest:

1. **The key.** At start the daemon writes `<state>/host.key` — 32 random bytes, mode `0600`,
   inside the state dir that is already `0700`. The host's own client reads that file and presents
   it when it connects. A process on another machine cannot read it, whatever address its packets
   arrive from and whatever headers they carry.
2. **The address.** The connection must also have started on this machine — loopback, with no
   proxy header on the upgrade (the 0.21.1 test, kept).

Before v0.34 the address was the whole gate, and every relay claude-jam offers proxies to
`localhost` — so a header test was standing in for identity. It held for cloudflared, which was
measured; it was a guess for anything else. The key is what makes the answer transport-independent:
a relayed socket has no key, whichever relay it is.

**This grants nothing filesystem access did not already grant.** Anyone who can read
`<state>/host.key` can already read `token.json` beside it, and is already a local user with your
own privileges. What it stops is the *network* impersonating the filesystem.

**No key, no host — and it says so.** `claude-jam host`, `host --attach`, the launcher menu's
attach and `claude-jam adopt` all hand the client the key's *path* (`--host-key-file`), and the
client reads the file. Against a jam that has no key file — a daemon from before v0.34, or one
started by hand — the client prints one line and **joins as a guest** rather than falling back to
the address. End the jam and start it again to be its host. If a host claim is refused, the reason
names which of the two conditions failed.

The key is a credential: it is never logged, never sent back in any frame, never told to claude,
and it is scrubbed out of `/export` alongside the join token. Only its path is ever printed.

### Uploads and the transcript: two policies, two defaults

Every `/send` and `/paste` from a guest hits the approval ladder. That is the default and it is
unchanged — but a jam where three people are pasting screenshots is a jam where the host does
nothing but press `a`, so the host can choose once instead of per file:

```sh
claude-jam host --uploads auto                  # anyone already admitted may send, no prompt
claude-jam host --uploads auto --upload-quota 500MB
claude-jam host --uploads off                   # refuse every upload, with a reason
```

`ask` (default) · `auto` · `off`, and `/menu → Access → Uploads` switches it while the jam runs.
Under `auto` the transfer is still announced to everybody and still logged — the host sees
`⇪ Yossi sent screenshot.png (2.1 MB) → jam-uploads/…` — it just is not a question. `off`
refuses everybody, standing `always` grants and the host's own `/paste` included.

**What never relaxes, in any policy** — these are the actual protections, not the prompt:
sanitized basename with traversal refused (and Windows device names — `con`, `nul`, `com1`… —
renamed, because they are not files) · the 20 MB per-file cap · one transfer in flight per
client · writes only under `<cwd>/jam-uploads/` · nothing executed, nothing auto-opened · an
announced-vs-actual byte mismatch drops the upload. `scripts/smoke-nudge.mjs` proves each of
those still refuses **while the policy is `auto`**.

**The guard `auto` makes necessary:** a session quota of **40 files or 200 MB**, whichever comes
first. When it is spent the policy falls back to `ask` and says so once —
`upload quota reached — asking again` — so an `auto` jam cannot quietly fill a disk.
`--upload-quota <n>[MB|files]` changes it and the menu row resets it.

**Export keeps its own toggle and stays `ask`.** `--export ask|auto|off`, and
`/menu → Access → Export the transcript`. The defaults differ on purpose: a file is one file,
and a transcript is the whole conversation — every file claude read, all its tool output, its
entire context — so handing one over is a bigger decision than accepting a PNG.

### Invite links

```sh
claude-jam invite Dana                          # multi-use, 24h — prints the guest's whole command
claude-jam invite Dana --uses 1 --expires 30m   # one shot, half an hour
claude-jam invites                              # id, name, state, uses, expiry (never the link again)
claude-jam invite revoke Dana                   # or revoke <id>
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

## Peer tasks — the host's agent can ask a guest's own Claude Code

**Off by default, twice over.** The host starts the jam with `--peer-tasks`, and each guest types
`/peer on` in their own client, and *then* every individual task still waits for that guest's yes.
Two switches, held by two different people, and neither one alone is enough.

```bash
# the host
claude-jam host --peer-tasks

# the guest, in their own client
/peer on
```

With both on, the host's claude gets two MCP tools and uses them like the built-in Agent tool:

| tool | what it does |
| --- | --- |
| `list_peers()` | `[{name, capable, busy, tasksToday}]`. `capable` is that person's own opt-in — the host cannot set it. `busy` means they are already running one; **nothing is queued** |
| `dispatch_to_peer({peer, prompt, allowedTools?, maxTurns?, deadlineMs?, schema?})` | hand one self-contained task to one person. Returns their answer, or the reason it did not happen. `schema` gives structured output, exactly as the Agent tool does |

### What a guest is agreeing to

The task runs **on the guest's machine, in the guest's own already-authenticated Claude Code,
spending the guest's own quota**. No credential ever crosses the wire; the host never sees a
guest's token; nothing is executed on anybody's behalf without their explicit, per-task consent.
**A guest may decline anything, every time, with no reason** — and a decline is a decision, not a
failure the host's agent should retry.

Before answering, the guest is shown the **whole prompt**, the exact tool list, both caps and the
directory it would run in:

```
⇄ Roy wants to run a task on YOUR machine, in YOUR Claude Code, on YOUR quota.
    tools      WebSearch, WebFetch, Read, Grep, Glob   (read-only)
    caps       up to 12 turns · 3m wall clock
    runs in    /tmp/claude-jam-peer-8f3a91c2 — created for this task, removed after, never your repo
    your own MCP servers are OFF for it, and it inherits none of your settings
    the prompt, in full — this is text from another machine, read it before you answer:
  │ find the current wording of the WebSocket close-code registry and quote it
    [a]ccept · [d]ecline · [n]ever this session   ·   Esc cancels it once it is running
```

### The controls, and why each one is there

- **Per-task approval.** There is **no `always`** on this ladder — unlike every other approval in
  claude-jam. The same person is asked again, every single time.
- **The default tool whitelist is read-only research**: `WebSearch`, `WebFetch`, `Read`, `Grep`,
  `Glob`. `Bash`, `Write` and `Edit` may be *asked* for, but **one key never grants them**: the
  guest has to type `/peer accept tools`, for that one task.
- **A fresh scratch directory** (`$TMPDIR/claude-jam-peer-<id>`, 0700), created for the task and
  removed when it ends — every way it can end. Never the guest's repository, never their home.
- **The guest's own MCP servers are off** for it (`--strict-mcp-config`, with no MCP config at
  all), so nothing they have connected — a database, a ticket system, a cloud account — is
  reachable by a prompt that arrived over a network.
- **It inherits none of the guest's settings.** `--restricted` makes claude ignore their user,
  project and local settings files, refuse `bypassPermissions`, and confine the file tools to that
  one directory. A machine whose own default is `bypassPermissions` — plenty are — does not hand
  that to work somebody else asked for.
- **The permission mode is always passed and is always `plan`** (or `acceptEdits` when something
  that writes was granted). **Never `bypassPermissions`, never
  `--dangerously-skip-permissions`** — asserted by a unit test and again by the smoke, against the
  argv that is actually used.
- **The prompt goes in on stdin**, never an argv: it is text that arrived over a network, and an
  argv is visible in `ps` to every user on that machine.
- **Two caps**: a wall clock (3 minutes by default, 10 maximum) and a turn count (12 by default,
  40 maximum). Both are enforced by killing the process, by its pid. **A turn cap is a proxy, not
  a spend cap** — it bounds how many times the model is asked, not what each of those costs.
  (`claude` 2.1.251 has no `--max-turns`, so claude-jam counts the stream itself.)
- **A per-guest daily counter** they can zero with `/peer reset`, shown in `/peers` and in
  `list_peers()`.
- **An audit log both sides can read**: `/peers log`.

### Prompt injection goes both ways

The host's prompt is **untrusted input on the guest's machine** — which is what the whitelist, the
scratch directory, the missing MCP servers and the human reading it in full are for. The guest's
result is **untrusted input in the host's context** — so it is quoted into the transcript behind a
`│ `, with the `[Name]: ` participant form neutralised, and handed to the host's agent behind a
banner saying what it is. **It is never executed and never auto-applied to a file.**

### What the room sees

Everything, attributed `[Dana → task]`: what was asked, that it was accepted, each line of
progress and the answer. A task only the two parties could see would be a private channel inside a
shared session.

### Failure is honest

**Decline**, **timeout**, **cap-hit**, **crash** and **cancel** are five different answers the
host's agent can tell apart, and partial output is preserved on every one of them. A busy or
offline peer is **reported with its reason**, never silently queued.

### The open question — say it out loud

Claude Code subscriptions are individual. Peer tasks are built so that every task is one person
choosing, in the moment, to spend their own quota on something — which is ordinary individual
usage of each account. **Whether a coordinated multi-account fan-out counts as ordinary individual
usage is not settled**, and nobody should discover that later. If you are running a jam where one
agent routinely dispatches to several people at once, that is the question to ask before you build
on it, not after. `--peer-tasks` is off by default for this reason as much as for any other.

## Session lifecycle

claude-jam creates the tmux session, so claude-jam cleans it up — no `tmux kill-session` line to remember.

| command | what it does |
| --- | --- |
| `claude-jam sessions`, `claude-jam ls` | claude-jam's own sessions: tmux name, jam name, port, state, uptime, session id, who is here, which relays are on, cwd. `--json` for scripting. A `!` marks an `orphan` state dir (its tmux session is gone), a `no-daemon` session (nothing answers on its port), or an `incomplete` state dir (no `session.json` — a start that died before it claimed a session) |
| `claude-jam find`, `claude-jam discover` | jams announcing themselves on **this network**: name, host, access mode, view, address, and the exact join command per row. `--json` for scripting. Talks to no daemon and holds no credential — and finding a jam is not being let into one |
| `claude-jam end [name]`, `claude-jam kill` | end one jam: every client is told and exits 0, the daemon stops its children (ttyd, tunnel, popups), the tmux session is killed and its state dir removed. No name and one jam → that one; several → a numbered picker; `--all` after an explicit confirmation |
| `claude-jam clean` | remove state dirs whose session is gone, and only those, after listing exactly what will go |
| `claude-jam host --attach` | reopen your client on a jam that is already running |
| `/end` (host, in the client) | the same end, from inside, after `really end this jam for everyone? [y/N]` |

Closing the host's client asks `[k]eep it running · [e]nd it · [c]ancel`; `--no-prompt`,
`--keep-on-exit` and `--end-on-exit` answer it up front, and a stdin that is not a terminal
counts as **keep**. `claude-jam host` on a name already held by one of claude-jam's own offers
`[a]ttach as host · [n]ew session (claude-jam-2) · [e]nd it and start fresh · [c]ancel`.

**claude-jam only ever ends a tmux session it created.** On creation it stamps
`@claude-jam-owned <state-dir>` on the session and writes `session.json` into that dir; ending anything
requires that pair to line up, for the exact name you gave (or picked out of claude-jam's own list).
There is no name pattern, no filtered sweep over `tmux list-sessions`, no `kill-server`, and
`--all` re-verifies every session it touches. Your own tmux sessions — and a session carrying a
hand-written `@claude-jam-owned` marker — are refused, never listed, and never touched; a session
started before v0.18 has no marker, so it is claude-jam's to leave alone too
(`tmux kill-session -t <name>` remains yours to run).

Since v0.20 that is structural as well as checked: claude-jam's sessions live on **its own tmux server**
(socket `claude-jam-<port>`, recorded in `session.json`), so `list-sessions` there cannot return
one of yours even in principle. The marker check stays anyway, and `killOwned` additionally
refuses a session whose recorded socket is not the one it was asked about.

## Commands

claude-jam owns the commands below; **everything else starting with a slash belongs to claude** — from
the host it is typed into the real TUI verbatim, from a guest it becomes a request the host
approves.

| command | who | effect |
| --- | --- | --- |
| *(plain line)* | anyone | goes to claude as `[Name]: …` — attribution is symmetric, the host is a `[Name]` too |
| `/c <text>` | anyone | human-only chat; the agent never sees it |
| `/who`, `/help`, `/quit` | anyone | roster · reprint onboarding · leave (session keeps running) |
| `/menu` | anyone | the live control panel: People · Invites · Access · Session · Notifications · Help & guides. Shows the jam's state next to every toggle, runs any command with one key, and renders MANUAL.md inline. A guest's `/menu` lists exactly what a guest may do. **Every feature has to be reachable from it — a unit test fails when one is not** |
| `/ping <Name\|all> [message]` | anyone | *(alias `/nudge`)* get somebody to look at their screen. The person addressed gets a highlighted `👋 Roy is asking for you: …` plus their own bell/sound/notification; **everybody else sees a dim `* Roy nudged Yossi`**, so a nudge is never secret. Refused for somebody who is not connected — never queued. One per sender per target per 30 s. `!` at the end repeats it **once** after a minute if they are still not active |
| `/sound [on\|off]` | anyone | this client's own sounds. Bare `/sound` reports all three tiers |
| `/peer on\|off\|never` | anyone | whether the host's agent may run a task on **your** machine, in **your** Claude Code, on **your** quota. Off until you say so; `never` is a one-way door for that client session that no host can clear. See [Peer tasks](#peer-tasks--the-hosts-agent-can-ask-a-guests-own-claude-code) |
| `/peer accept\|decline`, `a`/`d`/`n` | anyone | answer the task in front of you. **`/peer accept tools`** is a second, typed gate for a task that asks for `Bash`, `Write` or `Edit` — one key never grants those. `Esc` (or `/peer cancel`) stops one that is already running |
| `/peer reset`, `/peer` | anyone | zero your own daily task counter · report where you stand |
| `/peers`, `/peers log` | anyone | who has opted in, who is busy, how many tasks today · the audit trail of everything this jam dispatched |
| `/mirror`, **F2** | anyone | swap live TUI ⇄ transcript. The live TUI renders in the terminal's **alternate screen buffer**, so the transcript keeps the normal one and flipping either way loses nothing |
| **PgUp** / **PgDn** | anyone | in the live TUI: scroll back through the host's **real pane history** (`capture-pane`, colours included), 2000 lines at most. **Shift+↑/↓** moves one line, the wheel three *if your terminal sends wheel events* — claude-jam never turns mouse reporting on, because that would take text selection away from you |
| **End** / `G` / **Esc** | anyone | back to the live screen. While you are scrolled, live frames are **held, not dropped** — the status row says how many are waiting |
| `/history [n\|all]` | anyone | re-print further back than the replay you were given, a page at a time, under a dim divider that says what is still behind it. `/export` is always the complete record |
| **F3** | host | **attach** the real TUI — `tmux attach` takes the terminal, so permission prompts, pickers, the mouse and Ctrl-C all work at native speed. **F3 again** (or `Ctrl-b d`) comes back. Host only: the `0600` `host.key` **and** a local socket (v0.34) |
| `a` `d` `i`/Esc | host | answer the approval bar above the status row — accept · deny · dismiss. Only while the input line is empty |
| `/tools`, `/tools on\|off` | anyone | reprint the last turn's full tool log · stop/resume collapsing tool lines |
| `/files` | anyone | every path this session read, wrote or edited — newest first, with a count |
| `/diff [path]` | anyone | `git diff --stat` of the host's working tree, or the real hunks for one path |
| `/answer`, `/answer <n>` | anyone | show what claude is asking · answer it. **A question** (claude's own `AskUserQuestion`) goes straight through, first answer wins. **A permission** (a tool wanting approval) is offered to the host, who approves before a key is typed |
| `/answer <q> <n>` | anyone | one question of a multi-question form — only the one on screen |
| `/answer other <text>` | host | the free-text option. Host-only whatever `--answers` says: arbitrary text into the terminal is raw keyboard access. Reduced to one line with no control characters, so it cannot submit and start a second prompt |
| `/outbox`, `/retry` | anyone | what claude-jam kept when it could not confirm a message landed · send the newest kept one again (yours; the host may send anybody's) |
| `↑` / `↓` | anyone | recall your own last 50 submissions — per client, and they survive a restart |
| `/join`, `/token new\|set\|off` | host | reprint the invite lines (one dated block, so which one is live is never a guess) · rotate or drop the token |
| `/token invite-only on\|off` | host | refuse knocks outright, so an invite link is the only door |
| `/remote off\|tunnel\|funnel` | host | put the jam on a public relay, or take it back off, without dropping anybody. `claude-jam remote …` does the same from a shell |
| `/invite <Name> [--uses N] [--expires 24h]` | host | mint a link that joins as that name with no approval |
| `/invites`, `/invite revoke <Name\|id>` | host | list the links (never reprinting one) · take one back |
| `/kick <name> [revoke]` | host | remove somebody already in: their socket closes 4406, they drop out of the roster, everybody is told — and you are offered their invite link back |
| `/end` | host | end the jam for everybody — asks `[y/N]` first, then every client prints `<Host> ended the jam` and exits |
| `/accept [name]`, `/deny <name>` | host | answer a knock |
| `/allow-cmd [name] [always]`, `/deny-cmd <name>` | host | answer a guest's claude command |
| `/allow-perm [name] [always]`, `/deny-perm <name>` | host | answer a guest's permission answer |
| `/send <path>`, `/paste [caption]` | anyone | guest uploads a file to `<cwd>/jam-uploads/` (host approves — or not, under `--uploads auto`); host **offers** one instead |
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

**A question is not a permission.** claude-jam classifies claude's *current screen* — `question` ·
`permission` · `dialog` · nothing — 2.5 times a second, and drives the status row from that, so the
`⚠` says what is really there and clears itself when the prompt goes. A **question** is a product
decision, so anyone may `/answer <n>` it: no approval, first answer wins, and the room is told who
answered what (`--answers host` locks it to the host). A **permission** is a security grant and
keeps the v0.17 ladder exactly: only while the prompt is really up, only a digit the daemon can see
on the screen, only after the host approves *that* digit, and only if the screen still says the
same thing when the key is typed. A **dialog** with nothing numbered on it is nobody's to relay —
the host takes the keyboard with F3. A guest never gets raw keys, and the free-text option
(`Type something.`) counts as raw keys, so it stays the host's in every mode.

**Your message is never lost.** Every message is written to `<state>/outbox/` (0600) before it is
pasted and deleted only once the input box is seen to empty. If claude-jam cannot confirm it landed you
get `couldn't confirm your message reached claude — kept at <path> · /retry to send it again`,
nothing is retyped or wiped behind your back, and `/outbox` · `/retry` · `↑`/`↓` are three ways to
get it back.

Multi-line input: `Shift+Enter` (kitty/CSI-u), `Option/Alt+Enter`, or a trailing `\` (works
everywhere).

## How it works

The daemon injects messages into the real TUI with `tmux load-buffer` + `paste-buffer -p`
(bracketed paste, so multi-line stays one message), waits for the text to actually appear in
the pane, and only then sends Enter — text never passes through a shell or argv. Output comes
back by tailing `~/.claude/projects/*/<session-id>.jsonl`. Turn boundaries come from `Stop` /
`Notification` hooks in a generated `settings.json` passed with `--settings`, so nothing global
is touched.

What claude-jam tells the agent is split by **lifetime**. The durable half — that the session is shared,
that `[Name]:` is who is talking, the two rules that must never decay (never reveal the token or an
invite link to a bridged participant; never claim to have seen `/c` chat), and a short digest of
how a jam works — is written to `<state>/system-prompt.txt` and passed as
`--append-system-prompt-file`, so it survives `/compact` instead of being summarised away on a
long session. The half that *changes* at runtime — the live roster, the token, the tunnel URLs, the
whole of `MANUAL.md` — stays in the `SessionStart`/`UserPromptSubmit` hooks, because a system
prompt is read once at startup and can never be rewritten. claude-jam probes for the flag before using it
(it is absent from `claude --help` on 2.1.251 even though it works) and falls back to hooks-only
with one log line if a build rejects it; `--no-system-prompt` opts out. The live view is `tmux capture-pane -e`, only for clients that
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

Four moments interrupt you, each with its own bell (`\x07`), macOS notification and — for the
three that are about a person — its own **sound**: claude waiting for a permission answer (the
host's client only, since the host can always answer, though a *question* rings everybody);
anybody saying your name in a message or in `/c` chat; a **knock** (`Submarine`, a slow low tone,
repeated once after 30 s if nobody answers, then never again); and a **token or invite arrival**
(`Glass`, one short chime, nothing owed). A **nudge** addressed to you is `Hero`. Leaving is
silent on purpose. At most one bell or notification every three seconds.

Three independent toggles per client — sound · desktop notification · terminal bell — in
`/menu → Notifications`, plus `--no-sound` at launch and `/sound on|off` from the keyboard.
`--no-sound` silences the **sound** and nothing else. On Linux the sounds go through `paplay`
or `aplay` if either is there, and are silently skipped if not.

Each client also reports **one number** on its heartbeat: whole seconds since its own human last
typed or submitted — never a keystroke, never any text. `/who` shows `Roy (active),
Dana (idle 4m), Yossi (away 20m+)`, and the confirmation after a `/ping` says which state the
person was in, so nudging is purposeful. Optionally, and only if **you** put an
`{ "ntfy": { "topic": … } }` block in your own `~/.config/claude-jam/config.json`, **your own
client** also pushes a nudge addressed to you to your phone — the topic is a bearer secret and it
never reaches the host, an invite link, the protocol or a log. The status row also carries this
connection's own round trip, measured by the 30 s heartbeat: a dim `~120ms`, or `⚠ stale Ns` once
a pong is overdue.

Everything that is only true of one operating system lives in `platform.mjs` — the clipboard,
the desktop notification, sounds, `$TMPDIR`, `~/.config`, and writing a file only its owner can
read. It is the only module allowed to spawn a platform binary, and a test says so.

`node --test test.mjs` covers the pure functions in `lib.mjs` — **388 tests**. Eighteen
end-to-end smokes live in `scripts/`; the recipe for driving them against a throwaway daemon is
in `SPEC.md` (`smoke-transport.mjs`, `smoke-replay.mjs`, `smoke-perm.mjs`,
`smoke-lifecycle.mjs`, `smoke-invite.mjs`, `smoke-answer.mjs`, `smoke-discover.mjs`,
`smoke-nudge.mjs`, `smoke-scroll.mjs`, `smoke-adopt.mjs` and `smoke-peer.mjs` bring their own —
most of them run under a `TMPDIR` of their own and start by
proving they will not touch a session they did not create). `smoke-nudge.mjs` asserts the sounds
**through the platform seam**, with a stub `afplay` on each client's own `PATH`: a knock and an
auto-join have to produce two different calls, and only the client a nudge is addressed to may
produce a third.

`fixtures/pane/` holds thirteen real `tmux capture-pane -p` captures of claude 2.1.251 — the empty
input box, short text, a wrapped line, a 3-line and an 18-line paste (both collapsed to
`[Pasted text #N +M lines]`), the trust dialog, a real `Bash` permission prompt, and the
`AskUserQuestion` picker in all four of its states. They are the corpus the paste verification and
the prompt classifier are judged against, so a future Claude Code that draws differently fails a
test instead of somebody's message.

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
- **The prompt classifier reads pixels, not intentions.** It knows an `AskUserQuestion` picker by
  three measured signals (a checkbox header, a `Type something.` option, a `to navigate` footer)
  and a permission prompt by what is left. A numbered picker with none of those is called a
  *permission* — deliberately the safe way to be wrong, since the cost is one host approval rather
  than a tool grant handed to a guest. A future Claude Code that drops all three signals would make
  questions host-gated again, not the reverse, and `fixtures/pane/` is the corpus that would fail
  first.
- **`/answer <q> <n>` can only answer the question that is on screen.** Moving between the tabs of
  a multi-question form is a Tab keypress — raw keyboard, host-only — so the other questions are
  refused by name rather than guessed at.
- **A pty drops what a busy TUI does not read in time.** Measured on macOS 15 / tmux 3.7c: an 8 KB
  `paste-buffer` into a pane mid-redraw arrived 4.2 KB short, silently. So pastes go in as 2 KB
  pieces and each one is checked against the count in claude's own `[Pasted text +N lines]` marker;
  a piece that arrives short is treated as a truncation and the whole message is kept rather than
  half-sent. If a slower machine ever comes up short anyway, `PASTE_CHUNK_MAX` is the knob.
- **A message is capped at 20 000 characters on the wire** (`sanitize`), so chunking covers roughly
  2 KB to 20 KB. A bigger brief goes in as a file (`/send`), not as a message.
- **The outbox is a safety net, not a queue.** It keeps the last 20 payloads, in the host's state
  dir, and a `/retry` is a fresh attempt — nothing re-sends on its own, and ending the jam takes
  the state dir (and anything still kept in it) with it.
- The host answers a prompt with F3 — which *is* a `tmux attach`.
  While the host is attached their own mirror is paused. Coming back re-feeds **nothing**: tmux
  draws on the alternate screen and hands the normal one back untouched, so the transcript is
  exactly where it was. (Before v0.28 it re-fed the last 40 lines and dropped the rest.)
- The frame signal is a poll, not `tmux pipe-pane`: the cadence adapts (40 ms active, 250 ms
  idle) but an active mirror still costs one `capture-pane` per tick.
- **An invite link is a bearer credential.** It joins as that name with no approval, so whoever
  holds it is that person as far as claude-jam is concerned — there is no second factor and no device
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
- **Host is a local file, not an address (v0.34).** `<state>/host.key` is `0600` in a `0700` dir,
  and reading it is what proves the claim; the loopback test is kept as a second, independent
  condition. A client that claims `--host` with no key file joins as a guest and says so — there
  is no fall back to the address. This is a floor, not a ceiling: it says the *network* cannot
  become the host, and nothing more. Any local process running as you can read the key — but it
  can already read `token.json`, so that is not a new boundary. It is also not device binding: the
  key protects host authority, not the machine.
- The token-in-context guard ("reveal only to the host") is an instruction to the model, not a
  boundary — and neither is the appended system prompt that repeats it. What the system prompt
  buys is durability, not enforcement: it survives a `/compact` that would have summarised the
  same words away. If a credential must not leak, run knock-only, and mint invite links rather
  than telling the agent a shared token at all.
- **Export scrubbing is best effort.** A transcript is everything claude saw — file contents,
  tool output, the whole context. claude-jam strips its own token block and the raw token, nothing
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
- The history a joiner is shown is `min(--replay, --history)` events (300 out of a 2000-event
  ring by default) parsed out of the last 8 MB of the transcript. `/history [n|all]` reaches the
  rest of the ring; everything older than the ring is only in `/export`, and a replayed event is
  stamped with the daemon's boot time, not the moment it originally happened. The client says so
  out loud the first time you scroll to the top: `— that is as far back as this jam kept …`.
- **Scrolling the mirror reads the host's pane, not a recording.** The last 2000 lines, in pages
  of at most 200 rows, cached for 2 s per range — so a page you re-read inside that window can be
  up to two seconds stale, and lines that have already fallen out of the pane's own
  `history-limit` are gone from there too. `/export` is the complete transcript; the pane's
  scrollback is not.
- Scrolling is **ink-only**. `--basic` has no live region to redraw a screen into, so it gets
  `/history` but not PgUp.
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
- `--funnel` also carries a known **upstream** risk: tailscale/tailscale#18827 (open since
  2026-02-27) reports WebSockets through `tailscale serve`'s HTTP reverse proxy — the layer
  Funnel rides — closing every 10–40 s with code 1001. A 30 s heartbeat cannot save a 10 s
  drop. Take `--funnel` for what it is proven to give you, a hostname that never changes, and
  expect `--tunnel` to be the steadier long session until somebody runs Funnel for real.
- **claude-claude-jam's ownership of a session is a marker on disk, not a capability.** `@claude-jam-owned` plus a
  matching `session.json` is what authorises an end, so anybody who can already set a tmux
  option on their own session and write a directory can make claude-jam end *that* session — which
  they could have killed themselves anyway. What the pair rules out is the accident: a name
  pattern, a session claude-jam did not create, a stale marker, a `session.json` copied in from
  somewhere else.
- `claude-jam sessions`/`end`/`clean` enumerate claude-jam's OWN namespace — the `$TMPDIR/claude-jam-<port>`
  state dirs — so a jam-owned session whose state dir was deleted by hand is invisible to them
  (and `tmux kill-session` is then the way out). A jam started before v0.18 has neither, and is
  likewise none of their business.
- `claude-jam clean` decides "the session is gone" from `tmux has-session` plus a TCP probe of that
  port. A state dir whose port is held by something else is flagged, not deleted.
- The exit prompt is the launcher's, so it exists only for the host client the launcher spawned.
  A `claude-jam join --host --host-key-file …` client started by hand just closes, and the jam
  keeps running.
- The live view, scrolling it, tool collapse, F2/F3 and the newline keys are ink-only — `--basic` is a
  transcript-only client.
- No rate limiting, no web client, one session per host, no Windows.

`README` keeps the short list; `SPEC.md` has the full one, plus every wire frame and the
phase-2 relay sketch that removes the inbound port.

## Docs

| file | what it is |
| --- | --- |
| `MANUAL.md` | the manual **claude itself is given** — so a participant can just ask "how does this jam work?" and get an accurate answer |
| `AGENTS.md` | how an agent works **on** this project: layout, tests, the smokes and their order, the rules that must never be broken |
| `SPEC.md` | protocol, frames, design decisions, the full ceiling list |
| `PRIOR-ART.md` | the ~40-project survey the credits below summarize |
| [wiki](https://github.com/roypadina/claude-jam/wiki) | task-shaped pages: Install, Agent-Install, Hosting, Joining, Remote access, Files, Security, **Peer tasks**, Architecture, Troubleshooting |

## For agents

Point an agent at one of two pages and nothing else:

- **installing and running it** → [wiki: Agent-Install](https://github.com/roypadina/claude-jam/wiki/Agent-Install)
  — numbered, non-interactive commands, what to verify after each one, what needs a human, what
  must never be done, and a self-test with its expected output.
- **working on the code** → [`AGENTS.md`](AGENTS.md) — the same, for changing this repo.

Both say the same two hard rules out loud, because getting them wrong costs somebody else their
work: never `tmux kill-server`, and never kill a process by name or pattern (`pkill`, `killall`).

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
