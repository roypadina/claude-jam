#!/usr/bin/env node
// v0.32 W1 check: does the CLIENT ENTRY POINT actually refuse the legacy Windows console?
//
// The unit suite proves terminalSupport() decides right. It cannot prove client.mjs ASKS it
// right, and that distinction is not academic: the first run of this script found the real bug
// it exists for — `terminalSupport()` was called with no arguments, so it read an EMPTY
// environment and refused Windows Terminal along with everything else. A pure-function test
// could never have seen that.
//
// So this spawns the real `client.mjs` as a child, with a controlled environment, and looks at
// what came out. It costs nothing: no tmux, no daemon, no network, no claude, no tokens. It is
// in the CI matrix on BOTH legs, which is what makes it the one part of the Windows client whose
// end-to-end behaviour is checked on a real Windows machine every push.
//
// On win32 it asserts both directions — a bare console is refused with the hint, Windows
// Terminal gets through to the ordinary usage text. Everywhere else it asserts the gate is a
// NO-OP, because a check that can refuse a Mac is a worse bug than the one it prevents.
//   usage: node scripts/check-terminal-gate.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalSupport, WINDOWS_TERMINAL_HINT } from '../lib.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLIENT = path.join(ROOT, 'client.mjs');
const IS_WINDOWS = process.platform === 'win32';

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
};
const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};

// The environment the child gets, minus every variable that would answer the question for it.
// PATH stays (node needs to be findable on Windows); the terminal variables are the input.
const baseEnv = () => {
  const env = { ...process.env };
  for (const k of ['TERM', 'TERM_PROGRAM', 'WT_SESSION', 'WT_PROFILE_ID', 'ConEmuANSI', 'JAM_ASSUME_ANSI']) delete env[k];
  return env;
};

// No arguments at all, so the client stops at its own usage text — the gate runs BEFORE that, so
// which of the two came out is the answer. `--name` is deliberately absent for the same reason:
// nothing here should ever open a socket.
const run = (env) => {
  const r = spawnSync(process.execPath, [CLIENT], { encoding: 'utf8', env, timeout: 20_000 });
  if (r.error) throw new Error(`could not run the client: ${r.error.message}`);
  return { out: `${r.stdout || ''}${r.stderr || ''}`, status: r.status };
};

console.log(`--- v0.32 W1 terminal gate, on ${process.platform} ---`);

if (IS_WINDOWS) {
  check('a bare Windows console is refused, and the refusal names Windows Terminal', () => {
    const { out, status } = run(baseEnv());
    eq(status, 2, 'exit status');
    if (!out.includes('Windows Terminal')) throw new Error(`the refusal did not name the terminal to use:\n${out}`);
    if (!out.includes('JAM_ASSUME_ANSI')) throw new Error(`the refusal did not offer the way past it:\n${out}`);
    if (out.includes('usage:')) throw new Error(`it printed usage instead of refusing:\n${out}`);
    // The whole hint, not a paraphrase of it: one message, so the docs and the client agree.
    for (const line of WINDOWS_TERMINAL_HINT.split('\n')) {
      if (!out.includes(line.trim())) throw new Error(`the refusal is not WINDOWS_TERMINAL_HINT — missing: ${line.trim()}`);
    }
  });

  check('Windows Terminal gets through to the usage text', () => {
    const { out, status } = run({ ...baseEnv(), WT_SESSION: '00000000-0000-0000-0000-000000000000' });
    eq(status, 2, 'exit status'); // the usage exit, not the gate's
    if (!out.includes('usage:')) throw new Error(`the gate refused Windows Terminal:\n${out}`);
    if (out.includes('Windows Terminal')) throw new Error(`it refused with the hint anyway:\n${out}`);
  });

  check('JAM_ASSUME_ANSI gets through too — a documented escape hatch that does not work is a lie', () => {
    const { out } = run({ ...baseEnv(), JAM_ASSUME_ANSI: '1' });
    if (!out.includes('usage:')) throw new Error(`the escape hatch did not work:\n${out}`);
  });
} else {
  check('the gate never refuses a non-Windows machine', () => {
    const { out, status } = run(baseEnv());
    eq(status, 2, 'exit status'); // the usage exit
    if (!out.includes('usage:')) throw new Error(`the client did not reach its usage text:\n${out}`);
    if (out.includes('Windows Terminal')) throw new Error(`a non-Windows machine was shown the Windows hint:\n${out}`);
  });

  check('and the decision it would make on Windows is still the refusing one', () => {
    // The pure half, asserted here as well, so that a mac-only run of this script still says
    // something about Windows rather than nothing.
    eq(terminalSupport('win32', {}).ok, false, 'a bare Windows console');
    eq(terminalSupport('win32', { WT_SESSION: 'x' }).ok, true, 'Windows Terminal');
    eq(terminalSupport(process.platform, {}).ok, true, 'this platform');
  });
}

console.log(`\n--- RESULT --- ${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
