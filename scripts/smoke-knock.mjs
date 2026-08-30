#!/usr/bin/env node
// Access-control smoke: drive a jam daemon started WITHOUT --token through both
// admission paths — loopback host, knock + accept, duplicate name, /token set, token
// join, knock + deny. Needs no claude turn, so it never injects anything.
// v0.34: and the three ways a host claim is refused — the F1 probe shape (relay headers, relay
// address), the key from a non-local address, and a local socket with no key — each refused for
// its own stated reason. `ws` rather than the global WebSocket, because only it can set the
// upgrade headers a relay puts there.
// usage: node scripts/smoke-knock.mjs <ws-url>
import os from 'node:os';
import WS from 'ws';
import { hostKeyPath, stateDirFor, HOST_KEY_FILE } from '../lib.mjs';
import { readHostKey } from '../platform.mjs';

const url = process.argv[2];
if (!url) { console.error('usage: node scripts/smoke-knock.mjs <ws-url>'); process.exit(2); }

// The daemon writes `<state>/host.key` at start; the host's own client reads it to prove itself.
const PORT = Number(new URL(url).port) || 7777;
const STATE = stateDirFor(os.tmpdir(), PORT);
const HOST_KEY = readHostKey(hostKeyPath(STATE));
if (!HOST_KEY) {
  console.error(`no ${HOST_KEY_FILE} in ${STATE} — this daemon predates v0.34, or is not the one on ${url}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One test participant: sends its hello on open, keeps every frame it ever saw so a
// step can assert on frames that arrived before it started looking.
function peer(hello) {
  const p = { frames: [], closeCode: null };
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', ...hello })));
  ws.addEventListener('message', (m) => { try { p.frames.push(JSON.parse(m.data)); } catch { /* not ours */ } });
  ws.addEventListener('close', (e) => { p.closeCode = e.code; });
  ws.addEventListener('error', () => { /* close carries the verdict */ });
  p.send = (o) => ws.send(JSON.stringify(o));
  p.want = async (what, pred, ms = 5000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      const hit = p.frames.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    throw new Error(`no ${what} (saw: ${p.frames.map((f) => f.t).join(',') || 'nothing'}${p.closeCode ? `, closed ${p.closeCode}` : ''})`);
  };
  p.wantClose = async (code, ms = 5000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      if (p.closeCode != null) {
        if (p.closeCode === code) return code;
        throw new Error(`closed ${p.closeCode}, expected ${code}`);
      }
      await sleep(50);
    }
    throw new Error(`never closed, expected ${code}`);
  };
  // Latest roster the daemon told this peer about (welcome carries the first one).
  p.roster = () => [...p.frames].reverse().find((f) => f.t === 'roster' || f.t === 'welcome')?.roster || [];
  return p;
}

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}

const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

const TOKEN = 'friends-only-1';
const host = peer({ name: 'SmokeHost', host: true, hostKey: HOST_KEY });
let dana, eli, noa;

await step('loopback host hello (host:true, no token) is welcomed', async () => {
  const w = await host.want('welcome', (f) => f.t === 'welcome');
  eq(w.you, 'SmokeHost', 'welcome.you');
  // Knock mode: the address is still handed out, only the --token part is dropped (017bf4b).
  if (!/ --name <You>$/.test(w.session.join || '')) {
    throw new Error(`welcome.session.join should be a token-less invite line, got ${w.session.join}`);
  }
});

await step('friend hello without a token lands in knock pending, host is told', async () => {
  dana = peer({ name: 'Dana' });
  const k = await dana.want('knock', (f) => f.t === 'knock');
  eq(k.state, 'pending', 'knock.state');
  const seen = await host.want('knock for Dana', (f) => f.t === 'knock' && f.name === 'Dana');
  if (!seen.ip) throw new Error('host knock frame carries no ip');
  if (host.roster().includes('Dana')) throw new Error('a pending knocker is in the roster');
});

// v0.16: the bar in the host's client is driven by one frame carrying the whole pending set,
// pushed on every change — so this is what a knock has to produce besides the text line.
await step('v0.16: host clients get the pending set with an expiry, and it empties on admit', async () => {
  const p = await host.want('pending with Dana', (f) => f.t === 'pending' && f.items?.some((i) => i.name === 'Dana'));
  const item = p.items.find((i) => i.name === 'Dana');
  eq(item.kind, 'knock', 'item.kind');
  if (!item.ip) throw new Error('the pending item carries no ip');
  const left = item.expires - Date.now();
  if (!(left > 60000 && left <= 120000)) throw new Error(`expires is ${left}ms away, want ~2min`);
  console.log(`      pending: ${JSON.stringify(p.items)} (${Math.round(left / 1000)}s left)`);
  if (dana.frames.some((f) => f.t === 'pending')) throw new Error('a guest was told about the pending set');
});

await step('a pending socket cannot talk (say is refused)', async () => {
  dana.send({ t: 'say', text: 'let me in' });
  await dana.want('error', (f) => f.t === 'error' && /approval/i.test(f.text));
  if (dana.frames.some((f) => f.t === 'welcome')) throw new Error('pending socket got a welcome');
});

await step('host admit ok:true welcomes the knocker and puts it in the roster', async () => {
  host.send({ t: 'admit', name: 'Dana', ok: true });
  const w = await dana.want('welcome', (f) => f.t === 'welcome');
  eq(w.you, 'Dana', 'welcome.you');
  eq(w.session.join, undefined, 'a friend must not receive the join line');
  await host.want('roster with Dana', (f) => f.t === 'roster' && f.joined === 'Dana');
  if (!host.roster().includes('Dana')) throw new Error(`roster is ${host.roster().join(',')}`);
  // v0.16: and the bar comes down, because the pending set is pushed again and is now empty.
  const last = [...host.frames].reverse().find((f) => f.t === 'pending');
  if (last.items.length) throw new Error(`still pending after admit: ${JSON.stringify(last.items)}`);
});

await step('a second Dana is closed 4409', async () => {
  const dup = peer({ name: 'Dana' });
  await dup.wantClose(4409);
});

await step('host /token set replies to host clients with the join line', async () => {
  host.send({ t: 'token', op: 'set', value: TOKEN });
  const t = await host.want('token', (f) => f.t === 'token');
  eq(t.token, TOKEN, 'token.token');
  if (!t.join?.includes(`--token ${TOKEN}`)) throw new Error(`join line is ${t.join}`);
  // Rotating must not disconnect anyone already admitted.
  if (dana.closeCode != null) throw new Error(`Dana was disconnected (${dana.closeCode}) by the rotation`);
});

await step('a friend with that token is admitted directly, no knock', async () => {
  eli = peer({ name: 'Eli', token: TOKEN });
  const w = await eli.want('welcome', (f) => f.t === 'welcome');
  eq(w.you, 'Eli', 'welcome.you');
  if (eli.frames.some((f) => f.t === 'knock')) throw new Error('token path went through a knock');
});

await step('a wrong token knocks, and admit ok:false closes it 4403', async () => {
  noa = peer({ name: 'Noa', token: 'definitely-wrong-1' });
  const k = await noa.want('knock', (f) => f.t === 'knock');
  eq(k.state, 'pending', 'knock.state');
  host.send({ t: 'admit', name: 'Noa', ok: false });
  const denied = await noa.want('denied', (f) => f.t === 'knock' && f.state === 'denied');
  eq(denied.state, 'denied', 'knock.state');
  await noa.wantClose(4403);
});

// -------------------------------------------------------------------- v0.34 ----
// Host is TWO conditions, and either one failing denies it. These are the three shapes that
// must be refused, each for its own reason — and the reason is asserted, not just the refusal,
// because "you are not the host on your own machine" is otherwise an unanswerable bug report.
// `ws` (not the global WebSocket) so the upgrade headers a relay adds can actually be set.
function raw(hello, { headers = {}, host: dial = '127.0.0.1' } = {}) {
  const p = { frames: [], closeCode: null };
  const u = new URL(url);
  u.hostname = dial;
  const ws = new WS(u.toString(), { headers });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', ...hello })));
  ws.on('message', (m) => { try { p.frames.push(JSON.parse(m.toString())); } catch { /* not ours */ } });
  ws.on('close', (c) => { p.closeCode = c; });
  ws.on('error', () => { /* the assertions carry the verdict */ });
  p.close = () => ws.close();
  p.want = async (what, pred, ms = 5000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      const hit = p.frames.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    throw new Error(`no ${what} (saw: ${p.frames.map((f) => f.t).join(',') || 'nothing'}${p.closeCode ? `, closed ${p.closeCode}` : ''})`);
  };
  return p;
}

// Exactly what cloudflared put on the upgrade, measured 2026-08-30 (cloudflared 2026.8.2).
const RELAY_HEADERS = {
  'x-forwarded-for': '84.229.122.233',
  'x-forwarded-proto': 'https',
  'cf-connecting-ip': '84.229.122.233',
  'cf-ray': 'a32ea05c0091da54-TLV',
  'cdn-loop': 'cloudflare; loops=1',
};

await step('v0.34 refusal 1 — the F1 probe shape (relay headers, relay address) fails BOTH conditions', async () => {
  // The campaign's repro exactly: a stranger through the tunnel claiming host, with no token and
  // no key. Before v0.21.1 this was admitted as the HOST. It must now be refused twice over.
  const mallory = raw({ name: 'Mallory', host: true }, { headers: RELAY_HEADERS });
  const why = await mallory.want('the refusal', (f) => f.t === 'error' && /host refused/.test(f.text));
  if (!/did not start on this machine/.test(why.text)) throw new Error(`locality not named: ${why.text}`);
  if (!/no host key was presented/.test(why.text)) throw new Error(`the key not named: ${why.text}`);
  if (why.text.includes(HOST_KEY)) throw new Error('the refusal quoted the key');
  console.log(`      ${JSON.stringify(why.text)}`);
  // And they are a knocker, not a host: no welcome, no join line, nothing to drive the TUI with.
  const k = await mallory.want('the knock', (f) => f.t === 'knock');
  eq(k.state, 'pending', 'knock.state');
  if (mallory.frames.some((f) => f.t === 'welcome')) throw new Error('the F1 probe was WELCOMED');
  mallory.close();
});

await step('v0.34 refusal 2 — the right key from a socket that is not local is refused on locality alone', async () => {
  // The whole point of keeping localSocket(): two conditions that fail INDEPENDENTLY. Here the
  // key is the real one out of the state dir and the connection is still not the host's.
  const relayed = raw({ name: 'Relay', host: true, hostKey: HOST_KEY }, { headers: RELAY_HEADERS });
  const why = await relayed.want('the refusal', (f) => f.t === 'error' && /host refused/.test(f.text));
  if (!/did not start on this machine/.test(why.text)) throw new Error(`locality not named: ${why.text}`);
  if (/host key/.test(why.text.replace(/no host key was presented/, ''))) {
    throw new Error(`the key condition should have PASSED: ${why.text}`);
  }
  console.log(`      ${JSON.stringify(why.text)}`);
  relayed.close();

  // And the same again over a genuinely off-box address, where one exists — the daemon binds
  // 0.0.0.0, so this is the measured control from the campaign: an off-box socket arrives on its
  // own address and carries no header at all.
  const off = Object.values(os.networkInterfaces()).flat()
    .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
  if (!off) return console.log('      (no non-loopback IPv4 on this machine — header form only)');
  const box = raw({ name: 'OffBox', host: true, hostKey: HOST_KEY }, { host: off });
  const w2 = await box.want('the refusal', (f) => f.t === 'error' && /host refused/.test(f.text));
  if (!/did not start on this machine/.test(w2.text)) throw new Error(`locality not named: ${w2.text}`);
  console.log(`      from ${off}: ${JSON.stringify(w2.text)}`);
  box.close();
});

await step('v0.34 refusal 3 — a LOCAL socket with no key is a guest, and is told which condition', async () => {
  const bare = raw({ name: 'Bare', host: true });
  const why = await bare.want('the refusal', (f) => f.t === 'error' && /host refused/.test(f.text));
  if (!/no host key was presented/.test(why.text)) throw new Error(`the key not named: ${why.text}`);
  if (/did not start on this machine/.test(why.text)) throw new Error(`locality should have PASSED: ${why.text}`);
  console.log(`      ${JSON.stringify(why.text)}`);
  // A guest, not a closed door: this jam is knock-only, so they wait like anybody else.
  const k = await bare.want('the knock', (f) => f.t === 'knock');
  eq(k.state, 'pending', 'knock.state');
  bare.close();

  // A WRONG key on a local socket is refused the same way a bad token is, and says so.
  const wrong = raw({ name: 'Wrong', host: true, hostKey: 'f'.repeat(64) });
  const w2 = await wrong.want('the refusal', (f) => f.t === 'error' && /host refused/.test(f.text));
  if (!/is not the one in this jam/.test(w2.text)) throw new Error(`mismatch not named: ${w2.text}`);
  console.log(`      ${JSON.stringify(w2.text)}`);
  wrong.close();
});

console.log(`\n--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'}`);
process.exit(failed ? 1 : 0);
