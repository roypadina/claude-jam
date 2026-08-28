#!/usr/bin/env node
// v0.4 smoke: in-TUI knock approval. Drives a knock-only daemon and checks the popup path
// end to end — the tmux popup is spawned, the session's status-right shows the waiting
// badge, POST /admit answers a knock exactly like /accept does, an unknown name is a 404,
// and popup.mjs itself both times out on its own and admits on a stubbed 'a'.
// Needs no claude turn, so it never injects anything.
// usage: node scripts/smoke-popup.mjs <ws-url> <tmux-session> <port> <hook-secret>
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const [url, session, port, secret] = process.argv.slice(2);
if (!url || !session || !port || !secret) {
  console.error('usage: node scripts/smoke-popup.mjs <ws-url> <tmux-session> <port> <hook-secret>');
  process.exit(2);
}
const HERE = path.dirname(new URL(import.meta.url).pathname);
const POPUP = path.join(HERE, '..', 'popup.mjs');
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A knocker: hello on open, every frame kept so a step can assert on frames that arrived
// before it started looking.
function peer(hello) {
  const p = { frames: [], closeCode: null };
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', ...hello })));
  ws.addEventListener('message', (m) => { try { p.frames.push(JSON.parse(m.data)); } catch { /* not ours */ } });
  ws.addEventListener('close', (e) => { p.closeCode = e.code; });
  ws.addEventListener('error', () => { /* close carries the verdict */ });
  p.send = (o) => ws.send(JSON.stringify(o));
  p.want = async (what, pred, ms = 6000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      const hit = p.frames.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    throw new Error(`no ${what} (saw: ${p.frames.map((f) => f.t).join(',') || 'nothing'})`);
  };
  return p;
}

const statusRight = () =>
  (spawnSync(TMUX, ['show-options', '-t', session, '-v', 'status-right'], { encoding: 'utf8' }).stdout || '').trim();
// The daemon's own log lives in the `daemon` tmux window, scrollback included.
const daemonLog = () =>
  spawnSync(TMUX, ['capture-pane', '-p', '-S', '-400', '-t', `${session}:daemon`], { encoding: 'utf8' }).stdout || '';

async function until(what, pred, ms = 6000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const v = pred();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Run popup.mjs the way tmux would, minus the popup. The exit promise is created at spawn
// time on purpose: 'exit' fires once, and a listener added after the child is already gone
// would never see it.
function runPopup(name, ttl = '120', kind = 'knock', detail = '') {
  const child = spawn(process.execPath, [POPUP, name, '127.0.0.1', ttl, port, kind, detail],
    { env: { ...process.env, JAM_HOOK_SECRET: secret }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.on('exit', r));
  return {
    key: (k) => child.stdin.write(k),
    out: () => out,
    exit: (ms = 6000) => Promise.race([exited,
      sleep(ms).then(() => { child.kill(); throw new Error(`popup.mjs still alive after ${ms}ms`); })]),
  };
}

// POST /admit the way popup.mjs does.
async function admit(body, hdrSecret = secret) {
  const res = await fetch(`http://127.0.0.1:${port}/admit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jam-secret': hdrSecret },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

let dana, eli, noa;
// What status-right looked like before any knock — the daemon must put exactly this back.
const baseline = statusRight();
console.log(`      status-right baseline: ${JSON.stringify(baseline)}`);

await step('a knock takes the popup path and sets status-right to the waiting badge', async () => {
  dana = peer({ name: 'Dana' });
  await dana.want('knock pending', (f) => f.t === 'knock' && f.state === 'pending');
  await until('status-right badge', () => statusRight() === '⚑ 1 waiting');
  // With a client attached to the jam session the popup is spawned; with none (a
  // --no-attach run like this one) the daemon says so and moves on — display-popup would
  // block forever waiting for a client to draw on. Either way the knock is answerable.
  const line = await until('popup decision in the daemon log',
    () => /\[knock\] (?:popup for Dana|no client attached — no popup for Dana)[^\n]*/.exec(daemonLog())?.[0]);
  console.log(`      ${line.trim()}`);
});

await step('POST /admit needs the hook secret (wrong one is 403, not an admission)', async () => {
  eq((await admit({ name: 'Dana', ok: true }, 'wrong-secret')).status, 403, 'status');
  if (dana.frames.some((f) => f.t === 'welcome')) throw new Error('Dana was admitted by a bad secret');
});

await step('POST /admit {name, ok:true} admits the knocker and restores status-right', async () => {
  eq((await admit({ name: 'Dana', ok: true })).status, 200, 'status');
  const w = await dana.want('welcome', (f) => f.t === 'welcome');
  eq(w.you, 'Dana', 'welcome.you');
  await until('status-right back to the baseline', () => statusRight() === baseline);
  console.log(`      status-right now: ${JSON.stringify(statusRight())}`);
});

await step('POST /admit for a name nobody is knocking under is a 404', async () => {
  const r = await admit({ name: 'Ghost', ok: true });
  eq(r.status, 404, 'status');
  if (!/nobody named/.test(r.body)) throw new Error(`body is ${r.body}`);
});

await step('popup.mjs exits on its own when its TTL elapses', async () => {
  const started = Date.now();
  const p = runPopup('Ghost', '2'); // nobody named Ghost is knocking; no key is ever sent
  eq(await p.exit(), 0, 'exit code');
  const took = Date.now() - started;
  if (took < 1500) throw new Error(`exited after only ${took}ms — the TTL was not honoured`);
  console.log(`      exited by itself after ${took}ms`);
});

await step("popup.mjs with 'a' on stdin admits the knocker through the real daemon", async () => {
  eli = peer({ name: 'Eli' });
  await eli.want('knock pending', (f) => f.t === 'knock' && f.state === 'pending');
  const p = runPopup('Eli');
  p.key('a'); // one raw key, no Enter
  const w = await eli.want('welcome', (f) => f.t === 'welcome');
  eq(w.you, 'Eli', 'welcome.you');
  eq(await p.exit(), 0, 'exit code');
  if (!/wants to join/.test(p.out())) throw new Error(`popup printed: ${JSON.stringify(p.out())}`);
  console.log(`      popup rendered: ${JSON.stringify(p.out().replace(/\x1b\[[0-9;]*m/g, '').trim())}`);
});

await step("popup.mjs with 'd' on stdin denies the knocker (close 4403)", async () => {
  noa = peer({ name: 'Noa' });
  await noa.want('knock pending', (f) => f.t === 'knock' && f.state === 'pending');
  const p = runPopup('Noa');
  p.key('d');
  await noa.want('denied', (f) => f.t === 'knock' && f.state === 'denied');
  eq(await p.exit(), 0, 'exit code');
  await until('close 4403', () => noa.closeCode === 4403);
});

await step('an ignored key leaves the knock pending, and /admit still works after it', async () => {
  const zoe = peer({ name: 'Zoe' });
  await zoe.want('knock pending', (f) => f.t === 'knock' && f.state === 'pending');
  const p = runPopup('Zoe');
  p.key('i');
  eq(await p.exit(), 0, 'exit code');
  if (zoe.frames.some((f) => f.t === 'welcome')) throw new Error('an ignored popup admitted Zoe anyway');
  eq((await admit({ name: 'Zoe', ok: true })).status, 200, 'later /admit status');
  await zoe.want('welcome', (f) => f.t === 'welcome');
});

await step('a stale popup (knock already answered) gets a 404 and exits', async () => {
  const p = runPopup('Zoe'); // Zoe was admitted a moment ago, so nothing is pending
  p.key('a');
  eq(await p.exit(), 0, 'exit code');
  if (!/too late \(404\)/.test(p.out())) throw new Error(`popup printed: ${JSON.stringify(p.out())}`);
});

// v0.14: the same popup answers a guest's claude command.
await step("popup.mjs kind=cmd allows a guest's /command through the real daemon", async () => {
  const cmdy = peer({ name: 'Cmdy' });
  await cmdy.want('knock pending', (f) => f.t === 'knock' && f.state === 'pending');
  eq((await admit({ name: 'Cmdy', ok: true })).status, 200, 'admit status');
  await cmdy.want('welcome', (f) => f.t === 'welcome');
  cmdy.send({ t: 'slash', text: '/cost' });
  await until('the request in the daemon log', () => /\[cmd\] Cmdy wants \/cost/.test(daemonLog()));
  const p = runPopup('Cmdy', '120', 'cmd', '/cost');
  p.key('a'); // one raw key, no Enter — and a popup grants one command, never `always`
  const ran = await cmdy.want('the approval line', (f) => f.t === 'sys' && /Cmdy ran \/cost in the TUI \(approved by/.test(f.text));
  eq(await p.exit(), 0, 'exit code');
  const out = p.out().replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!/⌘ Cmdy wants to run \/cost/.test(out)) throw new Error(`popup printed: ${JSON.stringify(out)}`);
  if (!/\[a\]llow/.test(out)) throw new Error(`popup does not offer allow: ${JSON.stringify(out)}`);
  console.log(`      popup rendered: ${JSON.stringify(out)}`);
  console.log(`      ${JSON.stringify(ran.text)}`);
});

console.log(`\n--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'}`);
process.exit(failed ? 1 : 0);
