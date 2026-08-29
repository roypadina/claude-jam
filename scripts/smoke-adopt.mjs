#!/usr/bin/env node
// v0.33 smoke: adopting a session claude-jam did not start — and, above everything else, NOT
// owning it. This is the first feature that points tmux at a server claude-jam does not own, so
// most of these steps are about what does NOT happen.
//   S1  no tmux at all → spec item 6: the whole `--resume` alternative, id already filled in
//   S2  a pane id that is not one, and a socket name that would become a path, are refused
//   S3  a pane that does not exist on that socket is refused, with how to find one
//   S4  a directory with no claude transcript is refused rather than adopting nothing
//   S5  no terminal to confirm on and no --yes adopts NOTHING — no state dir, no tmux session
//   S6  adopt (on a socket this smoke made): the daemon comes up, `sessions` says `adopted`,
//       `--json` carries the pane, and the ownership marker is on claude-jam's OWN session only
//   S6b the BRIEFING lands in that pane, whole, prefixed `[claude-jam:tool]:` — the half an
//       adopted claude cannot be given as a hook or a system prompt — and is NOT kept in the outbox
//   S7  a guest's mirror shows the REAL adopted pane, and their message lands in it whole
//   S8  the same pane cannot be adopted twice
//   S9  `claude-jam clean` removes nothing while it is running
//   S10 a jam of claude-jam's OWN is refused for adoption — `--attach` is the way back in
//   S11 `claude-jam end`: the daemon, its session and its state dir go — and the ADOPTED session
//       still exists, its pane still exists, and the process in it has the SAME pid
//   S12 the same, once, on the DEFAULT tmux socket, which is the case the feature exists for —
//       and this one runs `--no-brief`, so nothing is typed into the pane at all and every
//       client's welcome carries `noBrief: true` to say claude has NOT been told
//
// Self-contained: its own $TMPDIR (so `claude-jam sessions|end|clean` cannot see a state dir that
// is not this smoke's), its own $HOME (so the transcripts it invents are the only ones there),
// and its own tmux socket for every session it creates — except S12's ONE session on the default
// server, which is named `jamadopt-<random>` and removed by that exact name. No real claude: the
// adopted pane is scripts/fake-tui.mjs, so capture-pane, paste-buffer and send-keys are all real.
//   usage: node scripts/smoke-adopt.mjs
import { spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSlug, BRIEF_NAME, validName } from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const JAM = path.join(ROOT, 'claude-jam');
const HOST_MJS = path.join(ROOT, 'host.mjs');
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
const TOKEN = 'adoptsmoketoken';
// Clear of jam's 7777 and of every other smoke's block (7799/7801, 7811-7819, 7823/7825, 7831,
// 7851-7855, 7861, 7871, 7881, 7891-7895, 7901).
const P = { own: 7921, dflt: 7923, jam: 7925 };

// Every tmux session this script creates, and the only ones it ever kills. S12's lives on the
// DEFAULT server, so its name is randomised — nothing may collide with somebody's own session.
const RAND = randomBytes(4).toString('hex');
const S = { pane: 'jamadoptpane', jam: 'jamadoptjam', dflt: `jamadopt-${RAND}` };
for (const [k, v] of Object.entries(S)) {
  if (typeof v !== 'string' || !v.startsWith('jamadopt')) throw new Error(`S.${k} is ${v}`);
}

const SOCKET = 'jamadoptsock';                 // this smoke's own tmux server
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => spawnSync(TMUX, ['-L', SOCKET, ...a], { encoding: 'utf8' });
// The DEFAULT server. Everything through here is either read-only or about S.dflt, by exact name.
const dtmux = (...a) => spawnSync(TMUX, ['-L', 'default', ...a], { encoding: 'utf8' });
const paneOf = (t, sess = tmux) => (sess('capture-pane', '-p', '-t', t).stdout || '').replace(/\n+$/, '');
const running = (pid) => !!pid && spawnSync('ps', ['-p', String(pid)], { encoding: 'utf8' }).status === 0;
// One exact name per call, on the socket that name was created on, and only a name this script
// made up. Never a filtered sweep, never kill-server.
const killMine = (name, sess = tmux) => {
  if (typeof name === 'string' && name.startsWith('jamadopt')) sess('kill-session', '-t', `=${name}`);
};

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
const ok = (cond, what) => { if (!cond) throw new Error(what); };
async function until(what, pred, ms = 20000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const v = await pred();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

// ------------------------------------------------------------------ fixtures ----
// REALPATHED, all of them. On macOS `$TMPDIR` is a symlink (`/var/folders/…` →
// `/private/var/folders/…`), and both a real claude (which files its transcript under its own
// `process.cwd()`) and tmux (`#{pane_current_path}`) report the resolved path. A fixture built
// under the unresolved one would slug to a directory adoption can never find — which is exactly
// what the first run of this smoke did.
const mkdir = (tag) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), tag)));
const TMP = mkdir('jam-adopt-');       // this smoke's $TMPDIR
const HOME = mkdir('jam-adopt-home-'); // and its $HOME
const BIN = mkdir('jam-adopt-bin-');
const WORK = mkdir('jam-adopt-cwd-');  // what the pane's cwd is
const BARE = mkdir('jam-adopt-bare-'); // a cwd with no transcript
const CTL = path.join(TMP, 'tui-mode');
const LOG = path.join(TMP, 'tui-log');
fs.writeFileSync(CTL, 'box');
fs.writeFileSync(LOG, '');

// A transcript exactly where claude would file one for WORK, under this smoke's own $HOME. The
// first user line and the last assistant line are what the confirmation has to echo back.
const SESSION_ID = randomUUID();
const FIRST = 'port the flux capacitor to rust';
const LAST = 'the flux capacitor now compiles';
const projectDir = path.join(HOME, '.claude', 'projects', projectSlug(WORK));
fs.mkdirSync(projectDir, { recursive: true });
const TRANSCRIPT = path.join(projectDir, `${SESSION_ID}.jsonl`);
fs.writeFileSync(TRANSCRIPT, [
  JSON.stringify({ type: 'user', cwd: WORK, message: { content: FIRST } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: LAST }] } }),
  '',
].join('\n'));
// A SECOND, older transcript in the same directory: the newest is the one that must be picked.
fs.writeFileSync(path.join(projectDir, `${randomUUID()}.jsonl`),
  `${JSON.stringify({ type: 'user', cwd: WORK, message: { content: 'an older conversation' } })}\n`);
fs.utimesSync(path.join(projectDir, fs.readdirSync(projectDir).find((f) => !f.startsWith(SESSION_ID))),
  new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));

// A stand-in claude for S10's REAL jam only — adoption never spawns one.
const FAKE_CLAUDE = path.join(BIN, 'claude');
fs.writeFileSync(FAKE_CLAUDE,
  '#!/bin/sh\nfor a in "$@"; do case "$a" in --claude-jam-probe-unknown-flag)'
  + ' echo "error: unknown option \'$a\'" >&2; exit 1;; esac; done\n'
  + 'rows=$(tput lines 2>/dev/null); [ -n "$rows" ] || rows=24\n'
  + 'i=1; while [ "$i" -lt "$rows" ]; do echo; i=$((i+1)); done\n'
  + "printf '%s' 'fake claude — v0.33 adopt smoke'\nexec sleep 1800\n", { mode: 0o755 });

// Everything jam runs sees this: its own TMPDIR (hence its own state-dir namespace) and its own
// HOME (hence its own ~/.claude/projects). TMUX/TMUX_PANE are deliberately absent — S1 needs
// "not inside tmux" to be the truth, and every other step passes --pane explicitly.
const ENV = { ...process.env, TMPDIR: TMP, HOME, JAM_CLAUDE: FAKE_CLAUDE, FAKE_TUI_W: '100' };
delete ENV.TMUX;
delete ENV.TMUX_PANE;
delete ENV.CLAUDE_CONFIG_DIR; // or the daemon would glob a profile that is not this smoke's
const stateDir = (port) => path.join(TMP, `claude-jam-${port}`);

function jam(...args) {
  const r = spawnSync(JAM, args, { encoding: 'utf8', env: ENV });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const jamJson = () => JSON.parse(jam('sessions', '--json').out);
const tuiLog = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } };
const submitted = () => tuiLog().split('\n').filter((l) => l.startsWith('SUBMIT '))
  .map((l) => JSON.parse(l.slice(7)));

// The adopted pane: the fake TUI, in a session this smoke created, on the socket it names.
function makePane(name, sess = tmux, cwd = WORK) {
  killMine(name, sess);
  const born = sess('new-session', '-d', '-s', name, '-x', '100', '-y', '32', '-c', cwd, '-n', 'mywork',
    process.execPath, path.join(HERE, 'fake-tui.mjs'), CTL, LOG);
  if (born.status !== 0) throw new Error(`tmux new-session ${name}: ${born.stderr}`);
  const id = (sess('display-message', '-p', '-t', name, '#{pane_id}').stdout || '').trim();
  const pid = Number((sess('display-message', '-p', '-t', name, '#{pane_pid}').stdout || '').trim());
  if (!/^%\d+$/.test(id)) throw new Error(`no pane id for ${name}: ${JSON.stringify(id)}`);
  return { name, id, pid };
}

// A scripted guest. Raw socket, because the assertions are about the DAEMON's frames.
function connect(port, name, { host = false } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const c = { ws, name, events: [] };
  c.ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', name, token: TOKEN, ...(host ? { host: true } : {}) })));
    ws.addEventListener('message', (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      c.events.push(ev);
      if (ev.t === 'welcome') res(c);
    });
    ws.addEventListener('error', rej);
    setTimeout(() => rej(new Error(`${name} never got a welcome`)), 15000);
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.waitFor = (what, pred, ms) => until(`${name}: ${what}`, () => c.events.find(pred), ms);
  return c;
}

console.log(`TMPDIR ${TMP}\nHOME   ${HOME}\ncwd    ${WORK}\nsocket ${SOCKET}\ndefault-socket session ${S.dflt}`);
const started = Date.now();
let adopted = null;

try {
  // =============================================================== the refusals ====
  await step('S1 REFUSAL not inside tmux at all — the whole --resume alternative, id filled in', async () => {
    const r = spawnSync(JAM, ['adopt'], { encoding: 'utf8', env: { ...ENV, PWD: WORK }, cwd: WORK });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    console.log(`      ${out.trim().split('\n').slice(0, 3).join('\n      ')}`);
    ok(r.status === 1, `expected exit 1, got ${r.status}`);
    ok(/needs this claude to be running in a tmux pane/.test(out), 'no reason given');
    ok(out.includes(`claude-jam host --resume ${SESSION_ID} --cwd ${WORK}`),
      `the alternative did not carry the detected id:\n${out}`);
    ok(!fs.existsSync(stateDir(P.own)), 'a refusal built a state dir');
  });

  await step('S2 REFUSAL a pane id that is not one, and a socket name that would become a path', async () => {
    const bad = jam('adopt', '--pane', 'claude-jam:claude');
    ok(bad.code === 2, `expected exit 2, got ${bad.code}`);
    ok(/is not a tmux pane id/.test(bad.out), bad.out);
    const worse = jam('adopt', '--pane', '%1', '--socket', '../../etc/passwd');
    ok(worse.code === 2, `expected exit 2, got ${worse.code}`);
    ok(/is not a usable tmux socket name/.test(worse.out), worse.out);
    // And host.mjs refuses them too, for anybody who skips the front door.
    const direct = spawnSync(process.execPath, [HOST_MJS, '--adopt-pane', 'nope', '--session-id', SESSION_ID],
      { encoding: 'utf8', env: ENV });
    ok(direct.status === 2, `host.mjs took a bad pane: ${direct.status}`);
    ok(/bad --adopt-pane/.test(`${direct.stdout}${direct.stderr}`), direct.stderr);
    // A pane with no session id is refused rather than tailing a transcript that cannot exist.
    const noId = spawnSync(process.execPath, [HOST_MJS, '--adopt-pane', '%1'], { encoding: 'utf8', env: ENV });
    ok(noId.status === 2 && /needs --session-id/.test(`${noId.stdout}${noId.stderr}`), noId.stderr);
  });

  await step('S3 REFUSAL a pane that does not exist on that socket', async () => {
    const r = jam('adopt', '--pane', '%99999', '--socket', SOCKET, '--yes');
    ok(r.code === 1, `expected exit 1, got ${r.code}`);
    ok(/no tmux pane %99999 on socket jamadoptsock/.test(r.out), r.out);
    ok(/list-panes/.test(r.out), 'a refusal has to say how to find the right one');
  });

  await step('S4 REFUSAL a directory with no claude transcript', async () => {
    const p = makePane(S.pane, tmux, BARE);
    const r = jam('adopt', '--pane', p.id, '--socket', SOCKET, '--yes');
    ok(r.code === 1, `expected exit 1, got ${r.code}`);
    ok(/no claude transcript for that directory/.test(r.out), r.out);
    killMine(S.pane);
  });

  await step('S5 REFUSAL no terminal to confirm on, and no --yes: NOTHING is adopted', async () => {
    const p = makePane(S.pane);
    const r = jam('adopt', '--pane', p.id, '--socket', SOCKET);
    console.log(`      ${r.out.trim().split('\n').slice(0, 8).join('\n      ')}`);
    ok(r.code === 1, `expected exit 1, got ${r.code}`);
    // The resolution is still SHOWN — that is the whole point of it being separate from the act.
    ok(r.out.includes(p.id) && r.out.includes(SOCKET) && r.out.includes(WORK), r.out);
    ok(r.out.includes(SESSION_ID), 'the newest transcript was not the one resolved');
    ok(r.out.includes(FIRST) && r.out.includes(LAST), 'the two transcript lines were not echoed');
    ok(/no terminal here to confirm on/.test(r.out), r.out);
    ok(!fs.existsSync(stateDir(P.own)), 'a refusal built a state dir');
    ok(tmux('has-session', '-t', '=claude-jam').status !== 0, 'a refusal built a tmux session');
  });

  // ==================================================================== adopting ====
  await step('S6 ADOPT a pane on a socket this smoke made — and `sessions` says `adopted`', async () => {
    const p = makePane(S.pane);
    adopted = p;
    const r = jam('adopt', '--pane', p.id, '--socket', SOCKET, '--yes', '--port', String(P.own),
      '--token', TOKEN, '--no-popup', '--no-announce', '--no-attach');
    console.log(`      ${r.out.trim().split('\n').slice(-7).join('\n      ')}`);
    ok(r.code === 0, `adopt exited ${r.code}:\n${r.out}`);
    ok(/ADOPTED pane/.test(r.out), r.out);
    const info = JSON.parse(fs.readFileSync(path.join(stateDir(P.own), 'session.json'), 'utf8'));
    ok(info.adopt?.pane === p.id, `session.json does not name the pane: ${JSON.stringify(info.adopt)}`);
    ok(info.adopt.socket === SOCKET, JSON.stringify(info.adopt));
    ok(info.tmux !== S.pane, 'jam claimed the adopted session as its own tmux session');
    ok(info.sessionId === SESSION_ID, `wrong session id: ${info.sessionId}`);
    // The ownership marker is on jam's OWN session, and NOT on the adopted one — this is the
    // single most important assertion in this file. jam's own session lives on jam's own server
    // (`claude-jam-<port>`), which is a DIFFERENT socket from the adopted pane's: asking the
    // wrong one answers "no such session" and would have passed this check for the wrong reason.
    const otmux = (...a) => spawnSync(TMUX, ['-L', info.socket, ...a], { encoding: 'utf8' });
    ok(info.socket !== SOCKET, `jam put its own session on the adopted server: ${info.socket}`);
    const mine = otmux('show-options', '-t', info.tmux, '-v', '@claude-jam-owned');
    ok(mine.status === 0 && mine.stdout.trim() === info.state, `own marker: ${mine.stdout}${mine.stderr}`);
    const theirs = tmux('show-options', '-t', S.pane, '-v', '@claude-jam-owned');
    ok(!(theirs.stdout || '').trim(), `claude-jam stamped a marker on the adopted session: ${theirs.stdout}`);
    // And no option of any kind was written on the adopted session's status line.
    const status = tmux('show-options', '-t', S.pane, 'status-right');
    ok(!/back to claude-jam|waiting/.test(status.stdout || ''), `status-right was written: ${status.stdout}`);
    // Nor a bare F3 on that server, which would be everybody's F3.
    const bind = tmux('list-keys', '-T', 'root');
    ok(!/\bF3\b/.test(bind.stdout || ''), 'claude-jam bound F3 on a server it does not own');

    const row = jamJson().find((x) => x.port === P.own);
    ok(row?.state === 'adopted', `state is ${row?.state}`);
    ok(row.adopted === true && row.adopt.pane === p.id, JSON.stringify(row.adopt));
    ok(row.cleanable === false, 'a running adopted jam must never be cleanable');
    const table = jam('sessions').out;
    ok(/adopted/.test(table), table);
    ok(table.includes(`attach -t ${p.id}`), `the raw-TUI line does not name the adopted pane:\n${table}`);
  });

  await step('S6b the BRIEFING lands in the adopted pane, whole, as the tool and not as a person', async () => {
    // The half an adopted claude cannot be given any other way: it started before claude-jam
    // existed for it, so its --settings and its system prompt are already read and closed.
    const brief = await until('the briefing in the adopted pane',
      () => submitted().find((s) => s.startsWith(`[${BRIEF_NAME}]: `)), 40000);
    // The prefix is the mechanism, not a label: NAME_RE has no colon, so no participant can ever
    // hold that name and no guest's own text can carry that prefix.
    ok(!validName(BRIEF_NAME), 'a guest could join under the tool\'s own name');
    // The whole contract arrived, not a truncated paste of it.
    for (const line of ['TWO RULES THAT MUST NOT DECAY', 'NEVER reveal the join token',
      'NEVER claim to have seen human-only chat', 'WHO IS TALKING']) {
      ok(brief.includes(line), `the briefing lost "${line}"`);
    }
    ok(/reads this screen/.test(brief), 'the briefing did not say why there are no hooks');
    ok(brief.includes(path.join(ROOT, 'MANUAL.md')), 'the briefing did not point at the manual');
    console.log(`      briefing: ${brief.length} chars, ${brief.split('\n').length} lines, `
      + `starts ${JSON.stringify(brief.slice(0, 60))}`);
    // And it is NOT in the outbox: it is regenerated whenever it is needed, so keeping it would
    // put a page of protocol under somebody's `/retry`.
    const outbox = path.join(stateDir(P.own), 'outbox');
    const kept = fs.existsSync(outbox) ? fs.readdirSync(outbox) : [];
    ok(!kept.some((f) => f.includes('claude-jam')), `the briefing was kept: ${kept.join(', ')}`);
  });

  await step('S7 a guest sees the REAL adopted pane, and their message lands in it whole', async () => {
    const g = connect(P.own, 'Guest');
    const welcome = await g.ready.then(() => g.events.find((e) => e.t === 'welcome'));
    // Everybody is told this jam was adopted, and that claude WAS told — the client turns both
    // into the two lines a participant needs before they type anything.
    ok(welcome.session.adopted === true, JSON.stringify(welcome.session));
    ok(welcome.session.noBrief === false, 'noBrief is true on a jam that briefed');
    g.send({ t: 'mirror', on: true });
    const frame = await g.waitFor('a mirror frame of the adopted pane',
      (e) => e.t === 'screen' && e.rows.some((r) => /\[fake-tui\]/.test(r)), 20000);
    ok(frame.rows.some((r) => /❯/.test(r)), frame.rows.slice(-6).join('\n'));
    console.log(`      mirror: ${frame.rows.filter(Boolean).slice(-3).join(' | ')}`);
    const before = submitted().length;
    const said = 'does the adopted pane get this whole message, every word of it?';
    g.send({ t: 'say', text: said });
    const got = await until('the message in the adopted pane', () => {
      const all = submitted();
      return all.length > before ? all[all.length - 1] : null;
    }, 30000);
    ok(got === `[Guest]: ${said}`, `the pane got ${JSON.stringify(got)}`);
    g.ws.close();
  });

  await step('S8 REFUSAL the same pane is never adopted twice', async () => {
    const r = jam('adopt', '--pane', adopted.id, '--socket', SOCKET, '--yes', '--port', String(P.dflt));
    ok(r.code === 1, `expected exit 1, got ${r.code}`);
    ok(/already being shared by a jam on :7921/.test(r.out), r.out);
    ok(/the pane and claude are left alone/.test(r.out), r.out);
    ok(!fs.existsSync(stateDir(P.dflt)), 'the refusal built a second state dir');
  });

  await step('S9 `claude-jam clean` removes nothing while an adopted jam is running', async () => {
    const r = jam('clean', '--yes');
    console.log(`      ${r.out.trim().split('\n')[0]}`);
    ok(/nothing to clean/.test(r.out), r.out);
    ok(fs.existsSync(stateDir(P.own)), 'clean took a live adopted jam\'s state dir');
    ok(tmux('has-session', '-t', `=${S.pane}`).status === 0, 'clean touched the adopted session');
  });

  await step('S10 REFUSAL a jam of claude-jam\'s OWN is not adopted — --attach is the way back', async () => {
    const born = spawnSync(process.execPath, [HOST_MJS, '--tmux', S.jam, '--port', String(P.jam),
      '--view-port', String(P.jam + 1), '--name', 'Host', '--token', TOKEN, '--cwd', WORK,
      '--tmux-socket', SOCKET, '--no-attach', '--no-popup', '--no-announce'],
    { encoding: 'utf8', env: ENV });
    ok(born.status === 0, `could not build a real jam: ${born.stdout}${born.stderr}`);
    const id = (tmux('list-panes', '-t', `${S.jam}:claude`, '-F', '#{pane_id}').stdout || '').trim().split('\n')[0];
    ok(/^%\d+$/.test(id), `no claude pane in the real jam: ${JSON.stringify(id)}`);
    const r = jam('adopt', '--pane', id, '--socket', SOCKET, '--yes', '--port', String(P.dflt));
    ok(r.code === 1, `expected exit 1, got ${r.code}`);
    ok(/already a jam of claude-jam's own/.test(r.out), r.out);
    ok(/claude-jam host --attach/.test(r.out), r.out);
    const gone = jam('end', S.jam);
    ok(gone.code === 0, gone.out);
  });

  // ====================================================== the rule that matters ====
  await step('S11 END takes the daemon and NOTHING of the adopted session', async () => {
    const info = JSON.parse(fs.readFileSync(path.join(stateDir(P.own), 'session.json'), 'utf8'));
    const panePidBefore = Number((tmux('display-message', '-p', '-t', adopted.id, '#{pane_pid}').stdout || '').trim());
    ok(running(panePidBefore), 'the adopted pane was not running before the end');
    const r = jam('end', info.tmux);
    console.log(`      ${r.out.trim().split('\n').join('\n      ')}`);
    ok(r.code === 0, r.out);
    ok(/ADOPTED pane/.test(r.out), 'the end did not say what it was leaving alone');
    // claude-jam's own half is gone…
    ok(tmux('has-session', '-t', `=${info.tmux}`).status !== 0, 'jam\'s own tmux session survived');
    ok(!fs.existsSync(stateDir(P.own)), 'the state dir survived');
    // …and the adopted half is untouched, down to the pid of the process in it.
    ok(tmux('has-session', '-t', `=${S.pane}`).status === 0, 'THE ADOPTED SESSION WAS KILLED');
    const after = Number((tmux('display-message', '-p', '-t', adopted.id, '#{pane_pid}').stdout || '').trim());
    ok(after === panePidBefore, `the pane's process changed: ${panePidBefore} → ${after}`);
    ok(running(after), 'the process in the adopted pane is gone');
    ok(/\[fake-tui\]/.test(paneOf(adopted.id)), 'the adopted pane is no longer drawing');
    console.log(`      adopted pane ${adopted.id} still running, same pid ${after}`);
  });

  await step(`S12 the DEFAULT tmux socket — one session (${S.dflt}), adopted and released`, async () => {
    // The case the feature exists for: the user's own tmux server, which is also the one
    // claude-jam must be most careful with. One session, created here, named uniquely.
    const p = makePane(S.dflt, dtmux);
    const before = submitted().length; // this one runs --no-brief: nothing may be typed at all
    const r = jam('adopt', '--pane', p.id, '--socket', 'default', '--yes', '--port', String(P.dflt),
      '--token', TOKEN, '--no-popup', '--no-announce', '--no-attach', '--no-brief');
    ok(r.code === 0, `adopt exited ${r.code}:\n${r.out}`);
    ok(/on tmux socket default/.test(r.out), r.out);
    const info = JSON.parse(fs.readFileSync(path.join(stateDir(P.dflt), 'session.json'), 'utf8'));
    ok(info.adopt?.socket === 'default' && info.adopt.pane === p.id, JSON.stringify(info.adopt));
    // Nothing was written on the default server: no marker on the session, no root F3 binding.
    const marker = dtmux('show-options', '-t', S.dflt, '-v', '@claude-jam-owned');
    ok(!(marker.stdout || '').trim(), `a marker was stamped on the default server: ${marker.stdout}`);
    const g = connect(P.dflt, 'Guest2');
    const welcome = await g.ready.then(() => g.events.find((e) => e.t === 'welcome'));
    // This one was adopted with --no-brief, so every client has to SAY that claude does not know
    // it is shared — an agent that has not been told may answer a participant as if it were the
    // host, which is what the two standing rules exist to prevent.
    ok(welcome.session.adopted === true && welcome.session.noBrief === true, JSON.stringify(welcome.session));
    g.send({ t: 'mirror', on: true });
    await g.waitFor('a mirror frame off the default socket',
      (e) => e.t === 'screen' && e.rows.some((row) => /\[fake-tui\]/.test(row)), 20000);
    g.ws.close();
    ok(!submitted().slice(before).some((s) => s.startsWith(`[${BRIEF_NAME}]: `)),
      '--no-brief injected a briefing anyway');
    const pidBefore = Number((dtmux('display-message', '-p', '-t', p.id, '#{pane_pid}').stdout || '').trim());
    const gone = jam('end', info.tmux);
    ok(gone.code === 0, gone.out);
    ok(dtmux('has-session', '-t', `=${S.dflt}`).status === 0, 'THE SESSION ON THE DEFAULT SOCKET WAS KILLED');
    const pidAfter = Number((dtmux('display-message', '-p', '-t', p.id, '#{pane_pid}').stdout || '').trim());
    ok(pidAfter === pidBefore && running(pidAfter), `pid changed: ${pidBefore} → ${pidAfter}`);
    console.log(`      ${S.dflt} on the default socket survived, same pid ${pidAfter}`);
  });
} finally {
  // Any jam of this run's own that is still up, by the name its own session.json records — never
  // a sweep, never `--all`, and never `kill-server`, on any socket, for any reason.
  for (const port of Object.values(P)) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(stateDir(port), 'session.json'), 'utf8'));
      if (info?.tmux) jam('end', info.tmux);
    } catch { /* no such jam, which is the normal case by the time we get here */ }
  }
  // Then the sessions this script created itself: exact names, one command each, on the socket
  // each one was made on. S.dflt lives on the DEFAULT server, which is why its name is random.
  killMine(S.pane);
  killMine(S.jam);
  killMine(S.dflt, dtmux);
  for (const d of [TMP, HOME, BIN, WORK, BARE]) fs.rmSync(d, { recursive: true, force: true });
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(failed ? `\n--- RESULT --- ${failed} step(s) FAILED in ${secs}s`
    : `\n--- RESULT --- all steps passed in ${secs}s`);
  process.exit(failed ? 1 : 0);
}
