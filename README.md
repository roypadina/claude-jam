<div align="center">

<img src="docs/demo/demo.gif" alt="A guest joins a shared Claude Code session: the host's live claude TUI, attributed [Name] messages, and a human-only side channel." width="860">

# claude-jam

### Share one real Claude Code session with other humans, live over WebSockets.

The host keeps the native `claude` TUI: their own plugins, skills, MCP servers, `CLAUDE.md`, hooks and
account. Guests join from a terminal. The agent sees **who wrote each message**, and humans get a side
channel the agent never sees.

[![Release](https://img.shields.io/github/v/release/roypadina/claude-jam?logo=github&label=release)](https://github.com/roypadina/claude-jam/releases/latest)
[![npm](https://img.shields.io/npm/v/@roypadina/claude-jam?logo=npm)](https://www.npmjs.com/package/@roypadina/claude-jam)
[![CI](https://github.com/roypadina/claude-jam/actions/workflows/tests.yml/badge.svg)](https://github.com/roypadina/claude-jam/actions/workflows/tests.yml)
[![CI: macOS, Linux, Windows](https://img.shields.io/badge/CI-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-informational)](https://github.com/roypadina/claude-jam/actions/workflows/tests.yml)
[![Node](https://img.shields.io/badge/Node-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-F16061?logo=ko-fi&logoColor=white)](https://ko-fi.com/roypadina)

</div>

---

## Quickstart

```sh
brew install roypadina/tap/claude-jam      # or: npm i -g @roypadina/claude-jam
claude-jam host --name Alice --cwd .       # host: start a jam in this directory
claude-jam join <invite-link-or-ws-url>    # guest: the host sends you the link, privately
```

Mint a link for one person with `claude-jam invite Dana`. Bare `claude-jam` opens a menu.

## Why

Claude Code's Remote Control is one account. tmux or screen-share has no idea who typed what.
claude-jam keeps **one real interactive session**, bridges it to several people, and makes the agent
aware of the room.

- **It is the real TUI, not a wrapper.** The host's `claude` runs in tmux with their own setup;
  guests watch it streamed live and type into it.
- **Attributed messages.** Every participant, host included, reaches the agent as `[Name]: ...`.
- **A human-only side channel.** `/c` messages are never injected into the session.
- **Admission you control.** Token, knock-and-approve, single-use invite links; the host approves
  tool permissions and file uploads.
- **Works across the network.** LAN, Tailscale, a Cloudflare tunnel, or Tailscale Funnel. Guests
  need only Node 22.
- **Peer tasks.** The host's agent can ask a guest's own Claude Code to do a job, with the guest's
  consent and on the guest's own quota.

## Requirements

- **Node 22 or later.** The host also needs `tmux` and the `claude` CLI on `PATH`.
- Optional: `ttyd` (browser view), `cloudflared` (`--tunnel`), `tailscale` (`--funnel`), `git` (`/diff`).

| Platform | Host | Join as guest |
|---|---|---|
| macOS | verified on every release | verified |
| Linux | supported, thinly proven (lifecycle smoke 19/19 on Debian, CI leg) | CI-tested |
| Windows | via WSL2 only, integrated but not yet run on a real WSL install | native client CI-tested; a jam has been joined from a WSL2 client |

Row-by-row evidence, with dates, is in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Documentation

The full guide (every command, access mode, peer tasks, internals) lives in the
**[wiki](https://github.com/roypadina/claude-jam/wiki)**: start with the
[Full Guide](https://github.com/roypadina/claude-jam/wiki/Full-Guide),
[Hosting a Jam](https://github.com/roypadina/claude-jam/wiki/Hosting-a-Jam) and
[Security Model](https://github.com/roypadina/claude-jam/wiki/Security-Model).
Contributors: [AGENTS.md](AGENTS.md), [SPEC.md](SPEC.md), [TESTING.md](TESTING.md),
[PRIOR-ART.md](PRIOR-ART.md).

## Support

If claude-jam lets you share a Claude Code session with the people you work with, you can support its development. It is optional and always appreciated.

[![Support me on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/roypadina)

A star on the repo helps just as much.

## License

MIT, see [LICENSE](LICENSE).

Made by Roy Padina · [Support on Ko-fi](https://ko-fi.com/roypadina)
