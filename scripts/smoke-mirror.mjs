#!/usr/bin/env node
// v0.7 smoke: terminal mirror mode over the wire. Two scripted clients — one watching, one
// not — prove that `{t:'mirror'}` starts and stops the real screen stream, that the frames
// carry the actual claude pane (escape sequences and the injected text included), that they
// stay under 4/s while the TUI is animating, and that a client which never asked gets none.
// usage: node scripts/smoke-mirror.mjs <ws-url> <token>
const [url, token] = process.argv.slice(2);
if (!url || !token) { console.error('usage: node scripts/smoke-mirror.mjs <ws-url> <token>'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK = `mirrormark-${Math.random().toString(36).slice(2, 8)}`;

function peer(name, hello = {}) {
  const p = { frames: [], screens: [] };
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', name, token, ...hello })));
  ws.addEventListener('message', (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.t === 'screen') p.screens.push({ at: Date.now(), ev });
    else p.frames.push(ev);
  });
  ws.addEventListener('error', () => { /* the assertions carry the verdict */ });
  p.send = (o) => ws.send(JSON.stringify(o));
  p.close = () => ws.close();
  p.want = async (what, pred, ms = 30000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      const hit = p.frames.find(pred);
      if (hit) return hit;
      await sleep(60);
    }
    throw new Error(`no ${what} (saw: ${[...new Set(p.frames.map((f) => f.t))].join(',') || 'nothing'})`);
  };
  return p;
}

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
async function until(what, pred, ms = 30000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const v = pred();
    if (v) return v;
    await sleep(60);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const watcher = peer('Watcher');
const quiet = peer('Quiet');

await step('a client that never asked for the mirror receives no frames', async () => {
  await watcher.want('welcome', (f) => f.t === 'welcome');
  await quiet.want('welcome', (f) => f.t === 'welcome');
  await sleep(1200);
  if (watcher.screens.length) throw new Error(`${watcher.screens.length} frames before subscribing`);
  if (quiet.screens.length) throw new Error(`${quiet.screens.length} frames for a non-subscriber`);
});

await step('{t:mirror,on:true} sends the current screen at once, with SGR intact', async () => {
  watcher.send({ t: 'mirror', on: true });
  const first = await until('the first frame', () => watcher.screens[0], 5000);
  const { rows, w, h } = first.ev;
  if (!Array.isArray(rows) || !rows.length) throw new Error('frame carries no rows');
  if (!(w > 20 && h > 5)) throw new Error(`frame size looks wrong: ${w}x${h}`);
  if (!rows.some((r) => r.includes('\x1b['))) throw new Error('no escape sequences: capture-pane lost -e');
  if (!rows.some((r) => /Claude Code|❯/.test(r))) throw new Error('frame does not look like the claude TUI');
  console.log(`      first frame ${w}x${h}, ${rows.length} rows, e.g. ${JSON.stringify(rows.find((r) => r.trim())?.slice(0, 70))}`);
});

await step('the injected message shows up in the mirrored rows', async () => {
  watcher.send({ t: 'say', text: `${MARK} — reply with the single word ok and nothing else` });
  const hit = await until(`${MARK} on the mirrored screen`,
    () => watcher.screens.find((s) => s.ev.rows.some((r) => r.includes(MARK))), 60000);
  console.log(`      row: ${JSON.stringify(hit.ev.rows.find((r) => r.includes(MARK)).replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 80))}`);
});

await step('frames stay at or under 4/s while the TUI animates', async () => {
  const from = Date.now();
  await sleep(3000);
  const inWindow = watcher.screens.filter((s) => s.at >= from);
  const rate = inWindow.length / 3;
  console.log(`      ${inWindow.length} frames in 3s (${rate.toFixed(1)}/s)`);
  if (rate > 4.4) throw new Error(`${rate.toFixed(1)} frames/s exceeds the 4/s guard`);
  // Two frames closer together than the coalescing gap would mean the guard is not applied.
  for (let i = 1; i < inWindow.length; i++) {
    const gap = inWindow[i].at - inWindow[i - 1].at;
    if (gap < 200) throw new Error(`two frames only ${gap}ms apart`);
  }
});

await step('{t:mirror,on:false} stops the stream', async () => {
  await watcher.want('ok', (f) => f.t === 'agent' && f.kind === 'text' && /ok/i.test(f.text), 60000);
  watcher.send({ t: 'mirror', off: undefined, on: false });
  await sleep(600); // let an in-flight frame land
  const mark = watcher.screens.length;
  // Make the screen change for sure: another turn's worth of typing in the pane.
  watcher.send({ t: 'chat', text: 'humans-only line, no claude turn' });
  await sleep(2000);
  if (watcher.screens.length !== mark) {
    throw new Error(`${watcher.screens.length - mark} frame(s) arrived after mirror off`);
  }
  if (quiet.screens.length) throw new Error('the non-subscriber got frames after all');
});

await step('hello {mirror:true} subscribes from the first frame', async () => {
  const eager = peer('Eager', { mirror: true });
  await eager.want('welcome', (f) => f.t === 'welcome');
  await until('a frame without ever sending {t:mirror}', () => eager.screens.length, 5000);
  console.log(`      ${eager.screens.length} frame(s) with mirror:true in hello`);
  eager.close();
});

watcher.close();
quiet.close();
console.log(`\n--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'}`);
process.exit(failed ? 1 : 0);
