#!/usr/bin/env node
// v0.14 smoke: claude slash commands and raw keys over the wire — who may drive the real
// TUI, and what a guest has to ask for. Scripted peers only (no client under test), plus
// `tmux capture-pane` to prove what did and did not reach the pane:
//   host+loopback → typed straight in · guest → request, default deny
//   deny · allow once · /allow-cmd always · the hard list refused even with `always`
//   a guest's {t:'key'} and {t:'resize'} refused · knock + accept still works
// v0.17 P1: and the read-only allowlist — /cost runs for a guest with NO host round trip, which
// is also why the ladder steps below use /release-notes: an allowlisted command never asks.
// v0.21.1: and the other direction — the host's OWN loopback client is still the host after the
// loopback gate was narrowed (the flag in the welcome, F3 keys landing, a trusted() report).
// usage: node scripts/smoke-slash.mjs <ws-url> <token> <tmux-session>
import { spawnSync } from 'node:child_process';

const [url, token, session] = process.argv.slice(2);
if (!url || !token || !session) {
  console.error('usage: node scripts/smoke-slash.mjs <ws-url> <token> <tmux-session>');
  process.exit(2);
}
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
// v0.20: jam's tmux lives on a socket of its own, named per port. `JAM_SOCKET` overrides it for
// a host started with `--tmux-socket <name>`.
const SOCKET = process.env.JAM_SOCKET || `claude-jam-${new URL(url).port || 7777}`;
const TMUX_ARGS = ['-L', SOCKET];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pane = () => (spawnSync(TMUX, [...TMUX_ARGS, 'capture-pane', '-p', '-S', '-200', '-t', `${session}:claude`], { encoding: 'utf8' }).stdout || '');
const windowSize = () => (spawnSync(TMUX, [...TMUX_ARGS, 'display-message', '-p', '-t', `${session}:claude`, '#{window_width}x#{window_height}'], { encoding: 'utf8' }).stdout || '').trim();

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

// Smokes hand off to each other with commands still in flight: runSlash broadcasts its `sys` line
// BEFORE the daemon types anything, so the previous smoke can exit seconds before its own last
// /command actually opens one of claude's MODAL panels (/cost's is one, /release-notes' is another,
// and a modal swallows everything typed after it). So settle the pane first: wait out anything
// queued, then Esc — through the host's own {t:'key'}, which is host+loopback by definition —
// until claude's input row is back.
await step('the pane starts from claude\'s own input row, whatever an earlier smoke left up', async () => {
  const inputRow = () => /❯/.test(pane().split('\n').slice(-6).join('\n'));
  await sleep(4000); // a queued slash command from the previous smoke needs ~3s to land
  for (let i = 0; i < 6 && !inputRow(); i++) {
    host.send({ t: 'key', b64: Buffer.from('\x1b', 'utf8').toString('base64') });
    await sleep(700);
  }
  if (!inputRow()) throw new Error(`no input row on the pane:\n${pane().split('\n').slice(-6).join('\n')}`);
  console.log('      claude\'s input row is on screen — nothing modal is up');
});

// v0.21.1: the host reaches its OWN daemon over 127.0.0.1, and this release narrows the loopback
// gate — a socket is local only if the address is loopback AND the upgrade carried no proxy
// header. That is exactly the shape of change that locks the host out of their own jam, or
// silently demotes them to a guest, and nothing else in this file would notice: the daemon
// answers a guest's request the same way whether the answerer is host or not. So the three
// host-only surfaces are asserted here, in one place, directly.
await step('the host\'s own loopback client is still the HOST — flag, F3 keys, host-only report', async () => {
  // 1. the grant itself. `session.tmux` is spread into the welcome only for a client the daemon
  //    accepted as host AND loopback, so its presence IS the flag — and the guest is the control.
  const hw = host.frames.find((f) => f.t === 'welcome');
  const gw = guest.frames.find((f) => f.t === 'welcome');
  eq(hw?.session?.tmux, session, 'the host\'s welcome carries the tmux session');
  eq(gw?.session?.tmux, undefined, 'a guest\'s welcome must not carry it');
  eq(typeof hw?.session?.join, 'string', 'the host\'s welcome carries the join line');
  eq(gw?.session?.join, undefined, 'a guest\'s welcome must not carry the join line');

  // 2. a raw F3 key really reaches the real TUI. The settle step above tolerates zero presses, so
  //    it can pass without a host key ever landing; this types a mark, reads it back off claude's
  //    input row, and takes it away again through the same path.
  const tail = () => pane().split('\n').slice(-6).join('\n');
  const errors = () => host.frames.filter((f) => f.t === 'error').length;
  const before = errors();
  const MARK = 'JAMHOSTKEY';
  host.send({ t: 'key', b64: Buffer.from(MARK, 'utf8').toString('base64') });
  await until(`${MARK} on claude's input row`, () => tail().includes(MARK));
  console.log(`      the host's keystrokes reached the real pane: ${MARK}`);
  host.send({ t: 'key', b64: Buffer.from('\x7f'.repeat(MARK.length), 'utf8').toString('base64') });
  await until('the mark typed away again', () => !tail().includes(MARK));
  eq(errors(), before, 'error frames for the host\'s own keys');

  // 3. a trusted()-gated report — /grants reads standing approvals and changes nothing, so it is
  //    the cheapest of them to ask twice. The host is answered; the guest is refused.
  host.send({ t: 'grants' });
  const g = await host.want('the grants report', (f) => f.t === 'grants' && Array.isArray(f.items));
  console.log(`      /grants answered for the host: ${g.items.length} standing approval(s)`);
  guest.send({ t: 'grants' });
  await guest.want('the guest\'s refusal', (f) => f.t === 'error' && /standing approvals are the host/.test(f.text));
});

await step('host slash: /cost is typed into the real TUI, everybody is told', async () => {
  host.send({ t: 'slash', text: '/cost' });
  const line = await guest.want('the sys line', (f) => f.t === 'sys' && /ran \/cost in the TUI/.test(f.text));
  console.log(`      ${JSON.stringify(line.text)}`);
  // Either the echo of the command or the panel it opens. /cost redraws the WHOLE pane,
  // scrollback included, so the echo has a few hundred ms of life — and if a previous smoke
  // (smoke-popup runs /cost too) left that panel up, the echo is never visible at all. The
  // panel itself is the same proof: nothing but /cost puts it there.
  const hit = await until('/cost, or the panel it opens, on the claude pane',
    () => /\/cost/.exec(pane())?.[0] || /Total cost:|Current session/.exec(pane())?.[0]);
  console.log(`      pane shows ${JSON.stringify(hit)}`);
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

await step('P1 a guest\'s /cost runs with no host round trip at all', async () => {
  const before = host.frames.filter((f) => f.t === 'cmdreq').length;
  guest.send({ t: 'slash', text: '/cost' });
  const ran = await guest.want('the read-only line',
    (f) => f.t === 'sys' && /Guest ran \/cost in the TUI \(read-only/.test(f.text));
  console.log(`      ${JSON.stringify(ran.text)}`);
  // The host was never asked, and never had to be: nothing about /cost can change the session.
  await host.never('a /cost request reached the host', (f) => f.t === 'cmdreq');
  eq(host.frames.filter((f) => f.t === 'cmdreq').length, before, 'cmdreq count after an allowlisted command');
  const hit = await until('/cost, or the panel it opens, on the claude pane',
    () => /\/cost/.exec(pane())?.[0] || /Total cost:|Current session/.exec(pane())?.[0]);
  console.log(`      pane shows ${JSON.stringify(hit)}`);
});

await step('P1 an argument takes it back off the allowlist — that is a request again', async () => {
  guest.send({ t: 'slash', text: '/cost --json' });
  const req = await host.want('cmdreq', (f) => f.t === 'cmdreq' && f.cmd === '/cost --json');
  eq(req.name, 'Guest', 'cmdreq.name');
  host.send({ t: 'cmd', op: 'deny', name: 'Guest' });
  await guest.want('the denial', (f) => f.t === 'error' && /denied by/.test(f.text));
});

await step('a guest\'s /compact becomes a request the host can deny', async () => {
  guest.send({ t: 'slash', text: '/compact' });
  const req = await host.want('cmdreq', (f) => f.t === 'cmdreq' && f.cmd === '/compact');
  eq(req.name, 'Guest', 'cmdreq.name');
  // A second request while one is pending is refused rather than queued. (Not /cost: v0.17 P1
  // runs that one outright, so it would never queue behind anything.)
  guest.send({ t: 'slash', text: '/release-notes' });
  await guest.want('the one-at-a-time refusal', (f) => f.t === 'error' && /still waiting for the host/.test(f.text));
  host.send({ t: 'cmd', op: 'deny', name: 'Guest' });
  const denied = await guest.want('the denial', (f) => f.t === 'error' && /\/compact was denied by/.test(f.text));
  console.log(`      ${JSON.stringify(denied.text)}`);
  if (/❯ \/compact/.test(pane())) throw new Error('a denied command reached the pane');
});

await step('/allow-cmd runs it once — and only once', async () => {
  // Not /cost: since v0.17 P1 that one is allowlisted and never reaches the ladder at all.
  guest.send({ t: 'slash', text: '/release-notes' });
  await host.want('cmdreq', (f) => f.t === 'cmdreq' && f.cmd === '/release-notes');
  host.send({ t: 'cmd', op: 'allow', name: 'Guest' });
  const ran = await guest.want('the approval line', (f) => f.t === 'sys' && /Guest ran \/release-notes in the TUI \(approved by/.test(f.text));
  console.log(`      ${JSON.stringify(ran.text)}`);
  // The next one asks again: a one-time approval grants nothing standing.
  const before = host.frames.filter((f) => f.t === 'cmdreq').length;
  guest.send({ t: 'slash', text: '/release-notes' });
  await until('a second cmdreq', () => host.frames.filter((f) => f.t === 'cmdreq').length > before);
});

await step('/allow-cmd always gives that guest standing approval for this jam', async () => {
  host.send({ t: 'cmd', op: 'allow', name: 'Guest', always: true });
  const ran = await guest.want('the standing approval line', (f) => f.t === 'sys' && /standing/.test(f.text));
  console.log(`      ${JSON.stringify(ran.text)}`);
  // From now on the host is not asked at all.
  const before = host.frames.filter((f) => f.t === 'cmdreq').length;
  guest.send({ t: 'slash', text: '/release-notes' });
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
