#!/usr/bin/env node
// v0.14 smoke: claude slash commands and raw keys over the wire — who may drive the real
// TUI, and what a guest has to ask for. Scripted peers only (no client under test), plus
// `tmux capture-pane` to prove what did and did not reach the pane:
//   host+loopback → typed straight in · guest → request, default deny
//   deny · allow once · /allow-cmd always · the hard list refused even with `always`
//   a guest's {t:'key'} and {t:'resize'} refused · knock + accept still works
// usage: node scripts/smoke-slash.mjs <ws-url> <token> <tmux-session>
import { spawnSync } from 'node:child_process';

const [url, token, session] = process.argv.slice(2);
if (!url || !token || !session) {
  console.error('usage: node scripts/smoke-slash.mjs <ws-url> <token> <tmux-session>');
  process.exit(2);
}
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pane = () => (spawnSync(TMUX, ['capture-pane', '-p', '-S', '-200', '-t', `${session}:claude`], { encoding: 'utf8' }).stdout || '');
const windowSize = () => (spawnSync(TMUX, ['display-message', '-p', '-t', `${session}:claude`, '#{window_width}x#{window_height}'], { encoding: 'utf8' }).stdout || '').trim();

function peer(hello) {
  const p = { frames: [], closeCode: null };
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', ...hello })));
  ws.addEventListener('message', (m) => { try { p.frames.push(JSON.parse(m.data)); } catch { /* not ours */ } });
  ws.addEventListener('close', (e) => { p.closeCode = e.code; });
  ws.addEventListener('error', () => { /* the assertions carry the verdict */ });
  p.send = (o) => ws.send(JSON.stringify(o));
  p.close = () => ws.close();
  p.want = async (what, pred, ms = 15000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      const hit = p.frames.find(pred);
      if (hit) return hit;
      await sleep(60);
    }
    throw new Error(`no ${what} (saw: ${[...new Set(p.frames.map((f) => f.t))].join(',') || 'nothing'})`);
  };
  // Nothing of this shape may show up in the next `ms`.
  p.never = async (what, pred, ms = 2500) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = p.frames.find(pred);
      if (hit) throw new Error(`${what}: ${JSON.stringify(hit).slice(0, 120)}`);
      await sleep(60);
    }
  };
  return p;
}

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
async function until(what, pred, ms = 20000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const v = pred();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

const host = peer({ name: 'SmokeHost', host: true, token });
const guest = peer({ name: 'Guest', token });

await step('a loopback host and a token guest are both in', async () => {
  await host.want('welcome', (f) => f.t === 'welcome');
  await guest.want('welcome', (f) => f.t === 'welcome');
});

await step('host slash: /cost is typed into the real TUI, everybody is told', async () => {
  host.send({ t: 'slash', text: '/cost' });
  const line = await guest.want('the sys line', (f) => f.t === 'sys' && /ran \/cost in the TUI/.test(f.text));
  console.log(`      ${JSON.stringify(line.text)}`);
  await until('/cost on the claude pane', () => /\/cost/.test(pane()));
});

await step('a guest\'s raw {t:key} is refused — F3 is host+loopback only', async () => {
  guest.send({ t: 'key', b64: Buffer.from('\x1b[B', 'utf8').toString('base64') });
  const e = await guest.want('the refusal', (f) => f.t === 'error' && /F3 TUI control/.test(f.text));
  console.log(`      ${JSON.stringify(e.text)}`);
});

await step('a guest\'s {t:resize} is refused, and the claude window does not move', async () => {
  const before = windowSize();
  guest.send({ t: 'resize', w: 40, h: 12 });
  await guest.want('the refusal', (f) => f.t === 'error' && /host TUI only/.test(f.text));
  await sleep(500);
  eq(windowSize(), before, 'window size after a guest resize');
});

await step('the hard list is refused outright: no request, no popup, nothing typed', async () => {
  guest.send({ t: 'slash', text: '/clear' });
  const e = await guest.want('the refusal', (f) => f.t === 'error' && /ends or wipes the session/.test(f.text));
  console.log(`      ${JSON.stringify(e.text)}`);
  await host.never('a /clear request reached the host', (f) => f.t === 'cmdreq' && /clear/.test(f.cmd));
  if (/❯ \/clear/.test(pane())) throw new Error('/clear reached the pane');
});

await step('a guest\'s /compact becomes a request the host can deny', async () => {
  guest.send({ t: 'slash', text: '/compact' });
  const req = await host.want('cmdreq', (f) => f.t === 'cmdreq' && f.cmd === '/compact');
  eq(req.name, 'Guest', 'cmdreq.name');
  // A second request while one is pending is refused rather than queued.
  guest.send({ t: 'slash', text: '/cost' });
  await guest.want('the one-at-a-time refusal', (f) => f.t === 'error' && /still waiting for the host/.test(f.text));
  host.send({ t: 'cmd', op: 'deny', name: 'Guest' });
  const denied = await guest.want('the denial', (f) => f.t === 'error' && /\/compact was denied by/.test(f.text));
  console.log(`      ${JSON.stringify(denied.text)}`);
  if (/❯ \/compact/.test(pane())) throw new Error('a denied command reached the pane');
});

await step('/allow-cmd runs it once — and only once', async () => {
  guest.send({ t: 'slash', text: '/cost' });
  await host.want('cmdreq', (f) => f.t === 'cmdreq' && f.cmd === '/cost');
  host.send({ t: 'cmd', op: 'allow', name: 'Guest' });
  const ran = await guest.want('the approval line', (f) => f.t === 'sys' && /Guest ran \/cost in the TUI \(approved by/.test(f.text));
  console.log(`      ${JSON.stringify(ran.text)}`);
  // The next one asks again: a one-time approval grants nothing standing.
  const before = host.frames.filter((f) => f.t === 'cmdreq').length;
  guest.send({ t: 'slash', text: '/cost' });
  await until('a second cmdreq', () => host.frames.filter((f) => f.t === 'cmdreq').length > before);
});

await step('/allow-cmd always gives that guest standing approval for this jam', async () => {
  host.send({ t: 'cmd', op: 'allow', name: 'Guest', always: true });
  const ran = await guest.want('the standing approval line', (f) => f.t === 'sys' && /standing/.test(f.text));
  console.log(`      ${JSON.stringify(ran.text)}`);
  // From now on the host is not asked at all.
  const before = host.frames.filter((f) => f.t === 'cmdreq').length;
  guest.send({ t: 'slash', text: '/cost' });
  const auto = await guest.want('the auto-run line',
    (f) => f.t === 'sys' && /approved Guest's commands for this jam/.test(f.text));
  console.log(`      ${JSON.stringify(auto.text)}`);
  eq(host.frames.filter((f) => f.t === 'cmdreq').length, before, 'cmdreq count after standing approval');
});

await step('standing approval never widens into the hard list', async () => {
  guest.send({ t: 'slash', text: '/resume' });
  await guest.want('the refusal', (f) => f.t === 'error' && /ends or wipes the session/.test(f.text));
  await host.never('a /resume request reached the host', (f) => f.t === 'cmdreq' && /resume/.test(f.cmd));
});

await step('a nonsense command is refused before it can reach the pane', async () => {
  host.send({ t: 'slash', text: '/model\nrm -rf ~' });
  await host.want('the refusal', (f) => f.t === 'error' && /not a usable command/.test(f.text));
  if (/rm -rf/.test(pane())) throw new Error('a newline smuggled a second line into the pane');
});

await step('knock still works end to end: wrong token knocks, host accepts', async () => {
  const noa = peer({ name: 'Noa', token: 'definitely-wrong-1' });
  const k = await noa.want('knock', (f) => f.t === 'knock');
  eq(k.state, 'pending', 'knock.state');
  await host.want('the knock frame', (f) => f.t === 'knock' && f.name === 'Noa');
  host.send({ t: 'admit', name: 'Noa', ok: true });
  const w = await noa.want('welcome', (f) => f.t === 'welcome');
  eq(w.you, 'Noa', 'welcome.you');
  eq(w.session.join, undefined, 'a guest must not receive the join line');
  noa.close();
});

host.close();
guest.close();
console.log(`\n--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'}`);
process.exit(failed ? 1 : 0);
