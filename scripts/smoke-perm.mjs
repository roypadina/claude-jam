#!/usr/bin/env node
// v0.17 Batch P smoke: the permission relay, against a REAL claude and a REAL permission prompt.
//   P2  `/answer` with nothing waiting is refused
//   P2  a real prompt is driven into existence, and the daemon reads its numbered options off the
//       pane and shows them to the guest who asked — with no host round trip, because looking is
//       not acting
//   P2  an out-of-range digit is refused, and an unparseable one, and nothing reaches the pane
//   P2  a guest's request → the host DENIES → the prompt is still up and nothing was typed
//   P2  a guest's request → the host ALLOWS → the digit is typed, the prompt is answered, and
//       claude proceeds (the file the command was for exists)
//   P2  raw {t:'key'} from that same guest is still refused — the relay opened no passthrough
//   P3  a mention reaches a real client as a \x07 byte on its stdout, and a non-mention does not
//
// Self-contained, like smoke-transport and smoke-replay: its own port, its own tmux sessions, its
// own temp cwd, and it kills only what it created.
//
// It needs a claude that actually ASKS. The host's own settings may well say
// `"defaultMode": "bypassPermissions"` (mine does), in which case nothing ever prompts — so the
// claude window is started with `--permission-mode manual`, which beats the settings file. If the
// prompt never appears the smoke says exactly that instead of hanging.
//   usage: node scripts/smoke-perm.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaude, parsePermOptions, hostKeyPath, stateDirFor } from '../lib.mjs';
import { readHostKey } from '../platform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOST_MJS = path.join(ROOT, 'host.mjs');
const CLIENT_MJS = path.join(ROOT, 'client.mjs');
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
const TOKEN = 'permsmoketoken';
const PORT = 7831; // clear of jam's 7777, the shared smokes' 7799/7801, transport's 7811+, replay's 7823+
// v0.20: jam names its tmux socket after its port, so the launcher below and every call here land
// on the same server — including the driver session, which is this smoke's own.
const SOCKET = `claude-jam-${PORT}`;
const DRIVE = 'jampermdrive'; // holds the launcher, exactly as the documented recipe does
const SESSION = 'jampermtest'; // the jam session the launcher builds (windows: daemon, claude)
const TARGET = path.join(os.tmpdir(), `jam-perm-smoke-${process.pid}.txt`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => spawnSync(TMUX, ['-L', SOCKET, ...a], { encoding: 'utf8' });
const pane = (t) => (tmux('capture-pane', '-p', '-t', t).stdout || '').replace(/\n+$/, '');
const log = (t) => (tmux('capture-pane', '-p', '-S', '-600', '-t', t).stdout || '');

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
async function until(what, pred, ms = 25000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const v = await pred();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}
const show = (label, target) => {
  console.log(`\n----- ${label} (${target}) -----`);
  console.log(pane(target));
  console.log('-----------------------------------------------------------------');
};

function peer(name, hello = {}) {
  const p = { frames: [], screens: [], closed: null };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
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
  p.want = (what, pred, ms = 25000) => until(what, () => p.frames.find(pred), ms);
  p.never = async (what, pred, ms = 3000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      const hit = p.frames.find(pred);
      if (hit) throw new Error(`${what}: ${JSON.stringify(hit).slice(0, 160)}`);
      await sleep(80);
    }
  };
  return p;
}

// ------------------------------------------------------------------- the fixture ----
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-perm-cwd-'));
const claude = resolveClaude(process.env, fs.existsSync);
fs.rmSync(TARGET, { force: true });
console.log(`claude: ${claude}\ncwd: ${cwd}\ntarget: ${TARGET}`);

for (const s of [SESSION, DRIVE]) tmux('kill-session', '-t', s); // leftovers of OUR OWN names only
const born = tmux('new-session', '-d', '-s', DRIVE, '-x', '120', '-y', '40', '-c', cwd,
  `${process.execPath} ${HOST_MJS} --tmux ${SESSION} --port ${PORT} --name Host --token ${TOKEN} `
  + `--hook-secret permsmokesecret --cwd ${cwd} --no-attach --claude ${claude} `
  + '-- --model haiku --permission-mode manual; sleep 900');
if (born.status !== 0) { console.error(`tmux: ${born.stderr}`); process.exit(1); }

// The peers cannot be built until the daemon is listening: a WebSocket refused at connect time
// does not retry, and every later step would time out on a socket that never opened.
await until('the daemon to answer /health', () => {
  const r = spawnSync('curl', ['-s', '-m', '1', `http://127.0.0.1:${PORT}/health`], { encoding: 'utf8' });
  return r.stdout?.includes('"ok"');
}, 30000).catch((e) => {
  console.error(`${e.message}\n--- the launcher said ---\n${pane(DRIVE)}`);
  for (const s of [SESSION, DRIVE]) tmux('kill-session', '-t', s);
  process.exit(1);
});

// v0.34: the launcher's jam runs in the ambient $TMPDIR, so its state dir is the usual one.
const host = peer('Host', { host: true, hostKey: readHostKey(hostKeyPath(stateDirFor(os.tmpdir(), PORT))) });
const guest = peer('Guest');
let bell = null;

try {
  await step('a loopback host and a token guest are both in', async () => {
    await host.want('welcome', (f) => f.t === 'welcome');
    await guest.want('welcome', (f) => f.t === 'welcome');
  });

  await step('P2 /answer with nothing waiting is refused, and nothing is typed', async () => {
    guest.send({ t: 'perm', choice: 1 });
    // v0.31 reworded this: `/answer` now answers a QUESTION as well as a permission, so the
    // refusal is about there being nothing on screen at all rather than about permissions.
    const e = await guest.want('the refusal', (f) => f.t === 'error' && /nothing is waiting for an answer/.test(f.text));
    console.log(`      ${JSON.stringify(e.text)}`);
    // Bare /answer is refused for the same reason: there is no prompt to describe.
    guest.send({ t: 'perm' });
    await guest.want('the refusal', (f) => f.t === 'error' && /nothing is waiting/.test(f.text));
  });

  await step('a guest asks claude to run a command that needs approval, and the prompt appears', async () => {
    guest.send({ t: 'say', text: `run this exact bash command and nothing else: touch ${TARGET}` });
    await guest.want('the message going out', (f) => f.t === 'say' && f.from === 'Guest');
    // The real gate: options the daemon can actually read off the claude window.
    const options = await until('a parseable permission prompt on the claude pane', () => {
      const got = parsePermOptions(pane(`${SESSION}:claude`));
      return got.length ? got : null;
    }, 90000).catch((e) => {
      throw new Error(`${e.message}. If the pane shows the command already ran, this claude is not `
        + 'asking: check that --permission-mode manual reached it (a settings file with '
        + '"defaultMode": "bypassPermissions", or --dangerously-skip-permissions, would explain it).');
    });
    show('the real permission prompt', `${SESSION}:claude`);
    for (const o of options) console.log(`      option ${o.n}${o.marked ? ' ❯' : '  '} ${JSON.stringify(o.text)}`);
    if (options.length < 2) throw new Error(`only ${options.length} option(s) parsed`);
    // And the daemon's own `waiting` flag, which is what gates the relay.
    const st = await until('status.waiting', () => [...guest.frames].reverse().find((f) => f.t === 'status' && f.waiting === true), 20000);
    console.log(`      status frame: ${JSON.stringify(st).slice(0, 90)}`);
  });

  await step('P2 the daemon shows the options to the guest who asked — no host round trip', async () => {
    const before = host.frames.length;
    guest.send({ t: 'perm' });
    const rep = await guest.want('the options', (f) => f.t === 'sys' && /waiting for an answer/.test(f.text));
    for (const l of rep.text.split('\n')) console.log(`      ${l}`);
    if (!/❯ 1\./.test(rep.text)) throw new Error('the highlighted option lost its marker');
    if (!/\/answer <number>/.test(rep.text)) throw new Error('the report does not say how to pick one');
    // Looking is not acting: the host was told nothing, and nobody else saw the report either.
    await host.never('the host was asked about a mere /answer', (f) => f.t === 'permreq', 1500);
    if (host.frames.length !== before) {
      const extra = host.frames.slice(before).map((f) => f.t).join(',');
      if (/permreq|sys/.test(extra)) throw new Error(`the host received ${extra}`);
    }
  });

  await step('P2 an out-of-range digit and an unparseable one are both refused', async () => {
    const seen = pane(`${SESSION}:claude`);
    guest.send({ t: 'perm', choice: 9 });
    const over = await guest.want('the out-of-range refusal', (f) => f.t === 'error' && /no option 9/.test(f.text));
    console.log(`      ${JSON.stringify(over.text)}`);
    guest.send({ t: 'perm', choice: 'a' });
    const junk = await guest.want('the unparseable refusal', (f) => f.t === 'error' && /not one of the numbered options/.test(f.text));
    console.log(`      ${JSON.stringify(junk.text)}`);
    // Neither reached the host as a request, and the prompt is untouched.
    await host.never('a refused digit reached the host', (f) => f.t === 'permreq', 1500);
    if (parsePermOptions(pane(`${SESSION}:claude`)).length !== parsePermOptions(seen).length) {
      throw new Error('the prompt changed under a refused digit');
    }
    if (fs.existsSync(TARGET)) throw new Error(`${TARGET} exists — a refused digit ran the command`);
  });

  await step('P2 the host DENIES: the prompt is still up and nothing was typed', async () => {
    guest.send({ t: 'perm', choice: 1 });
    const req = await host.want('permreq', (f) => f.t === 'permreq');
    console.log(`      permreq: ${JSON.stringify(req)}`);
    if (req.name !== 'Guest' || req.choice !== 1) throw new Error('the request lost who or what');
    if (!req.option) throw new Error('the request does not say which option the digit stands for');
    // The bar and the popup answer this exactly like any other request: it is in `pending`.
    const bar = await host.want('the pending frame', (f) => f.t === 'pending' && (f.items || []).some((i) => i.kind === 'permission'));
    console.log(`      pending: ${JSON.stringify(bar.items)}`);
    host.send({ t: 'permok', op: 'deny', name: 'Guest' });
    const no = await guest.want('the denial', (f) => f.t === 'error' && /answered the prompt themselves|nothing of yours was typed/.test(f.text));
    console.log(`      ${JSON.stringify(no.text)}`);
    await sleep(1200);
    if (!parsePermOptions(pane(`${SESSION}:claude`)).length) throw new Error('the prompt went away on a DENY');
    if (fs.existsSync(TARGET)) throw new Error(`${TARGET} exists — a denied answer ran the command`);
  });

  await step('P2 the host ALLOWS: the digit is typed, the prompt is answered, claude proceeds', async () => {
    guest.send({ t: 'perm', choice: 1 });
    await host.want('the second permreq', (f) => f.t === 'permreq' && f.choice === 1);
    host.send({ t: 'permok', op: 'allow', name: 'Guest' });
    const said = await guest.want('the broadcast', (f) => f.t === 'sys' && /answered the permission prompt/.test(f.text));
    console.log(`      ${JSON.stringify(said.text)}`);
    if (!/^Guest answered the permission prompt: 1\./.test(said.text)) throw new Error(`unexpected wording: ${said.text}`);
    if (!/approved by Host/.test(said.text)) throw new Error('the line does not name who approved it');
    // The prompt is gone…
    await until('the prompt to be answered', () => !parsePermOptions(pane(`${SESSION}:claude`)).length, 20000);
    // …and the command it was guarding actually ran, which is the whole point.
    await until(`${TARGET} to exist`, () => fs.existsSync(TARGET), 30000);
    console.log(`      ${TARGET} exists — claude proceeded`);
    show('the claude pane after the answer', `${SESSION}:claude`);
    const dlog = log(`${SESSION}:daemon`);
    // v0.31: the relay logs under `[answer]` now — it drives questions as well as permissions.
    const typed = /\[answer\] typed 1[^\n]*/.exec(dlog);
    console.log(`      daemon: ${typed ? typed[0] : '(no [answer] line in the visible log)'}`);
    if (!typed) throw new Error('the daemon never logged the keystroke');
    // waiting cleared, so the next /answer is refused again.
    await until('status.waiting to clear', () => [...guest.frames].reverse().find((f) => f.t === 'status')?.waiting === false, 20000);
  });

  await step('P2 the relay opened no raw passthrough: a guest\'s {t:key} is refused as ever', async () => {
    guest.send({ t: 'key', b64: Buffer.from('\x1b[Bqqq', 'utf8').toString('base64') });
    const e = await guest.want('the refusal', (f) => f.t === 'error' && /F3 TUI control/.test(f.text));
    console.log(`      ${JSON.stringify(e.text)}`);
  });

  // --------------------------------------------------- P3: the bell, on a real client ----
  await step('P3 a mention rings a real client\'s terminal, and an ordinary line does not', async () => {
    // stdin is a pipe, so client.mjs picks the readline renderer — which is the point: its stdout
    // is a pipe too, so the \x07 byte can be asserted on directly.
    bell = spawn(process.execPath, [CLIENT_MJS, `ws://127.0.0.1:${PORT}`, '--name', 'Dana', '--token', TOKEN],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    bell.stdout.on('data', (c) => { out += c; });
    bell.stderr.on('data', (c) => { out += c; });
    await until('the client to join', () => /here: /.test(out), 25000);
    // A line that is not about Dana: no bell.
    host.send({ t: 'chat', text: 'nothing to see here' });
    await until('the chat line to arrive', () => /nothing to see here/.test(out), 15000);
    await sleep(400);
    if (out.includes('\x07')) throw new Error('an ordinary line rang the bell');
    // …and one that is.
    host.send({ t: 'chat', text: 'Dana can you take a look at this' });
    await until('the bell byte', () => out.includes('\x07'), 15000);
    const at = out.indexOf('\x07');
    console.log(`      \\x07 at byte ${at}, next: ${JSON.stringify(out.slice(at, at + 40))}`);
    if (!/Dana can you take a look/.test(out)) throw new Error('the mention itself never rendered');
  });
} finally {
  bell?.kill('SIGTERM');
  host.close();
  guest.close();
  await sleep(300);
  for (const s of [SESSION, DRIVE]) tmux('kill-session', '-t', s); // exact names, ours alone
  fs.rmSync(TARGET, { force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), `claude-jam-${PORT}`), { recursive: true, force: true });
}

console.log(`\n--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'}`);
process.exit(failed ? 1 : 0);
