#!/usr/bin/env node
// v0.18 smoke: jam owns its tmux sessions — and, above everything else, owns ONLY its own.
//   S1  a plain tmux session of ours (no marker) is refused, by name, and survives
//   S2  a session carrying a HAND-WRITTEN @jam-owned pointing at a directory jam never wrote is
//       refused — and still refused when a real session.json is copied in beside it
//   S3  the live `jam` session on :7777, if one is running, is proved unkillable READ-ONLY:
//       no marker, absent from `jam sessions`, refused by name. Nothing about it is touched
//   1   `jam sessions` lists a live jam and an orphan state dir, and NOT the plain decoy
//   2   `jam end` broadcasts {t:'ending'} (a scripted client sees it and exits 0), kills the
//       children (daemon, claude, the ttyd and cloudflared stand-ins) and removes the state dir
//   3   `jam clean` deletes the orphan and leaves the live jam's state dir alone
//   4   `jam host` on a taken name drives all four choices: [c]ancel, [n]ew, [a]ttach, [e]nd
//   5   the exit prompt: `k` keeps the jam (and prints the way back), `e` ends it
//   6   `/end` in the host client: `n` ends nothing, `y` ends it for everybody
//
// Self-contained, like smoke-transport and smoke-replay, and then some: it runs with a TMPDIR
// of its own, so `jam sessions|end|clean` cannot even SEE a state dir that is not this smoke's
// (the one deliberate exception is S3, which is read-only). No real claude, no real ttyd, no
// real cloudflared — stand-ins that hold a pid and sleep. Every tmux session it creates starts
// with `jamlife`, and it kills only those, by exact name.
//   usage: node scripts/smoke-lifecycle.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The gate itself, called directly: `jam end <name>` refuses a decoy at the outer gate (it is
// not in jam's own list at all), and this is the inner one — the marker check.
import { ownedSession } from '../sessions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOST_MJS = path.join(ROOT, 'host.mjs');
const JAM = path.join(ROOT, 'jam');
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
const TOKEN = 'lifecyclesmoketoken';
// Ports of this smoke's own: clear of jam's 7777, the shared smokes' 7799/7801,
// smoke-transport's 7811-7819, smoke-replay's 7823/7825 and smoke-perm's 7831.
const P = { main: 7851, orphan: 7853, live: 7855 };
// Every tmux session this script creates, and the only ones it ever kills.
const S = { jam: 'jamlife', two: 'jamlifelive-2', live: 'jamlifelive', plain: 'jamlifeplain',
  decoy: 'jamlifedecoy', drive: 'jamlifedrive' };
// A session name that is not one of ours is a bug in this script, and a bug in this script
// must never become a tmux session called `undefined`.
for (const [k, v] of Object.entries(S)) if (typeof v !== 'string' || !v.startsWith('jamlife')) throw new Error(`S.${k} is ${v}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => spawnSync(TMUX, a, { encoding: 'utf8' });
const alive = (name) => tmux('has-session', '-t', `=${name}`).status === 0;
const pane = (t) => (tmux('capture-pane', '-p', '-t', t).stdout || '').replace(/\n+$/, '');
const back = (t) => (tmux('capture-pane', '-p', '-S', '-2000', '-t', t).stdout || '').replace(/\n+$/, '');
const running = (pid) => !!pid && spawnSync('ps', ['-p', String(pid)], { encoding: 'utf8' }).status === 0;
// Only ever a session name this script made up itself, one exact name per call.
const killMine = (name) => { if (typeof name === 'string' && name.startsWith('jamlife')) tmux('kill-session', '-t', `=${name}`); };

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
async function until(what, pred, ms = 20000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const v = await pred();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}
// tmux wraps a long line at the pane width with no separator, so a 130-character prompt
// arrives as two rows. Prompts are matched against the unwrapped text.
const flat = (t) => back(t).replace(/\n/g, '');
const show = (label, target) => {
  console.log(`\n----- ${label} (${target}) -----`);
  console.log(pane(target));
  console.log('-----------------------------------------------------------------');
};

// ------------------------------------------------------------------ fixtures ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-lifecycle-'));   // this smoke's own $TMPDIR
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-lifecycle-bin-')); // the stand-ins
const NOTJAM = path.join(BIN, 'not-a-state-dir'); // what the decoy's marker points at
fs.mkdirSync(NOTJAM, { recursive: true });

function stub(name, body) {
  const p = path.join(BIN, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}
// A claude that draws a prompt and sits there: the daemon only ever captures this pane, and
// this smoke never injects anything.
const FAKE_CLAUDE = stub('claude', "printf '%s\\n' 'fake claude — v0.18 lifecycle smoke' '' '\u276f '\nexec sleep 1800");
// ttyd and cloudflared stand-ins: they exist to hold a pid the daemon has to kill on the way out.
const FAKE_TTYD = stub('ttyd', 'exec sleep 1800');
stub('cloudflared', 'case "$1" in --version) echo "cloudflared version 0.0.0-fake"; exit 0;; esac\nexec sleep 1800');

// Everything jam runs sees this environment: its own TMPDIR (hence its own state-dir namespace)
// and the stub cloudflared first on PATH.
const ENV = { ...process.env, TMPDIR: TMP, PATH: `${BIN}:${process.env.PATH}`, JAM_CLAUDE: FAKE_CLAUDE };
const stateDir = (port) => path.join(TMP, `claude-jam-${port}`);

// `jam <args>`, in this smoke's environment, captured.
function jam(...args) {
  const r = spawnSync(JAM, args, { encoding: 'utf8', env: ENV });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const jamJson = () => JSON.parse(jam('sessions', '--json').out);

// The launcher, with no client of its own (the prompts are driven separately, in a tmux session
// with a real tty). Returns the state it wrote.
function launch(name, port, extra = []) {
  const r = spawnSync(process.execPath, [HOST_MJS, '--tmux', name, '--port', String(port),
    '--view-port', String(port + 1), '--name', 'Host', '--token', TOKEN, '--cwd', ROOT,
    '--no-attach', '--no-popup', ...extra], { encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`launch ${name} failed: ${r.stdout}${r.stderr}`);
  return JSON.parse(fs.readFileSync(path.join(stateDir(port), 'session.json'), 'utf8'));
}

// A scripted guest: it only has to prove it hears {t:'ending'} and then leaves with 0.
function watcher(port) {
  const w = { frames: [], closed: null, ended: null };
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'Watcher', token: TOKEN })));
  ws.addEventListener('message', (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    w.frames.push(ev);
    if (ev.t === 'ending') w.ended = ev;
  });
  ws.addEventListener('close', (e) => { w.closed = e.code ?? 1006; });
  ws.addEventListener('error', () => { /* the assertions carry the verdict */ });
  w.want = (what, pred, ms = 20000) => until(what, () => w.frames.find(pred), ms);
  return w;
}

// A real client on a real tty, driven with send-keys — plus whatever `jam host` asks it.
function drive(cmd) {
  killMine(S.drive);
  const born = tmux('new-session', '-d', '-s', S.drive, '-x', '120', '-y', '40', '-c', ROOT,
    'sh', '-c', `${cmd}; echo "JAMEXIT=$?"; exec sleep 600`);
  if (born.status !== 0) throw new Error(`tmux: ${born.stderr}`);
}
const type = (s) => tmux('send-keys', '-t', S.drive, '-l', s);
const key = (...k) => tmux('send-keys', '-t', S.drive, ...k);
const line = (s) => { type(s); key('Enter'); };
// The drive session runs with this smoke's env, so `jam` inside it is the same jam as outside.
const driveEnv = () => Object.entries({ TMPDIR: TMP, PATH: `${BIN}:${process.env.PATH}`, JAM_CLAUDE: FAKE_CLAUDE })
  .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');

// A state dir in the REAL $TMPDIR, shaped exactly like the orphan `jam clean` exists to delete —
// planted to prove that a `jam` running with a TMPDIR of its own cannot see, offer or remove it.
// Its tmux session name was never created, so nothing else can pick it up either.
const GHOST = path.join(os.tmpdir(), 'claude-jam-7999');
fs.mkdirSync(GHOST, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(GHOST, 'session.json'), `${JSON.stringify({
  jam: 'claude-jam', v: 1, tmux: 'jamlifeghost', port: 7999, viewPort: 8000, cwd: ROOT,
  sessionId: '00000000-0000-4000-8000-000000000000', createdAt: Date.now(), pid: 0, state: GHOST, secret: null,
}, null, 2)}\n`);
let liveJam = false;

console.log(`TMPDIR ${TMP}\nstubs  ${BIN}\nghost  ${GHOST}`);
const started = Date.now();

try {
  // ============================================================ the safety proofs ====
  await step('S1 REFUSAL a plain tmux session of ours carries no marker, and survives being named', async () => {
    killMine(S.plain);
    const born = tmux('new-session', '-d', '-s', S.plain, '-x', '80', '-y', '24', 'sleep 900');
    if (born.status !== 0) throw new Error(`tmux: ${born.stderr}`);
    const opt = tmux('show-options', '-t', S.plain, '-v', '@jam-owned');
    console.log(`      @jam-owned on ${S.plain}: ${JSON.stringify((opt.stdout || opt.stderr || '').trim())}`);
    const v = ownedSession(S.plain);
    console.log(`      ownedSession → ${v.why}`);
    if (v.ok) throw new Error('verifyOwned accepted a session with no marker');
    if (!/carries no @jam-owned marker/.test(v.why)) throw new Error(`unexpected reason: ${v.why}`);
    const r = jam('end', S.plain);
    console.log(`      jam end ${S.plain} → exit ${r.code}: ${r.out.trim().split('\n')[0]}`);
    if (r.code === 0) throw new Error('jam end accepted a session it did not create');
    if (!alive(S.plain)) throw new Error('the plain session was killed anyway');
    // And it is not in the list, so it cannot be picked out of one either.
    if (jamJson().some((j) => j.name === S.plain)) throw new Error('a non-jam session appeared in `jam sessions`');
  });

  await step('S2 REFUSAL a hand-written @jam-owned marker buys nothing, even with a session.json copied in', async () => {
    killMine(S.decoy);
    const born = tmux('new-session', '-d', '-s', S.decoy, '-x', '80', '-y', '24', 'sleep 900');
    if (born.status !== 0) throw new Error(`tmux: ${born.stderr}`);
    // The spoof: the option jam looks for, pointing at a directory jam never wrote.
    tmux('set-option', '-t', S.decoy, '@jam-owned', NOTJAM);
    const v1 = ownedSession(S.decoy);
    console.log(`      ownedSession (empty dir)  → ${v1.why}`);
    if (v1.ok || !/there is no session\.json jam wrote/.test(v1.why)) throw new Error(`unexpected: ${JSON.stringify(v1)}`);
    const bare = jam('end', S.decoy);
    console.log(`      empty dir  → exit ${bare.code}: ${bare.out.trim().split('\n')[0]}`);
    if (bare.code === 0 || !alive(S.decoy)) throw new Error('the decoy was ended');
    // Now with a REAL session.json copied in beside the marker — it was written for another
    // directory and another session, and that is exactly what verifyOwned checks.
    // --view and --tunnel so the daemon has real children (stand-ins) to kill in step 2.
    const real = launch(S.jam, P.main, ['--view', '--view-ttyd', FAKE_TTYD, '--tunnel']);
    fs.copyFileSync(path.join(stateDir(P.main), 'session.json'), path.join(NOTJAM, 'session.json'));
    const v2 = ownedSession(S.decoy);
    console.log(`      ownedSession (copied one) → ${v2.why}`);
    if (v2.ok || !/not written together/.test(v2.why)) throw new Error(`unexpected: ${JSON.stringify(v2)}`);
    const copied = jam('end', S.decoy);
    console.log(`      copied one → exit ${copied.code}: ${copied.out.trim().split('\n')[0]}`);
    if (copied.code === 0 || !alive(S.decoy)) throw new Error('a copied session.json ended a session jam never made');
    if (!/not written together|by hand|no jam-owned/.test(copied.out)) throw new Error(`unexpected reason: ${copied.out}`);
    // …and the real jam it was copied from is untouched by any of it.
    if (!alive(S.jam)) throw new Error('the real jam died somewhere in here');
    if (real.tmux !== S.jam) throw new Error('session.json names the wrong session');
    fs.rmSync(path.join(NOTJAM, 'session.json'), { force: true });
  });

  await step('S3 READ-ONLY the live jam on :7777 is unkillable, unlistable, and never touched', async () => {
    if (!alive('jam')) return console.log('      no `jam` session is running right now — nothing to prove against');
    liveJam = true; // and the last step re-checks that it is STILL there
    const marker = tmux('show-options', '-t', 'jam', '-v', '@jam-owned');
    console.log(`      @jam-owned on jam: ${JSON.stringify((marker.stdout || marker.stderr || '').trim())}`);
    // The real $TMPDIR, on purpose and read-only: this is the one place the smoke looks outside
    // its own namespace, because "would `jam sessions` offer somebody else's session?" is the
    // question. Nothing here ends, kills or deletes anything.
    const real = spawnSync(JAM, ['sessions', '--json'], { encoding: 'utf8', env: { ...process.env, PATH: ENV.PATH } });
    const rows = JSON.parse(real.stdout || '[]');
    console.log(`      \`jam sessions\` in the real TMPDIR: ${rows.length} row(s)${rows.length ? ` — ${rows.map((r) => `${r.name}:${r.state}`).join(', ')}` : ''}`);
    // A `jam` that IS one of v0.18's own is legitimately listed FOR ITS OWNER; what must never
    // happen is this smoke ending it. So the hard assertions are the two below.
    if (rows.some((r) => r.name === 'jam')) console.log('      (that one is a v0.18 jam of its own — listed for its owner, still not this smoke\'s to end)');
    // The marker gate, on the live session itself — read-only, like everything in this step.
    const v = ownedSession('jam');
    console.log(`      ownedSession('jam') → ${v.ok ? 'VERIFIED (it is a v0.18 jam of its own)' : v.why}`);
    // Named outright, in this smoke's own namespace, it is still refused.
    const r = jam('end', 'jam');
    console.log(`      jam end jam → exit ${r.code}: ${r.out.trim().split('\n')[0]}`);
    if (r.code === 0) throw new Error('jam end accepted the live session');
    if (!alive('jam')) throw new Error('THE LIVE JAM IS GONE — this is the thing that must never happen');
    console.log('      still alive, still attached to whatever it was doing');
  });

  // ============================================================== the live jam ====
  let main = JSON.parse(fs.readFileSync(path.join(stateDir(P.main), 'session.json'), 'utf8'));
  const pids = {};

  await step('1 a launched jam is stamped, listed live, and says which relays it has', async () => {
    const opt = (tmux('show-options', '-t', S.jam, '-v', '@jam-owned').stdout || '').trim();
    console.log(`      @jam-owned → ${opt}`);
    if (opt !== stateDir(P.main)) throw new Error(`marker is ${opt}`);
    for (const k of ['tmux', 'port', 'viewPort', 'cwd', 'sessionId', 'createdAt', 'pid', 'state']) {
      if (!(k in main)) throw new Error(`session.json has no ${k}`);
    }
    const table = jam('sessions');
    console.log(table.out.split('\n').map((l) => `      ${l}`).join('\n'));
    const row = jamJson().find((r) => r.name === S.jam);
    if (!row) throw new Error('the live jam is not in the list');
    if (row.state !== 'live') throw new Error(`state is ${row.state}`);
    if (row.port !== P.main || row.cleanable) throw new Error(JSON.stringify(row));
    if (!row.view) throw new Error('--view was given, so the row should say so');
    if (!/jamlife/.test(table.out) || !/live/.test(table.out)) throw new Error('the table lost the row');
    // The listing must never carry the credential itself.
    if (new RegExp(TOKEN).test(table.out)) throw new Error('the token is in the listing');
  });

  await step('2 jam end: everybody is told, the children die, the state dir goes', async () => {
    // Every child the daemon spawned, by the pid it logged for itself.
    pids.daemon = main.pid;
    pids.claude = Number((tmux('list-panes', '-t', `${S.jam}:claude`, '-F', '#{pane_pid}').stdout || '').trim());
    const log = await until('the daemon to log its children', () => {
      const b = back(`${S.jam}:daemon`);
      const ttyd = /ttyd pid (\d+)/.exec(b);
      const cf = /tunnel \(ws\): cloudflared connecting… \(pid (\d+)\)/.exec(b);
      return ttyd && cf ? { ttyd: Number(ttyd[1]), cf: Number(cf[1]) } : null;
    }, 20000);
    Object.assign(pids, log);
    console.log(`      pids: daemon ${pids.daemon} · claude ${pids.claude} · ttyd(stub) ${pids.ttyd} · cloudflared(stub) ${pids.cf}`);
    for (const [what, pid] of Object.entries(pids)) if (!running(pid)) throw new Error(`${what} (${pid}) was not running to begin with`);
    const w = watcher(P.main);
    await w.want('the welcome', (f) => f.t === 'welcome');
    const r = jam('end', S.jam);
    console.log(r.out.split('\n').filter(Boolean).map((l) => `      ${l}`).join('\n'));
    if (r.code !== 0) throw new Error(`jam end exited ${r.code}`);
    // The frame that makes a client leave instead of reconnect.
    const ending = await until('the {t:\'ending\'} frame', () => w.ended, 10000);
    console.log(`      the watcher got: ${JSON.stringify(ending)}`);
    if (ending.by !== 'Host') throw new Error('the ending frame does not say who ended it');
    await until('the watcher socket to close', () => w.closed != null, 10000);
    if (alive(S.jam)) throw new Error('the tmux session is still there');
    for (const [what, pid] of Object.entries(pids)) {
      await until(`${what} (${pid}) to exit`, () => !running(pid), 8000);
      console.log(`      ${what} ${pid} is gone`);
    }
    if (fs.existsSync(stateDir(P.main))) throw new Error(`${stateDir(P.main)} survived`);
    if (jamJson().length) throw new Error(`still listed: ${JSON.stringify(jamJson())}`);
  });

  // A real client's view of the same frame: it prints one line and exits 0, with no reconnect.
  await step('2 a real client on a tty prints the notice once and exits 0', async () => {
    main = launch(S.jam, P.main);
    drive(`env ${driveEnv()} node ${path.join(ROOT, 'client.mjs')} ws://127.0.0.1:${P.main} --name Dana --token ${TOKEN}`);
    await until('the client to be in the room', () => /fake claude|live TUI/.test(pane(S.drive)), 25000);
    const r = jam('end', S.jam);
    if (r.code !== 0) throw new Error(`jam end exited ${r.code}: ${r.out}`);
    const out = await until('the client to leave', () => (/JAMEXIT=/.test(back(S.drive)) ? back(S.drive) : null), 15000);
    const exit = /JAMEXIT=(\d+)/.exec(out);
    const notice = out.split('\n').filter((l) => /ended the jam/.test(l)).at(-1) || '';
    console.log(`      client said: ${JSON.stringify(notice.trim())}`);
    console.log(`      client exit: ${exit?.[1]}`);
    if (exit?.[1] !== '0') throw new Error(`the client exited ${exit?.[1]}, not 0`);
    if (!/ended the jam/.test(notice)) throw new Error('no ending notice on screen');
    // reconnectMessage's own wording, which must not appear at all: the notice itself says
    // "nothing to reconnect to", so the test is for `retrying`.
    if (/retrying/i.test(out)) throw new Error('the client tried to reconnect');
    killMine(S.drive);
  });

  // ============================================================= orphans and clean ====
  await step('3 an orphan state dir is listed with a !, and `jam clean` takes only that one', async () => {
    // The realistic orphan: the tmux session goes away under a jam (a crash, a kill by hand),
    // leaving the state dir behind. Exact name, and one this script created.
    const orphan = launch(S.jam, P.orphan);
    await until('the orphan jam to answer', async () => (await fetch(`http://127.0.0.1:${P.orphan}/health`).then((r) => r.ok).catch(() => false)), 10000);
    killMine(S.jam);
    await until('its daemon to notice', () => !running(orphan.pid), 10000);
    // …and a second, healthy jam alongside it, which must come out of this untouched.
    const live = launch(S.live, P.live);
    const rows = jamJson();
    console.log(jam('sessions').out.split('\n').map((l) => `      ${l}`).join('\n'));
    const o = rows.find((r) => r.port === P.orphan);
    const l = rows.find((r) => r.port === P.live);
    if (o?.state !== 'orphan' || !o.cleanable) throw new Error(`the orphan is ${JSON.stringify(o)}`);
    if (o.name !== null) throw new Error('an orphan has no tmux session, so it has no name');
    if (l?.state !== 'live' || l.cleanable) throw new Error(`the live jam is ${JSON.stringify(l)}`);
    // Without an answer, nothing is deleted: stdin is not a tty here, so the question cannot be
    // put, and `jam clean` treats that as no.
    const asked = jam('clean');
    console.log(asked.out.split('\n').filter(Boolean).map((l2) => `      ${l2}`).join('\n'));
    if (asked.code === 0) throw new Error('clean deleted something with nobody to confirm it');
    if (!/nothing deleted/.test(asked.out)) throw new Error('clean did not say it was leaving things alone');
    if (!new RegExp(stateDir(P.orphan)).test(asked.out)) throw new Error('the orphan was not offered');
    if (new RegExp(`${stateDir(P.live)}\\b`).test(asked.out.split('leaving')[0])) throw new Error('the live jam was on the delete list');
    const done = jam('clean', '--yes');
    console.log(done.out.split('\n').filter(Boolean).map((l2) => `      ${l2}`).join('\n'));
    if (done.code !== 0) throw new Error(`clean --yes exited ${done.code}`);
    if (fs.existsSync(stateDir(P.orphan))) throw new Error('the orphan state dir is still there');
    if (!fs.existsSync(stateDir(P.live))) throw new Error('clean removed a LIVE jam\'s state dir');
    if (!alive(S.live)) throw new Error('clean killed a live session');
    // The decoys are still standing, having been offered to nothing at all.
    if (!alive(S.plain) || !alive(S.decoy)) throw new Error('a decoy went missing during clean');
    console.log(`      ${S.live} and both decoys are still up`);
    if (live.tmux !== S.live) throw new Error('the live session.json is wrong');
  });

  // ================================================================== the prompts ====
  await step('4 [c]ancel leaves the taken jam exactly as it was', async () => {
    drive(`env ${driveEnv()} node ${HOST_MJS} --tmux ${S.live} --port ${P.live} --name Host --cwd ${ROOT}`);
    const prompt = await until('the four choices', () => {
      const f = flat(S.drive);
      const m = /tmux session "[^"]+" is already a jam of yours — .*?\[c\]ancel/.exec(f);
      return m ? m[0] : null;
    }, 15000);
    console.log(`      ${prompt}`);
    for (const k of ['[a]ttach as host', '[n]ew session', '[e]nd it and start fresh', '[c]ancel']) {
      if (!prompt.includes(k)) throw new Error(`the prompt does not offer ${k}`);
    }
    line('c');
    const out = await until('it to stand down', () => (/JAMEXIT=/.test(back(S.drive)) ? back(S.drive) : null), 10000);
    console.log(out.split('\n').filter((l) => /jam host --attach|jam end|second jam|JAMEXIT/.test(l)).map((l) => `      ${l.trim()}`).join('\n'));
    if (!/JAMEXIT=1/.test(out)) throw new Error('cancel should be a refusal, i.e. non-zero');
    if (!alive(S.live)) throw new Error('cancel ended the jam');
    if (!/jam host --attach/.test(out)) throw new Error('the refusal does not name the way in');
    killMine(S.drive);
  });

  await step('4 [n]ew session builds a second jam under an auto-name and a free port', async () => {
    drive(`env ${driveEnv()} node ${HOST_MJS} --tmux ${S.live} --port ${P.live} --name Host --cwd ${ROOT} --no-attach`);
    await until('the four choices', () => /\[n\]ew session/.test(flat(S.drive)), 15000);
    line('n');
    await until(`${S.two} to exist`, () => alive(S.two), 30000);
    const rows = jamJson();
    console.log(jam('sessions').out.split('\n').map((l) => `      ${l}`).join('\n'));
    const two = rows.find((r) => r.name === S.two);
    if (!two) throw new Error('the second jam is not listed');
    if (two.port === P.live) throw new Error('it took the port the first jam is holding');
    if (rows.filter((r) => r.state === 'live').length !== 2) throw new Error('both jams should be live');
    if (!alive(S.live)) throw new Error('the first jam did not survive');
    const gone = jam('end', S.two);
    if (gone.code !== 0) throw new Error(`ending the second jam: ${gone.out}`);
    if (alive(S.two) || !alive(S.live)) throw new Error('the wrong session went');
    console.log(`      ${S.two} started on :${two.port}, then ended cleanly`);
    killMine(S.drive);
  });

  await step('5 [a]ttach opens the host client, and the exit prompt\'s `k` keeps the jam', async () => {
    drive(`env ${driveEnv()} node ${HOST_MJS} --tmux ${S.live} --port ${P.live} --name Host --cwd ${ROOT}`);
    await until('the four choices', () => /\[a\]ttach as host/.test(flat(S.drive)), 15000);
    line('a');
    await until('the client to open on the mirror', () => /fake claude/.test(pane(S.drive)), 25000);
    show('the host client, attached to a jam that was already running', S.drive);
    line('/quit');
    const asked = await until('the exit prompt', () => (/\[k\]eep it running/.test(flat(S.drive)) ? back(S.drive) : null), 15000);
    console.log(`      ${asked.split('\n').filter((l) => /still running/.test(l)).at(-1).trim()}`);
    line('k');
    const out = await until('the way back', () => (/JAMEXIT=/.test(back(S.drive)) ? back(S.drive) : null), 15000);
    console.log(out.split('\n').filter((l) => /jam is still running|jam host --attach|jam sessions|jam end|raw TUI/.test(l)).map((l) => `      ${l.trim()}`).join('\n'));
    if (!alive(S.live)) throw new Error('`k` ended the jam');
    if (!fs.existsSync(stateDir(P.live))) throw new Error('`k` removed the state dir');
    if (!/jam host --attach/.test(out) || !/jam sessions/.test(out)) throw new Error('the reattach lines are missing');
    if (jamJson().find((r) => r.name === S.live)?.state !== 'live') throw new Error('the jam is not healthy after a keep');
    killMine(S.drive);
  });

  await step('6 /end in the host client: `n` ends nothing, `y` ends it for everybody', async () => {
    const w = watcher(P.live);
    await w.want('the welcome', (f) => f.t === 'welcome');
    drive(`env ${driveEnv()} node ${HOST_MJS} --attach --tmux ${S.live} --port ${P.live} --name Host --cwd ${ROOT}`);
    await until('`--attach` to open the client', () => /fake claude/.test(pane(S.drive)), 25000);
    line('/end');
    await until('the confirmation', () => /really end this jam for everyone/.test(back(S.drive)), 10000);
    console.log(`      ${back(S.drive).split('\n').filter((l) => /really end/.test(l)).at(-1).trim()}`);
    line('n');
    await until('the refusal', () => /nothing ended/.test(back(S.drive)), 10000);
    await sleep(1500);
    if (!alive(S.live) || w.ended) throw new Error('`n` ended the jam anyway');
    console.log('      after `n`: the jam is still running and nobody was told anything');
    line('/end');
    await until('the confirmation again', () => /really end this jam for everyone/.test(back(S.drive)), 10000);
    line('y');
    const ending = await until('the ending frame', () => w.ended, 15000);
    console.log(`      the watcher got: ${JSON.stringify(ending)}`);
    if (!/Host/.test(String(ending.by))) throw new Error('the ending frame lost its author');
    await until('the tmux session to go', () => !alive(S.live), 15000);
    await until('the state dir to go', () => !fs.existsSync(stateDir(P.live)), 10000);
    const out = await until('the launcher to notice', () => (/JAMEXIT=/.test(back(S.drive)) ? back(S.drive) : null), 20000);
    console.log(out.split('\n').filter((l) => /has ended|JAMEXIT/.test(l)).map((l) => `      ${l.trim()}`).join('\n'));
    if (jamJson().length) throw new Error(`still listed: ${JSON.stringify(jamJson())}`);
    killMine(S.drive);
  });

  await step('5 the exit prompt\'s `e` ends the jam, from [e]nd-it-and-start-fresh onwards', async () => {
    const first = launch(S.jam, P.main);
    drive(`env ${driveEnv()} node ${HOST_MJS} --tmux ${S.jam} --port ${P.main} --name Host --cwd ${ROOT}`);
    await until('the four choices', () => /\[e\]nd it and start fresh/.test(flat(S.drive)), 15000);
    line('e');
    // The old jam ends and a brand-new one is built under the same name — new session id, so
    // there is no doubt about which one is on screen.
    await until('a fresh jam under the same name', () => {
      const info = (() => { try { return JSON.parse(fs.readFileSync(path.join(stateDir(P.main), 'session.json'), 'utf8')); } catch { return null; } })();
      return info && info.sessionId !== first.sessionId ? info : null;
    }, 40000);
    const fresh = JSON.parse(fs.readFileSync(path.join(stateDir(P.main), 'session.json'), 'utf8'));
    console.log(`      ended session ${first.sessionId.slice(0, 8)} (pid ${first.pid}) → fresh ${fresh.sessionId.slice(0, 8)} (pid ${fresh.pid})`);
    if (running(first.pid)) throw new Error('the old daemon is still running');
    await until('its client', () => /fake claude/.test(pane(S.drive)), 25000);
    line('/quit');
    await until('the exit prompt', () => /\[k\]eep it running/.test(flat(S.drive)), 15000);
    line('e');
    const out = await until('the teardown', () => (/JAMEXIT=/.test(back(S.drive)) ? back(S.drive) : null), 25000);
    console.log(out.split('\n').filter((l) => /ending jam|killed tmux|removed |JAMEXIT/.test(l)).map((l) => `      ${l.trim()}`).join('\n'));
    if (alive(S.jam)) throw new Error('`e` left the tmux session running');
    if (fs.existsSync(stateDir(P.main))) throw new Error('`e` left the state dir behind');
    if (running(fresh.pid)) throw new Error('`e` left the daemon running');
    if (jamJson().length) throw new Error(`still listed: ${JSON.stringify(jamJson())}`);
    killMine(S.drive);
  });

  await step('3 `jam end --all` ends jam\'s own two and nothing else', async () => {
    const a = launch(S.jam, P.main);
    const b = launch(S.live, P.live);
    const listed = jamJson().map((r) => r.name).sort();
    if (listed.join(',') !== [S.jam, S.live].sort().join(',')) throw new Error(`listed ${listed}`);
    const r = jam('end', '--all', '--yes');
    console.log(r.out.split('\n').filter((l) => /would end|ending jam|killed|removed/.test(l)).map((l) => `      ${l.trim()}`).join('\n'));
    if (r.code !== 0) throw new Error(`--all exited ${r.code}: ${r.out}`);
    if (alive(S.jam) || alive(S.live)) throw new Error('a jam survived --all');
    if (running(a.pid) || running(b.pid)) throw new Error('a daemon survived --all');
    if (jamJson().length) throw new Error('still listed');
    // The two decoys were never candidates, so --all could not reach them.
    if (!alive(S.plain) || !alive(S.decoy)) throw new Error('--all reached a session jam does not own');
  });

  await step('S1/S2 both decoys are STILL there, having been offered to nothing', async () => {
    for (const name of [S.plain, S.decoy]) {
      if (!alive(name)) throw new Error(`${name} was killed somewhere in this run`);
      console.log(`      ${name}: alive`);
    }
    // The one that matters most: if a live jam was running when this started, it is running now.
    if (liveJam && !alive('jam')) throw new Error('THE LIVE JAM WENT AWAY DURING THIS RUN');
    if (liveJam) console.log('      jam (the live one): still alive, still never touched');
    // And the namespace proof: a state dir outside this smoke's TMPDIR — orphan-shaped, so the
    // most temping thing `jam clean` could possibly reach — was not touched by anything above.
    if (!fs.existsSync(path.join(GHOST, 'session.json'))) throw new Error('the planted state dir outside our TMPDIR is gone');
    console.log(`      ${GHOST}: untouched (a real orphan, in the real TMPDIR, and none of jam's business here)`);
  });
} finally {
  // Exact names, and only the ones this script created.
  for (const name of [S.drive, S.two, S.jam, S.live, S.plain, S.decoy]) killMine(name);
  for (const port of Object.values(P)) fs.rmSync(stateDir(port), { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(BIN, { recursive: true, force: true });
  fs.rmSync(GHOST, { recursive: true, force: true }); // planted by this script, removed by it
}

console.log(`\n--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'} in ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(failed ? 1 : 0);
