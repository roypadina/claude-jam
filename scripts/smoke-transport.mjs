#!/usr/bin/env node
// v0.17 Batch T smoke: does the transport actually survive things going wrong.
//   T1  the cloudflared child is killed → a respawn comes back with a NEW hostname, and that
//       hostname reaches token.json and every host client on the same {t:'token'} frame
//   T2  a socket that stops answering pings is terminated and drops out of the roster (and,
//       for contrast, a client process that is SIGKILLed leaves by the ordinary close path)
//   T3  the fifth failed reconnect stops saying "retrying" and names the URL change
//   T4  --funnel: precheck, argv, foreground lifecycle, respawn with a STABLE hostname, and
//       the scoped turn-off on shutdown — against a stub CLI, because Funnel is not enabled
//       on this tailnet (the real refusal is asserted too, as its own step)
//
// Self-contained by design, unlike the other six: it starts and kills its own daemons, needs
// a --heartbeat far shorter than any real run, and deliberately kills relay children — none of
// which a shared daemon could survive. It runs NO tmux session and NO claude: the daemon is
// started directly with --daemon, so nothing here can touch anybody's live jam.
//   usage: node scripts/smoke-transport.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WS from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOST_MJS = path.join(ROOT, 'host.mjs');
const CLIENT_MJS = path.join(ROOT, 'client.mjs');
const TOKEN = 'transportsmoke';
// Ports of this smoke's own, clear of jam's 7777 default and of the 7799/7801 the other six use.
const P = { tunnel: 7811, funnel: 7813, funnelView: 7814, dead: 7819 };
const STUB_DNS = 'jam-smoke.tailsmoke.ts.net';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
async function until(what, pred, ms = 30000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const v = await pred();
    if (v) return v;
    await sleep(120);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

// ---------------------------------------------------------------- a daemon of our own ----
// `--daemon` is the same process the launcher re-execs, minus the tmux session and the claude
// window — everything Batch T touches (the relay children, the WS server, token.json) lives
// here, so this is the whole surface under test and none of the rest has to exist.
const daemons = [];
async function daemon(name, extra = []) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), `jam-smoke-${name}-`));
  const child = spawn(process.execPath, [HOST_MJS, '--daemon',
    '--name', 'Host', '--token', TOKEN, '--hook-secret', 'transportsmokesecret',
    '--cwd', ROOT, '--tmux', 'jam-smoke-no-such-session', '--state', state, '--no-popup',
    ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  const d = { name, state, child, out: '', exited: null };
  const eat = (c) => { d.out += c; };
  child.stdout.on('data', eat);
  child.stderr.on('data', eat);
  child.on('exit', (code) => { d.exited = code; });
  d.waitLog = (re, ms = 30000) => until(`${name} to log ${re}`, () => re.exec(d.out), ms);
  d.tokenFile = () => JSON.parse(fs.readFileSync(path.join(state, 'token.json'), 'utf8'));
  d.stop = async () => {
    if (d.exited == null) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    await until(`${name} to exit`, () => d.exited != null, 10000).catch(() => { child.kill('SIGKILL'); });
    fs.rmSync(state, { recursive: true, force: true });
  };
  daemons.push(d);
  // peer() has no reconnect of its own, so nothing may connect before the server is listening.
  await d.waitLog(/claude-jam daemon on /, 20000);
  return d;
}

// A scripted participant. The `ws` package rather than the global WebSocket every other smoke
// uses, for one reason: `autoPong: false` is the only way to hold a socket open while refusing
// to answer the server's pings, which is precisely the half-dead peer T2 exists to prune.
function peer(url, name, wsOpts = {}, hello = {}) {
  const p = { frames: [], closed: null };
  const ws = new WS(url, wsOpts);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, token: TOKEN, ...hello })));
  ws.on('message', (raw) => { try { p.frames.push(JSON.parse(raw)); } catch { /* not ours */ } });
  ws.on('close', (code) => { p.closed = code; });
  ws.on('error', () => { /* the assertions carry the verdict */ });
  p.close = () => ws.close();
  p.roster = () => [...p.frames].reverse().find((f) => f.t === 'roster')?.roster || [];
  p.want = (what, pred, ms = 30000) => until(what, () => p.frames.find(pred), ms);
  return p;
}

const tunnelHostOf = (line) => /wss:\/\/([^ ]+)/.exec(String(line || ''))?.[1] || null;

// ============================================================ T1: cloudflared respawn ====
if (spawnSync('cloudflared', ['--version'], { encoding: 'utf8' }).status !== 0) {
  failed++;
  console.log('FAIL  T1 needs cloudflared on PATH: brew install cloudflared');
} else {
  const d = await daemon('tunnel', ['--port', String(P.tunnel), '--tunnel']);
  // Loopback + host:true is what earns the {t:'token'} frames — the same frame /token rotation
  // uses, which is exactly why T1 needed no new protocol.
  const host = peer(`ws://127.0.0.1:${P.tunnel}`, 'Host', {}, { host: true });
  let first = null;
  let firstPid = null;

  await step('T1 the cloudflared quick tunnel comes up and its join line reaches the host client', async () => {
    await host.want('welcome', (f) => f.t === 'welcome');
    const m = await d.waitLog(/tunnel \(ws\): cloudflared connecting… \(pid (\d+)\)/);
    firstPid = Number(m[1]);
    const up = await d.waitLog(/tunnel \(ws\) up: (\S+)/, 60000);
    first = up[1];
    // Same string, three places: the daemon log, token.json (which is claude's own context via
    // hooks.sh) and the host client's frame.
    await until('token.json to carry the tunnel join line',
      () => tunnelHostOf(d.tokenFile().tunnelJoin) === first, 10000);
    const frame = await host.want('the token frame', (f) => f.t === 'token' && tunnelHostOf(f.tunnelJoin) === first, 10000);
    console.log(`      cloudflared pid ${firstPid}, host ${first}`);
    if (!/\.trycloudflare\.com$/.test(first)) throw new Error(`${first} is not a quick-tunnel hostname`);
    if (!frame.tunnelJoin.includes(TOKEN)) throw new Error('the join line lost its token');
  });

  await step('T1 killing the cloudflared child respawns it after 1s with a NEW hostname', async () => {
    if (!firstPid) throw new Error('no cloudflared pid to kill');
    process.kill(firstPid, 'SIGTERM'); // the exact pid the daemon told us, nothing else
    await d.waitLog(/tunnel \(ws\) exited \(cloudflared code/, 15000);
    const again = await d.waitLog(/tunnel \(ws\): restarting in 1s \(attempt 1\)/, 10000);
    const pid2 = await d.waitLog(/restarting in 1s \(attempt 1\)[\s\S]*?connecting… \(pid (\d+)\)/, 15000);
    if (Number(pid2[1]) === firstPid) throw new Error('the respawn reused the dead pid');
    const up2 = await until('a second hostname', () => {
      const all = [...d.out.matchAll(/tunnel \(ws\) up: (\S+)/g)].map((m) => m[1]);
      return all.length > 1 ? all[all.length - 1] : null;
    }, 90000);
    if (up2 === first) throw new Error('the respawned tunnel reused the old hostname');
    console.log(`      ${again[0].trim()} → pid ${pid2[1]}, host ${up2}`);
    console.log(`      a quick tunnel's URL is random per spawn: ${first} → ${up2}`);
    // The whole point: the new URL propagates by itself, on the paths that already existed.
    await until('token.json to carry the NEW join line',
      () => tunnelHostOf(d.tokenFile().tunnelJoin) === up2, 15000);
    await host.want('a second token frame', (f) => f.t === 'token' && tunnelHostOf(f.tunnelJoin) === up2, 15000);
  });

  await step('T1 our own SIGTERM is not a death to recover from — no respawn after shutdown', async () => {
    host.close();
    const before = (d.out.match(/restarting in/g) || []).length;
    await d.stop();
    await sleep(2500); // longer than the 1s a real respawn would have waited
    const after = (d.out.match(/restarting in/g) || []).length;
    if (after !== before) throw new Error(`${after - before} respawn(s) scheduled while shutting down`);
    console.log(`      daemon exit ${d.exited}, respawns scheduled during shutdown: 0`);
  });
}

// ============================================================ T2: heartbeat pruning ====
{
  // 1.5s instead of the 30s a real run uses, so a missed round is provable in seconds. The
  // production default lives in lib.mjs (HEARTBEAT_MS) and is asserted by the unit tests.
  const d = await daemon('heartbeat', ['--port', String(P.tunnel), '--heartbeat', '1500']);
  await d.waitLog(/heartbeat: ping every 1500ms/);
  const live = peer(`ws://127.0.0.1:${P.tunnel}`, 'Live');
  await live.want('welcome', (f) => f.t === 'welcome');

  await step('T2 a socket that never answers a ping is terminated and leaves the roster', async () => {
    // autoPong:false keeps the TCP connection wide open while refusing the protocol pong —
    // the genuinely half-dead peer. SIGKILLing a client process would NOT test this: the
    // kernel still sends a FIN, so the server sees an ordinary close (asserted below).
    const silent = peer(`ws://127.0.0.1:${P.tunnel}`, 'Silent', { autoPong: false });
    await live.want('Silent in the roster', (f) => f.t === 'roster' && f.roster.includes('Silent'), 15000);
    const gone = await live.want('Silent leaving', (f) => f.t === 'roster' && f.left === 'Silent', 15000);
    await d.waitLog(/\[heartbeat\] Silent missed a ping round — terminating/, 5000);
    console.log(`      roster after the sweep: ${JSON.stringify(gone.roster)}, Silent's close code ${silent.closed}`);
    if (silent.closed !== 1006) throw new Error(`expected an abnormal close (1006), got ${silent.closed}`);
    if (gone.roster.includes('Silent')) throw new Error('Silent is still in the roster');
    if (!gone.roster.includes('Live')) throw new Error('the sweep took a live client with it');
  });

  await step('T2 a client process killed outright also leaves — by the ordinary close path', async () => {
    const kid = spawn(process.execPath, ['-e',
      `import('ws').then(({default:W})=>{const w=new W('ws://127.0.0.1:${P.tunnel}');`
      + `w.on('open',()=>w.send(JSON.stringify({t:'hello',name:'Killed',token:'${TOKEN}'})));});`
      + 'setInterval(()=>{},1000);'], { cwd: ROOT, stdio: 'ignore' });
    await live.want('Killed in the roster', (f) => f.t === 'roster' && f.roster.includes('Killed'), 15000);
    kid.kill('SIGKILL'); // our own child, by pid
    const gone = await live.want('Killed leaving', (f) => f.t === 'roster' && f.left === 'Killed', 15000);
    console.log(`      SIGKILL leaves a FIN behind, so this is ws.on('close'), not the sweep: roster ${JSON.stringify(gone.roster)}`);
  });

  await step('T2 a live client survives round after round of pings', async () => {
    await sleep(5000); // three full heartbeat rounds
    if (live.closed != null) throw new Error(`the live client was terminated (code ${live.closed})`);
    const rounds = (d.out.match(/\[heartbeat\] Live /g) || []).length;
    if (rounds) throw new Error(`Live was swept ${rounds} time(s)`);
    console.log(`      still connected after 5s at a 1.5s interval, roster ${JSON.stringify(live.roster())}`);
  });

  live.close();
  await d.stop();
}

// ============================================================ T3: reconnect tiering ====
await step('T3 the fifth failed reconnect names the URL change instead of repeating "retrying"', async () => {
  // Nothing is listening on P.dead, so every attempt fails: 1s, 2s, 4s, 8s and the fifth line
  // is the tiered one (~15s of backoff). stdin is a pipe we never write to and never end —
  // readline would exit the client at EOF, and it has to live long enough to fail five times.
  const client = spawn(process.execPath, [CLIENT_MJS, `ws://127.0.0.1:${P.dead}`, '--name', 'Tier', '--basic'],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  client.stdout.on('data', (c) => { out += c; });
  client.stderr.on('data', (c) => { out += c; });
  try {
    await until('the tiered reconnect line', () => /still retrying \(5 failed\)/.test(out), 45000);
    // readline redraws its prompt around every emitted line, so strip escapes and keep only
    // the part from the `*` system glyph onwards. The tiered message is long enough that the
    // client wraps it, so the wording is asserted against the whole blob, not one line.
    const clean = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    const lines = clean.split('\n').filter((l) => /retrying|join URL/.test(l))
      .map((l) => l.replace(/^.*?\* /, '* ').trim());
    for (const l of lines) console.log(`      ${l}`);
    // The first four must NOT be tiered: a blip should not read like a dead host.
    const blips = lines.filter((l) => /^\* disconnected, retrying in \d+s$/.test(l));
    if (blips.length < 4) throw new Error(`only ${blips.length} plain "disconnected" line(s) before the tier`);
    if (!/join URL changed/.test(clean)) throw new Error('the tiered message does not name the URL change');
    if (!/\/join/.test(clean)) throw new Error('the tiered message does not say how to get the new URL');
  } finally { client.kill('SIGKILL'); }
});

// ============================================================ T4: Tailscale Funnel ====
// The live path could not be exercised on this machine, and the two reasons are asserted here
// rather than described: the tailnet has no funnel node attribute, and the App Store build of
// Tailscale.app cannot mutate serve/funnel config at all. So the lifecycle is proved against a
// stub CLI that answers exactly as the real one documents, and this is called out in the
// result line — the stub proves our side of the contract, not Tailscale's.
await step('T4 --tunnel and --funnel are mutually exclusive', async () => {
  const r = spawnSync(process.execPath, [HOST_MJS, '--tunnel', '--funnel'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 2) throw new Error(`expected exit 2, got ${r.status}`);
  if (!/pick one/.test(r.stderr)) throw new Error(`unexpected message: ${r.stderr.trim().slice(0, 120)}`);
  console.log(`      ${r.stderr.trim().split('\n')[0]}`);
});

await step('T4 the real tailscale CLI: startup refuses with the exact step that is missing', async () => {
  const r = spawnSync(process.execPath, [HOST_MJS, '--funnel', '--name', 'Host', '--cwd', ROOT],
    { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 2) throw new Error(`expected exit 2, got ${r.status}: ${(r.stdout || r.stderr).slice(0, 200)}`);
  for (const line of r.stderr.trim().split('\n')) console.log(`      ${line}`);
  // Whatever is missing here, the message has to be actionable and must not leave the operator
  // stranded — the cloudflared path is always the fallback.
  if (!/--funnel cannot start:/.test(r.stderr)) throw new Error('no precheck refusal');
  if (!/(nodeAttrs|not Running|tailscale CLI|MagicDNS)/.test(r.stderr)) throw new Error('the refusal names no fix');
});

{
  // The stub: `status --json` says a ready tailnet, `funnel --https=<p> <target>` prints the
  // real foreground banner and then holds the funnel open until it is killed, `funnel … off`
  // exits. Every invocation is appended to a log, so the argv the daemon really used and the
  // teardown it really ran are both assertable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-smoke-tsstub-'));
  const argvLog = path.join(dir, 'argv.log');
  const stub = path.join(dir, 'tailscale-stub.sh');
  fs.writeFileSync(stub, `#!/bin/sh
# stub tailscale CLI for scripts/smoke-transport.mjs
echo "$@" >> ${JSON.stringify(argvLog)}
if [ "$1" = "status" ]; then
  echo '{"BackendState":"Running","Self":{"DNSName":"${STUB_DNS}.","CapMap":{"https://tailscale.com/cap/funnel":null}}}'
  exit 0
fi
if [ "$1" = "funnel" ]; then
  for a in "$@"; do [ "$a" = "off" ] && exit 0; done
  port=443
  for a in "$@"; do case "$a" in --https=*) port=\${a#--https=} ;; esac; done
  host=${STUB_DNS}
  [ "$port" = "443" ] || host="$host:$port"
  echo "Available on the internet:"
  echo ""
  echo "https://$host/"
  echo "|-- proxy http://127.0.0.1:$port"
  echo ""
  echo "Press Ctrl+C to exit."
  exec sleep 86400
fi
exit 1
`, { mode: 0o755 });

  const d = await daemon('funnel', ['--port', String(P.funnel), '--view-port', String(P.funnelView),
    '--view', '--funnel', '--funnel-cli', stub]);
  const host = peer(`ws://127.0.0.1:${P.funnel}`, 'Host', {}, { host: true });

  await step('T4 the funnel URL is printed before it is up, because it is the same one every run', async () => {
    const m = await d.waitLog(/funnel: (wss:\/\/\S+) \(stable — same URL across restarts\)/, 20000);
    console.log(`      ${m[0].trim()}`);
    if (m[1] !== `wss://${STUB_DNS}`) throw new Error(`derived ${m[1]}, expected wss://${STUB_DNS} (no port — 443 is implicit)`);
  });

  await step('T4 both funnel targets come up on the ports Funnel actually opens (443 + 8443)', async () => {
    await host.want('welcome', (f) => f.t === 'welcome');
    await d.waitLog(/tunnel \(ws\) up: jam-smoke\.tailsmoke\.ts\.net$/m, 20000);
    await d.waitLog(/tunnel \(view\) up: jam-smoke\.tailsmoke\.ts\.net:8443/, 20000);
    const argv = fs.readFileSync(argvLog, 'utf8').trim().split('\n');
    for (const l of argv) console.log(`      tailscale ${l}`);
    // The argv shape is the contract with the real CLI: foreground (no --bg, so the funnel
    // lives and dies with our pid), --yes (a daemon has no terminal), one --https per target.
    if (!argv.includes('status --json')) throw new Error('the precheck never ran');
    if (!argv.includes(`funnel --yes --https=443 http://localhost:${P.funnel}`)) throw new Error('wrong argv for the client funnel');
    if (!argv.includes(`funnel --yes --https=8443 http://localhost:${P.funnelView}`)) throw new Error('wrong argv for the view funnel');
    if (argv.some((l) => l.includes('--bg'))) throw new Error('--bg would outlive the daemon');
  });

  await step('T4 the funnel URLs ride the existing join plumbing — token.json, /join and the host frame', async () => {
    const tf = await until('token.json to carry both funnel URLs',
      () => { const t = d.tokenFile(); return t.tunnelJoin && t.tunnelView ? t : null; }, 20000);
    console.log(`      tunnelJoin: ${tf.tunnelJoin}`);
    console.log(`      tunnelView: ${tf.tunnelView}`);
    if (tf.tunnelJoin !== `node client.mjs wss://${STUB_DNS} --name <You> --token ${TOKEN}`) {
      throw new Error(`unexpected tunnelJoin: ${tf.tunnelJoin}`);
    }
    if (!/^https:\/\/jam:[^@]+@jam-smoke\.tailsmoke\.ts\.net:8443$/.test(tf.tunnelView)) {
      throw new Error(`unexpected tunnelView: ${tf.tunnelView}`);
    }
    // The other delivery path: a host client that connects while the funnel is already up gets
    // the URLs in its welcome, not on a later frame. Both matter — the stub resolves instantly,
    // so a real cloudflared's five-second head start does not exist to paper this over.
    const late = peer(`ws://127.0.0.1:${P.funnel}`, 'Late', {}, { host: true });
    const w = await late.want('welcome', (f) => f.t === 'welcome', 20000);
    console.log(`      a host client's welcome carries: ${w.session.tunnelJoin}`);
    if (w.session.tunnelJoin !== tf.tunnelJoin) throw new Error(`welcome disagrees: ${w.session.tunnelJoin}`);
    if (w.session.tunnelView !== tf.tunnelView) throw new Error(`welcome view disagrees: ${w.session.tunnelView}`);
    late.close();
    // The daemon's own console block, i.e. what /join reprints.
    await d.waitLog(new RegExp(`tunnel invite: .*wss://${STUB_DNS} `), 10000);
  });

  await step('T4 killing the funnel child respawns it, the hostname is the SAME one, and the frame still fires', async () => {
    const pid = Number((await d.waitLog(/tunnel \(ws\): tailscale funnel connecting… \(pid (\d+)\)/))[1]);
    const framesBefore = host.frames.filter((f) => f.t === 'token').length;
    process.kill(pid, 'SIGTERM'); // the exact pid the daemon told us
    await d.waitLog(/tunnel \(ws\) exited \(tailscale funnel code/, 15000);
    await d.waitLog(/tunnel \(ws\): restarting in 1s \(attempt 1\)/, 10000);
    const ups = await until('a second "up" line', () => {
      const all = [...d.out.matchAll(/tunnel \(ws\) up: (\S+)/g)].map((m) => m[1]);
      return all.length > 1 ? all : null;
    }, 30000);
    console.log(`      ${ups.join(' → ')}  (unchanged: this is the whole point of Funnel over a quick tunnel)`);
    if (ups[0] !== ups[1]) throw new Error(`the funnel hostname changed across a respawn: ${ups.join(' → ')}`);
    // An already-connected host client hears about the respawn on the {t:'token'} frame — the
    // clearing of the URL and its return, both from onTunnelChange().
    await until('the respawn to push a token frame to the connected host client',
      () => host.frames.filter((f) => f.t === 'token').length > framesBefore, 15000);
    const last = [...host.frames].reverse().find((f) => f.t === 'token');
    console.log(`      host client frame after the respawn: ${last.tunnelJoin}`);
    if (!String(last.tunnelJoin).includes(`wss://${STUB_DNS} `)) throw new Error(`unexpected frame: ${last.tunnelJoin}`);
  });

  await step('T4 shutdown turns off exactly the ports we opened, and never runs `funnel reset`', async () => {
    host.close();
    await d.stop();
    const argv = fs.readFileSync(argvLog, 'utf8').trim().split('\n');
    const offs = argv.filter((l) => /\boff$/.test(l));
    for (const l of offs) console.log(`      tailscale ${l}`);
    if (!offs.includes('funnel --yes --https=443 off')) throw new Error('the client funnel was never turned off');
    if (!offs.includes('funnel --yes --https=8443 off')) throw new Error('the view funnel was never turned off');
    // `funnel reset` would drop config this daemon never created — someone else's funnel.
    if (argv.some((l) => /\breset\b/.test(l))) throw new Error('shutdown ran `funnel reset`');
  });

  fs.rmSync(dir, { recursive: true, force: true });
}

for (const d of daemons) await d.stop().catch(() => { /* already down */ });
console.log('\nNOTE  T4 ran against a stub tailscale CLI. The live Funnel path is UNVERIFIED on');
console.log('      this machine: the tailnet has no funnel node attribute, and Tailscale.app is');
console.log('      the sandboxed App Store build, whose CLI answers every serve/funnel mutation');
console.log('      with "The Tailscale GUI failed to start … (Tailscale.CLIError error 3.)".');
console.log('      Read-only subcommands (status, funnel status) work, which is what the');
console.log('      precheck uses — so the refusal above is real, only the happy path is stubbed.');
console.log(`\n--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'}`);
process.exit(failed ? 1 : 0);
