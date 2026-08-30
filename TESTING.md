# Testing policy and the deferred-verification list

Roy's decision (2026-08-29): **small verification per batch, one big verification campaign at
the end.** Batches were spending most of their wall-clock on full smoke sweeps; that moved to
the release gate and, finally, to the overnight campaign described below.

## Per batch (what an implementing agent owes)

1. `node --test test.mjs` — green, with a test for every new pure helper.
2. The two or three smoke suites that cover what changed. Not the full sweep.
3. Fixtures over live `claude` turns wherever a fixture proves the same thing.
4. Live pty evidence only for things a human must *look* at (UI), not for logic a test pins.
5. **Anything skipped goes in "Deferred" below, in the same commit.** Silence is the failure
   mode this file exists to prevent.

## At each release

The full smoke sweep (all suites, documented order) is the release gate. A red suite stops the
release; it is never released over.

## The end-game campaign (overnight, whole app)

Run when the feature list is done. Not a smoke re-run — an adversarial pass over the product:

- Every suite, repeated, on a fresh machine state (no leftover state dirs, no stale sockets).
- Long-run soak: a jam left up for 2+ hours with a guest attached, over `--tunnel` and over LAN,
  measuring reconnects, memory, frame cadence, and whether the relay survives (the 2-hour claim
  has never actually been run).
- Multi-guest: 3+ clients, mixed host/guest actions, races on the approval ladders (two people
  answering the same question, a knock arriving mid-`/kick`, an invite used twice at once).
- The trust boundary, deliberately attacked: forged invite blobs, replayed secrets, traversal and
  oversized uploads under every policy, a guest attempting F3/raw keys/`/exit`, prompt injection
  in both directions (host prompt → guest machine, guest result → host context).
- Failure injection: kill cloudflared mid-session, kill the daemon, kill tmux's server, fill the
  disk on an upload, drop the network mid-transfer, hit a Claude usage limit mid-turn.
- Cross-platform matrix (once Windows lands): every combination in `docs/COMPATIBILITY.md`,
  recorded with build and date, no "should work" entries.
- Fresh-install rehearsal: `brew install` and `npm i -g` on a clean machine, following the wiki's
  `Install` and `Agent-Install` pages literally, including the agent-driven path.

## Release gates that have actually run

- **0.22.0 — 2026-08-30.** All eighteen suites, in the documented order, one at a time, on node
  24.15 / tmux 3.7c / claude 2.1.251 / ttyd 1.7.7 / cloudflared 2026.8.2, from a verified-clean
  machine state (no tmux server on any socket, no jam daemon anywhere, the only state dirs the two
  dormant ones that pre-dated the run). Unit suite **424/0**.

  **The gate went red, and that is the whole story of this release.** `smoke-adopt` **S7c** failed
  on the first run — *"the key came back in a frame to Roy"* — and then passed five times running.
  A one-in-six flake on the assertion that guards the release's headline feature. Two real defects
  behind it:

  1. **The product.** `stripTokenBlock` had exactly one call site, `/export`. Every
     transcript-derived frame passes through one line in `onTranscript` and was broadcast
     unscrubbed, for all four kinds; the mirror rows were unscrubbed too (`maskSecrets` runs there,
     but `SECRET_HINT` needs a word like SECRET/TOKEN, so a bare 64-hex key matches nothing). The
     v0.34 comment asserting the key "has no route into a transcript" was the assumption it rested
     on — and there is a route: claude runs as the host user with file tools, so **any participant
     can ask it to read `<state>/host.key`**. Fixed with one shared helper (`scrubSecrets`) on both
     funnels, by known literal rather than by pattern. No released version was affected: none has a
     host key to leak.
  2. **The test.** S7c planted the key in the transcript the daemon tails and then asserted no
     frame held it — so the tailer's poll interval decided the result. It now **waits** for the
     planted line to come back and asserts it arrives scrubbed.

  Both canaries were run, because neither claim is worth anything unproven. Neutering
  `scrubSecrets` turns the two new unit tests **and** both pre-existing `stripTokenBlock` tests red
  (420/4), which is what proves the refactor actually routes through the shared helper. Reverting
  `scrubSecrets` out of `onTranscript` turns S7c red on **2 of 2** runs rather than 1 of 6, quoting
  the leaked value — the flake is gone, not merely re-hidden. Post-fix, `smoke-adopt` ran green
  five times, printing `transcript funnel: "and the host key is [host key removed]"` on each.

  **Host-still-host, on every launch surface**, since this release changes that gate:
  `smoke-slash` (*"the host's own loopback client is still the HOST — flag, F3 keys, host-only
  report"*), `smoke-lifecycle` 5 and 6 (`host --attach` and the launcher menu's attach — the
  assertion names `--host-key-file` by name), `smoke-adopt` S6 (`claude-jam adopt`), and
  `smoke-knock`'s three v0.34 refusals, each naming which condition failed.

  **The 0.21.1 → 0.22.0 upgrade path, measured rather than reasoned** (a real 0.21.1 daemon from
  `git archive 9e64c63`, confirmed to contain no host-key logic, with the real 0.22.0 client):

  | probe | result |
  | --- | --- |
  | 0.22.0 client, `--host`, no key file | prints `hostKeyNotice` with the path, joins as a **guest** — `host:false`, `tmux:null`, `join:null` |
  | a client still CLAIMING `host:true`, no key, vs the 0.21.1 daemon | **granted host on address alone**, handed `tmux` and the join line |

  So the client is correct and never falls back to address-only host — but the *daemon* decides,
  and an unrestarted jam keeps 0.21.1's gate. That is now an **Upgrading** section in the
  changelog rather than a footnote.

  Nothing was left behind: `$TMPDIR` held 100 `jam-*` directories before the sweep and 100 after
  (F10 holds across sixteen suites), no `dns-sd` child still advertising, no tmux server on a
  socket the gate created.

- **0.21.1 — 2026-08-30 (the security release).** All eighteen suites, in the documented order,
  one at a time, on node 24.15 / tmux 3.7c / claude 2.1.251 / ttyd 1.7.7 / cloudflared 2026.8.2,
  from a verified-clean machine state (no live tmux server on any socket). Every one green; unit
  suite **405/0**.

  The gate carried one extra question, because the release's own fix narrows the loopback gate
  and the host reaches its own daemon over loopback: **is the host still the host?** No suite
  asserted it directly — the pieces were scattered (`smoke-knock` S1 proved the flag on a
  token-less jam, `smoke-slash` used the host's F3 keys only as setup, `smoke-perm` proved the
  approval ladder), and none of them would have failed on a silent demotion. `smoke-slash` now
  has one step that asserts all three surfaces in one place: the host-only payload in the welcome
  (`session.tmux` and `session.join`, with the guest as the control), an F3 keystroke typed into
  the real claude pane and read back off it, and a `trusted()`-gated `/grants` report the guest is
  refused.

  It has a canary: with `localSocket()` forced to `false` — the shape of an over-tightened gate —
  the new step is the **only** one of the fifteen that goes red. Everything else still passed,
  including "host slash: /cost is typed into the real TUI", because a demoted host falls straight
  through to the read-only allowlist and the pane looks the same. That is exactly the blind spot
  the step exists to close, and it was measured rather than argued.

  **And then the RELEASE itself was probed, not just the tree.** The campaign's `check-released.sh`
  found Homebrew 0.21.0 vulnerable; the same shape was re-run on 2026-08-30 against the installed
  `claude-jam 0.21.1` (`/opt/homebrew/bin/claude-jam`, `brew test` exit 0, libexec `package.json`
  at 0.21.1) — a throwaway jam with a fake pane, a real `--tunnel`, a real `trycloudflare.com`
  hostname:

  | probe | result |
  | --- | --- |
  | stranger over the public URL, `host: true`, no token | **no welcome** — knocked, `pending` |
  | ... the join token / tmux session handed over | **null / null** |
  | relay guest WITH the token | admitted as an ordinary guest; no host payload |
  | ... their raw keys, their `/end` | both refused, jam still alive |
  | loopback socket carrying forged `x-forwarded-for` / `cf-connecting-ip` / `cf-ray` | **no welcome** — knocked (the test fails closed) |
  | the host's own plain loopback client | admitted as host, `session.tmux` + join line, keystrokes landed in the real pane, `/grants` answered, **zero error frames** |
  | a plain loopback client not claiming host | ordinary guest, no host payload |

  Still unproven, and unchanged by this: `--funnel`. See the deferral below.

- **0.21.0 — 2026-08-29.** All eighteen suites, in the documented order, one at a time, on node
  24.15 / tmux 3.7c / claude 2.1.251 / ttyd 1.7.7 / cloudflared 2026.8.2. Every one green; unit
  suite 389/0. Nothing was left behind: no tmux server on a socket the gate created, no `dns-sd`
  child still advertising, no state dir but the two that pre-dated the run.
  This discharges four of the deferrals below — the v0.28, v0.33 and v0.29 "not re-run, prove at
  the next release gate" entries, and the 0.20.0 one. They are kept, struck through, because what
  a skip cost is only visible next to what it was.
  It also found real drift no suite covers: `--help` and `/menu` disagreeing on three flags,
  `SPEC.md`'s recipe invoking sixteen of eighteen suites, and `MANUAL.md` missing six commands.
  Two new lints now fail on the first two.

## Deferred (owed to the campaign)

Append one line per skip: what, why, and how it will be proven. Newest last.

- ~~2026-08-29 · smoke.mjs, smoke-xfer, smoke-popup, smoke-slash, smoke-perm, smoke-knock not
  re-run after the v0.28 scrollback batch (judged unaffected; token cost). Prove: full sweep at
  the 0.20.0 release.~~ **DISCHARGED — 0.21.0 gate, 2026-08-29: all six re-run, all green.**
- 2026-08-29 · Linux sound path (`paplay`/`aplay`) never executed — no Linux box. Prove: a Linux
  run in the campaign, or mark the platform unsupported in the docs.
- 2026-08-29 · The nudge phone tier (ntfy) has no end-to-end run — the URL matcher is https-only,
  so there is no local stand-in server. Prove: one real ntfy topic in the campaign.
- 2026-08-29 · avahi (Linux mDNS) fallback not built and not tested; `dns-sd` is required.
  Prove: decide in the campaign whether Linux discovery is supported or documented as absent.
- 2026-08-29 · Invite links have never been used by a real remote guest on another machine —
  only by scripted clients here. Prove: the friend test, and the campaign's multi-guest pass.
- ~~2026-08-29 · The 2-hour remote-session claim is unproven: the keepalive, relay auto-restart
  and reconnect tiers exist but no long run has happened. Prove: the soak above.~~
  **DISCHARGED — campaign, 2026-08-30. The claim holds, on both transports.** Two runs of
  **130 minutes**, concurrent, one over LAN loopback and one over a live `--tunnel` (a real
  `trycloudflare.com` hostname, so every frame crossed the public internet), a guest client
  attached in mirror mode throughout, one sample every 30 s.

  |  | LAN | `--tunnel` |
  | --- | --- | --- |
  | duration | 130.1 min | 130.2 min |
  | reconnects | **0** | **1** (at t=0 only — see below) |
  | samples disconnected | 0 of 260 | 0 of 260 |
  | heartbeat terminations | 0 | 0 |
  | relay respawns | — | **0** |
  | frames delivered | 3878 | 3877 |
  | cadence per 30 s | 14.9 (ceiling is 15) | 14.9 |
  | ping RTT | mean 0.9 ms | mean 86.6 ms |
  | daemon RSS start → end | 77.9 → 88.7 MB | 77.9 → 88.8 MB |
  | alive at the end | yes | yes |

  The tunnel's single reconnect was at t=0: the daemon publishes the join line ~2.5 s before
  Cloudflare's edge will route to it, so the first connect gets one `1006` and the second
  succeeds. After that it held for 2 h 10 m with no relay respawn and no heartbeat termination.
  Cadence over the relay is indistinguishable from loopback — 3877 frames against 3878.

  RSS is a working set, not a leak: flat, a GC dip, one step up while four smoke sweeps and two
  live claude sessions shared the machine, then **flat for the last four deciles**. A 40-minute
  run on the POST-fix tree ended *lower* than it started (77.9 → 76.9 MB), which also confirms
  the two security fixes cost nothing measurable.

  Harness and raw samples: `~/ClaudWork/2026-08-30-jam-campaign/` (`soak.mjs`, `soak-*/`).
- 2026-08-29 · `--funnel` (Tailscale) live path unverified — Funnel is not enabled on this
  tailnet and the installed Tailscale is the sandboxed App Store build. Prove: after Roy enables
  Funnel and installs the standalone build, or record it as unsupported here.
- ~~2026-08-29 · A mention in `/c` chat never rang the bell in `--basic` clients: `client-basic.mjs`
  still called `nudge()` after the v0.25 rename to `alert()` — a ReferenceError at runtime, caught
  by the 0.20.0 release gate (smoke-perm P3), not by any unit test. Prove: a lint or test that
  every client call site resolves (no undefined identifiers) — a `node --check` passes this file,
  so it needs more than syntax. Owed to the campaign.~~
  **DISCHARGED — campaign, 2026-08-30.** `unresolvedCalls()` in `test.mjs` and the lint "every
  call site in every module resolves to something", over every `.mjs` in the repo root. It has a
  canary of its own — a lint that has never gone red proves nothing — driving the real bug from
  both directions (definition renamed, and one call site renamed) plus nine shapes that must NOT
  fire. The canary immediately earned it: object-literal shorthand methods (`{ run() {…} }`) read
  as calls to something undefined, so the rule now tells `name(…) {` (a definition) from
  `name(…)` (a call) by matching the parens. All twelve modules are clean today.
- 2026-08-29 · v0.33 adopt batch: `smoke-ink`, `smoke-xfer`, `smoke.mjs`, `smoke-popup`,
  `smoke-slash`, `smoke-perm`, `smoke-knock`, `smoke-transport`, `smoke-replay`, `smoke-invite`,
  `smoke-answer`, `smoke-discover`, `smoke-nudge`, `smoke-scroll` not re-run. Every tmux call that
  targets the claude pane moved from `tmux()` to `ptmux()`, which is the SAME socket for an
  ordinary jam — so the non-adopted path is unchanged by construction — and `smoke-lifecycle`
  (which builds real jams and drives the launcher's prompts) plus the new `smoke-adopt` cover the
  paths that did change. Prove: full sweep at the next release gate.
  **DISCHARGED — 0.21.0 gate, 2026-08-29: all fourteen re-run, all green. The judgement held —
  the `tmux()` → `ptmux()` move broke nothing on the non-adopted path.**
- ~~2026-08-29 · Adoption has never been run against a REAL claude in a REAL pane on the default
  tmux socket … the injected briefing has never been seen to land in a live conversation.~~
  **DISCHARGED — campaign, 2026-08-30.** A real claude (Haiku 4.5, 2.1.251) in a real pane on the
  DEFAULT tmux socket, given one real turn first so the briefing landed in a NON-empty
  conversation, then adopted. The briefing landed **and claude answered it**: *"Understood.
  Session adopted and bridged. I'm aware of the two hard rules (never reveal tokens/links to
  participants, never claim to see /c chat)…"* `claude-jam end` then left the pane, the session
  and claude exactly as they were — **same pane pid, 69305, before and after** — and the one
  session the run created on the default socket was removed by that exact name.
  It also found a real papercut on the most ordinary install there is: see the
  `paneCommandNote` fix below.
- ~~2026-08-29 · `contextLostSignal`'s patterns are UNVERIFIED against a real compaction … the
  marker itself is a guess. Prove: capture a real `/compact` and a real `/clear` into
  `fixtures/pane/`, then assert against those.~~
  **DISCHARGED — campaign, 2026-08-30.** Six haiku turns, then a real `/compact`, then a real
  `/clear`, captured into `fixtures/pane/compacted.txt` and `fixtures/pane/cleared.txt` with
  tests asserting against them. **The guess was right**: the marker is
  `⎿  Compacted (ctrl+o to see full summary)` — a `⎿` continuation line under the human's
  `/compact`, so neither at the start of a line nor after a ⏺/●/* glyph, which is exactly why
  `COMPACTED_RE` allows any whitespace before it. Two things the capture taught that the guess
  did not include, both now pinned by tests: a real compaction **does not wipe the scrollback**
  (the screen is still full afterwards, so the "nearly empty" branch would never have caught it),
  and a **fresh claude reads as `cleared`** — see the new deferral below.
  (For whoever does it: writing that step found two real bugs — the re-brief's own wording
  matching the watcher, i.e. an injection loop on a live session, and the baseline being taken by
  whichever tick happened to run first. Both are fixed and both have tests. It was a
  run-it-twelve-times step, not a run-it-once step; treat the real-capture version the same way.)
- ~~2026-08-29 · The ROSTER re-brief has unit tests (`briefUpdateDecision`, `rosterKey`) but no
  end-to-end run: proving it needs a fake clock … Prove: either a `--brief-min-gap` test hook, or
  a campaign run long enough to cross the gap with somebody joining.~~
  **DISCHARGED — campaign, 2026-08-30.** The hook, as `JAM_BRIEF_MIN_GAP` — an internal `JAM_*`
  var like `JAM_HOOK_SECRET`, deliberately NOT a flag, so `--help`, `/menu`, `MANUAL.md`, the
  README and the wiki gain nothing. `smoke-adopt` S13 adopts a pane of its own with the gap at 0,
  waits for the adoption briefing, has somebody JOIN, and asserts the re-brief lands in the pane
  naming them, keeps the standing rules, and is logged on the `roster` path rather than the
  compaction one. Ignoring the hook makes S13 time out, which was checked — so the deferral's own
  claim (the gap made this unreachable in a smoke) is now measured rather than assumed.
  S13 runs LAST on purpose: adoption names its own session `claude-jam`, so two adopted jams at
  once make `claude-jam end <name>` ambiguous — found the hard way while writing it.
- 2026-08-29 · v0.29 peer tasks: of the other seventeen smokes, four were re-run and thirteen were
  not. RE-RUN and green: `smoke-lifecycle` (real jams through the launcher, and `writeSystemPrompt`
  took a new argument), `smoke-answer` (the daemon's frame dispatch plus a real ink client),
  `smoke-nudge` (the `/menu` tree gained a section, and the platform seam), `smoke-scroll` (a real
  ink client on a real pty — the stdin key chain gained `peerKeys` in front of the approval bar).
  NOT re-run: `smoke-ink`, `smoke-xfer`, `smoke.mjs`, `smoke-mirror`, `smoke-popup`, `smoke-slash`,
  `smoke-perm`, `smoke-knock`, `smoke-transport`, `smoke-replay`, `smoke-invite`, `smoke-discover`,
  `smoke-adopt` — judged unaffected (no existing code path was edited; the daemon gained frame
  types and one loopback endpoint, the clients gained commands and a frame case, `peer.mjs` and
  `peer-mcp.mjs` are new files) and six of them spend tokens. Prove: full sweep at the next
  release gate.
  **DISCHARGED — 0.21.0 gate, 2026-08-29: all thirteen re-run, all green. The judgement held.**
- ~~2026-08-29 · The peer executor has NEVER been a real `claude`. … nobody has SEEN
  `--restricted` refuse a read outside the scratch directory.~~
  **DISCHARGED — campaign, 2026-08-30.** One live run, the SHIPPED `peerSpawnArgs`, real claude
  2.1.251, `--model claude-haiku-4-5-20251001`, $0.012. All five flags accepted (exit 0, empty
  stderr). `--restricted` refused the read in its own words, and the refusal is quoted here
  because that is the whole point of the deferral:
  `/Users/roypadina/.ssh is outside /private/var/folders/…/jam-livepeer-PoR9gs; --restricted
  confines the file tools to the working directory.` Refused, not empty. The stream also carried
  a `system/permission_denied` event, so the daemon could see it too.
- ~~2026-08-29 · The turn cap counts `{"type":"assistant"}` events in the stream. That one such
  event is one turn is taken from the documented event shape, not measured against a real stream
  — a build that emitted two per turn would halve every cap.~~
  **DISCHARGED — campaign, 2026-08-30, AND THE FEAR WAS RIGHT.** Measured on the live run above:
  **6 `assistant` events, 2 distinct `message.id`s, `result.num_turns: 3`.** 2.1.251 emits one
  event per CONTENT BLOCK — thinking, text, tool_use, tool_use / thinking, text — so the cap
  counted thinking and every tool call as turns of their own. A `--turns 12` task got about four,
  and the consent block promised twelve. Fixed by counting distinct `message.id`s; the stand-in
  now emits ids and a `blocks` mode reproducing the measured shape, and `smoke-peer` step 9b
  fails without the fix (verified by reverting it).
- 2026-08-29 · `--max-turns` DOES NOT EXIST on claude 2.1.251 (checked in `--help` 2026-08-29),
  so the spec's `--max-turns <n>` could not be passed and jam enforces the turn cap itself by
  counting the stream and killing the child by pid. `--max-budget-usd` exists and is a real spend
  cap, but it was NOT adopted: it is untestable without spending, and an inert or refusing flag
  would break every task. Prove: decide in the campaign whether to add it, after one live run.
  **PARTLY DISCHARGED — campaign, 2026-08-30.** Re-checked on 2.1.251: `--max-turns` is still
  absent, `--max-budget-usd` is still present. The live run happened (and found the turn-cap bug
  above), so the decision no longer needs one. It is Roy's call, and it is carried as its own
  entry at the end of this list rather than left inside a v0.29 note.
- ~~2026-08-29 · The ink client's peer surface — the consent block in the transcript, the
  `PeerBar` row, the `a`/`d`/`n` keys and Esc-to-cancel — has no pty evidence … nobody has LOOKED
  at the ink rendering.~~
  **DISCHARGED — campaign, 2026-08-30.** A real ink client on a real pty as the guest, with a
  stand-in executor so it spent nothing. All four surfaces photographed: the consent block (tools
  marked read-only, the caps, the scratch directory, "your own MCP servers are OFF for it", and
  the prompt under "this is text from another machine, read it before you answer"), the
  `[a]ccept · [d]ecline · [n]ever this session` line, `a` accepting, the `PeerBar` row
  (`⇄ a task is running on THIS machine, in your Claude Code · Esc cancels it`), and **Esc
  cancelling a running task**. Captures kept outside the repo, in the campaign folder
  (`~/ClaudWork/2026-08-30-jam-campaign/ink-peer-shots/`), because a screenshot of a client is not
  a fixture anything asserts against.
  NOT converted into a smoke step: it needs a real pty, a second `$TMPDIR`/`$HOME` and a stand-in
  executor, which is `smoke-peer`'s whole setup plus `smoke-scroll`'s — worth doing, not worth
  doing at 01:00 without somebody to review the seam.
- 2026-08-30 · **CAMPAIGN** `--funnel`'s trust boundary is UNVERIFIED in a second, new way. The
  campaign found and fixed a hole where every relayed socket reached the daemon from 127.0.0.1
  and so was treated as the host (see the campaign section below); the fix reads the upgrade
  headers a proxy adds, and it is measured against cloudflared only. Whether `tailscale funnel`
  adds `x-forwarded-for`/`cf-*`-style headers is not known, so `--funnel` may still be exposed.
  Prove: one Funnel upgrade captured and its headers read — or adopt the transport-independent
  fix (a second factor on `host: true`).
- 2026-08-29 · `--funnel` carries a known UPSTREAM risk, not merely an unverified path:
  tailscale/tailscale#18827 (filed 2026-02-27, open) reports WebSockets through `tailscale
  serve`'s HTTP reverse proxy — the same layer Funnel rides — closing every 10–40 s with code
  1001 "Going Away". Our 30 s heartbeat cannot save a 10 s drop; the reconnect tiers would just
  churn. Prove: one real WS session over Funnel before `--funnel` is recommended anywhere in the
  docs. Until then it is a stable-URL convenience with an unproven long-session story, and the
  docs must not imply otherwise.


- ~~2026-08-30 · **CAMPAIGN, NEW.** A just-STARTED claude and a just-`/clear`ed one draw the same
  screen — same banner, same emptiness — so `contextLostSignal` returns `cleared` for both …
  a later `/clear` does not change the signature — so no re-brief fires and the agent has
  silently lost the two standing rules.~~
  **FIXED — 2026-08-30 (F7).** They are distinguishable from the pane after all, and the campaign's
  own captures are what say so: `/clear` prints its own echo where the transcript it wiped used to
  be (`❯ /clear`, row 8 of `fixtures/pane/cleared.txt`) and neither `startup.txt` nor
  `startup-one-turn.txt` has such a row. The signature carries it — `cleared:/clear` against
  `cleared` — so F7's exact repro (adopt at the startup screen, one short turn, then `/clear`)
  now fires. Pinned by `F7: a STARTUP screen and a /clear are different signatures`, which asserts
  against all three real captures and replays the repro as the watcher walks it; with the echo
  term reverted it is one of exactly two tests that go red (checked, 403/2). `smoke-adopt` S7b
  re-run and green — its `[brief] compacted:` assertion also covers the daemon log line, which
  now prints the signature rather than the kind.
  What is NOT covered, and why it is not: the `cleared` branch has no end-to-end smoke step. S7b
  proves the watcher → decision → injection plumbing with the compaction marker, and nothing in
  that plumbing changed — only the value of one signature, which the unit test pins against the
  measured corpus. An end-to-end version needs a second adopted jam (adoption names its own
  session `claude-jam`, so two at once make `claude-jam end <name>` ambiguous — S13's note) or a
  restructure of S7b's guest lifetime, for a third proof of a path already proven twice. Prove:
  fold a `cleared`-mode paint into S7b when that step is next touched.
- 2026-08-30 · **F10 — the suites clean up after themselves now.** `smoke-peer` (4 dirs),
  `smoke-answer` (3), `smoke-discover` (2) and `smoke-xfer` (1) removed nothing, so `$TMPDIR` grew
  by ~10 per full sweep forever; 158 `jam-*` directories were counted. A PASSING run now removes
  exactly the paths its own `mkdtempSync` returned, one `rmSync` each, after its daemons are dead;
  a FAILING run keeps them and says where. No pattern, no glob, no sweep — the same rule AGENTS.md
  §0 states for processes and tmux sessions, and it is written down in §2 now.
  Measured, 2026-08-30: `$TMPDIR` held 104 `jam-*` directories; `smoke-peer`, `smoke-answer` and
  `smoke-discover` were run back to back (all green) and it held **104** afterwards. Before this
  change those three runs would have left nine.
  ~~NOT run: `smoke-xfer`. It is one of the six that need a daemon of yours with a real claude, so
  it spends tokens, and this batch's guardrail was not to. Its change is the same shape as the
  other three — one `rmSync` of one `mkdtempSync` path at the end of the script — and `node
  --check` passes it, which is not the same as having run it. Prove: the next full sweep; watch
  for `(cleaned up: …/jam-xfer-smoke-…)` on its last line.~~
  **DISCHARGED — 0.22.0 gate, 2026-08-30.** `smoke-xfer` ran and its last line read
  `(cleaned up: /var/folders/…/jam-xfer-smoke-eB7uZB)`, exactly the string this entry said to watch
  for. Across the whole sixteen-suite sweep `$TMPDIR` went 100 `jam-*` directories in, 100 out.
- 2026-08-30 · **F6 — said rather than waited for, deliberately.** The tunnel-ready line now ends
  `· give it a few seconds — the edge needs a moment before the first join works`, because
  cloudflared reports its hostname ~2.5 s before Cloudflare will route to it (soak log,
  21:10:51.616 published → 21:10:54.142 connected, one `1006` at 21:10:51.922 in between). Waiting
  for the edge instead would mean polling the public URL until it answers — a health check with a
  timeout, a retry policy and a failure mode of its own — for a race a human never loses. The
  sentence is on `relayReadyLine` only, and there is a test asserting `tunnelJoinLines` does NOT
  carry it, since those strings are reprinted by `/join` hours later. `smoke-transport` (a real
  cloudflared, a real `trycloudflare.com` hostname, the relay respawn and the reconnect ladder)
  re-run twice and green.
  NOT proven: nothing asserts the 2.5 s number in CI — no smoke measures the gap between the
  hostname landing and the first successful connect, and doing so would need exactly the probe
  this change avoids building. The number is the campaign's measurement, cited with its log
  timestamps in the code, the wiki and here. Prove: if it ever looks wrong, re-time it the same
  way — `soak.mjs` with a client connecting at t=0.
- 2026-08-30 · **F8 — the invisible state dir is visible.** A `claude-jam-<port>` directory with no
  `session.json` used to be skipped by `listRows`, so it could be neither listed nor cleaned. It is
  a new state, `incomplete`, listed and cleanable while nothing holds its port (and `no-session`,
  untouched, while something does — a `--daemon` with no `session.json` is what every smoke runs).
  Pinned by `F8 a state dir with no session.json is listed and cleanable — and nothing else
  changed`, which also asserts the half that must NOT move: no name, so `resolveTarget` cannot
  reach it and the v0.18 pair is never consulted. `smoke-lifecycle` — the suite that owns
  list/end/clean, including the two decoys and the planted real-TMPDIR orphan — re-run and green
  in 22s.
  End to end as well as in the unit suite: `smoke-lifecycle` step 3 now PLANTS one — a state dir
  with a `token.json` and no `session.json`, on a port below the range so nothing can ever be
  listening on it — and asserts the whole path, `readdir` → row → offered by `clean` → `rmSync`,
  alongside the orphan and the live jam that must survive. It also asserts the refusal:
  `claude-jam end 7849` exits non-zero, because there is no name for `resolveTarget` to find.
  Verified by hand on the real machine too, 2026-08-30: `claude-jam sessions` now shows
  `! 1 — — 7777 incomplete` with its explanatory note, where it previously showed nothing.
  **Not cleaned** — that directory is Roy's, and only he decides.
- 2026-08-30 · **F5 — fixed, and still unrunnable on the platform it is for.** `safeBaseName` now
  renames the Windows device names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`, with
  any extension) and strips trailing dots. Pinned by `safeBaseName: the Windows device names,
  which are not files at all`, including the near-misses that must NOT be renamed (`console.log`,
  `com10.txt`, `lpt0.txt`, `CONIN$.txt`) and idempotence. `smoke-nudge` (the upload-policy suite)
  re-run and green in 13s. The skip that remains is the platform itself: **no Windows box**, so
  "the file is now usable there" is reasoned from the API contract, not observed. Prove: the
  Windows run in the W3 work — send `con.txt` into a jam from a Windows client and open it.
- 2026-08-30 · **F4 — the stand-in was not the thing it stood in for.** `scripts/fake-claude.mjs`
  emitted one stream event per turn; 2.1.251 emits one per CONTENT BLOCK under a shared
  `message.id`, so the only path `smoke-peer` could reach was the no-id fallback and the turn-cap
  bug survived eighteen runs. Fixed: `turn()` emits the measured shape in EVERY mode (the `blocks`
  mode is now just two ordinary turns — thinking + text + two tool_use, then thinking + text: six
  assistant events, two ids), and a finished run writes a `receipt` line saying what it actually
  emitted, which step 9b asserts (`events: 6`, `ids: 2`) instead of trusting a mode name. The
  result frame carries the measured `num_turns`, `duration_ms` and `total_cost_usd`.
  **Proved by reverting the fix**, 2026-08-30: with `peer.mjs` counting events again
  (`turns++` unconditionally), step 9b goes red — *"it ran to completion instead of hitting the
  cap: 'cap': got false, want true"* — and every other step still passes, which is the point.
  Restored and re-run: all 16 steps green, 405/0 unit.
  NOT done, and named here rather than left implicit: the other stand-ins were not re-derived from
  a fresh measurement. `fake-tui.mjs` is built from the real `fixtures/pane/` corpus and its one
  known infidelity (its command name is `node`, which is what hid F9) is a property of running it
  under node at all, not something a rewrite fixes. Prove: when a stand-in's behaviour is next
  relied on for a new assertion, measure that behaviour first and say so in the file.
- 2026-08-30 · **F7's remaining ceiling, accepted and documented** (`host.mjs` `watchContext`,
  the wiki's Hosting-a-Jam). The watch is edge detection over a screen signature, so two identical
  losses with nothing observable between them read as one: `/clear`, then exchanges short enough
  that the screen never leaves `cleared:/clear`, then `/clear` again. The roster re-brief is the
  backstop. Prove/fix: something other than the pane for "the context went" — the transcript's own
  file is still the obvious candidate — if it ever actually bites.
- 2026-08-30 · **CAMPAIGN, NEW.** `--max-budget-usd` DOES exist on 2.1.251 (checked in `--help`,
  2026-08-30) and is a real spend cap, unlike the `--max-turns` the spec wanted. It is still not
  adopted, and the campaign did not adopt it: it is untestable without spending, and an inert or
  refusing flag would break every peer task. Now that a live run exists ($0.012, `total_cost_usd`
  on the result frame), the decision is cheap to make. Prove: Roy's call — one live run with the
  flag set below the task's cost, checking it refuses rather than truncating silently.

- ~~2026-08-30 · **v0.34 batch (host identity is a local secret).** Run per the batch policy, not
  the full sweep: `node --test test.mjs` (407 → 422, green) plus `smoke-slash`, `smoke-lifecycle`,
  `smoke-knock`, `smoke-adopt` and `smoke-transport`, all green. **Not re-run:** `smoke-ink`,
  `smoke.mjs`, `smoke-mirror`, `smoke-popup`, `smoke-xfer`, `smoke-perm`, `smoke-replay`,
  `smoke-invite`, `smoke-answer`, `smoke-discover`, `smoke-nudge`, `smoke-peer`, `smoke-scroll`.
  Every one of them that connects a scripted host was edited in the same commit to read
  `<state>/host.key` and present it, and `node --check` passes on all of them — but an edit that
  compiles is not a run, and a host peer that silently became a guest would fail those suites
  loudly rather than subtly (a demoted host gets no join line, no F3 and no host-only report).
  Prove: full sweep at the next release gate.~~
  **DISCHARGED — 0.22.0 gate, 2026-08-30: all thirteen re-run, all green.** The judgement held for
  twelve of them. It did NOT hold for `smoke-adopt`, which was in the re-run half and passed there:
  its S7c step was flaky, and the 0.22.0 gate is where it finally went red and gave up a real
  scrub gap. "An edit that compiles is not a run" was the right instinct; the missing half is that
  a suite that RAN is not the same as a suite that ran deterministically.
- ~~2026-08-30 · **v0.34: the `/export` leak proof did not run in `smoke-slash`.** Its jam's claude
  had never taken a turn, so there was no transcript on disk and the daemon refused the export
  with "there is no transcript on disk yet" — which the step now prints rather than failing on.
  The export half is proven instead in `smoke-adopt` S7c, against the transcript that suite
  plants under a `$HOME` of its own, with the key written INTO it first so the scrub is not
  vacuous (`[host key removed]` present, key absent, 501 bytes). `smoke-xfer` asserts the same
  thing against a REAL claude transcript and was not run (it costs a turn). Prove: `smoke-xfer`
  at the next release gate.~~
  **DISCHARGED — 0.22.0 gate, 2026-08-30.** Both halves ran. `smoke-xfer` green against a real
  claude transcript, and `smoke-slash`'s own step ran this time too — its jam HAD taken turns by
  then — reporting `/export: 5 chunk(s), 311203 bytes, no key in them` plus `daemon window: 241
  line(s) captured, no key in them` and `host.key is 0600 and the only file holding the key`.
- 2026-08-30 · **Funnel: the transport is still unverified; the HOST GATE no longer depends on
  it.** Whether a Tailscale Funnel upgrade carries any proxy header was never measured (Funnel is
  not enabled on this tailnet and the installed Tailscale is the sandboxed App Store build), and
  that is unchanged. What changed is that it no longer matters for host authority: since v0.34 a
  socket is the host only if it presents the daemon's `0600` `host.key`, which a process on
  another machine cannot read — so a funnel-relayed socket is not the host whether or not
  Tailscale sets a header we would have recognised. The **relay itself** (does `--funnel` carry
  bytes at all, end to end, from another machine) remains unproven and `smoke-transport`'s T4
  still runs against a stub CLI. Prove: after Roy enables Funnel and installs the standalone
  build — the same condition as the 2026-08-29 entry above.
- 2026-08-30 · **SECURITY REVIEW, NEW: `smoke-mirror` not re-run against a real claude after the
  wrapped-row scrub.** The change touches both pane funnels. `screen-history` is covered —
  `smoke-scroll` ran green, 13/13, and it asserts the rows are *row for row identical to
  `capture-pane`*, so it would fail on any over-masking. The live frame path was exercised by a
  purpose-built probe (a real daemon, a real mirror guest at 80 columns, the key printed on the
  pane, scrubbed in both the whole-row and the wrapped case) and by the new unit lint that fails if
  either funnel loses the join scrub. What was NOT run is `smoke-mirror` itself: it needs a real
  claude to answer an injected prompt (three of its eight steps assert `ok` came back and one
  asserts SGR the stand-in does not emit), and this review was instructed not to spend quota.
  Driven against a `fake-tui` daemon it is 5/8, with the three failures attributable to the
  stand-in by their own text. Prove: `smoke-mirror` in the next release gate's shared-daemon block,
  where a real claude is up anyway.
- 2026-08-30 · **SECURITY REVIEW, NEW: `smoke-xfer` not re-run after the upload write changed to
  `flag: 'wx'`.** Same reason — it takes a live jam with a real claude (its last step reads the
  pane for claude's reaction to an uploaded image). `smoke-nudge` covers the same
  `onUpload → writeUpload` path end to end for free, and now runs 16/16 including the two new
  steps. Prove: `smoke-xfer` in the next release gate.
- 2026-08-30 · **SECURITY REVIEW, NEW: the pre-auth roster oracle is REPORTED, not decided.**
  A hello with a name somebody already holds is refused `the name "X" is already taken here` and
  closed 4409 **before** any admission, so a stranger with no token can enumerate who is in a jam,
  unlimited (the close happens above `pending`, so `MAX_PENDING` does not apply). Invite-only mode
  does not leak — its refusal is above that line. The two answers are both defensible (a joiner
  who is told "that name is taken" can fix it in one go; a joiner who is not is left guessing why
  they were refused), so it was left for Roy rather than picked. Prove/decide: either accept it in
  `Security-Model` as the cost of name-based attribution, or move the name check below admission
  and give a knocker a generic refusal.

## The 2026-08-30 campaign

The end-game campaign of the section above, run overnight on 2026-08-30. Node 24.15 / tmux 3.7c /
claude 2.1.251 / ttyd 1.7.7 / cloudflared 2026.8.2, from a verified-clean machine state (no live
tmux server on any socket, no jam daemon anywhere).

### What it found

- **A guest on the far side of `--tunnel` was the host.** The whole `trusted()` gate — F3 raw
  keys, `/end`, `/kick`, `/invite`, `/remote`, `/announce`, `/grants`, the browser view — plus
  `host: true` itself rested on the socket's address, and every relay proxies to loopback. A
  stranger with only the public URL and **no token** was admitted as host, handed the join token,
  typed into the real pane and ended the jam. Fixed: `localSocket()` in `lib.mjs`, applied to the
  WS admission path and all six loopback-gated HTTP endpoints, with five unit tests. Verified
  after the fix: the stranger knocks, a token-holding relay guest is still an ordinary guest, and
  the host's own loopback client is unchanged.

- **F1's fix was a blocklist, and v0.34 replaced it with proof.** The header test above holds for
  cloudflared, which was measured — but it enumerates what a relay looks like, so the next relay
  that proxies to `127.0.0.1` without a header on that list re-opens the hole silently. v0.34
  makes host authority a `0600` file in the `0700` state dir that only a local process can read,
  with the header test kept as a second, independent condition. Canary (2026-08-30, run twice):
  breaking `hostKeyMatches` turned **8** `smoke-knock` steps red including "loopback host hello is
  welcomed", and 5 unit tests; removing `--host-key-file` from the launcher's own client turned
  `smoke-lifecycle` steps 5 and 6 red ("the attached client did not join as the HOST", then a
  demoted host unable to `/end`) and the "every surface … hands it the key file" lint. Restored,
  both suites green again.

### Deferrals this campaign closes, and the ones it opens

Struck-through entries above are discharged. New ones are appended above in date order.
