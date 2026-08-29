#!/usr/bin/env node
// v0.17 Batch H + F smoke: what a guest joining a RESUMED session actually sees.
//   H1  a daemon started with --resume seeds `history` from the transcript already on disk, so
//       the first guest gets a full backlog instead of a blank room — and nothing seeded is
//       broadcast a second time by the tail
//   H1  --replay N keeps the newest N events and nothing else
//   H2  the client prints `── history above (N replayed) · live from here ──` under the replay
//   F1  an Edit call reaches that guest as a real diff (path + -/+ lines), and folds into the
//       existing `⚙ N tools (…)` collapse instead of flooding the transcript
//   F2  /files lists the paths the session touched, newest first, with counts
//   F3  /diff is git's own answer: --stat by default, hunks for one path, a clean refusal
//       outside a repo, and a path that would be a git option refused
//   F4  a planted fake AWS key comes out masked in a tool argument, in a mirror row and in a
//       /diff of the file that contains it
//
// Self-contained, like smoke-transport: it builds its own config dir, its own git repo, its own
// fake `claude` window and its own daemons, and kills only what it created. It runs NO real
// claude — the daemon is started directly with --daemon — so nothing here can touch a live jam.
//   usage: node scripts/smoke-replay.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOST_MJS = path.join(ROOT, 'host.mjs');
const CLIENT_MJS = path.join(ROOT, 'client.mjs');
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
// v0.20: jam runs its own tmux server, so the stand-in `claude` window and both daemons have to
// agree on which one. One socket of this smoke's own, passed to each daemon as --tmux-socket.
const SOCKET = 'jamreplaysock';
const TOKEN = 'replaysmoketoken';
// Ports and session names of this smoke's own: clear of jam's 7777, the shared smokes' 7799/7801
// and smoke-transport's 7811-7819.
const P = { main: 7823, capped: 7825 };
const PANE_SESSION = 'jamreplaypane'; // the fake `claude` window the daemon mirrors
const GUEST_SESSION = 'jamreplayguest'; // the real ink client under test
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
// A fake AWS key id, in the shape AWS documents, planted in three places on purpose.
const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => spawnSync(TMUX, ['-L', SOCKET, ...a], { encoding: 'utf8' });
const pane = (t) => (tmux('capture-pane', '-p', '-t', t).stdout || '').replace(/\n+$/, '');
const back = (t) => (tmux('capture-pane', '-p', '-S', '-600', '-t', t).stdout || '').replace(/\n+$/, '');
const rows = (t) => pane(t).split('\n');
const type = (s) => tmux('send-keys', '-t', GUEST_SESSION, '-l', s);
const key = (...k) => tmux('send-keys', '-t', GUEST_SESSION, ...k);
const line = (s) => { type(s); key('Enter'); };
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
async function until(what, pred, ms = 20000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const v = await pred();
    if (v) return v;
    await sleep(120);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}
const show = (label, target) => {
  console.log(`\n----- ${label} (${target}) -----`);
  console.log(pane(target));
  console.log('-----------------------------------------------------------------');
};

// ------------------------------------------------------------------ the fixtures ----
const tmpDirs = [];
const mktmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `jam-replay-${tag}-`)); tmpDirs.push(d); return d; };

// A transcript claude could have written: a host turn, agent text, a Read, an Edit (the diff F1
// renders), a Bash call carrying the planted key, a bridged `[Dana]:` line, and a closing reply.
function plantTranscript(cfgDir, repo) {
  const dir = path.join(cfgDir, 'projects', 'jam-replay-smoke');
  fs.mkdirSync(dir, { recursive: true });
  const user = (content) => JSON.stringify({ type: 'user', message: { content } });
  const asst = (content) => JSON.stringify({ type: 'assistant', message: { content } });
  const lines = [
    user('read notes.md and fix the typo in it'),
    asst([{ type: 'text', text: 'reading it now' }]),
    asst([{ type: 'tool_use', name: 'Read', input: { file_path: path.join(repo, 'notes.md') } }]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'jam notes\nteh typo is here' }]),
    asst([{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(repo, 'notes.md'), old_string: 'teh typo is here', new_string: 'the typo is here' } }]),
    user([{ type: 'tool_result', tool_use_id: 't2', content: 'applied 1 edit' }]),
    asst([{ type: 'tool_use', name: 'Bash', input: { command: `grep -rn ${FAKE_KEY} .` } }]),
    user('[Dana]: nice, ship it'),
    asst([{ type: 'text', text: 'done — one typo fixed' }]),
  ];
  const file = path.join(dir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

// A real git repo with a real working-tree change, so /diff has something true to report — and
// one of the changed lines is the planted key, so the mask has to catch it there too.
function plantRepo() {
  const repo = mktmp('repo');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'jam notes\nteh typo is here\n');
  fs.writeFileSync(path.join(repo, 'config.env'), 'PORT=7777\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'smoke@example.com');
  git(repo, 'config', 'user.name', 'Replay Smoke');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  // …then the change the session made, uncommitted, which is exactly what `git diff` shows.
  fs.writeFileSync(path.join(repo, 'notes.md'), 'jam notes\nthe typo is here\n');
  fs.writeFileSync(path.join(repo, 'config.env'), `PORT=7777\nAWS_SECRET_ACCESS_KEY=${FAKE_KEY}\n`);
  return repo;
}

// --------------------------------------------------------------- daemons and peers ----
const daemons = [];
async function daemon(name, extra = []) {
  const state = mktmp(`state-${name}`);
  const child = spawn(process.execPath, [HOST_MJS, '--daemon',
    '--name', 'Host', '--token', TOKEN, '--hook-secret', 'replaysmokesecret',
    '--state', state, '--no-popup', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  const d = { name, child, out: '', exited: null };
  const eat = (c) => { d.out += c; };
  child.stdout.on('data', eat);
  child.stderr.on('data', eat);
  child.on('exit', (code) => { d.exited = code; });
  d.waitLog = (re, ms = 20000) => until(`${name} to log ${re}`, () => re.exec(d.out), ms);
  d.stop = async () => {
    if (d.exited == null) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    await until(`${name} to exit`, () => d.exited != null, 8000).catch(() => child.kill('SIGKILL'));
  };
  daemons.push(d);
  await d.waitLog(/claude-jam daemon on /, 20000);
  return d;
}

function peer(url, name, hello = {}) {
  const p = { frames: [], screens: [], closed: null };
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', name, token: TOKEN, ...hello })));
  ws.addEventListener('message', (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.t === 'screen') p.screens.push(ev); else p.frames.push(ev);
  });
  ws.addEventListener('close', (e) => { p.closed = e.code; });
  ws.addEventListener('error', () => { /* the assertions carry the verdict */ });
  p.send = (o) => ws.send(JSON.stringify(o));
  p.close = () => ws.close();
  p.want = (what, pred, ms = 20000) => until(what, () => p.frames.find(pred), ms);
  return p;
}

const cfg = mktmp('cfg');
const repo = plantRepo();
const jsonl = plantTranscript(cfg, repo);
console.log(`planted ${jsonl} (${fs.statSync(jsonl).size} bytes) · repo ${repo}`);

// A stand-in for the claude window: the daemon only ever captures it, and this smoke never
// injects anything, so a shell holding a screen with the planted key on it is the whole job.
tmux('kill-session', '-t', PANE_SESSION); // a leftover from an interrupted run, exact name only
const bornPane = tmux('new-session', '-d', '-s', PANE_SESSION, '-x', '100', '-y', '30', '-n', 'claude',
  'sh', '-c', `printf '%s\\n' 'jam replay smoke pane' '$ echo ${FAKE_KEY}' '${FAKE_KEY}' '❯ '; exec sleep 600`);
if (bornPane.status !== 0) { console.error(`tmux: ${bornPane.stderr}`); process.exit(1); }

const main = await daemon('main', ['--port', String(P.main), '--resume', SESSION_ID,
  '--config-dir', cfg, '--cwd', repo, '--tmux', PANE_SESSION, '--tmux-socket', SOCKET]);

let history = [];
const guest = peer(`ws://127.0.0.1:${P.main}`, 'Guest');

try {
  await step('H1 the daemon seeds history from the resumed transcript before anyone connects', async () => {
    const seeded = await main.waitLog(/\[replay\] (\d+) of (\d+) event\(s\) seeded from (\S+) \(--replay (\d+)\), (\d+) file\(s\) touched, tailing from byte (\d+)/);
    console.log(`      ${seeded[0].trim()}`);
    if (Number(seeded[1]) !== 9) throw new Error(`seeded ${seeded[1]} events, expected 9`);
    // findJsonl realpaths its hit (a --config-dir whose projects/ is a symlink has to settle on
    // one identity), and on macOS /var is itself a symlink to /private/var.
    if (seeded[3] !== fs.realpathSync(jsonl)) throw new Error(`seeded from ${seeded[3]}`);
    if (Number(seeded[5]) !== 1) throw new Error(`${seeded[5]} files touched, expected 1 (notes.md)`);
    if (Number(seeded[6]) !== fs.statSync(jsonl).size) throw new Error(`tail starts at ${seeded[6]}, not EOF`);
  });

  await step('H1 a guest joining that session gets the whole backlog in its welcome', async () => {
    const w = await guest.want('welcome', (f) => f.t === 'welcome');
    history = w.history || [];
    if (!history.length) throw new Error('welcome.history is empty — the blank room is back');
    console.log(`      ${history.length} event(s) replayed to the guest:`);
    for (const h of history) {
      console.log(`        ${h.t}${h.kind ? `/${h.kind}` : ''}${h.from ? ` [${h.from}]` : ''}: `
        + JSON.stringify(String(h.text || '').split('\n')[0].slice(0, 58)));
    }
    // The host's own turn, an agent reply, and the bridged line with its author kept and the
    // `[Dana]: ` prefix gone — the same shapes a live broadcast would have carried.
    const first = history[0];
    if (!(first.t === 'say' && first.from === 'Host' && /read notes.md/.test(first.text))) {
      throw new Error(`first event is ${JSON.stringify(first)}`);
    }
    const dana = history.find((h) => h.t === 'say' && h.from === 'Dana');
    if (!dana) throw new Error('the bridged [Dana] line lost its author');
    if (/^\[Dana\]/.test(dana.text)) throw new Error(`the prefix survived: ${JSON.stringify(dana.text)}`);
    if (!history.some((h) => h.t === 'agent' && h.kind === 'text' && /one typo fixed/.test(h.text))) {
      throw new Error('the closing agent reply is missing');
    }
    if (!history.some((h) => h.kind === 'tool-result' && /applied 1 edit/.test(h.text))) {
      throw new Error('the tool results are missing');
    }
    // Every event carries an id, which is what lets a client dedupe a reconnect's replay.
    if (!history.every((h) => Number.isInteger(h.id) && h.ts > 0)) throw new Error('a seeded event has no id/ts');
  });

  await step('H1 nothing seeded is broadcast a second time by the tail', async () => {
    const before = guest.frames.filter((f) => f.t === 'say' || f.t === 'agent').length;
    await sleep(2000); // ~6 tail polls at 300 ms over the very file that was seeded
    const after = guest.frames.filter((f) => f.t === 'say' || f.t === 'agent').length;
    console.log(`      live say/agent frames after the welcome: ${after - before}`);
    if (after !== before) throw new Error(`${after - before} seeded event(s) were re-broadcast`);
  });

  await step('F1 the Edit call reached the guest as a real diff, not truncated JSON', async () => {
    const edit = history.find((h) => h.kind === 'tool' && /^Edit: /.test(h.text));
    if (!edit) throw new Error('no Edit tool line in the replay');
    console.log(`      ${JSON.stringify(edit.text)}`);
    const [head, ...body] = edit.text.split('\n');
    if (head !== `Edit: ${path.join(repo, 'notes.md')}`) throw new Error(`header is ${JSON.stringify(head)}`);
    if (!body.includes('- teh typo is here')) throw new Error('no - line');
    if (!body.includes('+ the typo is here')) throw new Error('no + line');
    if (/old_string/.test(edit.text)) throw new Error('this is still the raw JSON summary');
  });

  await step('F4 the planted AWS key is masked in the tool argument that carried it', async () => {
    const bash = history.find((h) => h.kind === 'tool' && /^Bash: /.test(h.text));
    console.log(`      ${JSON.stringify(bash.text)}`);
    if (bash.text.includes(FAKE_KEY)) throw new Error('the key went out verbatim');
    if (!bash.text.includes('[masked]')) throw new Error('nothing was masked');
    // And nowhere else in the whole replay either.
    if (JSON.stringify(history).includes(FAKE_KEY)) throw new Error('the key survived somewhere in history');
  });

  await step('F4 a mirror row carrying the key is masked before it leaves the daemon', async () => {
    guest.send({ t: 'mirror', on: true });
    const hit = await until('a frame with the masked row', () => guest.screens.find((s) => (s.rows || []).some((r) => /\[masked\]/.test(r))), 15000);
    const row = hit.rows.find((r) => /\[masked\]/.test(r));
    console.log(`      row: ${JSON.stringify(row.replace(/\x1b\[[0-9;]*m/g, '').trim())}`);
    for (const f of guest.screens) {
      if ((f.rows || []).some((r) => r.includes(FAKE_KEY))) throw new Error('a frame carried the raw key');
    }
    guest.send({ t: 'mirror', on: false });
  });

  await step('F2 /files lists what the session touched, newest first, counted', async () => {
    guest.send({ t: 'files' });
    const rep = await guest.want('the /files answer', (f) => f.t === 'sys' && /file\(s\) touched this session/.test(f.text));
    for (const l of rep.text.split('\n')) console.log(`      ${l}`);
    if (!/×2 {2}notes\.md/.test(rep.text)) throw new Error('notes.md should be there twice (Read + Edit), shortened against the cwd');
    if (/config\.env/.test(rep.text)) throw new Error('config.env was never touched by a tool call');
  });

  await step('F3 /diff is git\'s own --stat, broadcast to everybody', async () => {
    guest.send({ t: 'diff' });
    const ev = await guest.want('the /diff broadcast', (f) => f.t === 'sys' && /ran \/diff:/.test(f.text));
    for (const l of ev.text.split('\n')) console.log(`      ${l}`);
    if (!/^Guest ran \/diff:/.test(ev.text)) throw new Error(`unexpected header: ${ev.text.split('\n')[0]}`);
    if (!/notes\.md/.test(ev.text) || !/config\.env/.test(ev.text)) throw new Error('the --stat lost a changed file');
    if (!/2 files changed/.test(ev.text)) throw new Error('this does not look like git diff --stat output');
  });

  await step('F3+F4 /diff <path> gives the real hunks, with the key in them masked', async () => {
    guest.send({ t: 'diff', path: 'notes.md' });
    const hunk = await guest.want('the notes.md hunk', (f) => f.t === 'sys' && /ran \/diff notes\.md:/.test(f.text));
    for (const l of hunk.text.split('\n')) console.log(`      ${l}`);
    if (!/^-teh typo is here$/m.test(hunk.text) || !/^\+the typo is here$/m.test(hunk.text)) {
      throw new Error('the hunk lines are missing');
    }
    guest.send({ t: 'diff', path: 'config.env' });
    const env = await guest.want('the config.env hunk', (f) => f.t === 'sys' && /ran \/diff config\.env:/.test(f.text));
    for (const l of env.text.split('\n')) console.log(`      ${l}`);
    if (env.text.includes(FAKE_KEY)) throw new Error('the key went out inside a diff');
    if (!/AWS_SECRET_ACCESS_KEY=\[masked\]/.test(env.text)) throw new Error('the .env line was not masked');
  });

  await step('F3 a path that would be a git option is refused, and so is a path with no changes', async () => {
    guest.send({ t: 'diff', path: '--output=/tmp/jam-replay-pwned' });
    const e = await guest.want('the refusal', (f) => f.t === 'error' && /git option/.test(f.text));
    console.log(`      ${JSON.stringify(e.text)}`);
    if (fs.existsSync('/tmp/jam-replay-pwned')) throw new Error('git wrote a file for a "path" argument');
    guest.send({ t: 'diff', path: 'no-such-file.md' });
    const none = await guest.want('the empty answer', (f) => f.t === 'error' && /no unstaged changes in no-such-file\.md/.test(f.text));
    console.log(`      ${JSON.stringify(none.text)}`);
  });

  // ------------------------------------------------------ the real client, on a pty ----
  await step('H2 a real client shows the backlog, the divider, and the collapsed tool summary', async () => {
    tmux('kill-session', '-t', GUEST_SESSION); // exact name, only this script's own
    const born = tmux('new-session', '-d', '-s', GUEST_SESSION, '-x', '120', '-y', '40',
      process.execPath, CLIENT_MJS, `ws://127.0.0.1:${P.main}`, '--name', 'Dana', '--token', TOKEN);
    if (born.status !== 0) throw new Error(`tmux: ${born.stderr}`);
    const all = await until('the divider under the replay', () => {
      const b = back(GUEST_SESSION);
      return /history above \(\d+ replayed\) · live from here/.test(b) ? b.split('\n') : null;
    }, 25000);
    const i = all.findIndex((l) => /history above/.test(l));
    console.log(`      row ${i}: ${JSON.stringify(all[i].trim())}`);
    // The backlog is ABOVE it and the roster line below: that is what the divider claims.
    const said = all.findIndex((l) => /read notes.md and fix the typo/.test(l));
    const here = all.findIndex((l) => /here: /.test(l));
    if (!(said >= 0 && said < i)) throw new Error(`the replayed message is at row ${said}, divider at ${i}`);
    if (!(here > i)) throw new Error(`the roster line is at row ${here}, divider at ${i}`);
    // F1's collapse: three replayed tool calls are one summary line, not thirty diff rows.
    const summary = all.find((l) => /⚙ 3 tools \(/.test(l));
    if (!summary) throw new Error('the replayed tool calls did not collapse into one summary');
    console.log(`      ${JSON.stringify(summary.trim())}`);
    if (all.slice(i).some((l) => /^\s*[-+] (teh|the) typo/.test(l))) throw new Error('diff rows landed below the divider');
  });

  await step('F4 the client\'s default mirror view shows the masked row, never the key', async () => {
    const r = await until('the mirrored pane', () => (rows(GUEST_SESSION).some((l) => /jam replay smoke pane/.test(l)) ? rows(GUEST_SESSION) : null), 15000);
    show('Dana — the live TUI view, mirroring the planted pane', GUEST_SESSION);
    if (!r.some((l) => /\[masked\]/.test(l))) throw new Error('no masked row on screen');
    if (back(GUEST_SESSION).includes(FAKE_KEY)) throw new Error('the raw key is on the guest\'s screen');
    console.log(`      masked row on screen: ${JSON.stringify(r.find((l) => /\[masked\]/.test(l)).trim())}`);
  });

  await step('F1 /tools reprints the replayed turn in full — the Edit as a real diff on screen', async () => {
    key('F2'); // the transcript view, where a multi-line answer is readable
    await until('the transcript chip', () => /≡ transcript/.test(pane(GUEST_SESSION)), 10000);
    line('/tools');
    const p = await until('the reprinted tool log', () => (/last turn's tools \(3\)/.test(back(GUEST_SESSION)) ? back(GUEST_SESSION) : null), 10000);
    const all = p.split('\n');
    const head = all.findIndex((l) => /⚙ Edit: /.test(l));
    if (head < 0) throw new Error('no ⚙ Edit line came back');
    console.log(`      ${all.slice(head, head + 3).map((l) => JSON.stringify(l.trim())).join('\n      ')}`);
    if (!all.some((l) => /^\s*- teh typo is here$/.test(l))) throw new Error('the - line is not on screen');
    if (!all.some((l) => /^\s*\+ the typo is here$/.test(l))) throw new Error('the + line is not on screen');
  });

  await step('F2/F3 /files and /diff render in the client too', async () => {
    line('/files');
    const f = await until('the /files rows', () => (/file\(s\) touched this session/.test(pane(GUEST_SESSION)) ? rows(GUEST_SESSION) : null), 10000);
    for (const l of f.filter((l) => /touched this session|×\d/.test(l))) console.log(`      ${l.trim()}`);
    line('/diff');
    const d = await until('the /diff rows', () => (/ran \/diff:/.test(pane(GUEST_SESSION)) ? rows(GUEST_SESSION) : null), 15000);
    for (const l of d.filter((l) => /ran \/diff|notes\.md|config\.env|files changed/.test(l))) console.log(`      ${l.trim()}`);
    show('Dana — transcript view after /tools, /files and /diff', GUEST_SESSION);
  });
} finally {
  tmux('kill-session', '-t', GUEST_SESSION); // exact names, only what this script created
}

// ------------------------------------------------- a second daemon: the cap and no repo ----
{
  const nonRepo = mktmp('norepo');
  const d = await daemon('capped', ['--port', String(P.capped), '--resume', SESSION_ID,
    '--config-dir', cfg, '--cwd', nonRepo, '--tmux', PANE_SESSION, '--tmux-socket', SOCKET, '--replay', '2']);
  const p = peer(`ws://127.0.0.1:${P.capped}`, 'Capped');

  await step('H1 --replay 2 keeps the NEWEST two events and nothing else', async () => {
    const w = await p.want('welcome', (f) => f.t === 'welcome');
    const h = w.history || [];
    console.log(`      ${h.length} event(s): ${h.map((e) => `${e.t}${e.kind ? `/${e.kind}` : ''}`).join(', ')}`);
    if (h.length !== 2) throw new Error(`${h.length} events, expected 2`);
    if (!(h[0].t === 'say' && h[0].from === 'Dana')) throw new Error(`first kept event is ${JSON.stringify(h[0])}`);
    if (!/one typo fixed/.test(h[1].text)) throw new Error(`last kept event is ${JSON.stringify(h[1])}`);
    await d.waitLog(/\[replay\] 2 of 9 event\(s\) seeded/);
  });

  await step('F3 /diff outside a git repository degrades cleanly instead of throwing', async () => {
    p.send({ t: 'diff' });
    const e = await p.want('the refusal', (f) => f.t === 'error' && /not inside a git repository/.test(f.text));
    console.log(`      ${JSON.stringify(e.text)}`);
  });

  await step('F2 /files on a session whose files were all seeded still answers', async () => {
    p.send({ t: 'files' });
    const rep = await p.want('the /files answer', (f) => f.t === 'sys' && /file\(s\) touched/.test(f.text));
    console.log(`      ${rep.text.split('\n').join(' | ')}`);
    // --replay caps the EVENTS a guest sees, never the file set: the whole transcript was parsed.
    if (!/notes\.md/.test(rep.text)) throw new Error('the file set was capped along with the events');
  });

  p.close();
  await d.stop();
}

guest.close();
for (const d of daemons) await d.stop().catch(() => { /* already down */ });
tmux('kill-session', '-t', PANE_SESSION); // exact name, only what this script created
for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'}`);
process.exit(failed ? 1 : 0);
