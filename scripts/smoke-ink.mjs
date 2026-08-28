#!/usr/bin/env node
// v0.6 smoke: the ink client, proved on a real pty. Runs a second client ("Dana") in its own
// tmux session, drives a scripted peer ("Eli") over raw WS, and asserts on what tmux actually
// captured — the transcript block layout, the human-only chat line, the STATUS BAR row (its
// own row: animated spinner left, typing indicator right, prompt row untouched), and the
// host's own chat surface.
// Extended for v0.9 (the claude window is one pane, the host chats in a `chat` window),
// v0.10 (tool collapse + /tools), v0.10b (Shift/Alt+Enter newlines) and v0.10c (the
// onboarding block + /help), plus the mirror view driven by a real F2 keypress.
// Needs a jam daemon already running with a token (see README).
// usage: node scripts/smoke-ink.mjs <ws-url> <token> <host-tmux-session>
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const [url, token, hostSession] = process.argv.slice(2);
if (!url || !token || !hostSession) {
  console.error('usage: node scripts/smoke-ink.mjs <ws-url> <token> <host-tmux-session>');
  process.exit(2);
}
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLIENT = path.join(HERE, '..', 'client.mjs');
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
// Our own session, created and killed by this script — never the host's.
const PEER_SESSION = 'jaminksmoke';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => spawnSync(TMUX, a, { encoding: 'utf8' });
const pane = (target) => (tmux('capture-pane', '-p', '-t', target).stdout || '').replace(/\n+$/, '');
const rows = (target) => pane(target).split('\n');
const SPIN = ['✻', '✼', '✽'];

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
const show = (label, target) => {
  console.log(`\n----- ${label} (${target}) -----`);
  console.log(pane(target));
  console.log('-----------------------------------------------------------------');
};
// Keys into Dana's pty. `-l` is literal text, `-H` raw bytes — the only way to send the
// exact CSI-u / ESC-CR sequences a terminal would emit for Shift+Enter and Alt+Enter.
const type = (s) => tmux('send-keys', '-t', PEER_SESSION, '-l', s);
const key = (...k) => tmux('send-keys', '-t', PEER_SESSION, ...k);
const hex = (...bytes) => tmux('send-keys', '-t', PEER_SESSION, '-H', ...bytes);
const line = (s) => { type(s); key('Enter'); };

// A scripted peer: raw WS, so nothing about the client under test is faked.
function peer(name) {
  const p = { frames: [], ws: new WebSocket(url) };
  p.ws.addEventListener('open', () => p.ws.send(JSON.stringify({ t: 'hello', name, token })));
  p.ws.addEventListener('message', (m) => { try { p.frames.push(JSON.parse(m.data)); } catch { /* not ours */ } });
  p.ws.addEventListener('error', () => { /* the assertions carry the verdict */ });
  p.send = (o) => p.ws.send(JSON.stringify(o));
  p.want = async (what, pred, ms = 60000) => until(what, () => p.frames.find(pred), ms);
  return p;
}

// Dana is the real thing: client.mjs in a 120x40 pty of its own.
tmux('kill-session', '-t', PEER_SESSION); // a leftover from an interrupted run, exact name only
const born = tmux('new-session', '-d', '-s', PEER_SESSION, '-x', '120', '-y', '40',
  process.execPath, CLIENT, url, '--name', 'Dana', '--token', token);
if (born.status !== 0) { console.error(`tmux: ${born.stderr}`); process.exit(1); }

const eli = peer('Eli');
let spinFrames = [];

try {
  await step('the ink client boots on a real pty: welcome block, then a clean `Dana ❯` row', async () => {
    await until('welcome', () => /jam [0-9a-f-]{36} — host /.test(pane(PEER_SESSION)));
    const last = rows(PEER_SESSION).at(-1);
    if (!/^Dana ❯/.test(last)) throw new Error(`last row is ${JSON.stringify(last)}, want the prompt`);
    if (/typing|working|waiting/.test(last)) throw new Error(`status text leaked into the prompt row: ${JSON.stringify(last)}`);
  });

  await step('v0.10c: the onboarding block is printed on connect, above the history', async () => {
    // Scrollback, not the visible screen: on a daemon with history to replay the block is
    // printed first and can be scrolled off by the time the roster line lands.
    const back = () => (tmux('capture-pane', '-p', '-S', '-400', '-t', PEER_SESSION).stdout || '').replace(/\n+$/, '');
    const p = await until('the onboarding box and the roster line',
      () => (/── claude-jam ─/.test(back()) && /here: /.test(back()) ? back() : null));
    for (const want of ['/c <text>', 'F2 or /mirror', 'Shift+Enter or \\', 'just ask claude', 'attributed [Dana]']) {
      if (!p.includes(want)) throw new Error(`onboarding block is missing ${JSON.stringify(want)}`);
    }
    const all = p.split('\n');
    const head = all.findIndex((l) => /── claude-jam ─/.test(l));
    const here = all.findIndex((l) => /here: /.test(l));
    if (!(head < here)) throw new Error(`block at row ${head}, roster line at ${here} — not above it`);
    console.log(`      rows ${head}..${here}: ${all.slice(head, head + 2).map((l) => JSON.stringify(l.trim())).join('  /  ')}`);
  });

  await step('a second friend joins and is announced', async () => {
    await eli.want('welcome', (f) => f.t === 'welcome');
    await until('Eli joined', () => /Eli joined/.test(pane(PEER_SESSION)));
  });

  await step('/c chat renders as [Eli] [humans-only] … in its own block', async () => {
    eli.send({ t: 'chat', text: 'psst, humans only' });
    const line = await until('the chat line',
      () => rows(PEER_SESSION).find((l) => /\[humans-only\] psst, humans only/.test(l)));
    if (!/^\[Eli\]/.test(line)) throw new Error(`chat line is ${JSON.stringify(line)}`);
  });

  await step('a peer typing shows up on the RIGHT of the status bar row, not in the prompt row', async () => {
    const stop = Date.now() + 6000;
    const beat = setInterval(() => { if (Date.now() < stop) eli.send({ t: 'typing' }); }, 800);
    try {
      const r = await until('Eli is typing… on the status row', () => {
        const all = rows(PEER_SESSION);
        const i = all.findIndex((l) => /Eli is typing…/.test(l));
        return i >= 0 ? { line: all[i], isLast: i === all.length - 1, all } : null;
      }, 8000);
      if (r.isLast) throw new Error('the typing indicator landed in the prompt row');
      if (!/^Dana ❯/.test(r.all.at(-1))) throw new Error(`prompt row is ${JSON.stringify(r.all.at(-1))}`);
      // Its own row, right-aligned: the text ends at (or near) the pane's right edge.
      if (r.line.trimEnd().length < 100) throw new Error(`not right-aligned: ${JSON.stringify(r.line)}`);
      console.log(`      status row: ${JSON.stringify(r.line)}`);
    } finally { clearInterval(beat); }
  });

  await step('an agent turn: the spinner animates in the status bar while the prompt row stays clean', async () => {
    eli.send({ t: 'say', text: 'Read the file package.json with the Read tool, then reply with the single word pong and nothing else.' });
    await until('busy', () => eli.frames.some((f) => f.t === 'status' && f.busy));
    // Four captures, 300ms apart: the frame must move, and the prompt row must not.
    for (let i = 0; i < 4; i++) {
      const all = rows(PEER_SESSION);
      const hit = all.find((l) => SPIN.some((g) => l.includes(`${g} claude is working…`)));
      if (hit) {
        spinFrames.push(SPIN.find((g) => hit.includes(`${g} claude is working…`)));
        if (all.indexOf(hit) === all.length - 1) throw new Error('the spinner landed in the prompt row');
        if (!/^Dana ❯/.test(all.at(-1))) throw new Error(`prompt row is ${JSON.stringify(all.at(-1))}`);
      }
      if (i < 3) await sleep(300);
    }
    console.log(`      spinner frames 300ms apart: ${JSON.stringify(spinFrames)}`);
    if (spinFrames.length < 2) throw new Error(`only ${spinFrames.length} capture(s) caught the spinner`);
    if (new Set(spinFrames).size < 2) throw new Error(`the spinner never moved: ${JSON.stringify(spinFrames)}`);
  });

  await step('the tool call, its ⎿ result and claude\'s answer all land in the transcript', async () => {
    await eli.want('pong', (f) => f.t === 'agent' && f.kind === 'text' && /pong/i.test(f.text));
    const text = await until('the transcript lines', () => {
      const p = pane(PEER_SESSION);
      return /⚙ Read/.test(p) && /⎿ /.test(p) && /\[Claude\]/.test(p) ? p : null;
    });
    if (!/pong/i.test(text)) throw new Error('claude\'s answer is not on screen');
  });

  await step('v0.10: a single-tool turn keeps its ⚙ and ⎿ inline (no summary line)', async () => {
    const p = pane(PEER_SESSION);
    if (/⚙ \d+ tools \(/.test(p)) throw new Error('a one-tool turn was collapsed into a summary');
    if (!/⚙ Read/.test(p)) throw new Error('the inline ⚙ Read line is gone');
  });

  await step('v0.10: a multi-tool turn shows live ⚙ lines, then ONE ⚙ N tools summary', async () => {
    eli.send({ t: 'say', text: 'Run seven separate Bash tool calls, one per call: echo 1, echo 2, echo 3, echo 4, echo 5, echo 6, echo 7. Then reply with the single word done.' });
    const sentAt = Date.now();
    await until('busy', () => eli.frames.some((f) => f.t === 'status' && f.busy && f.ts >= sentAt));
    // While the turn runs the ⚙/⎿ lines are in the LIVE region (nothing has been written to
    // the transcript yet, so the summary cannot be on screen), capped at four rows. Which
    // glyph is visible depends on the turn: seven tool_use blocks in one assistant record
    // arrive together, so the last four rows can be all ⎿ results.
    const live = await until('live tool lines while the turn runs', () => {
      const all = rows(PEER_SESSION);
      const idx = all.map((l, i) => (/[⚙⎿] /.test(l) && !/⚙ \d+ tools \(/.test(l) ? i : -1)).filter((i) => i >= 0);
      if (!idx.length || /⚙ \d+ tools \(/.test(all.join('\n'))) return null;
      const prompt = all.length - 1;
      // Contiguous rows sitting just above the status + prompt rows: the live region.
      const liveIdx = idx.filter((i) => i >= prompt - 6 && i < prompt);
      return liveIdx.length ? { all, liveIdx } : null;
    }, 90000);
    console.log(`      live region rows ${live.liveIdx.join(',')} of ${live.all.length}: ` +
      live.liveIdx.map((i) => JSON.stringify(live.all[i].trim().slice(0, 44))).join(' '));
    if (live.liveIdx.length > 4) throw new Error(`${live.liveIdx.length} live tool rows, cap is 4`);
    // Turn over: exactly one summary line, and no stray ⚙ Bash lines left in the transcript.
    const summary = await until('the collapsed summary', () => {
      const m = /⚙ (\d+) tools \(([^)]*)\)/.exec(pane(PEER_SESSION));
      return m && !eli.frames.some((f) => f.t === 'status' && f.busy && f.ts > Date.now() - 1500) ? m : null;
    }, 120000);
    console.log(`      summary: ${JSON.stringify(summary[0])}`);
    if (Number(summary[1]) < 2) throw new Error(`summary counts ${summary[1]} tools`);
    if (!/Bash ×/.test(summary[2])) throw new Error(`summary has no per-tool counts: ${summary[2]}`);
    const after = pane(PEER_SESSION);
    if ((after.match(/⚙ \d+ tools \(/g) || []).length !== 1) throw new Error('more than one summary line');
    if (/⚙ Bash/.test(after)) throw new Error('the collapsed ⚙ Bash lines are still on screen');
  });

  await step('v0.10: /tools reprints the last turn\'s full log', async () => {
    line('/tools');
    const p = await until('the reprinted log', () => (/last turn's tools \(\d+\)/.test(pane(PEER_SESSION)) ? pane(PEER_SESSION) : null));
    const bash = (p.match(/⚙ Bash/g) || []).length;
    if (bash < 2) throw new Error(`only ${bash} ⚙ Bash lines came back`);
    console.log(`      ${JSON.stringify(/last turn's tools \(\d+\)/.exec(p)[0])} — ${bash} ⚙ lines reprinted`);
  });

  await step('v0.10b: Shift+Enter (CSI-u) inserts a newline instead of submitting', async () => {
    type('/c first line');
    hex('1b', '5b', '31', '33', '3b', '32', '75'); // ESC [ 1 3 ; 2 u
    const r = await until('the pending line above the prompt', () => {
      const all = rows(PEER_SESSION);
      const last = all.at(-1);
      return /^Dana …? ?❯\s*$/.test(last) && all.at(-2)?.includes('/c first line') ? all : null;
    }, 8000);
    console.log(`      pending: ${JSON.stringify(r.at(-2))} · prompt: ${JSON.stringify(r.at(-1))}`);
    if (eli.frames.some((f) => f.t === 'chat' && /first line/.test(f.text))) {
      throw new Error('the message was submitted instead of continued');
    }
  });

  await step('v0.10b: Alt+Enter (ESC CR) does the same, then plain Enter submits all three lines', async () => {
    type('second line');
    hex('1b', '0d'); // ESC CR
    await until('two pending lines', () => {
      const all = rows(PEER_SESSION);
      return all.at(-2)?.includes('second line') && all.at(-3)?.includes('first line') ? all : null;
    }, 8000);
    line('third line');
    const chat = await eli.want('the three-line chat', (f) => f.t === 'chat' && /first line/.test(f.text), 10000);
    if (chat.text !== 'first line\nsecond line\nthird line') {
      throw new Error(`chat text is ${JSON.stringify(chat.text)}`);
    }
    console.log(`      submitted: ${JSON.stringify(chat.text)}`);
    await until('the block on screen', () => /\[humans-only\] first line/.test(pane(PEER_SESSION)));
  });

  await step('v0.10c: /help reprints the onboarding block', async () => {
    const before = (pane(PEER_SESSION).match(/── claude-jam ─/g) || []).length;
    line('/help');
    await until('a second onboarding box',
      () => (pane(PEER_SESSION).match(/── claude-jam ─/g) || []).length > before, 8000);
    console.log(`      onboarding boxes on screen: ${(pane(PEER_SESSION).match(/── claude-jam ─/g) || []).length}`);
  });

  await step('v0.7: F2 flips Dana into the mirror of the real claude TUI, F2 flips back', async () => {
    key('F2');
    // Proof it is the real TUI and not Dana's own transcript: only claude's own screen
    // renders an injected message as `❯ [Eli]: …` behind its prompt glyph.
    const mirrored = await until('the host screen in Dana\'s pane', () => {
      const all = rows(PEER_SESSION);
      return all.some((l) => /❯ \[Eli\]: /.test(l)) && all.some((l) => /\[mirror\]/.test(l)) ? all : null;
    }, 15000);
    if (!/^Dana ❯/.test(mirrored.at(-1))) throw new Error(`prompt row is ${JSON.stringify(mirrored.at(-1))}`);
    console.log(`      mirrored TUI row: ${JSON.stringify(mirrored.find((l) => /❯ \[Eli\]: /.test(l)).trim().slice(0, 70))}`);
    show('Dana — MIRROR view (the real TUI, streamed)', PEER_SESSION);
    // A chat line arriving while the mirror is up shows in the 3-row overlay, then lands in
    // the transcript when the mirror goes away.
    eli.send({ t: 'chat', text: 'overlay while mirroring' });
    await until('the overlay strip', () => /overlay while mirroring/.test(pane(PEER_SESSION)), 10000);
    key('F2');
    await until('back in the transcript', () => /mirror off/.test(pane(PEER_SESSION)), 10000);
    const back = rows(PEER_SESSION);
    // The live region is the status + prompt rows again: no mirrored TUI row left in it.
    if (back.slice(-4).some((l) => /❯ \[Eli\]: /.test(l))) throw new Error('still mirroring');
    if (!/overlay while mirroring/.test(back.join('\n'))) throw new Error('the overlay line never reached the transcript');
  });

  await step('v0.9: the claude window is ONE pane and the host chats in its own window', async () => {
    const panes = (tmux('list-panes', '-t', `${hostSession}:claude`).stdout || '').trim().split('\n').length;
    if (panes !== 1) throw new Error(`${panes} panes in the claude window — a viewer would see the chat strip`);
    const wins = (tmux('list-windows', '-t', hostSession, '-F', '#{window_name}').stdout || '').trim().split('\n');
    if (!wins.includes('chat')) throw new Error(`windows are ${wins.join(',')}`);
    const all = rows(`${hostSession}:chat`);
    if (!/^Host ❯/.test(all.at(-1))) throw new Error(`last row of the chat window is ${JSON.stringify(all.at(-1))}`);
    if (!all.some((l) => /\[Eli\]|\[Claude\]|\[humans-only\]/.test(l))) {
      throw new Error('no transcript reached the host chat window');
    }
    console.log(`      windows: ${wins.join(', ')} · claude panes: ${panes}`);
  });

  show('Dana — 120x40 ink client', PEER_SESSION);
  show('Host — chat window', `${hostSession}:chat`);
} finally {
  tmux('kill-session', '-t', PEER_SESSION); // exact name, only the session this script created
}

console.log(`\n--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'}`);
process.exit(failed ? 1 : 0);
