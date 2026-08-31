# The `/jam` plugin (optional)

A three-file Claude Code plugin that puts `claude-jam` behind a slash command:

| you type | it runs |
| --- | --- |
| `/jam` | `claude-jam adopt` — shares the session you are in, after showing you what it resolved |
| `/jam invite <Name>` | `claude-jam invite <Name>` |
| `/jam end` | `claude-jam end` (the daemon stops; the session carries on) |
| `/jam status` | `claude-jam sessions` |

**Installing it is entirely optional.** `claude-jam adopt` from the Bash tool works without it —
ask claude to run it, or run it yourself in another terminal with `--pane`. The plugin exists
because `/jam` is shorter than a sentence, and because the skill in it carries the two standing
rules about links and `/c` chat to a claude that has not been briefed yet.

It contains no code: a command, a skill, and a manifest. Everything it does, it does by running
the `claude-jam` you already have on `PATH`.

## Install

From this repository, which doubles as a one-plugin marketplace:

```sh
/plugin marketplace add roypadina/claude-jam
/plugin install claude-jam@claude-jam
```

Or from a clone on disk:

```sh
/plugin marketplace add ~/Code/claude-jam
/plugin install claude-jam@claude-jam
```

`/plugin` lists what is installed and removes it again. The plugin needs `claude-jam` itself on
`PATH` (`brew install roypadina/tap/claude-jam`, or `npm i -g @roypadina/claude-jam`); it does not install
it for you, and it says so rather than guessing when it is missing.

## What `/jam` does that you should know about

`claude-jam adopt` run from the Bash tool has **no terminal to ask a yes/no question on**, so it
prints everything it resolved — the pane, the tmux server, the directory, the session id, and
that session's first message and last answer — and stops. The command tells claude to show you
that block and wait for your confirmation before re-running with `--yes`.

That is not ceremony. The session id is a guess (the newest live transcript for this directory),
and a wrong guess would share somebody else's conversation with everybody you invited.
