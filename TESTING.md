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
- 2026-08-29 · The 2-hour remote-session claim is unproven: the keepalive, relay auto-restart and
  reconnect tiers exist but no long run has happened. Prove: the soak above.
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
- 2026-08-29 · Adoption has never been run against a REAL claude in a REAL pane on the default
  tmux socket — `smoke-adopt` uses `scripts/fake-tui.mjs` for the pane, and the one default-socket
  case it runs uses a session the smoke created itself. So the injected briefing has never been
  seen to land in a live conversation. Prove: one live adoption in the campaign (Roy's own
  session, `--no-brief` off), looking at the pane afterwards.
- 2026-08-29 · `contextLostSignal`'s patterns are UNVERIFIED against a real compaction. There is
  no capture of one in `fixtures/pane/`, so the wording (`Compacted`, the post-`/clear` welcome
  block) comes from claude 2.1.251's own output rather than from a measured corpus — and
  `smoke-adopt` S7b drives it with a fixture the SMOKE invents, in its own temp dir, deliberately
  not added to the real corpus. The end-to-end path (marker on the pane → re-brief injected and
  landed) is therefore proven; the marker itself is a guess. Prove: capture a real `/compact` and
  a real `/clear` into `fixtures/pane/`, then assert against those. A false negative here is an
  agent that has quietly forgotten the two standing rules, so it is worth a real capture.
  (For whoever does it: writing that step found two real bugs — the re-brief's own wording
  matching the watcher, i.e. an injection loop on a live session, and the baseline being taken by
  whichever tick happened to run first. Both are fixed and both have tests. It was a
  run-it-twelve-times step, not a run-it-once step; treat the real-capture version the same way.)
- 2026-08-29 · The ROSTER re-brief has unit tests (`briefUpdateDecision`, `rosterKey`) but no
  end-to-end run: proving it needs a fake clock, because the 10-minute rate limit is armed by the
  adoption briefing seconds earlier. Prove: either a `--brief-min-gap` test hook, or a campaign
  run long enough to cross the gap with somebody joining.
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
- 2026-08-29 · The ink client's peer surface — the consent block in the transcript, the `PeerBar`
  row, the `a`/`d`/`n` keys and Esc-to-cancel — has no pty evidence. `smoke-peer` drives the
  `--basic` client (the half that spawns), and the key decisions are unit-tested through
  `peerKeyAction`, but nobody has LOOKED at the ink rendering. Prove: a pty run in the campaign,
  in the style of `smoke-scroll`'s real ink guest.
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

### Deferrals this campaign closes, and the ones it opens

Struck-through entries above are discharged. New ones are appended above in date order.
