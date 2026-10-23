# Contributing to claude-jam

claude-jam is an **alpha** project and help is very welcome. You do not need to write code: running it on
a platform we cannot test (Windows, Linux desktop, WSL2) and telling us what happened is one of the most
useful things you can do.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Where to start

- [good first issue](https://github.com/roypadina/claude-jam/labels/good%20first%20issue): small, scoped, often no code.
- [help wanted](https://github.com/roypadina/claude-jam/labels/help%20wanted): bigger pieces we would love a hand with.
- [docs/ROADMAP.md](docs/ROADMAP.md): the path to 1.0, built from the real gaps.
- [Discussions](https://github.com/roypadina/claude-jam/discussions): questions, ideas, "is this worth a PR?".

Comment on an issue before you start so nobody duplicates work. For anything large, open a Discussion or
issue first.

## Dev setup

You need **Node 22 or later**. Hosting also needs `tmux` and the `claude` CLI on `PATH`; a pure guest
or a unit-test run needs only Node.

```sh
git clone https://github.com/roypadina/claude-jam.git
cd claude-jam
npm ci
```

Fork first if you plan to open a PR.

## Run the tests

```sh
node --test test.mjs        # or: npm test
```

The unit suite has 482 tests (479 pass on macOS/Linux, 3 are Windows-only and skipped elsewhere) and
runs in well under a second. It is all pure functions and spawns nothing. It must be green before every
commit. CI also runs it on macOS, Linux and Windows, plus the `scripts/check-*.mjs` checks.

Things that need a real tmux, a real process or a real terminal live in `scripts/`:
`node scripts/smoke-lifecycle.mjs` is a good first one (needs tmux). `TESTING.md` explains which smoke
covers what.

## Project layout

| Path | What |
| --- | --- |
| `claude-jam` | the launcher (bash); `cli.mjs` is the npm entry that wraps it |
| `lib.mjs` | pure functions only, where decisions are made and most tests aim |
| `host.mjs` | the host daemon: WebSocket server, injection, hooks endpoint |
| `client*.mjs`, `menu.mjs` | the guest/host terminal client (ink) and the launcher menu |
| `sessions.mjs` | tmux and filesystem lifecycle: list, end, invite, adopt |
| `platform.mjs` | the only place that spawns platform binaries (macOS, Linux, Windows) |
| `test.mjs` | the unit suite; `scripts/` holds smokes and real-entry-point checks |
| `docs/COMPATIBILITY.md` | what has actually been run, per platform |

`AGENTS.md` has the full file-by-file map and conventions. Read its section 0 before you run anything
that touches tmux: **never kill tmux servers or processes by name or pattern**, only the ones your own
run started. Another jam may be live on your machine.

Rule of thumb: put the decision in `lib.mjs` as a pure function with a test, and keep spawns in
`platform.mjs`. Two lints enforce this.

## Try host and guest locally

Two terminals on one machine are enough.

```sh
# terminal 1: host a jam in a scratch directory, on a port and tmux session name that are not your real jam's
mkdir -p /tmp/jam-scratch
./claude-jam host --name Alice --cwd /tmp/jam-scratch --port 7790 --tmux jam-dev

# terminal 2: join as a guest (use the link or ws URL the host printed)
./claude-jam join <invite-link-or-ws-url>
```

No `claude` login handy? The smokes use `scripts/fake-claude.mjs` as a stand-in; see
`scripts/smoke-lifecycle.mjs` for how it is wired. `./claude-jam --help` lists every flag.

## Pull request flow

1. Fork, then branch from `main`: `git switch -c fix/short-name`.
2. Keep the diff small and focused. No drive-by refactors.
3. Add or update tests. Run `node --test test.mjs`.
4. Changing behaviour? Add a line to `CHANGELOG.md`. Changing platform support? Update
   `docs/COMPATIBILITY.md` with the date, OS build, tool versions and what you observed. A row that says
   "verified" must mean "I ran it".
5. Open the PR against `main` and describe what and why. CI must pass.
6. Keep public text clean: no real hostnames, IP addresses, usernames, tokens or local paths in code,
   docs, fixtures, screenshots or commit messages. Use placeholders.

`main` is protected: it is merged by the maintainer, squashed. Do not worry about commit history inside
your PR.

## Reporting bugs and security issues

- Bugs: open an issue with `claude-jam --version`, OS, Node version, and the exact command and output.
- Security problems: use GitHub's private vulnerability reporting, not a public issue.

## License

By contributing you agree your work is released under the [MIT License](LICENSE).
