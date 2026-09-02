# The Windows testing phase — plan for two agents

Everything Windows in claude-jam was written on a Mac, by an agent, with no Windows machine in the
loop. CI proves every pure function on a real `windows-latest` runner; `docs/COMPATIBILITY.md` says,
row by row, what that leaves unproven. **This document is how that changes.** It is written for two
Claude Code sessions running at the same time:

| | machine | session | what it is |
| --- | --- | --- | --- |
| **M** | Roy's MacBook Pro (`Roys-MacBook-Pro-4.local`) | the claude-jam dev session | hosts most legs, reads the host client, judges results, fixes bugs |
| **W** | `dell-2026`, Windows | a fresh Claude Code session, started in Git Bash | runs every Windows-side command, reports exactly what it saw |

Both machines are on the same LAN **and** the same tailnet (`tail7bd91e.ts.net`).

```
M   LAN 192.168.0.144     tailnet 100.86.8.97     roys-macbook-pro.tail7bd91e.ts.net
W   LAN <W measures it>   tailnet 100.101.225.77  dell-2026.tail7bd91e.ts.net
```

## The one rule that matters more than the results

**A refusal, an error and an ugly screen are all RESULTS.** Write down what actually appeared,
verbatim, including the parts that look like noise. Do not fix, do not work around, do not
"probably". If a step's expectation and the screen disagree, the screen wins and that is the finding.

Never do these, on either machine:

- **no `pkill` / `killall` / any pattern- or name-based kill.** Kill only a PID you spawned, by PID.
- **never `tmux kill-server`.** End a jam with `claude-jam end <name>`; kill a tmux session only by
  exact quoted name, on that jam's own socket.
- **never touch a jam, tmux session or process this session did not create.** Roy runs several
  sessions at once.
- W does not push, tag, publish or install anything global except where a step says so.

## Versions, and why they differ on purpose

- **M and W's clone** run `main` (currently `0.24.2`-unreleased — `--version` says so).
- **`npm i -g @roypadina/claude-jam`** installs **0.24.1**, which is what the world gets and what
  nobody has ever run. Both are in the plan deliberately: the clone tests the newest code, the npm
  install tests the shipping artefact. `claude-jam --version` is how you tell which one answered.

## How M and W talk to each other

1. **Roy relays** the first join line by hand (copy/paste between the two terminals). That is
   unavoidable — before the first jam exists there is no channel.
2. **After that, the jam IS the channel.** `/c <text>` is the human-only side channel: the hosted
   `claude` never sees it, and every participant does. M reads it in the host client; W reads it in
   its own client's transcript. Use it for coordination (`/c ready for leg 3`), and never for
   anything the hosted agent should act on.
3. **W's scripted client** (so an agent can read and write without a keyboard):

   ```sh
   mkfifo /tmp/jam.in
   claude-jam join <the join URL> --name WinAgent --basic \
     > /tmp/jam.out 2>&1 < /tmp/jam.in &
   JAMPID=$!                       # the ONLY pid W may kill, and only with kill $JAMPID
   exec 3> /tmp/jam.in             # holds the fifo open; without this the client sees EOF
   echo '/c WinAgent here' >&3
   sleep 2; tail -40 /tmp/jam.out
   ```

   `--basic` is the readline client: no mirror, no F2/F3. It is the right client for an agent and
   the wrong one for judging the mirror, so the interactive legs below are Roy's keyboard, not W's.
4. **Before the first jam exists, the channel is ntfy** — one shared topic on `https://ntfy.sh`,
   which Roy hands to W (it is a password, so it is not in this repo). Each side titles its posts
   with its own letter and reads the other's:

   ```sh
   # W → M
   curl -s -H "X-Title: W" -d "phase 0 done: 11 PASS, 2 UNEXPECTED (0.2 stdin.isTTY false, 0.10 …)" \
     "https://ntfy.sh/$TOPIC"
   # W reads M's replies (blocks until one arrives, then exits)
   curl -s -N -m 3600 "https://ntfy.sh/$TOPIC/json?title=M" | grep -m1 '"event":"message"'
   ```

   M holds the mirror image of that listener open, so a post from W wakes M's session with no
   polling and no scheduled wakeups on either side.

   **What may and may not go on that topic.** ntfy.sh is a public server and the topic name — 64
   bits of randomness — is the only thing protecting it. **Roy has authorised join tokens, `cjam1_…`
   invite links and `--tunnel` URLs on it for this testing phase** (2026-09-02): the jams are
   throwaway, short-lived and nobody else is joining, and having M able to hand W a relay URL
   directly is worth more than the relaying it saves. Take the trade with eyes open — an invite link
   needs no host approval, so for the life of that jam the topic name *is* the door.

   Still never on it, and these are not the same question: the **host key** (it is host authority —
   a process holding it can type into the real Claude session), the **hook secret**, and
   **transcript content** (the conversation, which is not ours to publish to a third-party server).
   Rotate nothing through it that outlives the jam.
5. **W's findings come home as a file**, uploaded through the product: write
   `~/win-findings.md`, then `/send ~/win-findings.md` from W's client. M approves it, and it lands
   in the host's `jam-uploads/`. That delivers the report and tests `/send` in one move.

---

# Phase 0 — W alone, no jam yet (cheap, and it gates everything else)

No Mac involvement. Nothing here needs a jam, so a failure costs one line, not a session.

| # | shell | command | what to record |
| --- | --- | --- | --- |
| 0.1 | Git Bash | `uname -a; echo "$MSYSTEM"; node --version; git --version` | node **must be ≥ 22**. `MSYSTEM` names the Git Bash flavour |
| 0.2 | Git Bash | `node -e "console.log(process.platform, process.stdin.isTTY, process.stdout.isTTY, process.env.TERM)"` | **the single most important line in phase 0.** If `stdin.isTTY` is `false`, the ink client silently falls back to `--basic` in Git Bash — that is a finding, and `winpty node …` or Windows Terminal's own PowerShell profile is the comparison |
| 0.3 | PowerShell | `wsl --version; wsl -l -v` | WSL 2, which distro, which is default |
| 0.4 | Git Bash | `git clone --depth 1 https://github.com/roypadina/claude-jam ~/claude-jam-src` | needs no `npm install` for 0.5–0.7 |
| 0.5 | Git Bash | `node ~/claude-jam-src/scripts/check-wsl.mjs` | expect **NOT EXERCISED** for every WSL branch (this is not WSL). A `FAIL` here is a real bug |
| 0.6 | WSL | `node ~/claude-jam-src/scripts/check-wsl.mjs` (clone again inside WSL if `/mnt` is slow) | **the W2 measurement this whole feature is waiting for.** 8 checks. Paste the whole output, `--- RESULT ---` line included |
| 0.7 | WSL | `node -e "console.log(require('os').tmpdir())"`; `stat -c '%a %U' /tmp`; `stat -c '%a' /mnt/c/tmp 2>/dev/null` | is `$TMPDIR` on the Linux side, is `/tmp` 1777, does DrvFs really report 777 |
| 0.8 | Git Bash | `cd ~/claude-jam-src && npm ci && node --test test.mjs` | 475 pass, 0 fail on a real Windows machine. 3 tests are macOS/Linux-only and skip |
| 0.9 | Git Bash | `node ~/claude-jam-src/scripts/check-terminal-gate.mjs` | both directions of the terminal gate, on the real thing |
| 0.10 | Git Bash | `npm i -g @roypadina/claude-jam` then `claude-jam --version` and `claude-jam --help` | **never run by anyone.** Expect `claude-jam 0.24.1` and the Windows usage block. If npm's shim calls `bash`, that is the W1 bug returning |
| 0.11 | Git Bash | `claude-jam host`, `claude-jam sessions`, `claude-jam find`, `claude-jam invite Roy` | each must **refuse** naming WSL2, exit 2. A silent exit 0 is the `.pathname` class of bug |
| 0.12 | Windows Terminal, PowerShell profile | `claude-jam --help` | same output, different terminal. Then `cmd.exe /c claude-jam join ws://127.0.0.1:1 --name X` — the legacy console must be **refused with the Windows Terminal hint**, not a screen of `←[2J` |
| 0.13 | WSL | `which tmux claude node cloudflared tailscale; node --version` | what W2 can actually host with. `claude` inside WSL decides whether phase 5 gets a real agent or a fixture |

Stop and report after phase 0. M reads it before anything is hosted.

---

# Phase 1 — LAN, Mac hosts, Windows joins (fixture claude, no tokens spent)

M starts the jam with a **fake** claude (`JAM_CLAUDE=scripts/fake-tui.mjs`), so every connectivity
leg costs nothing. Real `claude` comes in phase 4, once.

**M:** `JAM_CLAUDE=$PWD/scripts/fake-tui.mjs claude-jam host --port 7801 --name Roy --jam-name wintest --cwd ~/Code/Padina/claude-jam`

**Knock-only, on purpose.** No `--token` anywhere in phases 1–3: W connects, M sees `⚑ Dana wants
to join` and accepts. Nothing secret has to reach W, so the ntfy channel stays safe to use for
coordination — and the knock/accept path gets exercised for free. The token and invite-link doors
get one step each (2.8, 2.5–2.7), where Roy relays the secret by hand.

M records **which address the join block printed** — this is suspect **S1** below — and gives W the
LAN form: `ws://192.168.0.144:7801`.

| # | who | step | expected |
| --- | --- | --- | --- |
| 1.1 | W, Git Bash | `curl.exe -s -m 3 http://192.168.0.144:7801/health` | `{"ok":true,…}`. If this fails the rest of phase 1 is a network finding, not a claude-jam one |
| 1.2 | W, Git Bash, **Roy's keyboard** | `claude-jam join ws://192.168.0.144:7801 --name Dana` | `waiting for host approval…`, M accepts, then the mirror of M's screen, in colour. **Roy reports: is it the whole screen, is it aligned, does the status row fit** |
| 1.3 | Roy at W | press **F2**, then F2 back | transcript ⇄ mirror. Windows Terminal key decoding, first real test |
| 1.4 | Roy at W | **PgUp**, **PgDn**, **Shift+↑**, **End**, **Esc** | scrollback through M's real pane; `End`/`Esc` returns to live |
| 1.5 | Roy at W | type `hello from windows` + Enter | it reaches M's pane as `[Dana]: hello from windows` — success criterion 1 |
| 1.6 | Roy at W | `/c windows side channel` | M sees it in the host client; **the hosted claude must never see it** (M checks the pane) |
| 1.7 | Roy at W | `/who`, `/menu`, `/help` | a guest's menu lists guest things only |
| 1.8 | Roy at W | multi-line: `line one \` Enter `line two`, then **Shift+Enter** | the trailing `\` must work; whether Shift+Enter does is a Windows Terminal CSI-u finding |
| 1.9 | Roy at W | press **F3** | must print the "no tmux on Windows" refusal, not spawn anything |
| 1.10 | M | `/ping Dana look at this` | W's client shows the highlighted nudge — **and Roy reports whether a Windows toast appeared and whether a sound was heard**. Both are unproven claims today |
| 1.11 | Roy at W | `/sound`, then `/ping Roy back at you` | three tiers reported; M hears its own sound |
| 1.12 | W, agent | the scripted `--basic` client from above, as `WinAgent`, **while Dana stays connected** | two Windows clients at once; `/who` shows three participants |
| 1.13 | Roy at W | `Ctrl+C` / `/quit` in the interactive client | leaves the jam running for everybody |

Then repeat **1.2 and 1.3 from WSL** (`claude-jam join ws://192.168.0.144:7801 --name Dana-wsl` inside the
distribution) — a WSL guest reaches the LAN outbound with no configuration, and that is the
comparison that tells a Git Bash tty problem apart from a claude-jam one.

---

# Phase 2 — the same jam, over the tailnet

Nothing restarts. Same jam, different address.

| # | who | step | expected |
| --- | --- | --- | --- |
| 2.1 | W, Git Bash | `curl.exe -s -m 3 http://100.86.8.97:7801/health` | `{"ok":true,…}` — the tailnet path, Windows→Mac |
| 2.2 | W, Git Bash | `claude-jam join ws://100.86.8.97:7801 --name Dana` | joins, and everything in phase 1 still holds |
| 2.3 | W, Git Bash | `claude-jam join ws://roys-macbook-pro.tail7bd91e.ts.net:7801 --name Dana2` | MagicDNS name, not just the IP. A DNS failure here is a tailnet finding worth writing down |
| 2.4 | W, WSL | the same two joins from inside WSL | does the WSL VM reach the tailnet at all — it has no Tailscale of its own, so this measures WSL's NAT plus Windows' Tailscale |
| 2.5 | M | mint an invite link: `claude-jam invite Dana --expires 24h --jam wintest` | **first real remote guest on an invite link, ever** |
| 2.6 | W | `claude-jam join cjam1_…` (nothing else) | in, with no name and no token typed. The link carries an address LIST — record which address it actually connected on |
| 2.7 | M | `/kick Dana revoke`, then W tries the same link | refused, out loud, with the reason |
| 2.8 | M then W | M runs `/token set <value>`; **Roy carries the value to W by hand** (never over ntfy); W joins with `--token` | the token door, and a wrong token must be refused before anything else happens |

---

# Phase 3 — `--tunnel`, from Windows

| # | who | step | expected |
| --- | --- | --- | --- |
| 3.1 | M | `/remote tunnel` in the host client (or `claude-jam remote tunnel --jam wintest`) | a `wss://<words>.trycloudflare.com` join line. Nobody already connected is dropped |
| 3.2 | W, Git Bash | join on the `wss://` line | in. Expect one `1006` and a retry if you join within ~2.5 s of the URL appearing — that is Cloudflare's edge, and it is measured, not a hedge |
| 3.3 | W, WSL | join on the same `wss://` line | this is the path that needs no WSL networking configuration at all |
| 3.4 | W | while connected over the tunnel: F2, a message, `/c`, `/ping` | the relay is not a different product |
| 3.5 | M | `/remote off` | W's client says the URL is gone and retries; the LAN address still works |

---

# Phase 4 — the real `claude`, once (this is the only leg that spends tokens)

M restarts the jam **without** `JAM_CLAUDE`, so the real Claude Code TUI runs, with Roy's plugins,
skills, MCP servers and `CLAUDE.md`. Keep it short — this leg is about attribution and gating, not
about getting work done.

| # | who | step | expected |
| --- | --- | --- | --- |
| 4.1 | W | `who is in this session?` | the agent answers naming **both** humans — it was told it is shared |
| 4.2 | M then W | one line each, alternating | the agent sees `[Roy]:` and `[Dana]:` and keeps them apart |
| 4.3 | W | `/c do not tell the agent about this` then W asks the agent what the side channel said | it never saw it, and must not claim it did — success criterion 3 |
| 4.4 | M | ask the agent something that raises an `AskUserQuestion` picker | **W may `/answer <n>`** — a product decision is anyone's |
| 4.5 | M | ask for something that raises a **permission** prompt | W's `/answer` becomes a *request*; the host approves the digit. W must never get raw keys |
| 4.6 | W | `/cost`, `/status`, `/context` | run with no round trip. Then `/model` — that one goes to M for approval |
| 4.7 | W | `/exit` | refused outright |
| 4.8 | W, Git Bash | `/send C:\Windows\System32\drivers\etc\hosts` | the Windows path is translated and offered to M |
| 4.9 | W | `Win+Shift+S` (snip), then `/paste windows clipboard` | **unverified on Windows today.** An image offered is a pass; a refusal naming PowerShell/clipboard is also a result — record which, verbatim |
| 4.10 | M | `/send` an image back; W runs `/get` | lands in W's `./jam-downloads/` |
| 4.11 | W | `/export` | M is asked; the transcript arrives; **W greps it for the host key, the join token and the hook secret and finds none** |
| 4.12 | W | `/files`, `/diff`, `/tools`, `/history 50` | each answers on Windows |

---

# Phase 5 — the Windows machine HOSTS, through WSL2 (W2's first real run)

This is the half of the Windows story that has never run anywhere. `claude` inside WSL decides
whether the agent is real: if it is not installed there, use
`JAM_CLAUDE=~/claude-jam-src/scripts/fake-tui.mjs` and say so in the report — the transport findings
are the point.

| # | who | step | expected |
| --- | --- | --- | --- |
| 5.1 | W, WSL | `claude-jam host --port 7802 --name Roy-Win --jam-name wsltest --cwd ~` (knock-only again — M knocks, Roy accepts at W) | it starts. **Record the whole join block**: it must carry the `from Windows on this PC:` line and the WSL2 explanation |
| 5.2 | W, PowerShell | `curl.exe -s -m 3 http://localhost:7802/health` | `{"ok":true,…}`. This is WSL2 localhost forwarding, and it is a claim until it runs |
| 5.3 | W, Git Bash | `claude-jam join ws://localhost:7802 --name Roy2` | a Windows client on a WSL host — the same machine twice, two stacks |
| 5.4 | M | `curl -s -m 3 --max-time 3 http://<W LAN ip>:7802/health` | **a refusal or timeout is the EXPECTED result** without mirrored networking or a portproxy. Record which it was |
| 5.5 | M | `curl -s -m 3 http://100.101.225.77:7802/health` | Windows' Tailscale cannot serve a port inside the VM, so expect this to fail too — and this is exactly the question Roy asked. Record it |
| 5.6 | W, PowerShell **as Administrator** | the portproxy + firewall rule from the wiki's §4 | then 5.4 again — M should get through, and M then **joins the jam over the LAN** |
| 5.7 | W, WSL | `claude-jam remote tunnel --jam wsltest` (or `--tunnel` at launch) | M joins on the `wss://` URL. This is the route that needs none of 5.6 |
| 5.8 | M | in that jam: a message, `/c`, F2, PgUp, `/who` | a Mac guest on a Windows host, end to end |
| 5.9 | W, WSL | `TMPDIR=/mnt/c/tmp claude-jam host --port 7803 --name X` | must **refuse**, naming DrvFs and 0777. This is the one privacy gate WSL can actually reach |
| 5.10 | W, WSL | `/send /mnt/c/Users/<you>/something.png`, and `/send \\wsl$\<Distro>\home\<you>\notes.md` | both translated. `\\wsl$\OtherDistro\…` and a `\\fileserver\…` share must both be refused |
| 5.11 | W, WSL | `claude-jam end wsltest`, then `claude-jam sessions` and `ls -d /tmp/claude-jam-*` | gone, and no state directory left behind |

---

# Phase 6 — close out

- W writes `~/win-findings.md` and `/send`s it into the last live jam (or Roy pastes it).
- M turns every finding into a numbered item, fixes what is fixable, and records what is not in
  `TESTING.md`'s Deferred list **in the same commit** as the fix.
- M updates `docs/COMPATIBILITY.md`: every row this phase touched moves from ⚠️ to a measurement,
  with the date and the machine.
- Both machines: end only the jams this phase created, by exact name. `claude-jam clean --yes`
  removes orphaned state dirs and never a live one.

---

# Known suspects — where the bugs most likely are

These are predictions, written before the run so they cannot be retrofitted. Each names what would
prove it.

- **S1 — the join block's address is chosen by accident.** `externalIp()` in `host.mjs` spawns a
  bare `tailscale`, but on macOS the CLI lives inside the app bundle and is not on PATH (that is
  why `resolveTailscale()` exists, and this call does not use it). The fallback then walks
  `os.networkInterfaces()` and returns the first non-internal IPv4 — which on M is the **tailnet**
  address, because `utun5` happens to come before `en8`. So the documented behaviour ("the printed
  join line already uses the tailnet IP") is currently true here by luck, and a LAN-only guest is
  handed an address that cannot work. **Measure first:** what does M's join block actually print,
  and can W reach it from the LAN and from the tailnet. The fix's shape (resolve the CLI, or print
  both addresses) depends on that answer.
- **S2 — Git Bash has no tty for node.** If step 0.2 says `stdin.isTTY false`, every interactive
  claude-jam client in Git Bash is silently the `--basic` one: no mirror, no F2, no PgUp — and it
  never says so, because a non-tty stdin is the documented trigger for `--basic`. The finding would
  be that the *client should say which renderer it chose and why*.
- **S3 — `/paste` through PowerShell.** Never run. The failure could be interop, the argv, the
  image encoding, or the temp file's ACL.
- **S4 — a toast and a sound.** Detection and argv are unit-tested; nobody has ever seen a Windows
  toast from claude-jam or heard a Windows sound.
- **S5 — Windows Terminal key decoding.** F2 / PgUp / PgDn / Shift+arrows / Shift+Enter / Esc.
  `Esc` in particular is the one that shares a prefix with everything.
- **S6 — DrvFs's real shape.** The 0777 refusal was measured in a container wearing the shape, not
  on a real Windows drive. Step 5.9 is the first real one.
- **S7 — WSL2 localhost forwarding, mirrored networking, the portproxy.** Straight from Microsoft's
  documentation, never run.
- **S8 — `--funnel`.** Still blocked on Funnel being enabled for the tailnet, and carrying an open
  upstream bug (tailscale/tailscale#18827: WebSockets through `tailscale serve` close every 10–40 s,
  which a 30 s heartbeat cannot outrun). **Out of scope for this phase** unless Roy enables it.
