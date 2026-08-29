#!/usr/bin/env node
// Access-control smoke: drive a jam daemon started WITHOUT --token through both
// admission paths — loopback host, knock + accept, duplicate name, /token set, token
// join, knock + deny. Needs no claude turn, so it never injects anything.
// usage: node scripts/smoke-knock.mjs <ws-url>
const url = process.argv[2];
if (!url) { console.error('usage: node scripts/smoke-knock.mjs <ws-url>'); process.exit(2); }

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
const host = peer({ name: 'SmokeHost', host: true });
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

console.log(`\n--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'}`);
process.exit(failed ? 1 : 0);
