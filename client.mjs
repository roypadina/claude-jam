#!/usr/bin/env node
// claude-jam client entry point. Validates the CLI surface, then hands the process to one of
// two renderers — both read process.argv themselves, so the flags reach them untouched:
//   client-ink.mjs   (default) ink UI: <Static> transcript, own status row, TextInput prompt
//   client-basic.mjs (--basic)  the readline renderer, for a terminal ink misbehaves in
// A dynamic import, not a spawn: one process keeps the tty, the signals and the exit code.
import { decodeInvite, terminalSupport } from './lib.mjs';

// v0.32 W1: before anything else, because the alternative is a screen of escape codes. The
// legacy Windows console cannot draw this client, and a person who lands there deserves the name
// of the terminal that can rather than a garbled session they have to reason about. Both
// renderers are covered by one check: --basic writes ANSI colour too, and one rule with one
// message beats a special case nobody will maintain.
// Both arguments are passed on purpose. The defaults are `process.platform` and `{}` — an EMPTY
// environment — because every pure function in lib.mjs defaults that way so its tests have to
// state what they are asking about. Calling `terminalSupport()` bare therefore refuses every
// Windows terminal there is, which is exactly what it did on the first run of
// scripts/check-terminal-gate.mjs.
const term = terminalSupport(process.platform, process.env);
if (!term.ok) { console.error(`! ${term.why}`); process.exit(2); }

// v0.22B: `claude-jam join cjam1_…` is a guest's WHOLE command — the link carries the addresses,
// their name and a per-invite secret, so there is nothing else to type. It is unpacked HERE, once,
// into the flags the renderers already understand, so neither renderer learns a second way in.
const link = process.argv.slice(2).find((a) => /^cjam\d/.test(a));
if (link) {
  const d = decodeInvite(link);
  // No usable contents at all (not a link, a future format, a damaged blob): there is nothing to
  // connect to, so say which and stop. An EXPIRED link still carries its address and name, so it
  // becomes a knock instead — the host can wave the person in.
  if (!d.invite) { console.error(`! ${d.error}`); process.exit(2); }
  if (!d.ok) console.error(`! ${d.error}`);
  const inv = d.invite;
  process.argv.splice(process.argv.indexOf(link), 1, inv.ws[0], '--jam-addresses', inv.ws.join(','));
  // An explicit --name on the command line wins: it is what a guest would use to rename
  // themselves, and the daemon re-derives the real name off the invite record anyway.
  if (!process.argv.includes('--name')) process.argv.push('--name', inv.name);
  if (d.ok) process.argv.push('--invite', inv.secret);
}

const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('ws'));
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
// No --token is normal: the host may run knock-only, and then you wait to be accepted.
if (!url || !flag('name')) {
  console.error('usage: claude-jam join <invite-link>\n'
    + '       claude-jam join <ws-url> --name <Name> [--token <token>] [--host --host-key-file F] [--basic] [--no-sound]');
  process.exit(2);
}
// No tty on stdin (a pipe, a cron, a heredoc) is exactly the case `--basic` exists for: ink
// needs raw mode and throws without it, while readline just reads the lines.
const basic = argv.includes('--basic') || !process.stdin.isTTY;
// v0.23.4: ink paints nothing but its <Static> region when `is-in-ci` says CI, and the mirror view
// has no <Static> — so a client started from any shell carrying `CI`, `CONTINUOUS_INTEGRATION` or a
// `CI_*` variable opened on a blank screen. See ink-ci.mjs; the import is what does it, and it has
// to happen before ink's, which is why the renderer below is loaded dynamically after this line.
const { restoreCi } = await import('./ink-ci.mjs');
await import(basic ? './client-basic.mjs' : './client-ink.mjs');
restoreCi();
