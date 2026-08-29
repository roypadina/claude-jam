#!/usr/bin/env node
// v0.25/v0.26/v0.27 smoke: sounds, nudges and the upload policy — the fifteenth smoke.
//
//   1   a KNOCK and an AUTO-JOIN produce two DIFFERENT sound calls, asserted through the
//       platform seam with a stub `afplay` on PATH — never by listening
//   2   `/ping <Name>` reaches only that client (their sound fires, the sender's does not) and
//       is still visible to the room: everybody gets the frame, and a bystander's client says
//       who nudged whom
//   3   the rate limit refuses a second ping to the same person inside 30 s, with the reason
//   4   a nudge to somebody who is not connected is refused — never queued
//   5   idle state appears in `/who`, and the nudge confirmation says which state they were in
//   6   `--no-sound` and the `/menu → Notifications` toggles suppress each tier independently
//   7   under `uploads auto` a transfer lands with NO prompt — while the caps that actually
//       protect the disk still refuse a traversal name and an oversized file
//   8   the session quota falls back to `ask` and says so out loud
//   9   `uploads off` refuses everybody, standing grants and the host included; `export` is a
//       separate toggle with its own default
//
// Self-contained: its own $TMPDIR and its own cwd (so jam-uploads/ is this smoke's), its own
// port, tmux sessions named jamnudge*, a fake `claude` that just draws a prompt, and a stub
// `afplay`/`osascript` per client so "who was interrupted" is a fact on disk. No real ttyd, no
// cloudflared, no network, no tokens spent. It kills only the session names it made, one exact
// name at a time.
//   usage: node scripts/smoke-nudge.mjs
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPLOAD_MAX } from '../lib.mjs';
// The seam's own table, so this smoke asserts on the sounds the product actually plays rather
// than on three file names copied into a test.
import { SOUNDS } from '../platform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOST_MJS = path.join(ROOT, 'host.mjs');
const CLIENT_MJS = path.join(ROOT, 'client.mjs');
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
// Clear of jam's 7777, the shared smokes' 7799/7801, smoke-transport's 7811-7819,
// smoke-replay's 7823/7825, smoke-perm's 7831, smoke-lifecycle's 7851-7855,
// smoke-invite's 7861, smoke-answer's 7871 and smoke-discover's 7891-7895.
const PORT = 7881;
const TOKEN = 'smokenudge1234';
const S = { jam: 'jamnudge', roy: 'jamnudgeroy' };
for (const [k, v] of Object.entries(S)) if (typeof v !== 'string' || !v.startsWith('jamnudge')) throw new Error(`S.${k} is ${v}`);

const SOCKET = `claude-jam-${PORT}`;
const SOCKET_ARGS = ['-L', SOCKET];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => spawnSync(TMUX, [...SOCKET_ARGS, ...a], { encoding: 'utf8' });
const alive = (name) => tmux('has-session', '-t', `=${name}`).status === 0;
const killMine = (name) => { if (typeof name === 'string' && name.startsWith('jamnudge')) tmux('kill-session', '-t', `=${name}`); };
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const pane = (t) => (tmux('capture-pane', '-p', '-S', '-400', '-t', t).stdout || '').replace(/\n+$/, '');
// The LIVE rows only: the /menu overlay lives in the live region, and matching it against 400
// rows of scrollback would find an older copy of itself.
const now = (t) => (tmux('capture-pane', '-p', '-t', t).stdout || '').replace(/\n+$/, '');

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
async function until(what, pred, ms = 12000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const v = await pred();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

// ------------------------------------------------------------------ fixtures ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-nudge-'));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-nudge-cwd-'));
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-nudge-bin-'));
const FAKE_CLAUDE = path.join(BIN, 'claude');
fs.writeFileSync(FAKE_CLAUDE,
  '#!/bin/sh\nfor a in "$@"; do case "$a" in --claude-jam-probe-unknown-flag)'
  + ' echo "error: unknown option \'$a\'" >&2; exit 1;; esac; done\n'
  + "printf '%s\\n' 'fake claude — v0.25 nudge smoke' '' '❯ '\nexec sleep 1800\n", { mode: 0o755 });

// THE SEAM UNDER TEST. platform.mjs is the only module allowed to spawn a platform binary, and
// it spawns `afplay <path>` / `osascript -e …` by NAME — so a directory in front of PATH holding
// two shell scripts is a real stub of the real call, not a mock of our own code. Each client
// gets its own pair, which is what makes "only the addressed client was interrupted" a fact on
// disk rather than an inference.
function stubs(who) {
  const dir = path.join(BIN, who);
  fs.mkdirSync(dir, { recursive: true });
  const sound = path.join(BIN, `${who}.sound`);
  const notify = path.join(BIN, `${who}.notify`);
  fs.writeFileSync(path.join(dir, 'afplay'), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${sound}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'osascript'), `#!/bin/sh\nprintf '%s\\n' "notify" >> ${notify}\n`, { mode: 0o755 });
  fs.writeFileSync(sound, '');
  fs.writeFileSync(notify, '');
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  return { who, dir, sound, notify,
    sounds: () => read(sound).map((l) => path.basename(l)),
    notifies: () => read(notify),
    path: `${dir}:${process.env.PATH}` };
}
const ENV = { ...process.env, TMPDIR: TMP, JAM_CLAUDE: FAKE_CLAUDE };
const KNOCK = `${SOUNDS.knock}.aiff`;
const JOIN = `${SOUNDS.join}.aiff`;
const NUDGE = `${SOUNDS.nudge}.aiff`;

// A scripted participant: raw WS, so nothing about the daemon under test is faked.
function peer(hello) {
  const p = { frames: [], closeCode: null };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', ...hello })));
  ws.addEventListener('message', (m) => { try { p.frames.push(JSON.parse(m.data)); } catch { /* not ours */ } });
  ws.addEventListener('close', (e) => { p.closeCode = e.code; });
  ws.addEventListener('error', () => { /* the assertions carry the verdict */ });
  p.send = (o) => { try { ws.send(JSON.stringify(o)); } catch { /* closing */ } };
  p.bye = () => { try { ws.close(); } catch { /* already gone */ } };
  p.want = async (what, pred, ms = 10000) => until(`${what} (saw: ${p.frames.map((f) => f.t).join(',') || 'nothing'})`,
    () => p.frames.find(pred), ms);
  // From an index, so a second refusal is not satisfied by the first one still in the log.
  p.since = () => p.frames.length;
  p.wantFrom = async (i, what, pred, ms = 10000) => until(`${what} (since ${i})`,
    () => p.frames.slice(i).find(pred), ms);
  p.none = (what, pred, ms = 1200) => sleep(ms).then(() => {
    const hit = p.frames.find(pred);
    if (hit) throw new Error(`${what}: ${JSON.stringify(hit).slice(0, 200)}`);
  });
  p.roster = () => [...p.frames].reverse().find((f) => f.t === 'roster' || f.t === 'welcome')?.roster || [];
  return p;
}

// A REAL client, the readline renderer (a pipe on stdin picks it), with a stub PATH of its own.
// Typed into like a human and read back like a human, which is the only way `/ping`, `/who` and
// `/sound` are proved end to end rather than at the wire.
const children = [];
function client(name, extra = []) {
  const st = stubs(name);
  const child = spawn(process.execPath, [CLIENT_MJS, `ws://127.0.0.1:${PORT}`,
    '--name', name, '--token', TOKEN, ...extra],
  { env: { ...ENV, PATH: st.path }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const text = () => out.replace(ANSI, '');
  // Flattened, because this renderer WRAPS: a `here:` line with five people in it is longer than
  // the 80 columns a pipe reports, and an assertion that did not know that would fail on the
  // wrap rather than on the behaviour.
  const flat = () => text().replace(/\s+/g, ' ');
  const grab = (re) => (flat().match(re) || [''])[0].trim();
  return { name, stubs: st, child, text, flat, grab,
    line: (s) => { try { child.stdin.write(`${s}\n`); } catch { /* gone */ } },
    want: (what, re, ms = 10000) => until(`${name}: ${what}`, () => re.test(flat()) || null, ms),
    bye: () => { try { child.stdin.write('/quit\n'); } catch { /* gone */ } } };
}

let dana; let ops;
console.log(`TMPDIR ${TMP}\ncwd    ${CWD}\nstubs  ${BIN}\nport   ${PORT}, tmux ${SOCKET_ARGS.join(' ')} -t ${S.jam}`);
const started = Date.now();

try {
  // ======================================================== the jam under test ====
  killMine(S.jam);
  killMine(S.roy);
  const born = spawnSync(process.execPath, [HOST_MJS, '--tmux', S.jam, '--port', String(PORT),
    '--name', 'Roy', '--cwd', CWD, '--token', TOKEN, '--no-attach', '--no-popup', '--replay', '0',
    // Two files is a quota this smoke can actually spend — the shipped default is 40/200 MB.
    '--upload-quota', '2files'],
  { encoding: 'utf8', env: ENV });
  if (born.status !== 0) throw new Error(`launch failed: ${born.stdout}${born.stderr}`);
  console.log(`      launched: ${S.jam} on :${PORT}`);

  // Roy's own client, for real, in a pty of its own — this is the one that has to make a noise.
  const roy = stubs('Roy');
  const royBorn = tmux('new-session', '-d', '-s', S.roy, '-x', '120', '-y', '40',
    'env', `PATH=${roy.path}`, `TMPDIR=${TMP}`,
    process.execPath, CLIENT_MJS, `ws://127.0.0.1:${PORT}`, '--name', 'Roy', '--token', TOKEN, '--host');
  if (royBorn.status !== 0) throw new Error(`could not start Roy's client: ${royBorn.stderr}`);
  await until("Roy's client to connect", () => /host Roy/.test(pane(S.roy)));

  // A second trusted client, raw, for driving the policy frames and watching what the daemon
  // sends. Loopback + host:true is exactly what makes a client trusted (see classifyHello).
  ops = peer({ name: 'Ops', host: true, token: TOKEN });
  await ops.want('the ops welcome', (f) => f.t === 'welcome');

  // ======================================================== 1: two different sounds ====
  await step('1 a knock and an auto-join make two DIFFERENT sound calls (through the seam)', async () => {
    // A hello with no token is a knock: somebody WAITING for the host.
    const knocker = peer({ name: 'Knocker' });
    await ops.want('the knock', (f) => f.t === 'knock' && f.name === 'Knocker');
    await until('the knock sound', () => roy.sounds().includes(KNOCK));
    eq(roy.sounds().length, 1, 'sounds after the knock');
    // The sound is spawned first and the notification a line later, so this waits rather than
    // reading the log in the same breath.
    await until('the knock notification', () => roy.notifies().length > 0);
    console.log(`      knock  → afplay ${roy.sounds().join(' ')}`);

    // …and a token join is somebody who is already in: a different sound, no approval owed.
    dana = client('Dana');
    await dana.want('welcome', /host Roy/);
    await until('the join sound', () => roy.sounds().includes(JOIN));
    console.log(`      join   → afplay ${roy.sounds().join(' ')}`);
    if (KNOCK === JOIN) throw new Error('the two sounds are the same file');
    eq(roy.sounds().length, 2, 'one sound per arrival, never a burst');
    // A guest hears nothing at all for an arrival: they have nobody to approve.
    eq(dana.stubs.sounds().length, 0, "a guest's arrival sounds");
    knocker.bye();
  });

  // ======================================================== 2: the nudge round trip ====
  const kobi = client('Kobi');
  await kobi.want('welcome', /host Roy/);
  await step('2 /ping reaches only that client, and the room still sees it happen', async () => {
    const before = { roy: roy.sounds().length, kobi: kobi.stubs.sounds().length, dana: dana.stubs.sounds().length };
    kobi.line('/ping Roy look at line 40');
    // The addressed client: the highlighted line, and the sound.
    await until('Roy to see the nudge', () => /Kobi is asking for you: look at line 40/.test(pane(S.roy)));
    await until('Roy to hear it', () => roy.sounds().length > before.roy);
    eq(roy.sounds().at(-1), NUDGE, 'the nudge sound');
    console.log(`      Roy    → afplay ${roy.sounds().at(-1)} · "${(pane(S.roy).split('\n').find((l) => /asking for you/.test(l)) || '').trim()}"`);
    // The sender is told it landed, and is NOT interrupted by their own nudge.
    await kobi.want('the confirmation', /you nudged Roy/);
    eq(kobi.stubs.sounds().length, before.kobi, "the sender's own sounds");
    // The room sees it happen — a nudge is never secret — but is not interrupted by it.
    await dana.want('the bystander line', /Kobi nudged Roy/);
    eq(dana.stubs.sounds().length, before.dana, "a bystander's sounds");
    console.log(`      Dana   → "${dana.grab(/Kobi nudged Roy/)}" (afplay: none)`);
    // …and the wire says the same thing: one frame, addressed.
    const f = await ops.want('the nudge frame', (x) => x.t === 'nudge' && x.from === 'Kobi');
    eq(f.to, 'Roy', 'nudge.to');
    eq(f.text, 'look at line 40', 'nudge.text');
  });

  await step('3 the rate limit refuses a second ping to the same person inside 30s', async () => {
    kobi.line('/ping Roy again');
    await kobi.want('the refusal', /one every 30s/);
    const line = kobi.grab(/you nudged them [^!]*?one every 30s[^!]*?left/);
    console.log(`      ! ${line}`);
    if (!/\d+s left/.test(line)) throw new Error('the refusal does not say how long is left');
    // Refused means refused: nothing reached Roy, and nothing rang.
    const seen = pane(S.roy).match(/asking for you/g) || [];
    eq(seen.length, 1, 'nudges on Roy\'s screen');
    // A DIFFERENT target is a different budget — the limit is per sender→target.
    kobi.line('/ping Dana over here');
    await dana.want('Dana\'s own nudge', /Kobi is asking for you: over here/);
  });

  await step('4 a nudge to somebody who is not connected is refused, never queued', async () => {
    kobi.line('/ping Yossi hello');
    await kobi.want('the refusal', /Yossi is not connected/);
    console.log(`      ! ${kobi.grab(/Yossi is not connected[^❯]*/)}`);
    // Nobody was told anything, and nothing is waiting for a Yossi who might turn up later.
    await ops.none('a nudge was routed to a stranger', (f) => f.t === 'nudge' && f.to === 'Yossi');
  });

  // ======================================================== 5: idle in /who ====
  await step('5 idle state shows in /who, and the nudge confirmation says which state they were in', async () => {
    // The wire contract is one number: seconds since that human last touched a key. A raw peer
    // reporting 25 minutes is the same frame a real client sends when it has been quiet that
    // long — and it is the whole of what a client ever reports.
    const idler = peer({ name: 'Idler', token: TOKEN });
    await idler.want('welcome', (f) => f.t === 'welcome');
    idler.send({ t: 'idle', s: 1500 });
    await until('the roster to carry the idle map', () => ops.frames.some((f) => f.t === 'roster' && f.idle?.Idler === 1500));
    kobi.line('/who');
    await kobi.want('/who with the state', /Idler \(away 20m\+\)/);
    const who = kobi.grab(/here: [^❯*!]*Idler \(away 20m\+\)/);
    console.log(`      ${who}`);
    if (!/Kobi \(you\)/.test(who)) throw new Error('/who does not mark the reader');
    if (!/Roy \(active\)/.test(who)) throw new Error('/who does not show a live client as active');
    // And the confirmation tells the sender what they are interrupting.
    kobi.line('/ping Idler are you there');
    await kobi.want('the confirmation with the state', /nudged Idler \(away 20m\+\)/);
    console.log(`      ${kobi.grab(/nudged Idler \(away 20m\+\)/)}`);
    idler.bye();
  });

  // ======================================================== 6: the tiers ====
  await step('6a --no-sound starts a client silent, and nothing else about it changes', async () => {
    const mute = client('Mute', ['--no-sound']);
    await mute.want('welcome', /host Roy/);
    kobi.line('/ping Mute look');
    await mute.want('the nudge line', /Kobi is asking for you: look/);
    await sleep(600);
    eq(mute.stubs.sounds().length, 0, 'sounds for a --no-sound client');
    // The line still arrived, and so did the desktop notification: --no-sound silences the
    // SOUND and nothing else. That is the whole reason there are three toggles.
    if (!mute.stubs.notifies().length) throw new Error('--no-sound also killed the notification');
    console.log(`      Mute   → afplay none, notification ${mute.stubs.notifies().length} — the line arrived anyway`);
    mute.line('/sound');
    await mute.want('the report', /sound off · notification on · bell on/);
    console.log(`      ${mute.grab(/sound off · notification on · bell on[^❯]*/)}`);
    mute.bye();
  });

  await step('6b /sound off silences a client that started loud, at runtime', async () => {
    // Dana was nudged in step 3 and heard it, so there is a `before` worth comparing to.
    if (!dana.stubs.sounds().includes(NUDGE)) throw new Error('Dana never heard the step-3 nudge');
    const before = dana.stubs.sounds().length;
    dana.line('/sound off');
    await dana.want('the switch', /sound off ·/);
    // A DIFFERENT sender, because the 30-second limit is per sender → target and Kobi has just
    // spent theirs on Dana. Ops is a client like any other as far as a nudge is concerned.
    ops.send({ t: 'nudge', to: 'Dana', text: 'still there' });
    await dana.want('the second nudge', /Ops is asking for you: still there/);
    await sleep(700);
    eq(dana.stubs.sounds().length, before, 'sounds after /sound off');
    console.log('      Dana   → the line arrived, afplay did not fire');
  });

  await step('6c the /menu toggle switches a tier, and the tier stops firing', async () => {
    const send = (...k) => tmux('send-keys', '-t', S.roy, ...k);
    const type = (s) => tmux('send-keys', '-t', S.roy, '-l', s);
    type('/menu'); send('Enter');
    await until('the control panel', () => /control panel/.test(now(S.roy)));
    // people · invites · access · session · NOTIFICATIONS · help
    for (let i = 0; i < 4; i++) { send('Down'); await sleep(120); }
    await until('the Notifications row', () => /Notifications/.test(now(S.roy)));
    send('Enter');
    await until('the tier rows', () => /Desktop notification/.test(now(S.roy)));
    console.log(`      ${now(S.roy).split('\n').filter((l) => /Sound |Desktop notification|Terminal bell|Phone \(ntfy\)/.test(l)).map((l) => l.trim().slice(0, 96)).join('\n      ')}`);
    // Nudge somebody · Sound · DESKTOP NOTIFICATION · Terminal bell · Phone · Who is idle
    for (let i = 0; i < 2; i++) { send('Down'); await sleep(120); }
    send('Enter');
    await until('the toggle to be reported', () => /desktop notification off/.test(pane(S.roy)));
    const before = { s: roy.sounds().length, n: roy.notifies().length };
    // A fresh knock: the sound tier still fires, the notification tier does not.
    const late = peer({ name: 'Latecomer' });
    await ops.want('the second knock', (f) => f.t === 'knock' && f.name === 'Latecomer');
    await until('the knock sound', () => roy.sounds().length > before.s);
    eq(roy.sounds().at(-1), KNOCK, 'the second knock still rings');
    await sleep(800);
    eq(roy.notifies().length, before.n, 'notifications after the tier was switched off');
    console.log(`      knock  → afplay ${roy.sounds().at(-1)}, notification suppressed (${before.n} before, ${roy.notifies().length} after)`);
    late.bye();
  });

  // ======================================================== 7-9: the upload policy ====
  const up = peer({ name: 'Upper', token: TOKEN });
  await up.want('welcome', (f) => f.t === 'welcome');
  const sendFile = async (name, data) => {
    const at = up.since();
    up.send({ t: 'upload', name, size: data.length });
    const g = await up.wantFrom(at, `the grant for ${name}`, (f) => f.t === 'xfergrant' && f.name === name);
    up.send({ t: 'file', xfer: g.xfer, seq: 0, b64: data.toString('base64'), done: true });
    return g;
  };

  await step('7a `ask` is unchanged: the host is asked, and nothing moves until they answer', async () => {
    up.send({ t: 'upload', name: 'asked.txt', size: 5 });
    const req = await ops.want('the file request', (f) => f.t === 'filereq' && f.file === 'asked.txt');
    eq(req.name, 'Upper', 'filereq.name');
    await up.none('an ask-policy upload was granted anyway', (f) => f.t === 'xfergrant');
    console.log(`      ⇪ ${req.name} wants to send ${req.file} — the ladder, exactly as before`);
    ops.send({ t: 'fileok', op: 'deny', name: 'Upper' });
    await up.want('the refusal', (f) => f.t === 'error' && /refused by Roy/.test(f.text));
  });

  await step('7b under `auto` a transfer lands with NO prompt at all', async () => {
    ops.send({ t: 'policy', kind: 'uploads', mode: 'auto' });
    await ops.want('the policy line', (f) => f.t === 'sys' && /uploads: anyone already admitted/.test(f.text));
    console.log(`      ${[...ops.frames].reverse().find((f) => f.t === 'sys' && /^uploads:/.test(f.text)).text.slice(0, 120)}…`);
    const at = ops.frames.length;
    await sendFile('auto1.txt', Buffer.from('one under auto\n'));
    // Not gated — and still announced: the host sees the file arrive, it is just not a question.
    if (ops.frames.slice(at).some((f) => f.t === 'filereq')) throw new Error('auto still asked the host');
    await ops.want('the arrival', (f) => f.t === 'say' && /sent a file: jam-uploads\/auto1\.txt/.test(f.text));
    await until('the file on disk', () => fs.existsSync(path.join(CWD, 'jam-uploads', 'auto1.txt')));
    console.log(`      ⇪ ${path.join(CWD, 'jam-uploads', 'auto1.txt')} — no prompt, still visible`);
  });

  await step('7c the caps do NOT move with the policy: traversal and the 20 MB limit still refuse', async () => {
    for (const bad of ['../escape.txt', '/etc/passwd', '..', 'a/b.txt']) {
      const at = up.since();
      up.send({ t: 'upload', name: bad, size: 3 });
      const e = await up.wantFrom(at, `the refusal for ${bad}`,
        (f) => f.t === 'error' && /is not a file name I will write/.test(f.text));
      console.log(`      ${JSON.stringify(bad).padEnd(16)} → ${e.text.slice(0, 88)}`);
      await up.none(`${bad} was granted anyway`, (f) => f.t === 'xfergrant' && f.name && /escape|passwd|b\.txt/.test(f.name), 200);
    }
    if (fs.existsSync(path.join(CWD, 'jam-uploads', 'escape.txt'))) throw new Error('a traversal name was written');
    if (fs.readdirSync(CWD).includes('escape.txt')) throw new Error('a traversal name escaped the upload dir');
    const atBig = up.since();
    up.send({ t: 'upload', name: 'huge.bin', size: UPLOAD_MAX + 1 });
    const big = await up.wantFrom(atBig, 'the size refusal', (f) => f.t === 'error' && /upload cap/.test(f.text));
    console.log(`      oversized → ${big.text}`);
    await up.none('an oversized upload was granted', (f) => f.t === 'xfergrant' && f.name === 'huge.bin');
  });

  await step('8 the session quota falls back to `ask`, and says so once', async () => {
    await sendFile('auto2.txt', Buffer.from('two under auto\n'));
    await until('the second file', () => fs.existsSync(path.join(CWD, 'jam-uploads', 'auto2.txt')));
    // Two files is the quota this jam was launched with. The third is a question again.
    const at = ops.frames.length;
    up.send({ t: 'upload', name: 'auto3.txt', size: 4 });
    const said = await ops.want('the quota line', (f) => f.t === 'sys' && /upload quota reached — asking again/.test(f.text));
    console.log(`      ${said.text}`);
    await ops.want('the fallback to the ladder', (f) => f.t === 'filereq' && f.file === 'auto3.txt');
    if (!ops.frames.slice(at).some((f) => f.t === 'filereq')) throw new Error('the quota did not fall back to ask');
    ops.send({ t: 'fileok', op: 'allow', name: 'Upper' });
    const g = await up.want('the grant after the host said yes', (f) => f.t === 'xfergrant' && f.name === 'auto3.txt');
    up.send({ t: 'file', xfer: g.xfer, seq: 0, b64: Buffer.from('four').toString('base64'), done: true });
    await until('the third file', () => fs.existsSync(path.join(CWD, 'jam-uploads', 'auto3.txt')));
    console.log(`      jam-uploads/: ${fs.readdirSync(path.join(CWD, 'jam-uploads')).join(', ')}`);
    // Resetting it puts `auto` back, without a restart.
    ops.send({ t: 'policy', kind: 'quota-reset' });
    await ops.want('the reset line', (f) => f.t === 'sys' && /quota was reset/.test(f.text));
    await sendFile('auto4.txt', Buffer.from('after the reset\n'));
    await until('the fourth file', () => fs.existsSync(path.join(CWD, 'jam-uploads', 'auto4.txt')));
  });

  await step('9 `off` refuses everybody — the host included — and export is its own toggle', async () => {
    ops.send({ t: 'policy', kind: 'uploads', mode: 'off' });
    await ops.want('the off line', (f) => f.t === 'sys' && /uploads: refused for everybody/.test(f.text));
    up.send({ t: 'upload', name: 'nope.txt', size: 3 });
    const e = await up.want('the refusal', (f) => f.t === 'error' && /uploads are off in this jam/.test(f.text));
    console.log(`      guest → ${e.text}`);
    // The host's own /paste goes down the same path, and `off` means off.
    ops.send({ t: 'upload', name: 'hostpaste.png', size: 3 });
    const eh = await ops.want('the host refusal', (f) => f.t === 'error' && /uploads are off in this jam/.test(f.text));
    console.log(`      host  → ${eh.text}`);
    if (fs.readdirSync(path.join(CWD, 'jam-uploads')).includes('nope.txt')) throw new Error('an `off` upload landed');
    // …and the transcript is a separate question with a separate default: still `ask`.
    up.send({ t: 'export' });
    await ops.want('the export request', (f) => f.t === 'exportreq' && f.name === 'Upper');
    console.log('      export → still on the ladder: `uploads off` says nothing about the transcript');
    ops.send({ t: 'exportok', op: 'deny', name: 'Upper' });
    ops.send({ t: 'policy', kind: 'export', mode: 'off' });
    await ops.want('the export policy line', (f) => f.t === 'sys' && /transcript is not shared/.test(f.text));
    up.send({ t: 'export' });
    await up.want('the export refusal', (f) => f.t === 'error' && /not shared in this jam/.test(f.text));
  });

  await step('9b the panel says what is true: /menu shows both policies and what the session spent', async () => {
    const tok = [...ops.frames].reverse().find((f) => f.t === 'token');
    eq(tok.uploads, 'off', 'the token frame carries the upload policy');
    eq(tok.exportPolicy, 'off', 'the token frame carries the export policy');
    console.log(`      token frame: uploads=${tok.uploads} export=${tok.exportPolicy} `
      + `used=${tok.uploadUsed.files} file(s)/${tok.uploadUsed.bytes}B of ${tok.uploadQuota.files}/${tok.uploadQuota.bytes}`);
    if (JSON.stringify(tok).includes('ntfy')) throw new Error('the protocol carried something about a phone');
  });
} finally {
  ops?.bye();
  dana?.bye();
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
  killMine(S.roy);
  killMine(S.jam);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* leave it */ }
  try { fs.rmSync(CWD, { recursive: true, force: true }); } catch { /* leave it */ }
  try { fs.rmSync(BIN, { recursive: true, force: true }); } catch { /* leave it */ }
  console.log(`\n--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'} in ${Math.round((Date.now() - started) / 1000)}s`);
  for (const n of Object.values(S)) if (alive(n)) console.log(`WARNING ${n} is still up — \`tmux ${SOCKET_ARGS.join(' ')} kill-session -t '=${n}'\``);
  process.exit(failed ? 1 : 0);
}
