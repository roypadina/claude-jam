# Roadmap to 1.0

claude-jam is **alpha**. This roadmap is built from the real open gaps: the unverified rows in
[COMPATIBILITY.md](COMPATIBILITY.md), the Deferred list in [../TESTING.md](../TESTING.md), the TODOs in
code and the design notes in [../SPEC.md](../SPEC.md). Each item links to an issue you can pick up. Items
marked **good first issue** need little or no code.

1.0 means: the platforms we claim are *run*, not "should work", and the public surface stops breaking.

## 1. Prove the platforms (the main blocker)

Nobody on the project has a Windows or Linux desktop, so CI is the only thing that runs those platforms.
Real-machine evidence is the most valuable contribution right now.

| Gap | Issue |
| --- | --- |
| WSL2 host: never run on a real install (`scripts/check-wsl.mjs`) | [#1](https://github.com/roypadina/claude-jam/issues/1) good first issue |
| Windows Terminal: key table, toasts, sounds written from docs, not captures | [#3](https://github.com/roypadina/claude-jam/issues/3) good first issue |
| Linux desktop: are knock / join / nudge sounds distinguishable | [#2](https://github.com/roypadina/claude-jam/issues/2) good first issue |
| Linux host: a real `claude` TUI through injection, frames and F3 | [#4](https://github.com/roypadina/claude-jam/issues/4) |
| `--funnel` (Tailscale Funnel): unverified everywhere | [#6](https://github.com/roypadina/claude-jam/issues/6) |

## 2. Close the feature gaps

| Gap | Issue |
| --- | --- |
| Linux mDNS discovery (`find`) via `avahi-browse` | [#7](https://github.com/roypadina/claude-jam/issues/7) |
| Windows `find` via Bonjour `dns-sd.exe` (`TODO(W1)` in `platform.mjs`) | [#8](https://github.com/roypadina/claude-jam/issues/8) |
| Nudge phone tier (ntfy) has no end-to-end test | [#5](https://github.com/roypadina/claude-jam/issues/5) |

## 3. Stabilise (before tagging 1.0)

- Freeze the CLI flags, the invite-link format and the WebSocket frame protocol, and document them as
  the public surface. Until then, breaking changes land in minor versions and are called out in the
  [CHANGELOG](../CHANGELOG.md).
- Run the end-game campaign described in TESTING.md (adversarial pass, repeated smokes on a fresh
  machine state).

## Not planned

- A native Windows host. Nothing reattaches to a running ConPTY, so the host's own operator would sit on a
  slow proxy path (SPEC.md v0.32 W3). WSL2 is the Windows host route.

## Later, design only

- A public relay so a host needs no inbound port (phase 2, designed, not built).

Have something else in mind? Start a [Discussion](https://github.com/roypadina/claude-jam/discussions) first.
