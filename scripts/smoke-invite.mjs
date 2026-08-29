#!/usr/bin/env node
// v0.22B/C smoke: invite links, and /kick — the twelfth smoke.
//   S1  READ-ONLY the live `jam` on :7777, if one is running, is invisible to this smoke's
//       `jam invite` (own TMPDIR, so its state-dir namespace holds only this smoke's). Nothing
//       about it is touched, and no link of ours can name it
//   1   `jam invite Yossi` on the COMMAND LINE mints a link; `jam invites` lists it and prints
//       neither the link nor a secret
//   2   a guest joining with ONLY the link is admitted, under the name the HOST bound to it,
//       with no knock and no approval — and the roster line says how they got in
//   3   the real client: `node client.mjs <link>` and nothing else is the guest's whole command
//   4   `/invite` from a HOST CLIENT mints one too, and only the asker is told the link
//   5-9 every refusal, each with its own reason, each falling through to a knock:
//       tampered · wrong version · expired · revoked · used up · name already connected
//   10  `/kick` closes the socket 4406, drops the roster entry, tells everyone — and `revoke`
//       takes the link with them, so they cannot walk back in
//   11  the invites survive a daemon restart: the store is reloaded and a live link still works
//
// Self-contained: its own $TMPDIR (so `jam invite` cannot even see another jam's state dir), its
// own port, its own tmux session named jaminvite*, a fake `claude` that just draws a prompt, and
// no real ttyd/cloudflared. It kills only the session names it made, one exact name at a time.
//   usage: node scripts/smoke-invite.mjs
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeInvite, encodeInvite, INVITE_PREFIX } from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOST_MJS = path.join(ROOT, 'host.mjs');
const CLIENT_MJS = path.join(ROOT, 'client.mjs');
const JAM = path.join(ROOT, 'jam');
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
// Ports of this smoke's own: clear of jam's 7777, the shared smokes' 7799/7801,
// smoke-transport's 7811-7819, smoke-replay's 7823/7825, smoke-perm's 7831 and
// smoke-lifecycle's 7851-7855.
const PORT = 7861;
const S = { jam: 'jaminvite' };
for (const [k, v] of Object.entries(S)) if (typeof v !== 'string' || !v.startsWith('jaminvite')) throw new Error(`S.${k} is ${v}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The socket jam's own tmux calls use. Before v0.20 that is the default server, so this smoke
// talks to the same one the launcher does — one constant, so it moves with the launcher.
const SOCKET_ARGS = [];
const tmux = (...a) => spawnSync(TMUX, [...SOCKET_ARGS, ...a], { encoding: 'utf8' });
const alive = (name) => tmux('has-session', '-t', `=${name}`).status === 0;
// Only ever a session name this script made up itself, one exact name per call.
const killMine = (name) => { if (typeof name === 'string' && name.startsWith('jaminvite')) tmux('kill-session', '-t', `=${name}`); };

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
async function until(what, pred, ms = 10000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const v = await pred();
    if (v) return v;
    await sleep(80);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

// ------------------------------------------------------------------ fixtures ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-invite-'));
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-invite-bin-'));
const FAKE_CLAUDE = path.join(BIN, 'claude');
fs.writeFileSync(FAKE_CLAUDE, "#!/bin/sh\nprintf '%s\\n' 'fake claude — v0.22 invite smoke' '' '❯ '\nexec sleep 1800\n", { mode: 0o755 });
const ENV = { ...process.env, TMPDIR: TMP, JAM_CLAUDE: FAKE_CLAUDE };
const STATE = path.join(TMP, `claude-jam-${PORT}`);

const jam = (...args) => {
  const r = spawnSync(JAM, args, { encoding: 'utf8', env: ENV });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// One test participant. Same shape as smoke-knock's: hello on open, every frame kept.
function peer(hello, url) {
  const p = { frames: [], closeCode: null, closeReason: null };
  const ws = new WebSocket(url || `ws://127.0.0.1:${PORT}`);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', ...hello })));
  ws.addEventListener('message', (m) => { try { p.frames.push(JSON.parse(m.data)); } catch { /* not ours */ } });
  ws.addEventListener('close', (e) => { p.closeCode = e.code; p.closeReason = e.reason; });
  ws.addEventListener('error', () => { /* close carries the verdict */ });
  p.send = (o) => { try { ws.send(JSON.stringify(o)); } catch { /* closing */ } };
  p.bye = () => { try { ws.close(); } catch { /* already gone */ } };
  p.want = async (what, pred, ms = 8000) => until(`${what} (saw: ${p.frames.map((f) => f.t).join(',') || 'nothing'})`,
    () => p.frames.find(pred), ms);
  p.wantClose = async (code, ms = 8000) => {
    await until(`close ${code}`, () => p.closeCode != null, ms);
    if (p.closeCode !== code) throw new Error(`closed ${p.closeCode}, expected ${code}`);
    return p.closeReason;
  };
  p.roster = () => [...p.frames].reverse().find((f) => f.t === 'roster' || f.t === 'welcome')?.roster || [];
  return p;
}

// A refused invite must always land in the knock queue, with a reason of its own. One helper,
// because this is the assertion the whole "never a silent failure" rule comes down to.
async function wantRefusal(name, secret, reason) {
  const g = peer({ name, invite: secret });
  const ref = await g.want(`invite refusal (${reason})`, (f) => f.t === 'invite' && f.state === 'refused');
  eq(ref.reason, reason, `refusal reason for ${name}`);
  if (!/knocking instead/.test(ref.text)) throw new Error(`refusal text does not promise a knock: ${ref.text}`);
  if (g.frames.some((f) => f.t === 'welcome')) throw new Error(`${name} was admitted on a ${reason} invite`);
  console.log(`      ${reason}: ${ref.text}`);
  return g;
}

// The real client, driven the way a guest runs it: one argument, then /quit. A pipe on stdin
// picks the readline renderer, which is all this step needs to prove.
function runClient(args, ms = 6000) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLIENT_MJS, ...args], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const bye = setTimeout(() => { try { child.stdin.write('/quit\n'); } catch { /* gone */ } }, ms - 1500);
    const hard = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, ms);
    child.on('exit', () => {
      clearTimeout(bye); clearTimeout(hard);
      done(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
    });
    child.on('error', () => { clearTimeout(bye); clearTimeout(hard); done(out); });
  });
}

const mint = (...args) => {
  const r = jam('invite', ...args);
  const link = (r.out.match(/cjam1_[A-Za-z0-9_-]+/) || [])[0];
  if (!link) throw new Error(`no link in: ${r.out.trim()}`);
  const d = decodeInvite(link);
  if (!d.ok) throw new Error(`minted link does not decode: ${d.error}`);
  return { link, ...d.invite, out: r.out };
};

let daemon = null; // the replacement daemon of step 11, ours by pid
let host;
console.log(`TMPDIR ${TMP}\nstubs  ${BIN}\nport   ${PORT}, tmux ${SOCKET_ARGS.join(' ')} -t ${S.jam}`);
const started = Date.now();

try {
  // ======================================================== the read-only decoy ====
  await step('S1 READ-ONLY the live jam on :7777 is invisible here, and untouched', async () => {
    const before = spawnSync(TMUX, ['-L', 'default', 'ls'], { encoding: 'utf8' }).stdout || '';
    const live = /^jam:/m.test(before);
    console.log(`      default socket: ${live ? before.trim().split('\n').find((l) => l.startsWith('jam:')) : 'no jam running'}`);
    // This smoke's TMPDIR holds only this smoke's state dirs, so nothing else can be resolved,
    // offered or minted against — before the launcher runs there is nothing at all.
    const r = jam('invites');
    if (/cjam1_/.test(r.out)) throw new Error(`a foreign jam leaked a link: ${r.out}`);
    if (!/no jam of jam's own is running/.test(r.out)) throw new Error(`unexpected: ${r.out.trim()}`);
    const after = spawnSync(TMUX, ['-L', 'default', 'ls'], { encoding: 'utf8' }).stdout || '';
    eq(after, before, 'the default tmux socket changed');
  });

  // ======================================================== the jam under test ====
  killMine(S.jam);
  const born = spawnSync(process.execPath, [HOST_MJS, '--tmux', S.jam, '--port', String(PORT),
    '--name', 'Host', '--cwd', ROOT, '--no-attach', '--no-popup', '--replay', '0'],
  { encoding: 'utf8', env: ENV });
  if (born.status !== 0) throw new Error(`launch failed: ${born.stdout}${born.stderr}`);
  const info = JSON.parse(fs.readFileSync(path.join(STATE, 'session.json'), 'utf8'));
  console.log(`      launched: ${info.tmux} on :${info.port}, state ${info.state}`);
  // Knock-only on purpose (no --token): then every fall-through is visible as a real knock.
  host = peer({ name: 'Host', host: true });
  await host.want('host welcome', (f) => f.t === 'welcome');

  // ======================================================== minting ====
  let yossi;
  await step('1 `jam invite Yossi` mints a link from the command line', async () => {
    yossi = mint('Yossi');
    console.log(`      ${yossi.out.trim().split('\n').slice(0, 2).join('\n      ')}`);
    eq(yossi.name, 'Yossi', 'the link carries the name');
    if (!yossi.ws.length) throw new Error('the link carries no address');
    if (!yossi.exp) throw new Error('the link carries no expiry (the default is 24h)');
    const left = yossi.exp * 1000 - Date.now();
    if (!(left > 23 * 3600_000 && left <= 24 * 3600_000)) throw new Error(`expiry is ${left}ms away, want ~24h`);
    if (!/is a password/.test(yossi.out)) throw new Error('the mint did not say the link is a credential');
  });

  await step('1b `jam invites` lists it, and prints neither the link nor the secret', async () => {
    const r = jam('invites');
    console.log(`      ${r.out.trim().split('\n').join('\n      ')}`);
    if (r.out.includes(yossi.link.slice(0, 24))) throw new Error('the listing printed the link');
    if (r.out.includes(yossi.secret)) throw new Error('the listing printed the secret');
    if (!new RegExp(`\\s${'Yossi'}\\s+live\\s`).test(r.out)) throw new Error(`Yossi is not listed live: ${r.out}`);
    const j = JSON.parse(jam('invites', '--json').out);
    eq(j.length, 1, '--json rows');
    eq(j[0].name, 'Yossi', '--json name');
    if (JSON.stringify(j).includes(yossi.secret)) throw new Error('--json carried the secret');
  });

  // ======================================================== joining with only a link ====
  let guest;
  await step('2 a guest with ONLY the link is admitted, named by the host, with no approval', async () => {
    // The name is deliberately NOT sent: the daemon takes it off the invite record.
    guest = peer({ name: 'SomeoneElse', invite: yossi.secret });
    const w = await guest.want('welcome', (f) => f.t === 'welcome');
    eq(w.you, 'Yossi', 'welcome.you — the name comes off the record, never off the hello');
    if (guest.frames.some((f) => f.t === 'knock')) throw new Error('an invite went through a knock');
    eq(w.session.join, undefined, 'a guest must not receive the host invite line');
    const r = await host.want('roster with Yossi', (f) => f.t === 'roster' && f.joined === 'Yossi');
    eq(r.via, 'invite', 'roster.via — the arrival has to be visible as an invite join');
    if (!host.roster().includes('Yossi')) throw new Error(`roster is ${host.roster().join(',')}`);
    // No ladder, no pending item: an invite is admission, not a request.
    const pend = [...host.frames].reverse().find((f) => f.t === 'pending');
    if (pend?.items?.length) throw new Error(`something is pending after an invite join: ${JSON.stringify(pend.items)}`);
  });

  await step('3 the real client: the link IS the command — no name, no token, no approval', async () => {
    const real = mint('Realclient');
    const out = await runClient([real.link]);
    console.log(`      ${out.split('\n').filter((l) => /jam [0-9a-f]|joined|approval|rejected/.test(l)).slice(0, 3).map((l) => l.trim()).join('\n      ')}`);
    if (/waiting for host approval/.test(out)) throw new Error('the one-command join needed an approval');
    if (!/host Host/.test(out)) throw new Error(`the client never got a welcome: ${out.slice(0, 400)}`);
    if (!/Realclient joined \(invite\)/.test(out)) throw new Error('the arrival was not visible as an invite join');
    // Nothing else was on the command line: no --name, no --token, no ws:// URL.
    if (!jam('invites').out.includes('Realclient')) throw new Error('the link that joined is not in the store');
  });

  let dana;
  await step('4 `/invite` from a host client mints one too, and only the asker sees the link', async () => {
    host.send({ t: 'invite', op: 'new', name: 'Dana', maxUses: 5, ttl: 60 * 60 * 1000 });
    const m = await host.want('minted invite', (f) => f.t === 'invite' && f.state === 'minted');
    const d = decodeInvite(m.link);
    if (!d.ok) throw new Error(`/invite minted a link that does not decode: ${d.error}`);
    eq(d.invite.name, 'Dana', 'the minted name');
    eq(m.invite.maxUses, 5, 'maxUses');
    dana = { link: m.link, ...d.invite, id: m.invite.id };
    console.log(`      /invite Dana → ${m.link.slice(0, 42)}… (${m.invite.id}, ${m.invite.maxUses} uses)`);
    // The link is a credential: it must never reach a guest or the shared history.
    if (guest.frames.some((f) => JSON.stringify(f).includes(m.link))) throw new Error('a guest saw a minted link');
    // And it is the same store the command line sees.
    if (!jam('invites').out.includes(m.invite.id)) throw new Error('`jam invites` does not know about a /invite link');
  });

  // ======================================================== every refusal ====
  await step('5 a TAMPERED link: the payload no longer decodes, and the client says so locally', async () => {
    const broken = `${yossi.link.slice(0, -8)}AAAAAAAA`;
    const d = decodeInvite(broken);
    if (d.ok) throw new Error('a tampered link decoded cleanly');
    console.log(`      decode → ${d.reason}: ${d.error}`);
    const r = spawnSync(process.execPath, [CLIENT_MJS, broken], { encoding: 'utf8', env: ENV, timeout: 15000 });
    eq(r.status, 2, 'the client exit code for an unusable link');
    if (!/damaged|no usable|not a claude-jam/.test(`${r.stderr}`)) throw new Error(`unhelpful: ${r.stderr}`);
    // And a link whose SECRET was swapped for another valid-looking one still decodes — so the
    // daemon is what refuses it, as 'unknown', and it knocks.
    const swapped = encodeInvite({ jam: yossi.jam, name: 'Yossi', secret: 'ZZZZZZZZZZZZZZZZZZZZZZZZ', ws: yossi.ws, expires: 0 });
    const g = await wantRefusal('Nadav', decodeInvite(swapped).invite.secret, 'unknown');
    await g.want('knock pending', (f) => f.t === 'knock' && f.state === 'pending');
    g.bye();
  });

  await step('6 a WRONG-VERSION link is a version error, not a crash — and never a connection', async () => {
    const v2 = yossi.link.replace(/^cjam1_/, 'cjam2_');
    eq(decodeInvite(v2).reason, 'bad-version', 'decode reason');
    const r = spawnSync(process.execPath, [CLIENT_MJS, v2], { encoding: 'utf8', env: ENV, timeout: 15000 });
    eq(r.status, 2, 'exit code');
    if (!/cjam2/.test(r.stderr) || !/update claude-jam/.test(r.stderr)) throw new Error(`unhelpful: ${r.stderr}`);
    console.log(`      ${r.stderr.trim()}`);
  });

  await step('7 an EXPIRED invite falls through to a knock, both ends agreeing why', async () => {
    const brief = mint('Ephemeral', '--expires', '1s');
    await sleep(1400);
    // The daemon's own clock is the one that decides — a client cannot lie its way in.
    const g = await wantRefusal('Ephemeral', brief.secret, 'expired');
    await g.want('knock pending', (f) => f.t === 'knock' && f.state === 'pending');
    // And the client, reading the same link, refuses it locally with the SAME word and still
    // knocks (the addresses and the name are fine; only the credential is old).
    const d = decodeInvite(brief.link);
    eq(d.reason, 'expired', 'the client-side reason');
    if (!d.invite?.ws?.length) throw new Error('an expired link gave the client nothing to knock at');
    g.bye();
  });

  await step('8 a REVOKED invite falls through to a knock, and revoking says what it took', async () => {
    const r = jam('invite', 'revoke', 'Dana');
    console.log(`      ${r.out.trim()}`);
    if (!r.out.includes(dana.id)) throw new Error(`revoke did not name the link: ${r.out}`);
    const g = await wantRefusal('Dana', dana.secret, 'revoked');
    await g.want('knock pending', (f) => f.t === 'knock' && f.state === 'pending');
    g.bye();
    // Revoking twice is not a second revocation.
    if (jam('invite', 'revoke', 'Dana').code === 0) throw new Error('an already-revoked link was revoked again');
  });

  await step('9 maxUses runs out, and a name already connected is refused', async () => {
    const once = mint('Once', '--uses', '1');
    const first = peer({ name: 'Once', invite: once.secret });
    await first.want('welcome', (f) => f.t === 'welcome');
    first.bye();
    await until('Once to leave the roster', () => !host.roster().includes('Once'));
    const g = await wantRefusal('Once', once.secret, 'used-up');
    await g.want('knock pending', (f) => f.t === 'knock' && f.state === 'pending');
    g.bye();
    // Yossi is still connected from step 2, so their own (still live, multi-use) link cannot
    // seat a second person under that name — attribution is by name, and two of one is worse
    // than a refusal.
    const dup = await wantRefusal('Yossi', yossi.secret, 'name-taken');
    await dup.wantClose(4409);
  });

  // ======================================================== /kick ====
  await step('10 /kick refuses what it should before it removes anybody', async () => {
    host.send({ t: 'kick', name: 'Host' });
    await host.want('refusal for kicking yourself', (f) => f.t === 'error' && /cannot kick yourself/.test(f.text));
    host.send({ t: 'kick', name: 'Nobody' });
    await host.want('refusal for a stranger', (f) => f.t === 'error' && /nobody here is called/.test(f.text));
    // A guest cannot kick, whatever they claim: the daemon's gate is host AND loopback.
    guest.send({ t: 'kick', name: 'Host' });
    await guest.want('guest refusal', (f) => f.t === 'error' && /host/.test(f.text));
    if (!host.roster().includes('Host')) throw new Error('the host kicked itself anyway');
  });

  await step('10b /kick closes the socket 4406, drops the roster entry, and tells everybody', async () => {
    const before = host.roster();
    if (!before.includes('Yossi')) throw new Error(`Yossi is not here to kick: ${before.join(',')}`);
    host.send({ t: 'kick', name: 'Yossi', revoke: true });
    const told = await guest.want('kicked notice', (f) => f.t === 'kicked');
    eq(told.by, 'Host', 'kicked.by');
    const reason = await guest.wantClose(4406);
    console.log(`      close 4406 "${reason}"`);
    await host.want('the sys line everyone sees', (f) => f.t === 'sys' && /Yossi was removed from the jam by Host/.test(f.text));
    await until('Yossi to leave the roster', () => !host.roster().includes('Yossi'));
    console.log(`      roster: ${host.roster().join(', ')}`);
    const done = await host.want('kick receipt', (f) => f.t === 'kick' && f.state === 'done');
    eq(done.via, 'invite', 'the receipt says how they got in, which is what the offer depends on');
    if (!done.revoked) throw new Error('revoke:true revoked nothing');
  });

  await step('10c the revoke means they cannot walk back in on the same link', async () => {
    const back = await wantRefusal('Yossi', yossi.secret, 'revoked');
    await back.want('knock pending', (f) => f.t === 'knock' && f.state === 'pending');
    back.bye();
  });

  // ======================================================== a restart ====
  await step('11 the invite store survives a daemon restart', async () => {
    const live = mint('Restarted');
    const onDisk = JSON.parse(fs.readFileSync(path.join(STATE, 'invites.json'), 'utf8'));
    if (onDisk.invites.some((r) => JSON.stringify(r).includes(live.secret))) {
      throw new Error('the state dir holds a usable secret');
    }
    console.log(`      invites.json: ${onDisk.invites.length} record(s), hash-only`);
    // Kill the daemon in its tmux window by the exact pid the launcher recorded, then run a
    // replacement over the SAME state dir — which is the restart the store has to survive.
    const pid = Number((tmux('list-panes', '-t', `${S.jam}:daemon`, '-F', '#{pane_pid}').stdout || '').trim());
    if (!pid) throw new Error('could not find the daemon pane pid');
    process.kill(pid, 'SIGTERM');
    await until('the old daemon to let go of the port', async () => {
      try { await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(400) }); return false; }
      catch { return true; }
    });
    daemon = spawn(process.execPath, [HOST_MJS, '--daemon', '--port', String(PORT), '--host', '0.0.0.0',
      '--name', 'Host', '--hook-secret', info.secret, '--cwd', ROOT, '--state', STATE,
      '--tmux', S.jam, '--session-id', info.sessionId, '--replay', '0'],
    { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    daemon.stdout.on('data', (c) => { log += c; });
    daemon.stderr.on('data', (c) => { log += c; });
    await until('the replacement daemon', async () => {
      try { return (await (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(400) })).json())?.ok === 'ok'; }
      catch { return false; }
    });
    if (!/invite\(s\) reloaded/.test(log)) throw new Error(`the daemon did not say it reloaded invites:\n${log}`);
    console.log(`      ${log.split('\n').find((l) => /reloaded/.test(l))}`);
    // The proof that matters: a link minted before the restart still admits.
    const g = peer({ name: 'whatever', invite: live.secret });
    const w = await g.want('welcome after the restart', (f) => f.t === 'welcome');
    eq(w.you, 'Restarted', 'welcome.you');
    g.bye();
    // …and a revoked one still does not.
    const no = await wantRefusal('Dana', dana.secret, 'revoked');
    no.bye();
  });
} finally {
  host?.bye();
  if (daemon?.pid) { try { process.kill(daemon.pid, 'SIGTERM'); } catch { /* already gone */ } }
  killMine(S.jam);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* leave it */ }
  try { fs.rmSync(BIN, { recursive: true, force: true }); } catch { /* leave it */ }
  console.log(`\n--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'} in ${Math.round((Date.now() - started) / 1000)}s`);
  if (alive(S.jam)) console.log(`WARNING ${S.jam} is still up — \`tmux ${SOCKET_ARGS.join(' ')} kill-session -t ${S.jam}\``);
  process.exit(failed ? 1 : 0);
}
