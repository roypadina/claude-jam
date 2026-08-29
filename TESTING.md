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

## Deferred (owed to the campaign)

Append one line per skip: what, why, and how it will be proven. Newest last.

- 2026-08-29 · smoke.mjs, smoke-xfer, smoke-popup, smoke-slash, smoke-perm, smoke-knock not
  re-run after the v0.28 scrollback batch (judged unaffected; token cost). Prove: full sweep at
  the 0.20.0 release.
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
- 2026-08-29 · A mention in `/c` chat never rang the bell in `--basic` clients: `client-basic.mjs`
  still called `nudge()` after the v0.25 rename to `alert()` — a ReferenceError at runtime, caught
  by the 0.20.0 release gate (smoke-perm P3), not by any unit test. Prove: a lint or test that
  every client call site resolves (no undefined identifiers) — a `node --check` passes this file,
  so it needs more than syntax. Owed to the campaign.
- 2026-08-29 · v0.33 adopt batch: `smoke-ink`, `smoke-xfer`, `smoke.mjs`, `smoke-popup`,
  `smoke-slash`, `smoke-perm`, `smoke-knock`, `smoke-transport`, `smoke-replay`, `smoke-invite`,
  `smoke-answer`, `smoke-discover`, `smoke-nudge`, `smoke-scroll` not re-run. Every tmux call that
  targets the claude pane moved from `tmux()` to `ptmux()`, which is the SAME socket for an
  ordinary jam — so the non-adopted path is unchanged by construction — and `smoke-lifecycle`
  (which builds real jams and drives the launcher's prompts) plus the new `smoke-adopt` cover the
  paths that did change. Prove: full sweep at the next release gate.
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
- 2026-08-29 · The ROSTER re-brief has unit tests (`briefUpdateDecision`, `rosterKey`) but no
  end-to-end run: proving it needs a fake clock, because the 10-minute rate limit is armed by the
  adoption briefing seconds earlier. Prove: either a `--brief-min-gap` test hook, or a campaign
  run long enough to cross the gap with somebody joining.
- 2026-08-29 · `--funnel` carries a known UPSTREAM risk, not merely an unverified path:
  tailscale/tailscale#18827 (filed 2026-02-27, open) reports WebSockets through `tailscale
  serve`'s HTTP reverse proxy — the same layer Funnel rides — closing every 10–40 s with code
  1001 "Going Away". Our 30 s heartbeat cannot save a 10 s drop; the reconnect tiers would just
  churn. Prove: one real WS session over Funnel before `--funnel` is recommended anywhere in the
  docs. Until then it is a stable-URL convenience with an unproven long-session story, and the
  docs must not imply otherwise.

