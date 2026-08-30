#!/usr/bin/env node
// 0.23.3 check: the state-dir privacy gate, on the platform where the attack it prevents lives.
//
// 0.23.2 fixed a local privilege escalation (finding 3) that macOS CANNOT test. `os.tmpdir()` on
// macOS is a per-user `0700` directory, so no other local user can create `$TMPDIR/claude-jam-<port>`
// first and there is nothing to attack; on Linux — and on WSL2, which is the documented Windows
// host path — `os.tmpdir()` is `/tmp`, mode `1777`, and getting there first is the whole attack.
// Five adversarial reviews missed the finding because every one of them ran on macOS.
//
// So this script exists to be run on a LINUX runner, on every push, and it costs nothing: no tmux,
// no daemon, no network, no claude, no tokens. The gate is the FIRST thing `host.mjs` does after
// argument parsing — before tmux, before claude — so `node host.mjs --state <planted> …` reaches it,
// refuses and exits 2 without building anything. That is what makes the real binary affordable here.
//
// WHAT IT IS NOT: `smoke-lifecycle` S4/S4b are the launcher-level proof (a real `claude-jam host`,
// a real tmux server, and the load-bearing half that no session was built) and they stay the
// behavioural gate. This runs the layer under them, in CI, on the platform they cannot reach.
//
// Every branch it could not exercise says NOT EXERCISED and says why, out loud, rather than being
// counted as a pass — the failure mode of the vacuity audit, in a file whose whole subject is a
// gate that must not fail open.
//   usage: node scripts/check-state-privacy.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assumePrivate, secureDir } from '../platform.mjs';
import { HOST_KEY_FILE, stateDirFor } from '../lib.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOST = path.join(ROOT, 'host.mjs');
const IS_WINDOWS = process.platform === 'win32';
const UID = typeof process.getuid === 'function' ? process.getuid() : null;
const KEY = 'a'.repeat(64); // a well-formed key, so `readHostKey` would have accepted it
// Never hardcode the version in a check — it drifts the moment a release does not happen, and a
// wrong version in a security check's own banner is the least trustworthy thing it could print.
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// THREE OUTCOMES, and they are structurally distinct because confusing them is this file's whole
// failure mode. The vacuity audit's lesson was that a check passing for the wrong reason buys false
// confidence; a check FAILING for the wrong reason is just as bad, because it teaches everyone to
// ignore a red gate. So:
//
//   PASS           the gate was exercised and got it right.
//   FAIL           the gate was exercised and got it WRONG. The only outcome that exits non-zero.
//   NOT EXERCISED  a precondition was unmet, and it is named. Never an exit code.
//
// `skip()` is how a check declares an unmet precondition, and it works from anywhere in the body —
// including the middle of setup, which is the second bug the first CI run found: the two-uid plant
// failed on the macOS runner (`nobody` cannot create inside a per-user 0700 `$TMPDIR`) and was
// reported as the GATE failing. Setup that cannot be built is a missing precondition, not a defect.
class Skip extends Error {}
const skip = (why) => { throw new Skip(why); };

let failed = 0;
let skipped = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    if (e instanceof Skip) { skipped++; console.log(`NOT EXERCISED  ${name} — ${e.message}`); return; }
    failed++;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

// --------------------------------------------------------------------------- preconditions ----
// Each one is a QUESTION asked before the attempt, so an unmet precondition is reported as itself
// rather than discovered from somebody's error text.

// Does this platform honour POSIX owner and mode at all? Windows has no getuid() and a synthesised
// `Stats.mode` (every writable file reads 0o666), so `pathPrivacy` skips both questions there by
// design and only its TYPE check runs — restrictToUser's NTFS ACL is the mechanism instead. A 0777
// directory is therefore NOT refused on Windows, host.mjs runs on past the gate, and asserting
// exit 2 there asserts something the platform cannot do.
const POSIX_MODES = !IS_WINDOWS && UID !== null;
const NO_POSIX_MODES = 'this platform has no POSIX owner/mode semantics — pathPrivacy skips both '
  + 'questions here by design (only its type check runs) and restrictToUser\'s NTFS ACL is the '
  + 'mechanism, so there is no mode for the gate to refuse';

// A directory a DIFFERENT uid can both create in and traverse into. `/tmp` is mode 1777 on Linux
// and on macOS (where it is a symlink to /private/tmp, and /private is 0755, so the whole path is
// searchable). `os.tmpdir()` is NOT usable for this on macOS: it is a per-user 0700 directory, so a
// second uid cannot even enter it — which is exactly what broke on the macOS CI runner.
const sharedBase = () => {
  for (const d of [os.tmpdir(), '/tmp']) {
    try { if (fs.statSync(d).mode & 0o002) return d; } catch { /* not there, or not ours to ask */ }
  }
  return null;
};

// Passwordless sudo, and `-n` so this can NEVER sit at a password prompt. A CI runner has it; a
// developer's machine should not.
let sudoAnswer = null;
const sudoOk = () => {
  if (sudoAnswer === null) {
    try {
      sudoAnswer = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8', timeout: 10_000 }).status === 0;
    } catch { sudoAnswer = false; }
  }
  return sudoAnswer;
};

// Can this process make a DIRECTORY symlink? Windows needs SeCreateSymbolicLinkPrivilege (Developer
// Mode, or an elevated shell) and refuses with EPERM otherwise. That is a missing precondition, not
// a gate that failed to refuse — and the type check it would exercise runs on every platform.
const canSymlinkDir = (parent) => {
  const at = path.join(parent, 'symlink-probe');
  try { fs.symlinkSync(parent, at, 'dir'); fs.unlinkSync(at); return null; } catch (e) { return e.code || e.message; }
};

// The real `host.mjs`, with a state dir of our choosing and nothing else.
//
// `JAM_TMUX_BIN` points at NOTHING on purpose, and it is the difference between a check and an
// incident. Measured 2026-08-30 while canarying this file: with the gate neutered, `node host.mjs`
// on a planted directory does not fail — it **builds a real jam**, with a real tmux server and a
// real claude, and detaches, so the red run leaves a live daemon behind on somebody's machine (it
// did, twice, and they were killed by exact name on their own sockets). With no tmux to find it
// dies at `tmux failed`, exits 1, and builds nothing — so a fail-open here is still a FAIL by exit
// code and by the files it left, and never a jam. The gate runs before tmux is reached, so a
// correct refusal is unaffected by this: exit 2, with the reason.
const NO_TMUX = { ...process.env, JAM_TMUX_BIN: '/nonexistent/claude-jam-check-has-no-tmux' };
const launch = (state, port) => {
  const r = spawnSync(process.execPath, [HOST, '--state', state, '--port', String(port), '--name', 'CI'],
    { encoding: 'utf8', timeout: 60_000, env: NO_TMUX });
  if (r.error) throw new Error(`could not run host.mjs: ${r.error.message}`);
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// Whatever the launcher writes into a state dir, it must write NONE of it into one it refused.
// `settings.json` and `roster.json` are the two that landed there in the canary run above, before
// the missing tmux stopped it — which is what makes this half load-bearing rather than decorative.
const STATE_FILES = ['session.json', 'settings.json', 'token.json', 'invites.json', 'roster.json',
  'system-prompt.txt', 'peer-mcp.json'];
const nothingWritten = (dir, allowed) => {
  const left = fs.readdirSync(dir).filter((n) => !allowed.includes(n));
  ok(left.length === 0, `it wrote ${left.join(', ')} into a directory it refused`);
  for (const f of STATE_FILES) ok(!fs.existsSync(path.join(dir, f)), `${f} landed in a refused state dir`);
};

console.log(`--- claude-jam ${VERSION} state-dir privacy gate, on ${process.platform} `
  + `(uid ${UID ?? 'n/a — no POSIX identity'}) ---`);

// ---------------------------------------------------------------------------------------------
// 0. The fact the finding rests on, measured rather than cited. TESTING.md named `os.tmpdir()`
//    returning `$TMPDIR || '/tmp'` and `/tmp` being mode 1777 as the two facts nobody had checked.
// The banner must not be able to become a FOURTH outcome. A bare `statSync` here would take the
// whole script down with a stack trace on any machine whose `os.tmpdir()` cannot be inspected —
// neither a PASS, a FAIL nor a NOT EXERCISED, and no line saying which check never ran.
const TMP = os.tmpdir();
const tmpSt = (() => { try { return fs.statSync(TMP); } catch (e) { return { err: e.code || e.message }; } })();
const tmpMode = tmpSt.err ? `unknown (${tmpSt.err})` : (tmpSt.mode & 0o7777).toString(8);
const worldWritable = !IS_WINDOWS && !tmpSt.err && !!(tmpSt.mode & 0o002);
console.log(`      os.tmpdir() = ${TMP} · mode ${tmpMode} · uid ${tmpSt.err ? 'unknown' : tmpSt.uid} · `
  + `world-writable: ${worldWritable} · TMPDIR${process.env.TMPDIR ? `=${process.env.TMPDIR}` : ' unset'}`);
console.log(`      a default jam's state dir here would be ${stateDirFor(TMP, 7777)}`);
check('Linux: os.tmpdir() really is /tmp, and /tmp really is world-writable — the exposure, measured', () => {
  if (process.platform !== 'linux') skip(`this is ${process.platform}; the exposure is Linux's (and WSL2's) `
    + `$TMPDIR, and here os.tmpdir() is ${TMP} at mode ${tmpMode}`);
  if (process.env.TMPDIR) skip(`$TMPDIR is set to ${process.env.TMPDIR}, so this run is not the default shape `
    + 'the finding is about');
  ok(TMP === '/tmp', `os.tmpdir() is ${TMP}, not /tmp`);
  ok(worldWritable, `/tmp is mode ${tmpMode} on this box, so the finding's premise does not hold here`);
});

// ---------------------------------------------------------------------------------------------
// 1. THE FALSE POSITIVE, which is the one nobody runs. A gate that refuses every Linux host is a
//    worse bug than the one it fixes, and macOS cannot detect it: there, the parent is 0700 and
//    the interesting case (an ordinary state dir under a WORLD-WRITABLE parent) never arises.
//    `assumePrivate(opts.state)` is the exact call host.mjs makes, with the exact argument.
check('the false positive: an ordinary jam under a world-writable parent is NOT refused', () => {
  const parent = fs.mkdtempSync(path.join(TMP, 'jam-fp-'));
  try {
    if (!IS_WINDOWS) fs.chmodSync(parent, 0o1777); // the Linux /tmp shape, whatever this platform's own is
    const st = fs.statSync(parent);
    ok(IS_WINDOWS || !!(st.mode & 0o002), 'the parent is not world-writable, so this check is vacuous');
    const state = stateDirFor(parent, 7777);
    ok(assumePrivate(state) === null, `refused before it exists: ${assumePrivate(state)}`);
    secureDir(state);
    const why = assumePrivate(state);
    ok(why === null, `refused a state dir it had just created itself: ${why}`);
    if (!IS_WINDOWS) ok((fs.statSync(state).mode & 0o777) === 0o700, 'secureDir did not leave 0700');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// 2. THE ATTACK, against the real host.mjs. One uid here — the directory and the key are planted
//    exactly as a second uid would have left them, which is how 0.23.2 was reproduced. Check 4
//    is the two-uid version.
check('a world-writable state dir with a planted host.key is refused, and nothing is written into it', () => {
  if (!POSIX_MODES) skip(NO_POSIX_MODES);
  const parent = fs.mkdtempSync(path.join(TMP, 'jam-attack-'));
  try {
    const state = stateDirFor(parent, 7999);
    fs.mkdirSync(state, { mode: 0o777 });
    fs.chmodSync(state, 0o777); // mkdirSync honours the umask; the plant does not
    fs.writeFileSync(path.join(state, HOST_KEY_FILE), `${KEY}\n`);
    const { status, out } = launch(state, 7999);
    ok(status === 2, `exit status ${status}, wanted 2\n${out}`);
    ok(/refusing to use this jam's state dir/.test(out), `the refusal is not the privacy one:\n${out}`);
    ok(/mode is 777/.test(out), `the refusal did not name the condition that failed:\n${out}`);
    ok(!out.includes(KEY), 'the refusal quoted the planted key');
    nothingWritten(state, [HOST_KEY_FILE]);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

// The TYPE check is the one branch of pathPrivacy that runs on every platform, Windows included —
// a symlink is a symlink — so this is not gated on POSIX modes. It IS gated on being able to make
// one, which Windows only allows with SeCreateSymbolicLinkPrivilege.
check('a symlink where the state dir belongs is refused, and its target is untouched', () => {
  const parent = fs.mkdtempSync(path.join(TMP, 'jam-link-'));
  try {
    const why = canSymlinkDir(parent);
    if (why) skip(`this process cannot create a directory symlink (${why}) — on Windows that needs `
      + 'SeCreateSymbolicLinkPrivilege (Developer Mode or an elevated shell)');
    const real = path.join(parent, 'somebody-elses');
    fs.mkdirSync(real, { mode: 0o700 });
    const state = stateDirFor(parent, 7998);
    fs.symlinkSync(real, state, 'dir');
    const { status, out } = launch(state, 7998);
    ok(status === 2, `exit status ${status}, wanted 2\n${out}`);
    ok(/not a directory/.test(out), `the refusal did not name the type condition:\n${out}`);
    nothingWritten(real, []);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// 3. EACCES — a parent jam cannot search. `assumePrivate` must refuse rather than assume private,
//    which is the fail-closed branch. As ROOT every mode is searchable, so the branch is
//    unreachable and this says so instead of reporting a pass it did not earn. A GitHub
//    `ubuntu-latest` runner is the user `runner`, not root, so this DOES run there; inside a
//    container it usually does not.
check('a parent directory that cannot be stat\'ed is refused, not assumed private', () => {
    if (!POSIX_MODES) skip('no POSIX mode bits, so a search right cannot be taken away here');
    if (UID === 0) skip('running as ROOT, so every mode is searchable and this branch cannot be '
      + 'reached at all — a GitHub ubuntu-latest runner is the non-root user `runner`, where it does run');
    const parent = fs.mkdtempSync(path.join(TMP, 'jam-eacces-'));
    const locked = path.join(parent, 'locked');
    try {
      fs.mkdirSync(locked, { mode: 0o700 });
      fs.mkdirSync(path.join(locked, 'claude-jam-7777'), { mode: 0o700 });
      fs.chmodSync(locked, 0o000);
      const why = assumePrivate(path.join(locked, 'claude-jam-7777'));
      ok(/cannot be inspected \(EACCES\)/.test(String(why)), `got ${JSON.stringify(why)}`);
    } finally {
      try { fs.chmodSync(locked, 0o700); } catch { /* it may never have been made */ }
      fs.rmSync(parent, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------------------------
// 4. THE ONE macOS CANNOT REACH: a state dir belonging to a SECOND REAL UID. Everything above
//    plants as one uid, which is how the finding was reproduced and is not the same thing.
//
//    THE PRECONDITIONS, and getting these wrong is what turned the first CI run red on macOS:
//      - POSIX uids at all (Windows has none);
//      - passwordless sudo, probed with `sudo -n` so this can never sit at a password prompt;
//      - **a parent the second uid can create in AND traverse into.** This is the one that bit.
//        `os.tmpdir()` on macOS is a per-user `0700` directory, so `nobody` cannot enter it however
//        the leaf is chmod'ed — the plant failed with `mkdir: Permission denied` and was reported as
//        the GATE failing. Docker passed only because there `os.tmpdir()` IS `/tmp` at 1777. So the
//        base is `sharedBase()`, and `/tmp` is 1777 on macOS too (via /private/tmp), which means
//        this branch now actually RUNS on the macOS runner rather than being skipped there.
//
//    The mode is 0700 on purpose: the OWNER branch is the one an attacker with a tidy umask
//    reaches, and a 0777 directory would be refused by the mode branch before owner is asked.
const HELPER = 'nobody';
check(`a state dir created by ANOTHER UID (${HELPER}) is refused even at mode 0700`, () => {
  if (!POSIX_MODES) skip('no POSIX uids here, so there is no second uid to be — restrictToUser\'s '
    + 'NTFS ACL is the mechanism that replaces this');
  if (!sudoOk()) skip('no passwordless sudo, so this run cannot become a second user. The one-uid '
    + 'plant above is NOT the same experiment — see TESTING.md');
  const base = sharedBase();
  if (!base) skip('no world-writable directory another uid could create in and traverse into, so '
    + 'the plant cannot be built where this process can also reach it');

  // Under a sticky /tmp only the owner may unlink, so the cleanup needs sudo too — and it is by
  // exact path, one command, never a pattern (AGENTS.md §0).
  const parent = fs.mkdtempSync(path.join(base, 'jam-twouid-'));
  const state = stateDirFor(parent, 7997);
  try {
    fs.chmodSync(parent, 0o777); // so the helper uid can create inside it at all
    const mk = spawnSync('sudo', ['-n', '-u', HELPER, 'mkdir', '-m', '700', state], { encoding: 'utf8', timeout: 10_000 });
    // Still a SKIP and not a FAIL: a plant that cannot be built has not asked the gate anything.
    if (mk.status !== 0) skip(`could not create the directory as ${HELPER} under ${base} `
      + `(${(mk.stderr || '').trim() || `exit ${mk.status}`}), so the gate was never asked`);
    const st = fs.lstatSync(state);
    if (st.uid === UID) skip(`the plant landed as uid ${UID}, this process's own — sudo did not `
      + `change user, so this would test the same thing as the one-uid check above`);
    ok((st.mode & 0o777) === 0o700, `it is mode ${(st.mode & 0o777).toString(8)}, so the MODE branch would fire, not the owner one`);
    // Everything above was setup. From here a wrong answer is the GATE being wrong.
    const { status, out } = launch(state, 7997);
    ok(status === 2, `exit status ${status}, wanted 2\n${out}`);
    ok(new RegExp(`owned by uid ${st.uid}`).test(out), `the refusal did not name the owner condition:\n${out}`);
    console.log(`      two real uids: ${HELPER} is uid ${st.uid}, this process is uid ${UID}, under ${base}`);
  } finally {
    spawnSync('sudo', ['-n', 'rm', '-rf', state], { encoding: 'utf8', timeout: 10_000 });
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

console.log(`\n--- RESULT --- ${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`
  + `${skipped ? `, ${skipped} branch(es) NOT EXERCISED (see above)` : ''}`);
process.exit(failed ? 1 : 0);
