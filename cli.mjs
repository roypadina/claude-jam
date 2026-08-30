#!/usr/bin/env node
// claude-jam's `bin` entry point — the thing `npm i -g claude-jam` puts on PATH (v0.32 W1).
//
// WHY IT IS NOT THE BASH LAUNCHER ANY MORE: npm writes a Windows `.cmd` shim by reading the
// target's shebang, so a `bin` pointing at `claude-jam` (which is `#!/bin/bash`) produces a shim
// that calls `bash`. On a Windows machine without Git Bash that is "'bash' is not recognized" as
// the very first thing the tool ever says — and the whole W1 client would be unreachable on the
// exact install path W1 was approved for.
//
// So: node here, and two behaviours.
//   POSIX    exec the bash launcher, unchanged, with the arguments untouched. There is still
//            exactly ONE dispatcher for host/adopt/join/sessions/end/clean/invite/remote, and it
//            is the launcher — this file must never grow a second copy of that table.
//   Windows  answer from windowsCli() in lib.mjs: `join` runs the client in THIS process, and
//            everything host-side is refused with its reason and the WSL2 route.
// Homebrew installs the launcher directly and never comes through here.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsCli, WIN_USAGE } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

if (process.platform !== 'win32') {
  // The launcher's own shebang picks its interpreter, so it is spawned as a program rather than
  // handed to a named shell. stdio inherited: it owns the tty, the prompts and the exit code —
  // `claude-jam host` asks questions, and `exec node host.mjs` behind it must still see a
  // terminal. A signal death is reported as a failure rather than as a silent 0.
  const r = spawnSync(path.join(HERE, 'claude-jam'), argv, { stdio: 'inherit' });
  if (r.error) {
    console.error(`! could not run the claude-jam launcher: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

const plan = windowsCli(argv);

if (plan.action === 'join') {
  // The renderers read process.argv themselves — the launcher hands them `$@` after `join`, so
  // this hands them the same thing. A dynamic import, not a spawn, for the same reason
  // client.mjs uses one: one process keeps the tty, the signals and the exit code.
  process.argv = [process.argv[0], path.join(HERE, 'client.mjs'), ...plan.argv];
  await import('./client.mjs');
} else if (plan.action === 'refuse') {
  console.error(`! ${plan.why}`);
  process.exit(plan.code);
} else {
  // Usage. The reason Windows is client-only is IN the text, not appended to a refusal nobody
  // sees, because a bare `claude-jam` on Windows lands here and that is where the question is.
  const out = plan.code === 0 ? console.log : console.error;
  for (const line of WIN_USAGE) out(line);
  process.exit(plan.code);
}
