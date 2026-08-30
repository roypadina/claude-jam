#!/usr/bin/env node
// v0.23.1 smoke: the browser view (`--view`) is READ-ONLY, proved from the wire — the nineteenth
// smoke, and the first behavioural test this surface has ever had.
//   1   nothing is served without the credential: `/`, `/token`, `/index.html`, `/favicon.ico`
//       and the WEBSOCKET UPGRADE all answer 401, and a ws client with no Authorization is hung up
//   2   a viewer's keystroke does not reach the host's pane: a real ttyd INPUT frame carrying
//       `VIEWER_TYPED_THIS\r` leaves the pane's own stdin log empty
//   3   a viewer cannot move the host's window: the host is attached at 150x45, a browser opens
//       the view at 30x8 and then sends a ttyd RESIZE frame for 12x4, and the host's real claude
//       window does not budge
//   4   and that does not depend on which ttyd is installed: the SAME VIEW_SH under `ttyd -W`
//       (what ttyd <= 1.6.3 does with no flag at all) still cannot type into the pane
//   5   the viewer does get what the feature promises: a grouped session of its own, on the
//       `claude` window, with `status off` and real output frames — and the host's own session
//       keeps its status bar
//   6   teardown: the daemon's ttyd dies with the jam and no `*-view-*` grouped session is left
//
// WHY IT EXISTS. 0.23.0 and every release before it rested the read-only claim on one comment:
// "ttyd >= 1.7 is read-only unless -W is given". Two things were wrong with that. ttyd honours a
// RESIZE even when it refuses INPUT, so a viewer could drag the host's live claude window down to
// 12x4 (measured 2026-08-30: 150x44 -> 30x8 on connect, -> 12x4 on one frame); and the claim was
// a statement about a BINARY, not about the product — ttyd <= 1.6.3 is writable unless `-R`, and
// `--view-ttyd <path>` takes any binary. Step 4 is the canary for the second half: it is the only
// step here that would still pass if the tmux flags came back out, and it is why it runs ttyd
// with `-W` on purpose.
//
// HONESTY: there is no real `claude` — the pane runs `cat >> <log>`, which is BETTER than claude
// for this, because "a keystroke arrived" becomes a byte in a file rather than a judgement about
// a redraw. Everything else is real: a real daemon, a real tmux server, a real host client
// attached in a real pty, the REAL ttyd, and real WebSocket frames in ttyd's own protocol.
//
// Self-contained: its own $TMPDIR, its own ports, its own tmux sockets, sessions named jamview*,
// each killed by exact name. No claude, no cloudflared, no network. Costs nothing.
//   usage: node scripts/smoke-view.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { VIEW_SH, resolveTtyd } from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOST_MJS = path.join(ROOT, 'host.mjs');
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
// Clear of jam's 7777, smoke-transport's 7811-7819, smoke-replay's 7823/7825, smoke-perm's 7831,
// smoke-lifecycle's 7851-7855, smoke-invite's 7861, smoke-answer's 7871, smoke-discover's
// 7891-7895, smoke-scroll's 7901, smoke-adopt's 7921-7925 and smoke-peer's 7941/7943.
const PORT = 7951;       // the jam
const VIEW = 7952;       // the daemon's own ttyd, the one under test
const VIEW_W = 7953;     // step 4's ttyd, ours, run with -W on purpose
const NAME = 'jamview';
const DRIVE = 'jamviewdrive';                 // the pty the host client is attached in
const SOCKET = `claude-jam-${PORT}`;          // what tmuxSocketFor(PORT) names
const DRIVE_SOCKET = `claude-jam-${PORT}-ui`; // the driver is not a jam and has no daemon
const TOKEN = 'smokeviewtoken01';
for (const n of [NAME, DRIVE]) if (!n.startsWith('jamview')) throw new Error(`${n} is not this smoke's own name`);

const tmux = (...a) => spawnSync(TMUX, ['-L', SOCKET, ...a], { encoding: 'utf8' });
const dtmux = (...a) => spawnSync(TMUX, ['-L', DRIVE_SOCKET, ...a], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
let ran = 0;
async function step(label, fn) {
  ran++;
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: got ${JSON.stringify(String(got))}, want ${JSON.stringify(String(want))}`); };
const ok = (cond, what) => { if (!cond) throw new Error(what); };

// ------------------------------------------------------------------- fixtures ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-view-'));
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-view-bin-'));
const KEYLOG = path.join(TMP, 'keystrokes.log');
fs.writeFileSync(KEYLOG, '');
const FAKE = path.join(BIN, 'claude');
// The unknown-flag contract the system-prompt probe reads, then a pane whose stdin is a FILE:
// every byte anybody types into this pane is evidence on disk.
fs.writeFileSync(FAKE, '#!/bin/sh\nfor a in "$@"; do case "$a" in --claude-jam-probe-unknown-flag)'
  + ' echo "error: unknown option \'$a\'" >&2; exit 1;; esac; done\n'
  + `printf "FAKECLAUDEMARKER\\n"; exec cat >> ${KEYLOG}\n`, { mode: 0o755 });
const ENV = { ...process.env, TMPDIR: TMP, JAM_CLAUDE: FAKE };
const CWD = path.join(TMP, 'work');
fs.mkdirSync(CWD, { recursive: true });

const ours = [];                 // every pid this script spawned; the only pids it ever kills
const killMine = () => {
  for (const p of ours.splice(0)) { try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ } }
  // Only a session name this script made up, one exact name at a time, on that session's own
  // socket. Never a pattern, never a sweep, never a server we did not start.
  for (const [t, base] of [[tmux, NAME], [dtmux, DRIVE]]) {
    for (const s of (t('list-sessions', '-F', '#{session_name}').stdout || '')
      .split('\n').map((x) => x.trim()).filter(Boolean)) {
      if (s === base || s.startsWith(`${base}-view-`)) t('kill-session', '-t', `=${s}`);
    }
  }
};

// A raw request, so nothing about it is a library's idea of one — step 1 is about bytes on a
// socket, including a websocket upgrade that never reaches a websocket library.
function rawRequest(port, lines) {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(`${lines.join('\r\n')}\r\n\r\n`));
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('error', () => resolve('(connection error)'));
    c.on('close', () => resolve(buf));
    setTimeout(() => { c.destroy(); resolve(buf); }, 2000);
  });
}
const statusLine = (r) => (String(r).split('\r\n')[0] || '').trim();
const BASIC = `Basic ${Buffer.from(`jam:${TOKEN}`).toString('base64')}`;

// ttyd's own protocol, client side. `/token` hands back the AuthToken the server wants in the
// opening JSON_DATA message; then '0'+data is INPUT and '1'+json is RESIZE_TERMINAL.
async function viewer(port, { cols = 80, rows = 24, auth = true } = {}) {
  const at = await rawRequest(port, ['GET /token HTTP/1.1', `Host: 127.0.0.1:${port}`,
    `Authorization: ${BASIC}`, 'Connection: close']);
  const body = at.slice(at.indexOf('\r\n\r\n') + 4).trim();
  const authToken = (JSON.parse(body) || {}).token || '';
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['tty'],
    auth ? { headers: { Authorization: BASIC } } : {});
  const frames = [];
  ws.on('message', (d) => frames.push(Buffer.from(d)));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('the view never opened a websocket')), 6000);
  });
  ws.send(JSON.stringify({ AuthToken: authToken, columns: cols, rows: rows }));
  await sleep(1500);
  return {
    frames,
    type: (s) => ws.send(`0${s}`),
    resize: (c, r) => ws.send(`1${JSON.stringify({ columns: c, rows: r })}`),
    output: () => Buffer.concat(frames.filter((f) => f[0] === 0x30).map((f) => f.subarray(1))).toString('utf8'),
    close: () => ws.close(),
  };
}

const winSize = () => (tmux('display-message', '-p', '-t', `${NAME}:claude`,
  '#{window_width}x#{window_height}').stdout || '').trim();
const groupedSessions = () => (tmux('list-sessions', '-F', '#{session_name}').stdout || '')
  .split('\n').map((s) => s.trim()).filter((s) => s.startsWith(`${NAME}-view-`));
const keylog = () => fs.readFileSync(KEYLOG, 'utf8');
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A ttyd of OUR own running the product's VIEW_SH, for step 4. Same argv the daemon builds, plus
// whatever `extra` the step is making a point about.
function ourTtyd(ttyd, port, extra = []) {
  const child = spawn(ttyd, [...extra, '-p', String(port), '-c', `jam:${TOKEN}`,
    'sh', '-c', VIEW_SH, 'jam-view', TMUX, NAME, SOCKET], { stdio: 'ignore' });
  ours.push(child.pid);
  return child;
}

// --------------------------------------------------------------------- setup ----
console.log(`smoke-view: ports ${PORT}/${VIEW}/${VIEW_W}, socket ${SOCKET}, sessions ${NAME} ${DRIVE}`);
console.log(`  TMPDIR ${TMP}`);
const ttyd = resolveTtyd(process.env.JAM_TTYD_BIN || null, fs.existsSync);
if (!ttyd) {
  console.log('SKIP  there is no ttyd on this machine, and this smoke is about ttyd: brew install ttyd');
  process.exit(0);
}
console.log(`  ttyd ${ttyd} — ${(spawnSync(ttyd, ['--version'], { encoding: 'utf8' }).stdout || '').trim()}`);
killMine();

let exitCode = 1;
let ttydPid = 0;
try {
  const boot = spawnSync(process.execPath, [HOST_MJS, '--tmux', NAME, '--port', String(PORT),
    '--view-port', String(VIEW), '--name', 'Host', '--token', TOKEN,
    '--hook-secret', 'smokeviewhooksecret', '--cwd', CWD, '--view', '--view-ttyd', ttyd,
    '--tmux-socket', SOCKET, '--no-attach', '--no-announce', '--no-popup'],
  { env: ENV, encoding: 'utf8' });
  if (boot.status !== 0) throw new Error(`could not boot the jam: ${boot.stdout}${boot.stderr}`);
  await sleep(3000);
  const daemonLog = tmux('capture-pane', '-p', '-S', '-200', '-t', `${NAME}:daemon`).stdout || '';
  ttydPid = Number((/ttyd pid (\d+)/.exec(daemonLog) || [])[1] || 0);
  if (!ttydPid) throw new Error(`the daemon never logged a ttyd pid — it said:\n${daemonLog}`);
  ours.push(ttydPid);

  // A REAL host client, attached in a real pty at a size nothing else would pick, so step 3's
  // "the host did not move" is a claim about a host that was actually there.
  dtmux('new-session', '-d', '-s', DRIVE, '-x', '150', '-y', '45',
    `${TMUX} -L ${SOCKET} attach -t ${NAME}:claude`);
  await sleep(1500);
  const hostSize = winSize();
  console.log(`  host attached at 150x45; the jam's claude window is ${hostSize}`);
  if (!/^150x/.test(hostSize)) throw new Error(`the host client did not size the window: ${hostSize}`);

  // ------------------------------------------------- 1: nothing without the credential ----
  await step('1  the view serves nothing without the credential — pages AND the ws upgrade', async () => {
    for (const p of ['/', '/token', '/index.html', '/favicon.ico', '/ws']) {
      const r = await rawRequest(VIEW, [`GET ${p} HTTP/1.1`, `Host: 127.0.0.1:${VIEW}`, 'Connection: close']);
      ok(/^HTTP\/1\.1 401\b/.test(statusLine(r)), `GET ${p} unauthenticated answered ${statusLine(r)}`);
    }
    // The upgrade itself, not just a GET of the same path: this is the request a viewer's browser
    // actually makes, and it is the one that would hand out a terminal.
    const upgrade = await rawRequest(VIEW, ['GET /ws HTTP/1.1', `Host: 127.0.0.1:${VIEW}`,
      'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Protocol: tty']);
    ok(!/101/.test(upgrade), `an unauthenticated upgrade was accepted: ${statusLine(upgrade)}`);
    // And a real ws client with no Authorization is refused rather than left hanging.
    let refused = false;
    try { await viewer(VIEW, { auth: false }); } catch { refused = true; }
    ok(refused, 'a websocket with no credential was allowed to open');
  });

  // ------------------------------------------------- 2 & 3: read-only, from the wire ----
  let v;
  await step('2  a viewer\'s keystroke does not reach the host\'s pane', async () => {
    const before = keylog();
    v = await viewer(VIEW, { cols: 30, rows: 8 });
    eq(groupedSessions().length, 1, 'the viewer got exactly one grouped session of its own');
    v.type('VIEWER_TYPED_THIS\r');
    await sleep(1500);
    const delta = keylog().slice(before.length);
    eq(delta, '', `the pane's stdin received ${JSON.stringify(delta)} — the view is WRITABLE`);
    ok(!tmux('capture-pane', '-p', '-t', `${NAME}:claude`).stdout.includes('VIEWER_TYPED_THIS'),
      'the typed text is on the host\'s pane');
  });

  await step('3  a viewer cannot move the host\'s window, on connect or by asking', async () => {
    eq(winSize(), hostSize, `just connecting a 30x8 viewer resized the host from ${hostSize}`);
    v.resize(12, 4);
    await sleep(1500);
    eq(winSize(), hostSize, `a ttyd RESIZE frame for 12x4 resized the host from ${hostSize}`);
  });

  // ------------------------------------------------- 4: THE CANARY ----
  await step('4  and it holds on a WRITABLE ttyd — the guarantee is not the binary\'s version', async () => {
    // `-W` is precisely what ttyd <= 1.6.3 does with no flag, and `--view-ttyd` accepts one.
    // If the tmux client flags ever come back out of VIEW_SH, this step is the one that fails.
    ourTtyd(ttyd, VIEW_W, ['-W']);
    await sleep(1500);
    const before = keylog();
    const w = await viewer(VIEW_W);
    w.type('OLD_TTYD_PWN\r');
    await sleep(1500);
    const delta = keylog().slice(before.length);
    w.close();
    eq(delta, '', `under \`ttyd -W\` the pane's stdin received ${JSON.stringify(delta)}`);
    eq(winSize(), hostSize, 'under `ttyd -W` the viewer moved the host\'s window');
  });

  // ------------------------------------------------- 5: the feature still works ----
  await step('5  the viewer still gets the claude window, its output, and no status bar', async () => {
    const text = v.output();
    ok(text.length > 0, 'the viewer received no output frames at all');
    ok(text.includes('FAKECLAUDEMARKER'), `the viewer is not looking at the claude pane: ${JSON.stringify(text.slice(0, 200))}`);
    const [sess] = groupedSessions();
    ok(sess, 'the viewer has no grouped session');
    eq((tmux('display-message', '-p', '-t', sess, '#{window_name}').stdout || '').trim(), 'claude',
      'the viewer\'s session is not pinned to the claude window');
    eq((tmux('show-options', '-t', sess, '-v', 'status').stdout || '').trim(), 'off',
      'the viewer\'s own status bar is not off');
    // `status off` was set on the VIEWER's session, never the host's.
    ok((tmux('show-options', '-t', NAME, '-v', 'status').stdout || '').trim() !== 'off',
      'the host\'s status bar was turned off by a viewer connecting');
    // The credential is the join token when one is set, so a view URL leak IS a join-token leak.
    // Documented, deliberate, and stated here so the fact stays visible next to the surface.
    v.close();
    await sleep(1000);
    eq(groupedSessions().length, 0, 'the grouped session outlived the browser');
  });

  // ------------------------------------------------- 6: teardown ----
  await step('6  the ttyd child dies with the jam, and leaves no grouped session behind', async () => {
    ok(running(ttydPid), `the daemon's ttyd (${ttydPid}) was not running to begin with`);
    tmux('kill-session', '-t', `=${NAME}`);
    await sleep(2500);
    ok(!running(ttydPid), `the daemon's ttyd (${ttydPid}) outlived the jam`);
    eq(groupedSessions().length, 0, 'a *-view-* grouped session outlived the jam');
  });

  // The vacuity guard: six steps, and the count is asserted, because a suite that runs none of
  // them and prints nothing but a summary is exactly how smoke-nudge passed while doing nothing.
  const EXPECTED = 6;
  if (ran !== EXPECTED) {
    failed++;
    console.log(`FAIL  the suite ran ${ran} of ${EXPECTED} steps`);
  }
  console.log(failed ? `\nsmoke-view: ${failed} FAILED of ${ran}` : `\nsmoke-view: all ${ran} steps passed`);
  exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(`smoke-view: ${e.message}`);
} finally {
  killMine();
  try { fs.rmSync(BIN, { recursive: true, force: true }); } catch { /* nothing to remove */ }
}
process.exit(exitCode);
