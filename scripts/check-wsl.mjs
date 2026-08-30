#!/usr/bin/env node
// v0.32 W2 check: everything the WSL2 Windows host rests on, measured on the machine it is run on.
//
// This is the one file in the repo that CANNOT be verified where it was written. Nobody on this
// project has a Windows machine, so W2 was built the way W1 was — every decision is a pure
// function in lib.mjs, asserted on every CI leg — and what remains is the set of facts that only a
// real WSL2 install can answer: does `wslpath` agree with our translation, is a Windows drive
// really 0777 under DrvFs, does interop reach the clipboard, is `$TMPDIR` on the Linux side.
//
// So: run it on macOS or Linux and it prints NOT EXERCISED, with the reason, for every WSL-only
// branch — and still checks the pure half against the real filesystem. Run it inside WSL2 and it
// answers all of them. That is the deliverable: not a checklist somebody has to interpret, but a
// command whose OUTPUT is the measurement, in the PASS / FAIL / NOT EXERCISED shape the other
// four checks use.
//
// It is read-only apart from two directories it creates and removes by their exact paths, and it
// starts no jam, no tmux session and no claude.
//   usage: node scripts/check-wsl.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseWslInfo, windowsDriveMount, wslTranslatePath, windowsUncPath, wslJoinLines,
  inviteLines, privacyRefusal, WSL_MOUNT_ROOT, stateDirFor, buildJoinLine } from '../lib.mjs';
import { assumePrivate, wslInfo } from '../platform.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

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
const note = (s) => console.log(`      ${s}`);

// ------------------------------------------------------------------ what this machine is ----
const osrelease = (() => {
  try { return fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim(); } catch { return `(no /proc) ${os.release()}`; }
})();
const info = wslInfo();
console.log(`--- claude-jam ${VERSION} WSL2 host facts, on ${process.platform} ---`);
note(`kernel osrelease: ${osrelease}`);
if (process.env.JAM_WSL_OSRELEASE) {
  note(`JAM_WSL_OSRELEASE is set (${process.env.JAM_WSL_OSRELEASE.trim()}) — detection is being STOOD IN FOR.`);
  note('    Everything below runs the real code against a real filesystem, but this is not a WSL kernel:');
  note('    wslpath, powershell.exe and DrvFs are absent, and each says so for itself.');
}
note(`WSL_DISTRO_NAME=${process.env.WSL_DISTRO_NAME ?? '(unset)'}  WSL_INTEROP=${process.env.WSL_INTEROP ? '(set)' : '(unset)'}`);
note(`parseWslInfo says: ${JSON.stringify(info)}`);
note(`os.tmpdir()=${os.tmpdir()}  cwd=${process.cwd()}  home=${os.homedir()}`);
const IN_WSL = info.wsl;
const STANDIN = Boolean(process.env.JAM_WSL_OSRELEASE);
const notWsl = 'this machine is not WSL — the branch cannot be reached here at all';

// The pure half runs everywhere, so a regression is caught by CI rather than by Roy.
check('the pure translation agrees with itself on the shapes Windows produces', () => {
  const at = { distro: info.distro || 'Ubuntu' };
  ok(wslTranslatePath('C:\\Users\\roy\\a.png', at).path === '/mnt/c/Users/roy/a.png', 'C:\\ did not translate');
  ok(wslTranslatePath('/home/roy/a', at).path === '/home/roy/a', 'a POSIX path was rewritten');
  ok(windowsDriveMount('/mnt/c/x') === 'c' && windowsDriveMount('/home/x') === null, 'windowsDriveMount is wrong');
});

// ------------------------------------------------------------------ 1. wslpath, the oracle ----
// The single most valuable measurement here: `wslpath` ships with WSL and is authoritative, so it
// can be asked whether our translation is right — in BOTH directions — rather than believed.
check('wslpath agrees with wslTranslatePath (Windows -> Linux) on real paths', () => {
  if (!IN_WSL) skip(notWsl);
  const cases = ['C:\\Users', 'C:\\Windows\\System32', 'C:\\'];
  for (const win of cases) {
    const r = spawnSync('wslpath', ['-u', win], { encoding: 'utf8' });
    if (r.error) skip(`wslpath is not on PATH (${r.error.code}), which no WSL install should be missing`);
    ok(r.status === 0, `wslpath -u ${win} exited ${r.status}: ${(r.stderr || '').trim()}`);
    const real = (r.stdout || '').trim().replace(/\/$/, '');
    const mine = wslTranslatePath(win, { distro: info.distro }).path.replace(/\/$/, '');
    note(`${win} -> wslpath ${real} · claude-jam ${mine}`);
    ok(real === mine, `DISAGREE on ${win}: wslpath says ${real}, claude-jam says ${mine}`);
  }
});

check('wslpath agrees with windowsUncPath (Linux -> Windows) on this distribution', () => {
  if (!IN_WSL) skip(notWsl);
  if (!info.distro) skip('WSL_DISTRO_NAME is unset in this process, so the \\\\wsl$ name is unknown '
    + '(start the jam from a WSL shell, or the join note simply omits the line)');
  for (const p of ['/tmp', os.homedir()]) {
    const r = spawnSync('wslpath', ['-w', p], { encoding: 'utf8' });
    if (r.error) skip(`wslpath is not on PATH (${r.error.code})`);
    ok(r.status === 0, `wslpath -w ${p} exited ${r.status}`);
    const real = (r.stdout || '').trim();
    const mine = windowsUncPath(p, info.distro);
    note(`${p} -> wslpath ${real} · claude-jam ${mine}`);
    ok(real.toLowerCase() === String(mine).toLowerCase(), `DISAGREE on ${p}: wslpath says ${real}, claude-jam says ${mine}`);
  }
});

// ------------------------------------------------------------- 2. the automount root ----
check(`Windows drives really are under ${WSL_MOUNT_ROOT}`, () => {
  if (!IN_WSL) skip(notWsl);
  let conf = '';
  try { conf = fs.readFileSync('/etc/wsl.conf', 'utf8'); } catch { conf = ''; }
  if (conf) note(`/etc/wsl.conf:\n${conf.split('\n').map((l) => `        ${l}`).join('\n')}`);
  const c = `${WSL_MOUNT_ROOT}c`;
  ok(fs.existsSync(c), `${c} does not exist — this install has moved the automount root `
    + `([automount] root in /etc/wsl.conf). claude-jam assumes ${WSL_MOUNT_ROOT}; a translated path `
    + 'that is wrong shows up as "no such file: <the path it tried>", which names it');
  note(`${c} exists`);
});

// ------------------------------------------- 3. THE state-dir question (TESTING.md experiment 3) ----
// The deferral this check exists to close: a --state on a mounted Windows drive. DrvFs without the
// `metadata` option reports mode 0777 and one uid for everything, so the mode branch should fire;
// a mount reporting nothing usable at all hits the fail-closed branch. BOTH are correct refusals,
// and WHICH one fires has never been observed.
check('a state dir on a Windows drive is REFUSED, and this is which branch fired', () => {
  if (!IN_WSL) skip(notWsl);
  const drive = `${WSL_MOUNT_ROOT}c`;
  if (!fs.existsSync(drive)) skip(`${drive} is not mounted, so there is no Windows drive to try`);
  const dir = path.join(drive, 'tmp', `claude-jam-wslcheck-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    skip(`could not create ${dir} (${e.code}) — try a directory you can write on C:`);
  }
  try {
    const st = fs.statSync(dir);
    note(`${dir}: mode ${(st.mode & 0o7777).toString(8)}, uid ${st.uid}, this process uid ${process.getuid?.()}`);
    const why = assumePrivate(dir);
    if (!why && (st.mode & 0o777) === 0o700) {
      // The mode asked for is the mode that came back, so this mount honours POSIX metadata — it
      // is DrvFs WITH the `metadata` option, or it is not DrvFs at all (a container's ordinary
      // filesystem, for instance). Either way the 0777 shape this check exists to observe is not
      // here, and reporting a pass or a fail would be reporting something that did not happen.
      skip(`${dir} came back mode 700, so this mount honours POSIX modes (DrvFs with the `
        + '`metadata` option, or not DrvFs at all). The 0777-for-everything shape is not present '
        + 'here, so which refusal fires cannot be observed — and a state dir on THIS mount would '
        + 'be allowed, which is the correct answer for a mount with real metadata');
    }
    ok(why, `assumePrivate ALLOWED a directory on a Windows drive whose mode came back `
      + `${(st.mode & 0o7777).toString(8)} — that is neither the metadata-less 0777 shape nor a `
      + 'genuinely private 0700 one, so something here is not what it claims');
    note(`REFUSED, and the branch is: ${why}`);
    const said = privacyRefusal("this jam's state dir", dir, why, { wsl: info });
    ok(/DrvFs/.test(said), 'the refusal did not carry the WSL note, so it still offers advice that '
      + 'cannot work on this filesystem');
    console.log(`      --- what a user would see ---\n${said.split('\n').map((l) => `      ${l}`).join('\n')}`);
    // And the second half of the experiment: chmod on DrvFs reports success and changes nothing.
    // If that is ever false on some mount, the advice above needs rewriting, so it is measured.
    let chmodTook = null;
    try {
      fs.chmodSync(dir, 0o700);
      chmodTook = (fs.statSync(dir).mode & 0o7777).toString(8);
    } catch (e) { chmodTook = `threw ${e.code}`; }
    note(`after chmod 700 the mode is ${chmodTook} (0777 means chmod is the no-op this refusal says it is)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // the exact path this check created
  }
});

check('the DEFAULT state dir is on the Linux filesystem, so an ordinary jam is not refused', () => {
  if (!IN_WSL) skip(notWsl);
  const base = os.tmpdir();
  const drive = windowsDriveMount(base);
  if (drive) {
    throw new Error(`os.tmpdir() is ${base}, which is on Windows drive ${drive.toUpperCase()}: — `
      + 'every jam on this machine will refuse to start. Unset TMPDIR, or pass '
      + '--state ~/.claude-jam-state');
  }
  const dir = stateDirFor(base, 7777);
  note(`a jam on :7777 would use ${dir}`);
  const existing = assumePrivate(dir);
  ok(!existing, `the state dir already there is not usable: ${existing}`);
});

// ------------------------------------------------------------------ 4. interop ----
check('Windows-binary interop is on, which is what /paste needs', () => {
  if (!IN_WSL) skip(notWsl);
  if (STANDIN) skip('detection is standing in (JAM_WSL_OSRELEASE), so there is no Windows behind '
    + 'this kernel for interop to reach — this branch needs a real install');
  if (!info.interop) note('WSL_INTEROP is unset in this process — that is not itself a refusal '
    + '(a service-started daemon has no such variable), so the run below is the real answer');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output OK'],
    { encoding: 'utf8', timeout: 30_000 });
  if (r.error) throw new Error(`PowerShell did not run (${r.error.code}) — Windows-binary interop `
    + 'is off in this distribution, so /paste will refuse with that reason and /send <path> is '
    + 'unaffected. Turn it on in /etc/wsl.conf if you want /paste');
  ok(r.status === 0 && /OK/.test(r.stdout || ''), `powershell.exe exited ${r.status}: ${(r.stderr || '').trim().slice(0, 200)}`);
  note('PowerShell answered — the /paste route exists (whether an image comes back is a human test)');
});

// ------------------------------------------------------------------ 5. the addresses ----
// Printed rather than asserted: what a friend is handed is a fact about this network, and the
// point is that a human can see whether it is usable before sending it to anybody.
check('what the join block would say on this machine', () => {
  if (!IN_WSL) skip(notWsl);
  const addrs = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  note(`non-loopback IPv4 here: ${addrs.join(', ') || '(none)'}`);
  const ip = addrs[0] || '127.0.0.1';
  const join = buildJoinLine(ip, 7777, 'TOKEN');
  for (const l of inviteLines({ join, view: null, token: 'TOKEN', wsl: info })) note(l);
  ok(wslJoinLines(join, null, info).length > 0, 'the WSL note did not render on a WSL machine');
  console.log('      Two things only the WINDOWS side can answer, and they are the checklist:');
  console.log('        1. in Windows Terminal (PowerShell, NOT this shell), with a jam running:');
  console.log('             curl.exe -s -m 3 http://localhost:7777/health');
  console.log('           "ok" means localhost forwarding works; a timeout means it does not.');
  console.log('        2. from ANOTHER machine on the LAN, the same URL with this PC\'s Windows IP:');
  console.log('           refused/timeout is EXPECTED unless WSL networkingMode=mirrored or a');
  console.log('           `netsh interface portproxy` rule exists. --tunnel needs neither.');
});

console.log(`\n--- RESULT --- ${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`
  + `${skipped ? `, ${skipped} branch(es) NOT EXERCISED (see above)` : ''}`);
if (!IN_WSL) {
  console.log('    This machine is not WSL. Everything WSL-specific above is NOT EXERCISED by');
  console.log('    construction — run this inside a WSL2 distribution and paste the output.');
}
process.exit(failed ? 1 : 0);
