#!/usr/bin/env node
// 0.23.6 check: does a stop/notification hook actually REACH the daemon — and when it cannot, does
// it say so anywhere at all?
//
// Through 0.23.5 `hooks.sh` posted those two events with `curl -s -m 2 … || true`. On a box with no
// curl the jam ran normally and every one of them was dropped: no idle signal, no turn-end nudge,
// and no error, because the thing that failed IS the report. Runtime rather than launch, and
// silent, which is the worst pair. 0.23.5 took the same dependency out of `waitForHealth()`; this
// is the one it left.
//
// The pure half (`hookErrorNote`) has unit tests and a lint says the word `curl` is gone. What has
// none of that is whether the real hooks.sh, run the way Claude Code runs it, posts the payload,
// removes the marker when it lands, and writes the marker when it does not — the same gap that made
// `check-terminal-gate.mjs` necessary, where the pure function was right and the caller handed it
// an empty environment.
//
// It costs nothing: no tmux, no claude, no jam, no network off loopback. The "daemon" is an
// http.createServer in this process, and the state dir is an mkdtemp of this run's own, removed by
// its exact path at the end.
//   usage: node scripts/check-hook-post.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOOK_ERROR_FILE, hookErrorNote } from '../lib.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOKS = path.join(ROOT, 'hooks.sh');
const SECRET = 'checkhookpostsecret';
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// Same three outcomes, same words, as check-state-privacy.mjs and check-discovery-refusal.mjs —
// these are read side by side in one CI log. FAIL is the only one that exits non-zero.
class Skip extends Error {}
const skip = (why) => { throw new Skip(why); };

let failed = 0;
let skipped = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    if (e instanceof Skip) { skipped++; console.log(`NOT EXERCISED  ${name} — ${e.message}`); return; }
    failed++;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

// This run's own directory, by the exact path mkdtemp handed back. Never a pattern, never a sweep.
const STATE = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jam-hookcheck-'));
const marker = path.join(STATE, HOOK_ERROR_FILE);
const readMarker = () => { try { return fs.readFileSync(marker, 'utf8'); } catch { return null; } };

// bash by ABSOLUTE path: one of the checks below hands the hook an empty PATH (that is the point of
// it), and a bash looked up through PATH would not be found at all.
const BASH = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'].find((p) => fs.existsSync(p));

// How Claude Code runs a hook: argv[1] is the event, the payload is on stdin, and the JAM_* env the
// daemon put in claude's environment is all it has. JAM_NODE is the daemon's own node, because the
// PATH claude inherited may have none.
//
// spawn, NOT spawnSync: the stand-in daemon is an http server in THIS process, and spawnSync blocks
// the event loop that would answer it — every request would time out and the check would "prove"
// the opposite of the truth.
const runHook = (event, payload, extra = {}) => new Promise((resolve, reject) => {
  const child = spawn(BASH, [HOOKS, event], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JAM_STATE: STATE,
      JAM_PORT: String(PORT),
      JAM_HOOK_SECRET: SECRET,
      JAM_NODE: process.execPath,
      ...extra,
    },
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.on('error', reject);
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000); // this child's own pid, by pid
  child.on('close', (status) => { clearTimeout(timer); resolve({ status, out }); });
  child.stdin.end(payload);
});

// A port nothing else in this repo uses (smoke-view holds 7951–7953, smoke-peer 7941/7943).
const PORT = 7961;
const DEAD_PORT = 7963;
const DAEMON_PORT = 7965;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const listen = (port, onHook) => new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      onHook({ url: req.url, method: req.method, secret: req.headers['x-jam-secret'], body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  server.on('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server));
});

const reachable = (port) => new Promise((resolve) => {
  const probe = createServer();
  probe.on('error', () => resolve(true));           // somebody else already holds it
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
});

console.log(`--- claude-jam ${VERSION} stop/notification hook delivery, on ${process.platform} ---`);
console.log(`      state ${STATE}`);

if (process.platform === 'win32') {
  console.log('NOT EXERCISED  the whole check — hooks.sh is bash, and Windows has no jam host to '
    + 'run it (windowsCli refuses every host-side command with the WSL2 route)');
  console.log('\n--- RESULT --- all checks passed, 1 branch NOT EXERCISED (see above)');
  fs.rmSync(STATE, { recursive: true, force: true });
  process.exit(0);
}

let received = [];
let server = null;
try {
  server = await listen(PORT, (r) => received.push(r));
} catch (e) {
  console.log(`NOT EXERCISED  every delivery check — could not listen on 127.0.0.1:${PORT} (${e.message})`);
}

if (server) {
  await check('a stop hook REACHES the daemon: right path, right secret, the payload intact', async () => {
    received = [];
    fs.writeFileSync(marker, '{"event":"stale","at":"","error":"left by an earlier failure"}\n');
    const r = await runHook('stop', '{"session_id":"abc","hook_event_name":"Stop"}');
    ok(r.status === 0, `hooks.sh exited ${r.status} — a hook must never break the claude session`);
    ok(received.length === 1, `the daemon got ${received.length} requests, wanted 1`);
    const got = received[0];
    ok(got.url === '/hook/stop', `it posted to ${got.url}`);
    ok(got.method === 'POST', `it used ${got.method}`);
    ok(got.secret === SECRET, `the x-jam-secret header was ${JSON.stringify(got.secret)}`);
    // notification reads `payload.message` off this body, so an empty one is a silent half-failure.
    ok(got.body === '{"session_id":"abc","hook_event_name":"Stop"}', `the payload arrived as ${JSON.stringify(got.body)}`);
    // And the marker a previous failure left is gone: the file means "the LAST attempt was lost".
    ok(readMarker() === null, `${HOOK_ERROR_FILE} survived a hook that landed — it would be logged forever`);
  });

  await check('and it reaches the daemon with NO CURL ON PATH AT ALL — the defect, directly', async () => {
    received = [];
    // An empty directory as the whole PATH: no curl, no node, nothing. JAM_NODE is absolute, which
    // is why this works — and is the reason the daemon exports it.
    const emptyDir = path.join(STATE, 'empty-path');
    fs.mkdirSync(emptyDir, { recursive: true });
    const r = await runHook('notification', '{"message":"claude needs your permission"}', { PATH: emptyDir });
    ok(r.status === 0, `hooks.sh exited ${r.status} with an empty PATH`);
    ok(received.length === 1, `the daemon got ${received.length} requests with no curl on PATH, wanted 1`);
    ok(received[0].url === '/hook/notification', `it posted to ${received[0].url}`);
    ok(received[0].body.includes('needs your permission'), `the payload arrived as ${JSON.stringify(received[0].body)}`);
    ok(readMarker() === null, `${HOOK_ERROR_FILE} was written for a hook that landed`);
  });
}

await check('a hook that CANNOT reach the daemon writes down why, and still exits 0', async () => {
  if (await reachable(DEAD_PORT)) skip(`something is listening on 127.0.0.1:${DEAD_PORT}, so there is no `
    + 'refused connection to observe');
  fs.rmSync(marker, { force: true });
  const r = await runHook('stop', '{"hook_event_name":"Stop"}', { JAM_PORT: String(DEAD_PORT) });
  ok(r.status === 0, `hooks.sh exited ${r.status} — a dropped hook must not break the claude session`);
  const raw = readMarker();
  ok(raw !== null, `nothing was written to ${HOOK_ERROR_FILE}: the hook was dropped SILENTLY, which is the bug`);
  const note = hookErrorNote(raw);
  ok(note !== null, `the daemon could not make a line out of it: ${JSON.stringify(raw)}`);
  ok(/^\[hook\] stop hook did NOT reach this daemon/.test(note), `the line does not name the event: ${note}`);
  console.log(`      the daemon would log: ${note}`);
});

await check('and when node itself will not run, BASH writes it down — the one case node cannot report', async () => {
  fs.rmSync(marker, { force: true });
  const r = await runHook('notification', '{}', {
    JAM_PORT: String(DEAD_PORT),
    JAM_NODE: path.join(STATE, 'there-is-no-node-here'),
  });
  ok(r.status === 0, `hooks.sh exited ${r.status}`);
  const note = hookErrorNote(readMarker());
  ok(note !== null, `nothing was written to ${HOOK_ERROR_FILE} when node could not start`);
  ok(/could not run/.test(note), `the line does not say node never ran: ${note}`);
  console.log(`      the daemon would log: ${note}`);
});

// The other half, and the half the two lines above only SAY: a REAL daemon has to notice the file
// and print it. Without this the marker is a file nobody reads, which is the same silence in a
// different place — and a lint that host.mjs calls hookErrorNote is exactly the shape of test this
// project has been bitten by twice.
//
// A bare `--daemon` needs no tmux session, no claude and no network: it binds loopback, is told not
// to announce, and is killed by the pid this check spawned. Its state dir is its own.
await check('a REAL daemon reads that file and LOGS it — the marker is not a file nobody reads', async () => {
  const dstate = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jam-hookdaemon-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'host.mjs'), '--daemon',
    '--port', String(DAEMON_PORT), '--host', '127.0.0.1', '--state', dstate,
    '--tmux', 'jamhookprobe', '--name', 'Host', '--hook-secret', SECRET, '--no-announce'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  try {
    const deadline = Date.now() + 20_000;
    while (!/claude-jam daemon on/.test(log) && Date.now() < deadline) await sleep(200);
    ok(/claude-jam daemon on/.test(log), `the probe daemon never came up:\n${log}`);
    fs.writeFileSync(path.join(dstate, HOOK_ERROR_FILE),
      '{"event":"stop","at":"2026-08-30T00:00:00Z","error":"probe: connection refused"}\n');
    // startHookWatch polls at 5 s, so this waits rather than sleeping a guessed amount.
    const seen = Date.now() + 20_000;
    while (!/\[hook\] stop hook did NOT reach/.test(log) && Date.now() < seen) await sleep(200);
    ok(/\[hook\] stop hook did NOT reach this daemon at 2026-08-30T00:00:00Z: probe: connection refused/.test(log),
      `the daemon never logged the dropped hook — it is still silent:\n${log}`);
    console.log(`      the daemon logged: ${log.split('\n').find((l) => l.startsWith('[hook]'))}`);
  } finally {
    child.kill('SIGTERM');                 // this check's own child, by pid, never by name
    await sleep(500);
    fs.rmSync(dstate, { recursive: true, force: true });   // the exact path mkdtemp gave us
  }
});

if (server) await new Promise((done) => server.close(done));
fs.rmSync(STATE, { recursive: true, force: true });

console.log(`\n--- RESULT --- ${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`
  + `${skipped ? `, ${skipped} branch(es) NOT EXERCISED (see above)` : ''}`);
process.exit(failed ? 1 : 0);
