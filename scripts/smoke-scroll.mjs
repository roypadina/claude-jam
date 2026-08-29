#!/usr/bin/env node
// v0.28 smoke: real scrollback — the sixteenth smoke.
//   1   the stand-in pane really has scrollback: tmux's #{history_size} is hundreds of lines
//   2   {t:'screen-history'} answers with the pane's ACTUAL history — row for row identical to
//       what `capture-pane -e -p -S -E` returns for the same range, colours included
//   3   a GUEST gets it too, and gets the same bytes the host does — that is the point of it
//   4   asking past the end clamps to what the pane kept, says atTop, and never exceeds the cap
//   5   the same range inside 2 s is one capture (the cached answer, proved by moving the pane
//       underneath it), and a different range is never served from that cache
//   6   on a real pty: PgUp pages BACK through actual host output, and the rows on the guest's
//       screen are rows `capture-pane -S` returns for the host pane
//   7   the status row says how far back it is scrolled and how many live frames are HELD
//   8   End returns to live, and the held frames land
//   9   F2 ⇄ mirror leaves the transcript in the terminal's native scrollback: every line still
//       there after two round trips, and every line exactly ONCE
//   10  /history all prints more than the default replay, under its own dim divider
//   11  the top-of-history line appears exactly once, however many times you hit the top
//   12  a client KILLED while the mirror is up gives the alternate screen back: tmux's
//       #{alternate_on} goes 1 → 0 on a SIGTERM and the transcript is on screen underneath
//
// HONESTY: there is no real `claude` here and none is needed — what is under test is tmux's
// scrollback, the daemon's capture and the client's rendering of it. The pane is a shell script
// that prints 400 numbered lines and then a TICK whenever a control file changes, so "the screen
// moved" is something this smoke decides rather than waits for. tmux, capture-pane, the daemon,
// both wire directions and a REAL ink client on a REAL pty are all genuine.
//
// Self-contained: its own $TMPDIR, its own port, two tmux sessions named jamscroll*, killed by
// exact name on its own socket. Costs nothing and needs no network.
//   usage: node scripts/smoke-scroll.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCREEN_HISTORY_MAX, SCREEN_CACHE_MS, MIRROR_CHROME } from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOST_MJS = path.join(ROOT, 'host.mjs');
const CLIENT = path.join(ROOT, 'client.mjs');
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
// Clear of jam's 7777, the shared smokes' 7799/7801, smoke-transport's 7811-7819,
// smoke-replay's 7823/7825, smoke-perm's 7831, smoke-lifecycle's 7851-7855, smoke-invite's 7861,
// smoke-answer's 7871, smoke-nudge's 7881 and smoke-discover's 7891-7895.
const PORT = 7901;
const NAME = 'jamscroll';
const INK = 'jamscrollink'; // a REAL ink client, on a real pty, as a GUEST
for (const n of [NAME, INK]) if (!n.startsWith('jamscroll')) throw new Error(`${n} is not this smoke's own name`);
const SOCKET = `claude-jam-${PORT}`;
const tmux = (...a) => spawnSync(TMUX, ['-L', SOCKET, ...a], { encoding: 'utf8' });
// Only ever the two session names this script made up itself, one exact name at a time.
const killMine = (n) => { if (n === NAME || n === INK) tmux('kill-session', '-t', `=${n}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
const ok = (cond, what) => { if (!cond) throw new Error(what); };
const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: got ${JSON.stringify(String(got).slice(0, 160))}, want ${JSON.stringify(String(want).slice(0, 160))}`);
};
async function until(what, pred, ms = 20000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const v = await pred();
    if (v) return v;
    await sleep(120);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

const CLAUDE_PANE = `${NAME}:claude`;
const paneRows = (target, from = 0) => (tmux('capture-pane', '-p', ...(from ? ['-S', String(from)] : []), '-t', target).stdout || '')
  .replace(/\n+$/, '').split('\n');
const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+$/, '');
// Keys into the guest client's pty. `-H` is raw bytes: the only way to send the exact CSI a
// terminal emits for PgUp, Home and End.
const hex = (...bytes) => tmux('send-keys', '-t', INK, '-H', ...bytes);
const type = (s) => tmux('send-keys', '-t', INK, '-l', s);
const enter = () => tmux('send-keys', '-t', INK, 'Enter');
const KEY = {
  pgup: ['1b', '5b', '35', '7e'], pgdn: ['1b', '5b', '36', '7e'],
  home: ['1b', '5b', '48'], end: ['1b', '5b', '46'],
  f2: ['1b', '4f', '51'],
};
const press = (k) => hex(...KEY[k]);
const show = (label, target, from = 0) => {
  const r = paneRows(target, from);
  console.log(`\n----- ${label} (${target}${from ? `, from ${from}` : ''}) -----`);
  console.log(r.join('\n'));
  console.log('-----------------------------------------------------------------\n');
};

// ------------------------------------------------------------------ fixtures ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-scroll-'));
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-scroll-bin-'));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-scroll-cwd-'));
const CTL = path.join(TMP, 'tick');
fs.writeFileSync(CTL, '0');
const FAKE = path.join(BIN, 'claude');
// 400 numbered lines, so the pane has REAL scrollback to page back through, and then one new
// line each time the control file changes — which is how this smoke makes "the screen moved"
// happen on purpose instead of waiting for something to move on its own.
// A real claude refuses an unknown option and exits; the probe at launch reads that, and a stub
// that swallowed every flag would stall the boot for the probe's whole budget.
fs.writeFileSync(FAKE,
  '#!/bin/sh\n'
  + 'for a in "$@"; do case "$a" in --claude-jam-probe-unknown-flag)'
  + ' echo "error: unknown option \'$a\'" >&2; exit 1;; esac; done\n'
  + 'i=1\n'
  + 'while [ $i -le 400 ]; do echo "SCROLLMARK $i"; i=$((i+1)); done\n'
  + 'echo "READY ❯"\n'
  + 'last=""\n'
  + 'while :; do\n'
  + `  now=$(cat "${CTL}" 2>/dev/null)\n`
  + '  if [ "$now" != "$last" ]; then last="$now"; echo "TICK $now"; fi\n'
  + '  sleep 0.2\n'
  + 'done\n', { mode: 0o755 });
let ticks = 0;
const tick = () => { ticks++; fs.writeFileSync(CTL, String(ticks)); return ticks; };

const ENV = { ...process.env, TMPDIR: TMP, JAM_CLAUDE: FAKE };
const TOKEN = 'scrollsmoketok';
const REPLAY = 5;   // what a joiner is shown
const HISTORY = 400; // what the ring keeps — /history is the difference between the two

// ------------------------------------------------------------------- clients ----
function connect(name, { host = false } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const c = { ws, name, events: [] };
  c.ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', name, token: TOKEN, ...(host ? { host: true } : {}) })));
    ws.addEventListener('message', (m) => {
      const ev = JSON.parse(m.data);
      c.events.push(ev);
      if (ev.t === 'welcome') res(c);
    });
    ws.addEventListener('error', rej);
    setTimeout(() => rej(new Error(`${name} never got a welcome`)), 10000);
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.since = () => c.events.length;
  c.waitAfter = (n, what, pred, ms) => until(`${name}: ${what}`, () => c.events.slice(n).find(pred), ms);
  return c;
}

// One screen-history round trip, always read from the frame that came back AFTER the ask.
async function askHistory(c, before, rows) {
  const n = c.since();
  c.send({ t: 'screen-history', before, rows });
  return c.waitAfter(n, `screen-history before=${before}`, (e) => e.t === 'screen-history');
}

// --------------------------------------------------------------------- setup ----
console.log(`smoke-scroll: port ${PORT}, socket ${SOCKET}, sessions ${NAME} + ${INK}`);
console.log(`  TMPDIR ${TMP}`);
killMine(NAME);
killMine(INK);
const boot = spawnSync(process.execPath, [HOST_MJS,
  '--tmux', NAME, '--port', String(PORT), '--view-port', String(PORT + 1),
  '--name', 'Host', '--token', TOKEN, '--hook-secret', 'scrollhooksecret',
  '--replay', String(REPLAY), '--history', String(HISTORY),
  '--no-announce', '--cwd', CWD, '--no-attach'], { env: ENV, encoding: 'utf8', stdio: 'pipe' });
if (boot.status !== 0) {
  console.error(boot.stdout, boot.stderr);
  killMine(NAME);
  process.exit(1);
}
// A pane tall enough that a page is a real page, and short enough that 400 lines are history.
tmux('resize-window', '-t', CLAUDE_PANE, '-x', '100', '-y', '30');

const host = connect('Host', { host: true });
const guest = connect('Dana');
let exitCode = 1;
try {
  await host.ready;
  await guest.ready;
  await until('the stand-in pane to finish printing', () => paneRows(CLAUDE_PANE).some((r) => /READY/.test(r)));

  // ------------------------------------------------ 1: there IS scrollback ----
  let depth = 0;
  await step('1  the claude pane really has scrollback for the mirror to reach into', async () => {
    depth = await until('a pane history worth paging through', () => {
      const n = Number((tmux('display-message', '-p', '-t', CLAUDE_PANE, '#{history_size}').stdout || '').trim());
      return n > 300 ? n : null;
    });
    console.log(`      #{history_size} = ${depth} lines above a 30-row pane`);
  });

  // ------------------------------- 2/3: the answer IS the pane's own history ----
  for (const [who, c] of [['a guest', guest], ['the host', host]]) {
    await step(`${who === 'a guest' ? '2' : '3'}  ${who} gets the pane's REAL history, row for row identical to capture-pane`, async () => {
      const before = 100;
      const rows = 20;
      const ev = await askHistory(c, before, rows);
      // The daemon's own range, computed the same way historyPageRange does: [-before, rows-1-before].
      const direct = (tmux('capture-pane', '-e', '-p', '-t', CLAUDE_PANE,
        '-S', String(-before), '-E', String(rows - 1 - before)).stdout || '').replace(/\n$/, '').split('\n');
      eq(ev.rows.length, direct.length, 'row count');
      for (let i = 0; i < direct.length; i++) {
        eq(plain(ev.rows[i]), plain(direct[i]), `row ${i} of the answer`);
      }
      ok(ev.rows.some((r) => /SCROLLMARK \d+/.test(r)), 'the rows are the pane\'s actual output');
      const nums = ev.rows.map((r) => Number(/SCROLLMARK (\d+)/.exec(plain(r))?.[1])).filter(Boolean);
      ok(nums.length >= 2 && nums.at(-1) === nums[0] + nums.length - 1, `the rows are consecutive: ${nums[0]}..${nums.at(-1)}`);
      console.log(`      ${who}: rows ${nums[0]}..${nums.at(-1)} of the host pane, ${ev.rows.length} of them, maxBefore ${ev.maxBefore}`);
      if (who === 'a guest') {
        console.log(`      first row verbatim: ${JSON.stringify(ev.rows[0].slice(0, 60))}`);
      }
    });
  }

  await step('3b the guest and the host are handed the SAME bytes — read-only is not a lesser view', async () => {
    const g = await askHistory(guest, 60, 12);
    const h = await askHistory(host, 60, 12);
    eq(JSON.stringify(g.rows), JSON.stringify(h.rows), 'guest rows vs host rows');
    eq(g.atTop, h.atTop, 'atTop');
    eq(g.maxBefore, h.maxBefore, 'maxBefore');
  });

  // ------------------------------------------------------- 4: the clamp ----
  await step('4  asking past the end clamps to what the pane kept, says so, and honours the cap', async () => {
    const ev = await askHistory(guest, 99999, 20);
    eq(ev.before, ev.maxBefore, 'a clamped ask comes back at the ceiling');
    eq(ev.atTop, true, 'and says it is at the top');
    ok(ev.maxBefore <= SCREEN_HISTORY_MAX, `maxBefore ${ev.maxBefore} is inside the ${SCREEN_HISTORY_MAX}-line cap`);
    ok(ev.maxBefore >= 300, `and it is the pane's real depth (${ev.maxBefore})`);
    ok(ev.rows.some((r) => /SCROLLMARK [1-9]\b/.test(plain(r))), 'the oldest page really is the oldest output');
    console.log(`      clamped to ${ev.before} (cap ${ev.cap}), oldest row ${JSON.stringify(plain(ev.rows[0]).slice(0, 40))}`);
  });

  // -------------------------------------------------------- 5: the cache ----
  await step('5  the same range inside 2 s is ONE capture; a different range never is', async () => {
    const first = await askHistory(guest, 50, 10);
    // Move the pane underneath it: a new line shifts every history offset by one.
    tick();
    await until('the pane to move', () => paneRows(CLAUDE_PANE).some((r) => /TICK 1\b/.test(r)));
    const cached = await askHistory(guest, 50, 10);
    eq(JSON.stringify(cached.rows), JSON.stringify(first.rows), 'the second ask inside the window is the cached answer');
    // A DIFFERENT range is never served from it, however fresh the cache is.
    const other = await askHistory(guest, 200, 10);
    ok(JSON.stringify(other.rows) !== JSON.stringify(first.rows), 'a different range gets its own capture');
    // And past the window it looks again — the pane moved, so the same offset is different rows.
    await sleep(SCREEN_CACHE_MS + 200);
    const fresh = await askHistory(guest, 50, 10);
    ok(JSON.stringify(fresh.rows) !== JSON.stringify(first.rows),
      'after the cache window the same offset is re-captured (the pane had moved)');
    console.log('      one capture per range per 2 s, and the staleness that buys is exactly that window');
  });

  // ------------------------------------------- the transcript, for later ----
  // 30 chat lines: far more than --replay 5, so the client that joins next is SHOWN five of them
  // and /history has 25 to go back for.
  for (let i = 1; i <= 30; i++) host.send({ t: 'chat', text: `SCROLLCHAT ${i}` });
  await until('the ring to hold all thirty', () => host.events.filter((e) => e.t === 'chat').length >= 30);

  // ------------------------------------------------- the real pty client ----
  // Wrapped in a shell that outlives it, so step 12 can look at the pane AFTER the client is
  // gone — a pane whose only command has exited takes the session with it.
  const born = tmux('new-session', '-d', '-s', INK, '-x', '110', '-y', '32',
    'sh', '-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(CLIENT)} `
      + `ws://127.0.0.1:${PORT} --name Guest --token ${TOKEN} --no-sound; sleep 120`);
  ok(born.status === 0, `tmux new-session: ${born.stderr}`);
  const inkRows = (from = 0) => paneRows(INK, from);
  const inkText = (from = 0) => inkRows(from).join('\n');
  await until('the guest client to open on the live TUI', () => /⧉ live TUI/.test(inkText())
    && inkRows().some((r) => /SCROLLMARK|TICK|READY/.test(r)), 30000);

  // ------------------------------------------------ 6: PgUp on a real pty ----
  let scrolledRows = [];
  await step('6  PgUp pages BACK through actual host output — and the rows are capture-pane\'s', async () => {
    const live = inkRows();
    ok(live.some((r) => /READY|TICK/.test(r)), 'the live view is the bottom of the pane');
    press('pgup');
    press('pgup');
    const row = await until('a scrolled-back row on the guest\'s screen', () => {
      const hit = inkRows().find((r) => /SCROLLMARK \d+/.test(r));
      const m = hit && /SCROLLMARK (\d+)/.exec(hit);
      // Older than what the live screen was showing: that is what "scrolled back" means.
      return m && Number(m[1]) < 380 ? hit : null;
    }, 15000);
    scrolledRows = inkRows().filter((r) => /SCROLLMARK \d+/.test(r))
      .map((r) => Number(/SCROLLMARK (\d+)/.exec(r)[1]));
    // Every one of those rows is a row the host pane really has, in the same order.
    const deep = (tmux('capture-pane', '-p', '-t', CLAUDE_PANE, '-S', '-2000', '-E', '-1').stdout || '').split('\n');
    const numbers = deep.map((r) => Number(/SCROLLMARK (\d+)/.exec(r)?.[1])).filter(Boolean);
    for (const n of scrolledRows) ok(numbers.includes(n), `SCROLLMARK ${n} is in the host pane's own scrollback`);
    ok(scrolledRows.at(-1) === scrolledRows[0] + scrolledRows.length - 1, 'and they are consecutive');
    console.log(`      guest is looking at SCROLLMARK ${scrolledRows[0]}..${scrolledRows.at(-1)} · first row: ${JSON.stringify(row.trim().slice(0, 60))}`);
  });

  // -------------------------------------------- 7: the status row says so ----
  await step('7  the status row says how far back it is, and how many live frames are HELD', async () => {
    const scrolled = await until('the scrolled status row', () => inkRows().find((r) => /scrolled back \d+ lines?/.test(r)), 10000);
    ok(/End\/G returns to live/.test(scrolled), `the row says the way out: ${JSON.stringify(scrolled.trim())}`);
    console.log(`      ${scrolled.trim()}`);
    // Now move the host pane while the guest is reading history: the frames must be HELD and
    // COUNTED, never painted over the page being read.
    const before = inkRows().filter((r) => /SCROLLMARK \d+/.test(r)).join('|');
    for (let i = 0; i < 3; i++) { tick(); await sleep(400); }
    const held = await until('the held-frame count', () => inkRows().find((r) => /live frames? waiting/.test(r)), 10000);
    console.log(`      ${held.trim()}`);
    const after = inkRows().filter((r) => /SCROLLMARK \d+/.test(r)).join('|');
    eq(after, before, 'the page being read did not move under the reader');
    ok(!inkRows().some((r) => new RegExp(`TICK ${ticks}\\b`).test(r)), 'and the newest live line is not on screen yet');
  });

  // ------------------------------------------------- 8: End returns to live ----
  await step('8  End returns to live, and the frames that were held land', async () => {
    press('end');
    await until('the live chip back', () => /⧉ live TUI/.test(inkText()) && !/scrolled back/.test(inkText()), 10000);
    await until(`TICK ${ticks} on the live screen`, () => inkRows().some((r) => new RegExp(`TICK ${ticks}\\b`).test(r)), 10000);
    console.log(`      back to live, and TICK ${ticks} — held while scrolled — is on screen`);
  });

  // ------------------------------ 11: the top-of-history line, exactly once ----
  await step('11 the top-of-history line appears exactly once, however often you hit the top', async () => {
    for (let i = 0; i < 3; i++) { press('home'); await sleep(700); }
    await until('the top-of-history line', () => /as far back as this jam kept/.test(inkText()), 10000);
    press('end');
    await until('live again', () => /⧉ live TUI/.test(inkText()) && !/scrolled back/.test(inkText()), 10000);
  });

  // ------------------------------------------- 9: the lossless F2 round trip ----
  await step('9  F2 ⇄ mirror leaves the transcript in native scrollback — nothing lost, nothing twice', async () => {
    press('f2');
    await until('the transcript view', () => /≡ transcript/.test(inkText()), 10000);
    const seen = () => paneRows(INK, -800);
    const count = (re) => seen().filter((r) => re.test(r)).length;
    const welcome = await until('the welcome line in the transcript', () => (count(/jam .*— host Host/) ? true : null), 10000);
    ok(welcome, 'the welcome block is in the terminal\'s own scrollback');
    const once = count(/as far back as this jam kept/);
    eq(once, 1, 'the top-of-history line, counted in the scrollback');
    console.log(`      ${seen().find((r) => /as far back as this jam kept/.test(r)).trim()}`);
    console.log(`      ${seen().find((r) => /F2 shows it/.test(r))?.trim() || '(the F2 hint row has expired)'}`);
    const chats = count(/SCROLLCHAT \d+/);
    ok(chats >= 1, `the replayed chat lines are there (${chats})`);
    // Two more round trips. The alternate screen is what makes this lossless: the mirror never
    // writes into this buffer, so nothing here is erased and nothing is reprinted.
    for (let i = 0; i < 2; i++) {
      press('f2');
      await until('the mirror', () => /⧉ live TUI/.test(inkText()), 10000);
      press('f2');
      await until('the transcript', () => /≡ transcript/.test(inkText()), 10000);
    }
    eq(count(/jam .*— host Host/), 1, 'the welcome line, after two more flips');
    eq(count(/as far back as this jam kept/), 1, 'the top-of-history line, after two more flips');
    eq(count(/SCROLLCHAT \d+/), chats, 'the chat lines, after two more flips');
    console.log(`      welcome ×1, top-of-history ×1, ${chats} chat line(s) — unchanged across three F2 round trips`);
  });

  // ------------------------------------------------------- 10: /history all ----
  await step('10 /history all prints more than the default replay, under its own divider', async () => {
    const seen = () => paneRows(INK, -1200);
    const chatNumbers = () => new Set(seen().flatMap((r) => {
      const m = /SCROLLCHAT (\d+)/.exec(r);
      return m ? [Number(m[1])] : [];
    }));
    const beforeSet = chatNumbers();
    ok(beforeSet.size <= REPLAY + 2, `the joiner was shown about --replay ${REPLAY} of them, not all thirty (${beforeSet.size})`);
    type('/history all');
    enter();
    await until('the /history divider', () => /earlier events? ·/.test(seen().join('\n')), 15000);
    // Wait for the WHOLE page, not for the first sign of it: <Static> paints 27 blocks over
    // several renders, and asserting on the first ten is asserting on a half-drawn screen.
    const afterSet = await until('every event the ring kept', () => {
      const found = chatNumbers();
      return found.size >= 30 ? found : null;
    }, 20000);
    const missing = [];
    for (let i = 1; i <= 30; i++) if (!afterSet.has(i)) missing.push(i);
    ok(!missing.length, `every chat line the ring kept is on screen (missing ${missing.join(',')})`);
    ok(afterSet.has(1), 'including the very first one');
    const divider = seen().find((r) => /earlier events? ·/.test(r));
    console.log(`      ${beforeSet.size} → ${afterSet.size} distinct chat lines · divider: ${JSON.stringify(divider.trim().slice(0, 78))}`);
  });

  // The evidence a human reads: the guest's scrolled-back mirror, and the same range straight
  // out of tmux, one under the other.
  press('f2');
  await until('the mirror once more', () => /⧉ live TUI/.test(inkText()), 10000);
  press('pgup');
  await sleep(1200);
  show('the guest client, mirror scrolled back', INK);
  console.log('----- the same range, straight from tmux -----');
  console.log((tmux('capture-pane', '-p', '-t', CLAUDE_PANE, '-S', String(-(32 - MIRROR_CHROME)), '-E', '-1').stdout || '').trimEnd());
  console.log('-----------------------------------------------------------------\n');
  press('end');
  await until('live again', () => !/scrolled back/.test(inkText()), 10000);

  // ------------------------------------ 12: killed while the mirror is up ----
  await step('12 a client killed while in the mirror leaves the terminal in the NORMAL buffer', async () => {
    // The evidence block above left this client in the live TUI; flip only if it did not.
    if (!/⧉ live TUI/.test(inkText())) press('f2');
    await until('the mirror', () => /⧉ live TUI/.test(inkText()), 10000);
    const altOn = () => (tmux('display-message', '-p', '-t', INK, '#{alternate_on}').stdout || '').trim();
    eq(await until('the alternate screen to be up', () => (altOn() === '1' ? '1' : null), 8000), '1',
      'the mirror really is drawn in the alternate screen buffer');
    // The pane's own shell is this smoke's child; its node child is the client. Kill THAT pid,
    // by pid — never a name, never a pattern.
    const shell = (tmux('display-message', '-p', '-t', INK, '#{pane_pid}').stdout || '').trim();
    ok(/^\d+$/.test(shell), `the pane pid is a number (${shell})`);
    const kid = (spawnSync('pgrep', ['-P', shell], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
    ok(/^\d+$/.test(kid), `the client pid is a child of the pane's shell (${kid})`);
    process.kill(Number(kid), 'SIGTERM');
    eq(await until('the alternate screen to be given back', () => (altOn() === '0' ? '0' : null), 10000), '0',
      'the terminal is back in the normal buffer');
    // And the transcript that was in that buffer is still there — the shell prompt lands under
    // it, not on top of a screen somebody has to `reset` their way out of.
    const after = paneRows(INK, -800);
    ok(after.some((r) => /SCROLLCHAT \d+/.test(r)), 'the transcript is on screen where the client left it');
    console.log(`      alternate_on 1 → SIGTERM → 0, and ${after.filter((r) => /SCROLLCHAT/.test(r)).length} transcript row(s) still there`);
  });

  show('the guest client, after the client was killed in the mirror view', INK);

  exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(`\nsmoke-scroll blew up: ${e.stack || e.message}`);
  failed++;
} finally {
  try { host.ws.close(); } catch { /* already gone */ }
  try { guest.ws.close(); } catch { /* already gone */ }
  killMine(INK);
  killMine(NAME);
  // Nothing of this run's is left running, and nothing of anybody else's was touched: both
  // names are this script's own and both kills name them exactly, on this port's own socket.
  const left = (tmux('list-sessions', '-F', '#{session_name}').stdout || '').split('\n').filter(Boolean);
  if (left.length) console.log(`note: sessions still on ${SOCKET}: ${left.join(', ')}`);
  for (const d of [TMP, BIN, CWD]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log(`\n--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'}`);
process.exit(failed ? 1 : exitCode);
