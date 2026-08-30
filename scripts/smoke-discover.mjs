#!/usr/bin/env node
// v0.23 smoke: a jam says it exists on the local network, and the right people find the right
// things — the fourteenth smoke.
//   1   a jam advertises, and `claude-jam find` finds it: name, host, access mode and address
//       all match the jam that is actually running
//   2   --no-announce is NOT found, while the announcing jam beside it still is
//   3   THE REDACTION RULE, against the wire: with a token set, an invite minted and a real cwd,
//       the TXT record dns-sd hands back contains the token nowhere, the invite secret nowhere,
//       and no path at all — only the six keys
//   4   two jams on ONE machine are both listed and told apart, by name, by host, by access mode
//       and by address
//   5   a stale advertisement disappears: after `claude-jam end`, a fresh browse does not list it
//   6   the launcher's Join screen lists a discovered jam, with "paste a link or URL" last
//   7   `--json` is the same facts with no layout, and carries no credential either
//   8   discovery never bypasses a gate: the found knock jam still knocks, and the found token
//       jam refuses a connection that has no token
//
// HONESTY: there is no real `claude` here — the pane is `sleep`, because nothing in this smoke
// asks claude anything. Everything else is real: two real daemons, the real /usr/bin/dns-sd
// registering and browsing on the real local network, the real `claude-jam find` command, the
// real launcher menu in a real pty, and real WebSocket connections for the gate checks.
//
// IT ADVERTISES ON YOUR NETWORK, briefly and by design — that is the thing under test. Every
// registration is a child of this script, killed by its own pid on the way out (mDNS sends the
// goodbye when the registering process goes), and step 5 proves the deregistration worked.
//
// Self-contained: its own $TMPDIR, its own ports, its own tmux socket, three sessions named
// jamdisco*, each killed by exact name. No real claude, ttyd or cloudflared. Costs nothing.
//   usage: node scripts/smoke-discover.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDnssdZone, discoveredJams, findJson, DISCOVERY_TYPE, DISCOVERY_DOMAIN,
  DISCOVERY_TXT_KEYS, JOIN_PASTE_VALUE, hostKeyPath } from '../lib.mjs';
import { readHostKey } from '../platform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOST_MJS = path.join(ROOT, 'host.mjs');
const JAM = path.join(ROOT, 'claude-jam');
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
// Clear of jam's 7777, the shared smokes' 7799/7801, smoke-transport's 7811-7819,
// smoke-replay's 7823/7825, smoke-perm's 7831, smoke-lifecycle's 7851-7855, smoke-invite's 7861,
// smoke-answer's 7871.
const PORT_A = 7891; // the announcing knock jam
const PORT_B = 7893; // the announcing token jam, on the same machine
const PORT_C = 7895; // --no-announce: running, and deliberately silent
// Each jam gets a tmux server of its own, named for its port — that is what tmuxSocketFor()
// does — so a session and its socket are a PAIR and neither is usable without the other. Getting
// this wrong is not a harmless miss: the kill silently does nothing, the daemon keeps running
// and its advertisement stays up on the network. (It did, on the first run of this file. The
// teardown check at the bottom is what caught it, which is why that check exists.)
const SOCKETS = {
  jamdiscoa: `claude-jam-${PORT_A}`,
  jamdiscob: `claude-jam-${PORT_B}`,
  jamdiscoc: `claude-jam-${PORT_C}`,
  jamdiscoui: `claude-jam-${PORT_A}`, // the launcher pty; it is not a jam and has no daemon
};
const NAMES = Object.keys(SOCKETS);
for (const n of NAMES) if (!n.startsWith('jamdisco')) throw new Error(`${n} is not this smoke's own name`);
const SOCKET = SOCKETS.jamdiscoui;
const tmux = (...a) => spawnSync(TMUX, ['-L', SOCKET, ...a], { encoding: 'utf8' });
// Only ever a session name this script made up itself, one exact name, on THAT session's own
// socket. Never a pattern, never a sweep, never another socket's server.
const killMine = (n) => {
  const sock = SOCKETS[n];
  if (!sock) return;
  spawnSync(TMUX, ['-L', sock, 'kill-session', '-t', `=${n}`], { encoding: 'utf8' });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: got ${JSON.stringify(String(got).slice(0, 160))}, want ${JSON.stringify(String(want).slice(0, 160))}`); };
const ok = (cond, what) => { if (!cond) throw new Error(what); };

// ------------------------------------------------------------------ fixtures ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-disco-'));
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-disco-bin-'));
const FAKE = path.join(BIN, 'claude');
// A real claude refuses an unknown option and exits — that is what the system-prompt probe reads,
// and a stub that swallowed every flag would stall the launch for the probe's whole budget.
fs.writeFileSync(FAKE, '#!/bin/sh\nfor a in "$@"; do case "$a" in --claude-jam-probe-unknown-flag)'
  + ' echo "error: unknown option \'$a\'" >&2; exit 1;; esac; done\nexec sleep 900\n', { mode: 0o755 });
const ENV = { ...process.env, TMPDIR: TMP, JAM_CLAUDE: FAKE };
// The cwd basenames ARE the default jam names, which is half of what step 1 checks. They contain
// a space on purpose: dns-sd escapes a space in an instance label as `\032`, and a smoke that
// only ever used single-word names would never exercise the unescape.
const CWD_A = path.join(TMP, 'reeco debugging');
const CWD_B = path.join(TMP, 'the other one');
const CWD_C = path.join(TMP, 'the quiet one');
for (const d of [CWD_A, CWD_B, CWD_C]) fs.mkdirSync(d, { recursive: true });
const TOKEN_B = 'discosmoketokenb';

const boot = (name, port, cwd, extra) => spawnSync(process.execPath, [HOST_MJS,
  '--tmux', name, '--port', String(port), '--view-port', String(port + 1),
  '--name', name === 'jamdiscoa' ? 'Roy' : name === 'jamdiscob' ? 'Dana' : 'Yossi',
  '--hook-secret', `${name}hooksecret`, '--cwd', cwd, '--no-attach', ...extra],
{ env: ENV, encoding: 'utf8', stdio: 'pipe' });

// A browse of our own, so a step can look at the RAW record rather than at what the table made
// of it. Same binary and same flags the tool uses; the child is ours and dies by its pid.
async function browseRaw(ms = 3500) {
  const p = spawn('/usr/bin/dns-sd', ['-Z', DISCOVERY_TYPE, DISCOVERY_DOMAIN], { stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  p.stdout.on('data', (d) => { text += d; });
  p.on('error', () => { /* answered by the empty text */ });
  await sleep(ms);
  try { p.kill('SIGTERM'); } catch { /* already gone */ }
  return text;
}
const findCmd = (args = []) => spawnSync(JAM, ['find', ...args], { env: ENV, encoding: 'utf8' });
// Only OUR jams: somebody else on this network may legitimately be running claude-jam, and a
// smoke that asserted on the whole listing would fail because of them rather than because of us.
const mine = (rows) => rows.filter((r) => [PORT_A, PORT_B, PORT_C].includes(r.port));

// --------------------------------------------------------------------- setup ----
console.log(`smoke-discover: ports ${PORT_A}/${PORT_B}/${PORT_C}, socket ${SOCKET}, sessions ${NAMES.join(' ')}`);
console.log(`  TMPDIR ${TMP}`);
console.log('  NOTE: this really does advertise on your local network for ~1 minute, by design.');
console.log('        Every registration is a child of this script and dies with it; step 5 proves it.');
if (!fs.existsSync('/usr/bin/dns-sd')) {
  console.log('SKIP  there is no /usr/bin/dns-sd on this machine, so there is nothing to smoke');
  process.exit(0);
}
for (const n of NAMES) killMine(n);

let exitCode = 1;
try {
  for (const [n, p, cwd, extra] of [['jamdiscoa', PORT_A, CWD_A, []],
    ['jamdiscob', PORT_B, CWD_B, ['--token', TOKEN_B]],
    ['jamdiscoc', PORT_C, CWD_C, ['--no-announce']]]) {
    const r = boot(n, p, cwd, extra);
    if (r.status !== 0) { console.error(`could not boot ${n}:`, r.stdout, r.stderr); throw new Error(`boot ${n}`); }
  }
  // mDNS registration takes a beat (dns-sd probes for a name conflict before it claims one).
  await sleep(3000);
  // ONE browse, shared by the steps that ask different questions of the same moment. Steps 1-4
  // are four assertions about one state of the network, and browsing four times would let it
  // change underneath them.
  const browsedOnce = await browseRaw(3500);

  // --------------------------------------------- 1: it advertises, and find finds it ----
  let rows = [];
  await step('1  a jam advertises, and `claude-jam find` finds it with the right facts', () => {
    const r = findCmd();
    eq(r.status, 0, 'claude-jam find exit code');
    rows = mine(discoveredJams(parseDnssdZone(browsedOnce)));
    const a = rows.find((x) => x.port === PORT_A);
    ok(a, `the knock jam on :${PORT_A} was not found — the listing was:\n${r.stdout}`);
    // The default name is the cwd's basename, and it survived the `\032` escaping intact.
    eq(a.jam, 'reeco debugging', 'the jam name');
    eq(a.host, 'Roy', "the host's display name");
    eq(a.access, 'knock', 'the access mode');
    eq(a.view, false, 'the browser view flag');
    eq(a.port, PORT_A, 'the port');
    ok(/^[A-Za-z0-9][A-Za-z0-9.-]*:\d+$/.test(a.address), `the address looks like one: ${a.address}`);
    eq(a.url, `ws://${a.address}`, 'the join URL is the address');
    eq(a.id.length, 8, `the session id is 8 characters: ${a.id}`);
    // And the human-facing table said the same thing.
    ok(r.stdout.includes('reeco debugging'), 'the printed table names the jam');
    ok(r.stdout.includes(a.address), 'the printed table gives the address');
    ok(/finding a jam is not being let into it/.test(r.stdout), 'the table states the gate');
  });

  // ------------------------------------------------ 2: --no-announce is not there ----
  await step('2  --no-announce is running but NOT on the network, while its neighbour is', async () => {
    // It really is up: the daemon answers on its port.
    const health = await fetch(`http://127.0.0.1:${PORT_C}/health`).then((x) => x.json()).catch(() => null);
    eq(health?.ok, 'ok', `the --no-announce jam on :${PORT_C} is running`);
    eq(rows.some((r) => r.port === PORT_C), false, 'the silent jam must not be advertised');
    eq(rows.some((r) => r.jam === 'the quiet one'), false, 'and not under its name either');
    // The proof that this is about --no-announce and not about the browse: its neighbours ARE here.
    ok(rows.some((r) => r.port === PORT_A), 'the announcing jam beside it is found');
    ok(rows.some((r) => r.port === PORT_B), 'and so is the second one');
  });

  // ------------------------------------ 3: the redaction rule, against the wire ----
  await step('3  the TXT record carries no token, no invite secret and no path', () => {
    // Mint a real invite on the token jam first, so there IS a secret in the daemon to leak.
    const inv = spawnSync(JAM, ['invite', 'Yossi', '--jam', 'jamdiscob'], { env: ENV, encoding: 'utf8' });
    const link = (inv.stdout || '').split('\n').map((l) => l.trim()).find((l) => /cjam\d_/.test(l));
    ok(link, `a link was minted, so there is a secret to leak: ${(inv.stderr || inv.stdout || '').slice(0, 200)}`);

    // The RAW record, exactly as dns-sd printed it — not what our own parser made of it.
    const txtLines = browsedOnce.split('\n').filter((l) => /\s+TXT\s+/.test(l) && /_claude-jam\._tcp/.test(l));
    ok(txtLines.length, 'dns-sd printed at least one TXT record');
    const blob = txtLines.join('\n');
    for (const leak of [TOKEN_B, link, 'cjam1_', TMP, CWD_A, CWD_B, '/var/folders', '/tmp/',
      'jamdiscoahooksecret', 'jamdiscobhooksecret']) {
      eq(blob.includes(leak), false, `${String(leak).slice(0, 40)} appeared in a TXT record`);
    }
    // Not a path, under any spelling: a record that carried one would have a `/` in it.
    eq(/\//.test(blob.replace(/^\S+\s+TXT\s+/gm, '')), false, `a TXT value contains a slash:\n${blob}`);
    // And it is the six keys, no more: the allow-list held on the wire, not just in a unit test.
    for (const line of txtLines) {
      const keys = [...line.matchAll(/"([^"=]+)=/g)].map((m) => m[1]);
      eq(keys.join(','), DISCOVERY_TXT_KEYS.join(','), `the keys of ${line.trim().slice(0, 90)}`);
    }
    // The token jam DID say it wants a token — the mode is published, the credential is not.
    const b = rows.find((r) => r.port === PORT_B);
    eq(b.access, 'token', 'the token jam publishes that it is a token jam');
  });

  // ------------------------------------------ 4: two jams, both listed, told apart ----
  await step('4  two jams on one machine are both listed and distinguishable', () => {
    const a = rows.find((r) => r.port === PORT_A);
    const b = rows.find((r) => r.port === PORT_B);
    ok(a && b, `both are listed (found ${rows.length}: ${rows.map((r) => r.jam).join(', ')})`);
    eq(b.jam, 'the other one', "the second jam's name");
    eq(b.host, 'Dana', "the second jam's host");
    // Four independent things tell them apart, and no two of them collide.
    ok(a.jam !== b.jam, 'different names');
    ok(a.host !== b.host, 'different hosts');
    ok(a.access !== b.access, 'different access modes');
    ok(a.address !== b.address, 'different addresses');
    ok(a.id !== b.id, 'different session ids');
    // They share a machine, and the listing does not pretend otherwise.
    eq(a.target, b.target, 'they really are on the same host');
  });

  // --------------------------------------------------- 7: --json, same facts ----
  await step('7  --json is the same facts with no layout, and no credential', () => {
    const r = findCmd(['--json']);
    eq(r.status, 0, 'claude-jam find --json exit code');
    const j = JSON.parse(r.stdout);
    ok(Array.isArray(j), '--json is an array');
    const a = j.find((x) => x.port === PORT_A);
    ok(a, 'the knock jam is in the JSON');
    eq(a.jam, 'reeco debugging', 'the name');
    eq(a.access, 'knock', 'the access mode');
    eq(a.view, false, 'the view flag');
    eq(a.url, `ws://${a.address}`, 'the URL');
    // Exactly the shape findJson promises, and nothing that is a secret or a path.
    eq(Object.keys(a).sort().join(','), Object.keys(findJson([a])[0]).sort().join(','), 'the JSON shape');
    eq(r.stdout.includes(TOKEN_B), false, 'the token is not in --json');
    eq(/hooksecret|cjam1_/.test(r.stdout), false, 'no secret is in --json');
    // …and nothing was printed around it, because --json is for a script.
    eq(/looking for jams/.test(r.stdout), false, '--json prints no progress line');
  });

  // ------------------------------------ 8: discovery never bypasses a gate ----
  await step('8  a found jam still has its door: the token jam refuses a tokenless connection', async () => {
    const b = rows.find((r) => r.port === PORT_B);
    // Connect on loopback with exactly what discovery gave us — an address and a name — and
    // nothing else. The daemon must NOT let this in.
    const refusal = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${b.port}`);
      const done = (v) => { try { ws.close(); } catch { /* gone */ } resolve(v); };
      ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'Uninvited' })));
      ws.addEventListener('message', (m) => {
        const ev = JSON.parse(m.data);
        if (ev.t === 'welcome') done({ admitted: true });
        if (ev.t === 'error') done({ admitted: false, why: ev.text || ev.error || '' });
      });
      ws.addEventListener('close', (e) => done({ admitted: false, why: e.reason || `close ${e.code}` }));
      setTimeout(() => done({ admitted: false, why: 'no answer' }), 6000);
    });
    eq(refusal.admitted, false, `the token jam admitted a connection that only knew its address (${refusal.why})`);
    // And the knock jam does not hand out a welcome either — it makes you wait for the host.
    const knock = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT_A}`);
      const done = (v) => { try { ws.close(); } catch { /* gone */ } resolve(v); };
      ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'Knocker' })));
      ws.addEventListener('message', (m) => { if (JSON.parse(m.data).t === 'welcome') done({ admitted: true }); });
      setTimeout(() => done({ admitted: false }), 5000);
    });
    eq(knock.admitted, false, 'a knock jam let somebody in without the host answering');
  });

  // ------------------------------------------- 6: the Join screen lists it ----
  await step('6  the launcher Join screen lists a discovered jam, paste-a-link last', async () => {
    killMine('jamdiscoui');
    // A real pty, because this is an ink app and what matters is what a human sees.
    tmux('new-session', '-d', '-s', 'jamdiscoui', '-x', '120', '-y', '30',
      `cd ${JSON.stringify(ROOT)} && TMPDIR=${JSON.stringify(TMP)} ${JSON.stringify(JAM)} join; sleep 30`);
    let screen = '';
    for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
      screen = tmux('capture-pane', '-p', '-t', 'jamdiscoui').stdout;
      if (/reeco debugging/.test(screen) && /paste a link or URL/.test(screen)) break;
      await sleep(400);
    }
    ok(/Join a jam/.test(screen), `the Join screen opened:\n${screen}`);
    ok(/reeco debugging/.test(screen), `it lists the discovered jam:\n${screen}`);
    ok(/the other one/.test(screen), `and the second one:\n${screen}`);
    ok(!/the quiet one/.test(screen), `and not the silent one:\n${screen}`);
    // The fallback is the LAST row, and it never disappears.
    const lines = screen.split('\n').map((l) => l.trim()).filter(Boolean);
    const pasteAt = lines.findIndex((l) => /paste a link or URL/.test(l));
    const jamAt = lines.findIndex((l) => /reeco debugging/.test(l));
    ok(pasteAt > jamAt, `"paste a link or URL" comes after the found jams:\n${screen}`);
    ok(/still needs a knock, a token or an invite link/.test(screen), `the gate is on screen:\n${screen}`);
    // The row value the launcher switches on is the one lib promises.
    eq(JOIN_PASTE_VALUE, 'paste', 'the paste row value');
    killMine('jamdiscoui');
  });

  // ------------------- 9: a RE-announce replaces the child, it does not add one ----
  // The bug this exists for, found 2026-08-29 during a smoke sweep: a `dns-sd -R` for a jam that
  // had been gone for minutes was still up, orphaned, telling the LAN about it. A re-announce is
  // stop-then-start, and the "we killed it" flag was one variable shared by every child the
  // daemon ever spawned — so the OLD child's `exit` arrived after the flag had been cleared for
  // the NEW one, read its own death as a crash, and respawned. The respawn overwrote
  // `announceProc`, which left the first child untracked and therefore unkillable on shutdown.
  // Counting is the assertion: one advertising jam, one `dns-sd -R` for its port, always.
  await step('9  a re-announce (the token changed) replaces the child rather than adding one', async () => {
    const adverts = () => (spawnSync('/bin/ps', ['-o', 'pid=,command=', '-ax'], { encoding: 'utf8' }).stdout || '')
      .split('\n').filter((l) => l.includes('dns-sd -R') && l.includes(` ${PORT_A} `));
    eq(adverts().length, 1, `advertisements for :${PORT_A} before the re-announce`);
    // The daemon re-registers when what the record SAYS changes, and `access` is one of the six
    // fields — so setting a token on a knock-only jam is a real re-announce with a real change.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT_A}`);
    await new Promise((done, fail) => {
      // v0.34: a host proves itself with the key out of that jam's own state dir.
      const hk = readHostKey(hostKeyPath(path.join(TMP, `claude-jam-${PORT_A}`)));
      ws.addEventListener('open', () => { ws.send(JSON.stringify({ t: 'hello', name: 'Roy', host: true, hostKey: hk })); done(); });
      ws.addEventListener('error', () => fail(new Error(`could not reach the daemon on :${PORT_A}`)));
    });
    ws.send(JSON.stringify({ t: 'token', op: 'set', value: 'discoreannounce1' }));
    await sleep(3000);
    try { ws.close(); } catch { /* already gone */ }
    const now = adverts();
    eq(now.length, 1, `advertisements for :${PORT_A} after it — ${now.map((l) => l.trim()).join(' | ')}`);
    console.log(`      one child, and it carries the new record: ${now[0].trim().slice(-60)}`);
    // …and the network really is told the new thing, or "one child" would be one STALE child.
    const rec = mine(discoveredJams(parseDnssdZone(await browseRaw(3000)))).find((r) => r.port === PORT_A);
    eq(rec?.access, 'token', 'the re-announced access mode');
  });

  // ------------------------------------------ 5: a stale advertisement goes ----
  await step('5  a jam that ended stops advertising', async () => {
    const before = mine(discoveredJams(parseDnssdZone(await browseRaw(3000))));
    ok(before.some((r) => r.port === PORT_A), 'it is still advertised before it is ended');
    const end = spawnSync(JAM, ['end', 'jamdiscoa'], { env: ENV, encoding: 'utf8' });
    eq(end.status, 0, `claude-jam end jamdiscoa: ${end.stderr || end.stdout}`);
    // mDNS sends the goodbye when the registering process goes, so this is quick — but give the
    // responder a moment to flush its own cache before asking again.
    await sleep(2500);
    const after = mine(discoveredJams(parseDnssdZone(await browseRaw(3500))));
    eq(after.some((r) => r.port === PORT_A), false,
      `the ended jam is still on the network: ${JSON.stringify(after.map((r) => `${r.jam}:${r.port}`))}`);
    eq(after.some((r) => r.jam === 'reeco debugging'), false, 'and not under its name either');
    // The other jam is untouched — an end deregisters ONE advertisement, not the machine's.
    ok(after.some((r) => r.port === PORT_B), 'the jam beside it is still advertised');
  });

  exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(`\nFATAL ${e.message}`);
  exitCode = 1;
} finally {
  // The product's own end first, because that is the path that deregisters cleanly; killMine is
  // the belt for a jam whose state dir has already gone.
  for (const n of ['jamdiscoa', 'jamdiscob', 'jamdiscoc']) {
    spawnSync(JAM, ['end', n], { env: ENV, encoding: 'utf8' });
  }
  for (const n of NAMES) killMine(n);
  await sleep(2000);
  // Belt: every advertisement this smoke caused belonged to a daemon it started, and every one
  // of those daemons is now gone. Say what a fresh browse sees, so a leak is visible rather than
  // left on the network silently.
  const left = mine(discoveredJams(parseDnssdZone(await browseRaw(2500))));
  if (left.length) {
    failed++;
    exitCode = 1;
    console.log(`FAIL  teardown: ${left.length} advertisement(s) of this smoke's are STILL UP on the `
      + `network: ${left.map((r) => `${r.jam}:${r.port}`).join(', ')} — find the daemon and end it`);
  } else {
    console.log('clean: nothing of this smoke is left advertising on the network');
  }
  spawnSync(process.execPath, [path.join(ROOT, 'sessions.mjs'), 'clean', '--yes'], { env: ENV, encoding: 'utf8' });
  console.log(`\n${failed ? `${failed} step(s) FAILED` : 'all steps passed'}`);
  // v0.21.2 (campaign F10): this suite leaked two directories per run with no note saying why,
  // which reads more like an oversight than a choice. A passing run takes both with it; a failing
  // one keeps them, because that is when the daemon logs inside are worth reading. Exactly the two
  // paths mkdtempSync handed this process — never a pattern, never a sweep of $TMPDIR.
  if (failed) {
    console.log(`(TMPDIR ${TMP} — left in place for inspection)`);
  } else {
    for (const d of [TMP, BIN]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    console.log(`(cleaned up: ${TMP}, ${BIN})`);
  }
}
process.exit(exitCode);
