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

// v0.15: the cadence is adaptive, so this is two steps instead of the old flat 4/s one.
// While the TUI is animating a watcher gets frames at up to 25/s (the 40 ms gap); two
// seconds after the last sign of life the poll drops back to 250 ms.
const gaps = (frames) => frames.slice(1).map((s, i) => s.at - frames[i].at);

await step('v0.15: while the TUI animates, frames come fast — under 25/s, never inside 40 ms', async () => {
  const from = Date.now();
  await sleep(3000);
  const inWindow = watcher.screens.filter((s) => s.at >= from);
  const rate = inWindow.length / 3;
  const g = gaps(inWindow);
  console.log(`      ${inWindow.length} frames in 3s (${rate.toFixed(1)}/s), gaps min ${Math.min(...g, Infinity)}ms `
    + `median ${g.length ? [...g].sort((a, b) => a - b)[Math.floor(g.length / 2)] : '-'}ms max ${Math.max(...g, 0)}ms`);
  // The cap: 40 ms between frames is 25/s per client, and nothing may be closer than that.
  if (rate > 25.4) throw new Error(`${rate.toFixed(1)} frames/s exceeds the 25/s cap`);
  for (const gap of g) if (gap < 35) throw new Error(`two frames only ${gap}ms apart — under the 40 ms cap`);
  // And the point of v0.15: at least one gap under the old fixed 250 ms poll.
  if (inWindow.length >= 3 && Math.min(...g) >= 250) {
    throw new Error(`fastest gap was ${Math.min(...g)}ms — the fast cadence never engaged`);
  }
});

await step('v0.15: once the turn is over and nothing moves, the stream goes quiet again', async () => {
  await watcher.want('ok', (f) => f.t === 'agent' && f.kind === 'text' && /ok/i.test(f.text), 60000);
  await sleep(3000); // longer than the 2 s activity window, so the cadence has fallen back
  const from = Date.now();
  await sleep(3000);
  const inWindow = watcher.screens.filter((s) => s.at >= from);
  const rate = inWindow.length / 3;
  console.log(`      idle: ${inWindow.length} frames in 3s (${rate.toFixed(1)}/s)`);
  if (rate > 4.4) throw new Error(`${rate.toFixed(1)} frames/s while idle — the cadence did not fall back`);
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
