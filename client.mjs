#!/usr/bin/env node
// claude-jam client entry point. Validates the CLI surface, then hands the process to one of
// two renderers — both read process.argv themselves, so the flags reach them untouched:
//   client-ink.mjs   (default) ink UI: <Static> transcript, own status row, TextInput prompt
//   client-basic.mjs (--basic)  the readline renderer, for a terminal ink misbehaves in
// A dynamic import, not a spawn: one process keeps the tty, the signals and the exit code.
const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('ws'));
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
// No --token is normal: the host may run knock-only, and then you wait to be accepted.
if (!url || !flag('name')) {
  console.error('usage: node client.mjs <ws-url> --name <Name> [--token <token>] [--host] [--basic]');
  process.exit(2);
}
// No tty on stdin (a pipe, a cron, a heredoc) is exactly the case `--basic` exists for: ink
// needs raw mode and throws without it, while readline just reads the lines.
const basic = argv.includes('--basic') || !process.stdin.isTTY;
await import(basic ? './client-basic.mjs' : './client-ink.mjs');
