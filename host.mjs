#!/usr/bin/env node
// claude-jam host daemon + launcher. Launcher builds the tmux session; the same file
// re-execs itself with --daemon in window 0 to be the actual WS/HTTP server.
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { sanitize, stripControl, neutralizePrefixes, validName, isUuid, parseJsonlLine, buildSettings, resolveClaude, buildJoinLine, buildViewUrl, inviteLines, resolveViewKey, resolveTtyd, buildTokenFile, classifyHello, nameTaken, tokenMatches, validTokenValue, buildPopupArgs, statusRightWaiting, resolveConfigDir, jsonlGlobs, claudeTarget, toolResultAction, sanitizeFrameRow, frameDecision, frameCadence, FRAME_MIN_GAP, FRAME_FAST_GAP, mirrorSize, sendKeyArgs, validSlashCommand, guestSlashDecision, slashName, parseTunnelUrl, buildTunnelJoinLine, buildTunnelViewUrl, tunnelJoinLines, humanBytes, safeBaseName, uniqueName, xferFrames, pumpFrames, XFER_FRAME_MAX, EXPORT_MAX, UPLOAD_MAX, exportFileName, stripTokenBlock, clientCommand,
  // v0.17 Batch T: relay respawn, socket heartbeat, Tailscale Funnel.
  respawnDelay, heartbeatSweep, HEARTBEAT_MS, resolveTailscale, funnelPrecheck, funnelHost, parseFunnelUrl, FUNNEL_PORTS } from './lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
const tmux = (...a) => spawnSync(TMUX, a, { encoding: 'utf8' });

function parseArgs(argv) {
  const o = { port: 7777, host: '0.0.0.0', tmux: 'jam', extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.extra = argv.slice(i + 1); break; }
    else if (a === '--daemon') o.daemon = true;
    else if (a === '--no-attach') o.noAttach = true;
    // Value-less flags need naming here, or the generic branch below eats the next argument.
    // v0.14: the browser view is opt-in — every participant already has the real screen in
    // their own client. `--no-view` stays accepted (it is the default) so old commands run.
    else if (a === '--view') o.view = true;
    else if (a === '--no-view') o.view = false;
    else if (a === '--no-popup') o.noPopup = true;
    // v0.14: the host is in the client like everybody else, so the old host-chat layouts
    // (--split pane, cmux split, `chat` window) are gone. The flags stay accepted and do
    // nothing, so an old command line still runs.
    else if (a === '--split' || a === '--no-split' || a === '--no-cmux') o.retiredLayout = a;
    else if (a === '--no-token-in-context') o.noTokenInContext = true;
    else if (a === '--tunnel') o.tunnel = true;
    // v0.17 T4: the other public relay — Tailscale Funnel, whose hostname survives a restart.
    else if (a === '--funnel') o.funnel = true;
    else if (a.startsWith('--')) o[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    else throw new Error(`unexpected argument: ${a}`);
  }
  o.port = Number(o.port);
  return o;
}

const opts = parseArgs(process.argv.slice(2));
opts.name ||= 'Host';
opts.cwd = path.resolve(opts.cwd || process.cwd());
opts.state ||= path.join(os.tmpdir(), `claude-jam-${opts.port}`);
// No --token means no token at all: friends knock and the host accepts them. A token that
// was given must survive a join line, a chat message and a URL unquoted.
opts.token ||= null;
if (opts.token && !validTokenValue(opts.token)) { console.error(`bad --token: must be 8-64 chars of [A-Za-z0-9_-]`); process.exit(2); }
// Hooks authenticate with this, not with the friend-facing token: rotating that one must
// never break the Stop/Notification round trip.
opts.hookSecret ||= randomBytes(18).toString('base64url');
if (opts.resume) {
  // A bare `--resume` (no id) would open claude's interactive session picker, which the
  // daemon has no way to drive — require and validate a real id up front. Wins over
  // --session-id if both were given, since it's set right before the fallback below.
  if (!isUuid(opts.resume)) { console.error(`bad --resume: expected a session id (UUID), got "${opts.resume}"`); process.exit(2); }
  opts.sessionId = opts.resume;
}
opts.sessionId ||= randomUUID();
opts.claude ||= resolveClaude(process.env, fs.existsSync); // --claude wins, then JAM_CLAUDE
// The join command every invite line hands out. Computed once, here, and threaded through to
// the re-exec'd daemon as --client-cmd (below): tmux new-session does not reliably forward a
// launcher-only env var (JAM_INSTALLED) to the window it starts, so recomputing this from
// process.env independently in each process could disagree; an explicit arg cannot.
opts.clientCmd ||= clientCommand(HERE, process.env);
// Which claude account/profile the TUI runs as. null = whatever claude defaults to.
opts.configDir = resolveConfigDir(opts.configDir, process.env);
if (!validName(opts.name)) { console.error(`bad --name: ${opts.name}`); process.exit(2); }
// v0.11: fail fast, before anything is built — a daemon that started and only then
// discovered cloudflared is missing would strand the host inside `tmux attach`.
if (opts.tunnel && opts.funnel) {
  console.error('--tunnel and --funnel are two public relays for the same port: pick one.\n' +
    '  --tunnel  cloudflared quick tunnel — nothing to set up, NEW random URL on every restart\n' +
    '  --funnel  Tailscale Funnel — needs Tailscale + Funnel enabled, STABLE URL across restarts');
  process.exit(2);
}
if (opts.tunnel && spawnSync('cloudflared', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.error('cloudflared not found on PATH. --tunnel needs it: brew install cloudflared');
  process.exit(2);
}
// v0.17 T4: same fail-fast, one step earlier — Funnel has a tailnet-side prerequisite no
// amount of retrying fixes, so say exactly which of the three things is missing and stop.
// The daemon re-runs this on its own side (it is a separate process) and skips the spawn if
// the answer changed underneath us; opts.funnelDns is what makes the stable URL printable.
const tailscaleBin = resolveTailscale(opts.funnelCli, process.env, fs.existsSync);
if (opts.funnel) {
  const st = spawnSync(tailscaleBin, ['status', '--json'], { encoding: 'utf8' });
  const pre = st.error
    ? { ok: false, error: `could not run the tailscale CLI at ${tailscaleBin}: ${st.error.message}\n` +
        '  macOS keeps it inside the app bundle; point --funnel-cli <path> (or JAM_TAILSCALE) at it.' }
    : funnelPrecheck(st.stdout);
  if (!pre.ok) { console.error(`--funnel cannot start: ${pre.error}`); process.exit(2); }
  opts.funnelDns = pre.dns;
}

// Everything that drives the real TUI — capture-pane, paste-buffer, send-keys — targets the
// claude window, which holds exactly one pane: the TUI. Named, never indexed, so a host with
// `base-index`/`pane-base-index` of 1 is fine. v0.14: nothing else ever lives in that window,
// so pane and window are the same thing — the mirror, and a ttyd viewer, see only Claude Code.
const CLAUDE_PANE = claudeTarget(opts.tmux);
const BOOT = randomUUID(); // clients drop their id-dedupe set when this changes
// The live token, `/token new|set|off` away from the startup value. null = knock-only.
let currentToken = opts.token;

// Live view (ttyd): `--view` only (v0.14 — the mirror in every client made it a nice-to-have
// for people who want the TUI in a browser tab). Both the launcher and the daemon compute
// this, so they print the same view line; the launcher hands its key to the daemon with
// --view-key so a knock-only run does not end up with two different keys.
opts.viewPort = Number(opts.viewPort) || opts.port + 1;
const ttyd = opts.view ? resolveTtyd(opts.viewTtyd, fs.existsSync) : null;
if (opts.view && !ttyd) console.error('--view needs ttyd and could not find it: brew install ttyd (or --view-ttyd <path>)');
let viewKey = ttyd ? resolveViewKey(currentToken, () => opts.viewKey || newToken()) : null;

// ---------------------------------------------------------------- launcher ----
function launch() {
  if (tmux('has-session', '-t', opts.tmux).status === 0) {
    console.error(`tmux session "${opts.tmux}" already exists. Attach with: tmux attach -t ${opts.tmux}\n` +
      `Or run a second jam with --tmux <other-name>.`);
    process.exit(1);
  }
  if (opts.resume) console.log(`resuming session ${opts.resume}`);
  fs.mkdirSync(opts.state, { recursive: true, mode: 0o700 });
  writeRoster([]);
  const hooks = path.join(HERE, 'hooks.sh');
  fs.writeFileSync(path.join(opts.state, 'settings.json'), JSON.stringify(buildSettings(hooks), null, 2));

  const self = new URL(import.meta.url).pathname;
  const common = ['--port', String(opts.port), '--host', opts.host, '--name', opts.name,
    ...(opts.token ? ['--token', opts.token] : []),
    '--hook-secret', opts.hookSecret,
    '--client-cmd', opts.clientCmd,
    '--session-id', opts.sessionId, '--cwd', opts.cwd,
    '--tmux', opts.tmux, '--state', opts.state,
    '--view-port', String(opts.viewPort),
    ...(opts.view ? ['--view'] : []),
    ...(opts.viewTtyd ? ['--view-ttyd', opts.viewTtyd] : []),
    ...(viewKey ? ['--view-key', viewKey] : []),
    ...(opts.noTokenInContext ? ['--no-token-in-context'] : []),
    ...(opts.noPopup ? ['--no-popup'] : []),
    ...(opts.tunnel ? ['--tunnel'] : []),
    ...(opts.funnel ? ['--funnel'] : []),
    ...(opts.funnelCli ? ['--funnel-cli', opts.funnelCli] : []),
    ...(opts.heartbeat ? ['--heartbeat', String(opts.heartbeat)] : []),
    ...(opts.configDir ? ['--config-dir', opts.configDir] : []), // daemon globs that profile's transcripts too
    ...(opts.resume ? ['--resume', opts.resume] : [])]; // daemon needs this to skip pre-existing JSONL history

  // First window: the daemon (its own window, not a pane — its log is for when something
  // breaks, and it must never eat rows from the TUI).
  // Nothing ever attaches to this session (v0.14), so tmux would size its windows to the
  // 80x24 default and the host would watch a postage stamp in a full-screen terminal. Size
  // it to what the mirror view can actually show instead; the client re-sizes it on resize.
  const size = mirrorSize(process.stdout.columns, process.stdout.rows);
  must(tmux('new-session', '-d', '-s', opts.tmux, '-x', String(size.w), '-y', String(size.h),
    '-c', opts.cwd, '-n', 'daemon',
    process.execPath, self, '--daemon', ...common));
  sessionCreated = true;
  waitForHealth();

  // JAM_NODE: hooks.sh must not depend on whatever PATH tmux/claude inherited.
  const env = ['env', `JAM_STATE=${opts.state}`, `JAM_PORT=${opts.port}`, `JAM_HOOK_SECRET=${opts.hookSecret}`,
    `JAM_HOST_NAME=${opts.name}`, `JAM_NODE=${process.execPath}`,
    // Picks the claude account/profile for this window only; nothing global changes.
    ...(opts.configDir ? [`CLAUDE_CONFIG_DIR=${opts.configDir}`] : [])];
  console.log(`claude binary: ${opts.claude}`);
  if (opts.configDir) console.log(`claude profile: ${opts.configDir}`);
  must(tmux('new-window', '-d', '-t', opts.tmux, '-c', opts.cwd, '-n', 'claude',
    ...env, opts.claude,
    ...(opts.resume ? ['--resume', opts.resume] : ['--session-id', opts.sessionId]),
    '--settings', path.join(opts.state, 'settings.json'), ...opts.extra));
  // v0.9 addendum: a client bigger than the window (a browser viewer, or anyone who
  // attaches) gets tmux's `·` padding around the TUI, which reads as a broken screen.
  // Window option on OUR window only — the host's global config is never written.
  tmux('set-option', '-w', '-t', CLAUDE_PANE, 'fill-character', ' ');
  if (opts.retiredLayout) console.log(`${opts.retiredLayout} is retired in v0.14 — the host uses the same client as everyone (ignored)`);
  console.log(`\nclaude-jam up. session ${opts.sessionId}\n` +
    `  tmux: ${opts.tmux} (windows: daemon, claude) — detached; \`tmux attach -t ${opts.tmux}\` for the raw TUI`);
  // The tunnel dials out from the daemon process (a separate node process from this one), so
  // it has not resolved anything yet by the time this print runs — the daemon window logs the
  // URLs a few seconds later, once cloudflared reports them.
  if (opts.tunnel) console.log('cloudflared tunnel connecting — the join/view URLs land in your client (/join) once it is up');
  // v0.17 T4: unlike a quick tunnel this hostname is known before the relay is up, and it is
  // the same one tomorrow — so print it here rather than only in the daemon window.
  if (opts.funnel) console.log(`tailscale funnel connecting — wss://${funnelHost(opts.funnelDns, FUNNEL_PORTS.ws)} (same URL every run)`);
  printJoin();
  if (opts.noAttach) return;

  // v0.14: nothing attaches to tmux. The host runs the same single-pane client as every
  // guest, full-screen in this terminal, and watches the real TUI through its mirror view —
  // so there is one surface to learn, and no host chrome for a viewer to see. Loopback +
  // `--host` is what makes this client trusted (F3 key passthrough, slash commands, /token).
  const client = spawnSync(process.execPath,
    [path.join(HERE, 'client.mjs'), `ws://127.0.0.1:${opts.port}`,
      '--name', opts.name, ...(opts.token ? ['--token', opts.token] : []), '--host'],
    { stdio: 'inherit' });
  // The client is just a window onto the session: closing it leaves the daemon, the TUI and
  // every guest exactly where they were, so say how to come back and how to actually stop.
  console.log(`\nclient closed — the jam is still running.\n` +
    `  rejoin:  ${opts.clientCmd} ws://127.0.0.1:${opts.port} --name ${opts.name}` +
    `${currentToken ? ` --token ${currentToken}` : ''} --host\n` +
    `  raw TUI: tmux attach -t ${opts.tmux}\n` +
    `  stop:    tmux kill-session -t ${opts.tmux}\n`);
  if (client.status) process.exitCode = client.status;
}

let sessionCreated = false;
function must(r) {
  if (r.status !== 0) {
    console.error(`tmux failed: ${r.stderr || r.stdout}`);
    // Half-built session is useless and blocks the next `jam host`; remove the exact
    // session name we created a moment ago, nothing else.
    if (sessionCreated) tmux('kill-session', '-t', opts.tmux);
    process.exit(1);
  }
}

function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const r = spawnSync('curl', ['-s', '-m', '1', `http://127.0.0.1:${opts.port}/health`], { encoding: 'utf8' });
    if (r.stdout?.includes('"ok"')) return;
    spawnSync('sleep', ['0.3']);
  }
  console.error('daemon did not come up; check the tmux daemon window');
  process.exit(1);
}

function externalIp() {
  const ts = spawnSync('tailscale', ['ip', '-4'], { encoding: 'utf8' });
  const ip = ts.stdout?.trim().split('\n')[0];
  if (ip && /^\d/.test(ip)) return ip;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return '127.0.0.1';
}

// Shared by launch() and daemon() (same process, re-exec'd with --daemon) and by the
// welcome frame, so both invite lines are built in exactly one place. `join` is null while
// no token is set, `view` while there is no ttyd view. tunnelJoin/tunnelView (v0.11) are
// null until --tunnel is given and cloudflared has resolved a hostname for that port.
function joinInfo() {
  const ip = externalIp();
  return {
    join: buildJoinLine(ip, opts.port, currentToken, opts.clientCmd),
    view: buildViewUrl(ip, opts.viewPort, viewKey),
    tunnelJoin: buildTunnelJoinLine(tunnelHosts.ws, currentToken, opts.clientCmd),
    tunnelView: buildTunnelViewUrl(tunnelHosts.view, viewKey),
  };
}

// What the host is told wherever the invite lines would go — the same list, in the same
// order, that a host client prints on connect and on `/join`.
function printJoin() {
  const info = joinInfo();
  const lines = inviteLines(info).map((l) => `  ${l}`).join('\n');
  console.log(info.join || info.tunnelJoin ? `\nSend this to a friend:\n${lines}\n` : `\n${lines}\n`);
}

// claude reads this back through hooks.sh, so the host can just ask the agent for the
// token. --no-token-in-context keeps it off disk entirely (a stale file from an earlier
// run on this port would otherwise put the token back into the context).
function writeTokenFile() {
  const file = path.join(opts.state, 'token.json');
  if (opts.noTokenInContext) return fs.rmSync(file, { force: true });
  const { join, view, tunnelJoin, tunnelView } = joinInfo();
  fs.writeFileSync(file, JSON.stringify(buildTokenFile(currentToken, join, view, tunnelJoin, tunnelView), null, 2));
}

function writeRoster(participants) {
  fs.writeFileSync(path.join(opts.state, 'roster.json'),
    JSON.stringify({ hostName: opts.name, sessionId: opts.sessionId, participants }, null, 2));
}

// ------------------------------------------------------------------ daemon ----
const clients = new Map(); // ws -> {name, host, joinedAt, lastTyping}
const pending = new Map(); // ws -> {name, ip, timer} — knockers waiting for the host
const KNOCK_TTL = 120000;
const MAX_PENDING = 10;
const history = [];
let nextId = 1;
const status = { busy: false, waiting: false };
let busyGen = 0; // bumped when a turn starts, so a slow Stop drain cannot clear a newer turn
let toolResults = 0; // `⎿` lines broadcast this turn; capped so a big grep cannot flood

function startTurn() { busyGen++; toolResults = 0; }

function send(ws, ev) { try { ws.send(JSON.stringify(ev)); } catch { /* closing */ } }

// Errors are host->client events too, so they carry id/ts like everything else.
function sendError(ws, text) { send(ws, { t: 'error', id: nextId++, ts: Date.now(), text }); }

// Knock and token frames go to host clients only: friends must not see the token, and
// they stay out of `history`, which is replayed to everyone in `welcome`.
function sendHosts(ev) {
  const full = { ...ev, id: nextId++, ts: Date.now() };
  for (const [ws, c] of clients) if (c.host) send(ws, full);
}

function newToken() { return randomBytes(12).toString('base64url').slice(0, 16); }

function broadcast(ev) {
  const full = { ...ev, id: nextId++, ts: Date.now() };
  if (ev.t !== 'typing') { history.push(full); if (history.length > 300) history.shift(); }
  for (const ws of clients.keys()) send(ws, full);
  if (ev.t !== 'typing') console.log(`[${ev.t}]`, ev.from || ev.kind || '', (ev.text || '').slice(0, 120));
  bumpActivity(); // v0.15: anything worth telling everybody is worth a fast mirror
  return full;
}

function names() { return [...clients.values()].map((c) => c.name); }

function pushStatus() { broadcast({ t: 'status', busy: status.busy, waiting: status.waiting }); }

function rosterChanged(extra) {
  writeRoster([...clients.values()].map(({ name, joinedAt }) => ({ name, joinedAt })));
  broadcast({ t: 'roster', roster: names(), ...extra });
}

// ------------------------------------------------------------- live view ----
// ttyd runs this once per browser connection: a tmux session of the viewer's own, grouped
// with the jam session (same live windows) but with its own focus — so the host switching
// windows never yanks a viewer's screen — pinned to the claude window and destroyed the
// moment the browser goes away. The tmux binary and session name are passed as arguments,
// never interpolated into the script.
// v0.9: `status off` on the viewer's OWN session (never the host's), so the browser shows
// the Claude Code screen and nothing else — no window list, no `⚑ N waiting` badge.
const VIEW_SH = 'S="$2-view-$$"; exec "$1" new-session -t "$2" -s "$S" ";" ' +
  'set-option -t "$S" destroy-unattached on ";" set-option -t "$S" status off ";" ' +
  'select-window -t "$S:claude"';

let viewProc = null; // our ttyd child: killed by its own pid, never by pattern

function startView() {
  if (!ttyd || viewProc) return;
  // ttyd >= 1.7 is read-only unless -W is given, so read-only needs no flag of its own.
  const child = spawn(ttyd, ['-p', String(opts.viewPort), '-c', `jam:${viewKey}`,
    'sh', '-c', VIEW_SH, 'jam-view', TMUX, opts.tmux], { stdio: 'ignore' });
  viewProc = child;
  child.on('exit', (code) => {
    if (viewProc === child) viewProc = null;
    if (code) console.log(`live view exited (ttyd code ${code}) — is :${opts.viewPort} taken?`);
  });
  child.on('error', (e) => { if (viewProc === child) viewProc = null; console.log(`live view failed: ${e.message}`); });
  console.log(`live view on :${opts.viewPort} (ttyd pid ${child.pid})`);
}

function stopView() {
  if (!viewProc) return;
  const child = viewProc;
  viewProc = null;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

// ttyd cannot change its basic-auth credentials while running, so a new view key means a
// new child. Wait for the old one to die before respawning, or the port is still bound.
function restartView() {
  if (!ttyd) return;
  if (!viewProc) return startView();
  const child = viewProc;
  viewProc = null;
  child.once('exit', () => startView());
  child.kill('SIGTERM');
}

// ------------------------------------------------------ public relays ----
// v0.11: two quick tunnels, spawned from the daemon so their lifecycle matches ttyd's —
// tracked by the exact pid we spawned, killed on daemon exit. Cloudflare terminates TLS at the
// edge, so the guest join line is wss:// with no port.
// v0.17 T1/T4: two relays now, one code path. cloudflared (`--tunnel`, random hostname, dies
// with the process) and `tailscale funnel` in the FOREGROUND (`--funnel`, the node's own stable
// MagicDNS hostname) differ only in argv and in which line carries the hostname, so RELAY holds
// exactly that and everything below — the pid tracking, the URL propagation, and T1's respawn
// backoff — is shared. Mutually exclusive; both optional.
const TUNNEL_WAIT_MS = 30000;
let tunnelProcs = { ws: null, view: null }; // our own children, killed by pid only
let tunnelHosts = { ws: null, view: null }; // resolved hostnames; null until the relay reports one
const relayAttempts = { ws: 0, view: 0 }; // consecutive deaths, reset the moment a URL resolves
const relayTimers = { ws: null, view: null }; // pending respawns, cleared on shutdown
let relayStopping = false; // a SIGTERM of ours is not a death to recover from

const RELAYS = {
  tunnel: {
    what: 'cloudflared',
    // cloudflared writes its banner to stderr, `tailscale funnel` to stdout — both streams are
    // piped and fed into the same buffer, so neither relay needs to care which.
    args: (port) => ['tunnel', '--url', `http://localhost:${port}`],
    parse: parseTunnelUrl,
    // Every respawn is a NEW random hostname: exactly why T3 tells a guest after five failed
    // reconnects that the join URL may have changed.
    stable: false,
  },
  funnel: {
    what: 'tailscale funnel',
    // Foreground (no --bg): the funnel lives exactly as long as this child, which is the same
    // tracked-pid lifecycle cloudflared has. --yes because a daemon has no terminal to prompt.
    args: (port, label) => ['funnel', '--yes', `--https=${FUNNEL_PORTS[label]}`, `http://localhost:${port}`],
    parse: parseFunnelUrl,
    stable: true,
  },
};
const relay = opts.funnel ? RELAYS.funnel : RELAYS.tunnel;
const relayBin = () => (opts.funnel ? tailscaleBin : 'cloudflared');

function spawnRelay(label, port) {
  const child = spawn(relayBin(), relay.args(port, label), { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnelProcs[label] = child;
  console.log(`tunnel (${label}): ${relay.what} connecting… (pid ${child.pid})`);
  let buf = '';
  const timer = setTimeout(() => {
    if (!tunnelHosts[label]) console.log(`tunnel (${label}): still no URL after 30s — ${relay.what} may be stuck or blocked`);
  }, TUNNEL_WAIT_MS);
  timer.unref?.();
  const onOut = (chunk) => {
    buf += chunk;
    if (buf.length > 8192) buf = buf.slice(-8192); // the banner is small; never grow unbounded
    if (tunnelHosts[label]) return; // already resolved, nothing left to parse for
    const host = relay.parse(buf);
    if (!host) return;
    tunnelHosts[label] = host;
    relayAttempts[label] = 0; // it worked: the next death waits 1s, not 30
    clearTimeout(timer);
    console.log(`tunnel (${label}) up: ${host}`);
    onTunnelChange();
  };
  child.stdout.on('data', onOut);
  child.stderr.on('data', onOut);
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (tunnelProcs[label] === child) tunnelProcs[label] = null;
    const had = tunnelHosts[label];
    tunnelHosts[label] = null;
    console.log(`tunnel (${label}) exited (${relay.what} code ${code}) — its join/view URL is cleared`);
    // A relay that never got a URL took the reason with it; the tail of what it said is the
    // only diagnosis anybody gets (a sandboxed Tailscale, a blocked cloudflared).
    if (!had && buf.trim()) console.log(`tunnel (${label}) said: ${buf.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`);
    if (had) onTunnelChange();
    // v0.17 T1: a dead relay is the confirmed failure mode of a two-hour session, so bring it
    // back — unlimited attempts, 1s doubling to 30s. Our own SIGTERM is not a death.
    if (relayStopping) return;
    const delay = respawnDelay(++relayAttempts[label]);
    console.log(`tunnel (${label}): restarting in ${delay / 1000}s (attempt ${relayAttempts[label]})`);
    relayTimers[label] = setTimeout(() => { relayTimers[label] = null; spawnRelay(label, port); }, delay);
    relayTimers[label].unref?.();
  });
  // 'error' (the binary vanished) is followed by 'exit', which owns the respawn.
  child.on('error', (e) => console.log(`tunnel (${label}) failed to start: ${e.message}`));
}

function startTunnels() {
  if (!opts.tunnel && !opts.funnel) return;
  if (opts.funnel) {
    // The whole point of Funnel over a quick tunnel: this URL is the same after a respawn, a
    // daemon restart and a reboot. Say it up front — it is bookmarkable before it is even up.
    console.log(`funnel: wss://${funnelHost(opts.funnelDns, FUNNEL_PORTS.ws)} (stable — same URL across restarts)`);
  }
  spawnRelay('ws', opts.port);
  // The view relay only makes sense when a view server is actually running — same gate
  // startView() itself uses (`--view` given and ttyd found).
  if (ttyd) spawnRelay('view', opts.viewPort);
}

function stopTunnels() {
  relayStopping = true;
  for (const label of Object.keys(relayTimers)) {
    if (relayTimers[label]) { clearTimeout(relayTimers[label]); relayTimers[label] = null; }
  }
  for (const label of Object.keys(tunnelProcs)) {
    const child = tunnelProcs[label];
    if (!child) continue;
    tunnelProcs[label] = null;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    // Foreground `tailscale funnel` is documented to drop its config when it exits, but a
    // funnel left open is a port on the public internet — so ask for that exact port to be
    // turned off too, scoped, never `funnel reset` (which would wipe config we never made).
    if (opts.funnel) {
      const r = spawnSync(tailscaleBin, ['funnel', '--yes', `--https=${FUNNEL_PORTS[label]}`, 'off'], { encoding: 'utf8' });
      if (r.status !== 0) console.log(`funnel (${label}) off failed: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
    }
  }
}

// Whenever a tunnel resolves or dies: token.json (hence claude's context) and the console
// block reflect it right away, and already-connected host clients hear about it on the same
// frame `/token` uses. `/token` rotation itself does NOT call this — it never touches
// tunnelHosts, only the join/view *strings*, which joinInfo() recomputes from the live token.
function onTunnelChange() {
  writeTokenFile();
  printJoin();
  const { join, view, tunnelJoin, tunnelView } = joinInfo();
  sendHosts({ t: 'token', token: currentToken, join, view, tunnelJoin, tunnelView });
}

// -------------------------------------------------------- terminal mirror ----
// v0.7: guests who ask for it get the claude pane's actual cells, escape sequences and all,
// instead of an imitation of them. `capture-pane -e` is only run while somebody is
// subscribed, and only a changed screen is sent — so an idle mirror costs one tmux call per
// tick and zero bytes on the wire. Frames never enter `history`: they are a live view, and
// replaying yesterday's screen to a reconnecting client would be nonsense.
const mirrors = new Set(); // sockets in mirror mode
let frameTimer = null;
let lastFrame = null;
let lastFrameAt = 0;
// v0.15: the cadence signal. Anything that can move the screen — a message going in, a turn
// running, somebody typing, the screen itself changing — stamps this, and the poll runs at
// FRAME_FAST_GAP for the next FRAME_ACTIVE_MS. Nothing else has to know about frames.
let lastActivity = 0;
let cadenceShown = null; // the gap we last logged, so a transition costs one line

function bumpActivity() {
  lastActivity = Date.now();
  // Only a transition reschedules: a burst of ten messages must not churn ten timers.
  if (mirrors.size && cadenceShown !== FRAME_FAST_GAP) scheduleFrames();
}

// The pane's size, cached. It only changes when somebody attaches or resizes, and at 25
// frames/s a second tmux call per frame would double the spawn count for nothing.
const SIZE_TTL = 500;
let paneSize = { w: 0, h: 0, at: 0 };
function paneDims(rows) {
  const now = Date.now();
  if (paneSize.at && now - paneSize.at < SIZE_TTL) return paneSize;
  const out = (tmux('display-message', '-p', '-t', CLAUDE_PANE, '#{pane_width} #{pane_height}').stdout || '').trim().split(/\s+/);
  paneSize = { w: Number(out[0]) || 80, h: Number(out[1]) || rows.length, at: now };
  return paneSize;
}

function captureFrame() {
  const r = tmux('capture-pane', '-e', '-p', '-t', CLAUDE_PANE);
  if (r.status !== 0) return null;
  return (r.stdout || '').replace(/\n$/, '').split('\n').map(sanitizeFrameRow);
}

function pumpMirror() {
  if (!mirrors.size) return;
  const now = Date.now();
  // The cadence is also the rate cap: at 40 ms nobody gets more than 25 frames a second.
  const gap = frameCadence({ viewers: mirrors.size, lastActivityAt: lastActivity, now }) ?? FRAME_MIN_GAP;
  const rows = captureFrame();
  if (frameDecision({ rows, prev: lastFrame, now, lastAt: lastFrameAt, minGap: gap }) !== 'send') return;
  lastFrame = rows;
  lastFrameAt = now;
  const size = paneDims(rows);
  const ev = { t: 'screen', id: nextId++, ts: lastFrameAt, rows, w: size.w, h: size.h };
  keepWindowSize(ev.w, ev.h); // somebody attached and took the window's size with them
  for (const ws of mirrors) if (clients.has(ws)) send(ws, ev);
  bumpActivity(); // a screen that is still moving keeps its own cadence fast
}

// One self-rescheduling timer instead of a fixed interval: every tick books the next one at
// the cadence that is right NOW, so the mirror speeds up on the first sign of activity and
// drops back to 250 ms two seconds after the last. No viewers = no timer at all.
function scheduleFrames() {
  if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
  const gap = frameCadence({ viewers: mirrors.size, lastActivityAt: lastActivity, now: Date.now() });
  if (gap == null) { cadenceShown = null; return; }
  if (gap !== cadenceShown) {
    cadenceShown = gap;
    console.log(`[frames] cadence ${gap}ms (${gap === FRAME_FAST_GAP ? 'active' : 'idle'}, ${mirrors.size} watching)`);
  }
  frameTimer = setTimeout(() => { frameTimer = null; pumpMirror(); scheduleFrames(); }, gap);
  frameTimer.unref?.();
}

// Only the client the launcher spawned on loopback with `--host` may touch the real TUI.
// Both halves matter: `host` is the claim, `loopback` is what makes it believable.
const trusted = (me) => !!(me && me.host && me.loopback);

// Keep the detached claude window the size of the host's mirror. A no-op when it already
// matches, so a resize storm costs one tmux query. `resize-window` pins the window to a
// manual size (documented ceiling: a later `tmux attach` no longer reshapes it).
let windowSize = { w: 0, h: 0 };
function resizeClaudeWindow(w, h) {
  const want = mirrorSize(w, h); // the client sends its terminal size; mirrorSize takes the chrome off
  if (want.w === windowSize.w && want.h === windowSize.h) return;
  windowSize = want;
  applyWindowSize('resize');
}

function applyWindowSize(why) {
  const r = tmux('resize-window', '-t', CLAUDE_PANE, '-x', String(windowSize.w), '-y', String(windowSize.h));
  if (r.status !== 0) return console.log(`resize-window failed: ${(r.stderr || '').trim()}`);
  console.log(`[${why}] claude window → ${windowSize.w}x${windowSize.h}`);
  lastFrame = null; // the next capture is a different shape; send it even if the text matches
  paneSize.at = 0; // and the cached pane size is stale by definition
}

// tmux sizes a shared window to the last client that used it, so anyone attaching to the raw
// TUI (or a second browser viewer) reshapes the screen the host is mirroring — and it stays
// that way after they leave. Put the host's size back, but only once nobody is attached:
// while someone has the session open, the size is theirs.
function keepWindowSize(w, h) {
  if (!windowSize.w || (w === windowSize.w && h === windowSize.h)) return;
  if (hostClients().length) return;
  applyWindowSize('resize back');
}

function setMirror(ws, on) {
  if (on) mirrors.add(ws); else mirrors.delete(ws);
  // A joiner wants the screen now, not in 250 ms — and it has never seen `lastFrame`.
  // Subscribing is itself activity: the frame after an F3 attach comes back must be prompt.
  if (on) { lastFrame = null; lastFrameAt = 0; lastActivity = Date.now(); pumpMirror(); }
  scheduleFrames();
  console.log(`[mirror] ${clients.get(ws)?.name || '?'} ${on ? 'on' : 'off'} (${mirrors.size} watching)`);
}

// ----------------------------------------------------------- knock popups ----
// The host approves a knock without leaving the claude window. Popups land only on clients
// attached to the jam session itself — ttyd viewers sit on grouped sessions and never see
// them. One at a time: the next knock gets its popup when the current one closes, and a
// knock whose popup was ignored keeps waiting for /accept instead of popping again.
let popupProc = null;
let statusRightShown = null; // the '⚑ N waiting' we last wrote, null = the host's own value
let savedStatusRight; // undefined = never read; null = was inherited, so restore with -u

function saveStatusRight() {
  if (opts.noPopup) return;
  // Without -A this prints nothing unless status-right is set on the SESSION, which is
  // exactly the difference between "put the old value back" and "go back to inheriting".
  const set = tmux('show-options', '-t', opts.tmux, 'status-right');
  savedStatusRight = set.status === 0 && set.stdout.trim()
    ? (tmux('show-options', '-t', opts.tmux, '-v', 'status-right').stdout || '').replace(/\n$/, '')
    : null;
}

// Session option only: the host's global tmux config is never touched.
function restoreStatusRight() {
  if (!statusRightShown) return; // we never wrote one, so there is nothing to undo
  statusRightShown = null;
  if (savedStatusRight == null) tmux('set-option', '-u', '-t', opts.tmux, 'status-right');
  else tmux('set-option', '-t', opts.tmux, 'status-right', savedStatusRight);
}

function refreshStatusRight() {
  if (opts.noPopup) return;
  const want = statusRightWaiting(pending.size);
  if (want === statusRightShown) return;
  if (!want) return restoreStatusRight();
  statusRightShown = want;
  tmux('set-option', '-t', opts.tmux, 'status-right', want);
}

// display-popup needs a client attached to the jam session to draw on. With nobody attached
// it does NOT fail: the tmux client blocks forever waiting for one, which would wedge the
// queue and orphan a process. So ask first. `list-clients -t <session>` lists only clients
// attached to the base session — a ttyd viewer sits on a grouped session of its own and is
// not in here, which is exactly who must not see popups. The names are also what `-c` needs:
// without it tmux picks any client showing the window, viewers included (v0.9).
function hostClients() {
  const r = tmux('list-clients', '-t', opts.tmux, '-F', '#{client_name}');
  return r.status === 0 ? (r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

function stopPopup() {
  if (!popupProc) return;
  const child = popupProc;
  popupProc = null;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

// What the popup's one line names: the command, or the file with its size. A knock names the
// person and their IP, which popupPrompt takes separately.
const popupDetail = (kind, rec) => (kind === 'file' ? `${rec.detail} (${humanBytes(rec.size)})` : rec.detail || '');

// v0.16: the host client's approval bar. ONE frame carries the whole pending set — every
// change to `pending` or to a ladder already funnels through pumpPopups(), so there is a
// single place to push from and no add/remove bookkeeping that could drift out of step with
// what is really waiting. `expires` is the request's own deadline, so the bar counts down to
// the same moment the daemon's timer fires.
function pendingFrame() {
  return {
    t: 'pending',
    items: [
      ...[...pending.values()].map((p) => ({ kind: 'knock', name: p.name, ip: p.ip, expires: p.expires })),
      ...Object.entries(ladders).flatMap(([kind, L]) => [...L.requests.values()].map((r) => ({
        kind, name: r.name, detail: r.detail || '', size: r.size, expires: r.expires,
      }))),
    ],
  };
}

// Called on every change to `pending` or a ladder's requests: keeps the status line honest,
// raises the approval bar in every host client, and opens the next popup. v0.14: the host
// normally sits in the client, not in tmux, so the popup is the path for anyone who IS
// attached — `hostClients()` is empty otherwise and the request waits for a bar key or a
// client command instead.
function pumpPopups() {
  sendHosts(pendingFrame());
  refreshStatusRight();
  if (opts.noPopup || popupProc) return;
  // Knocks first, then every kind of approval request; `popped` is set on the record itself,
  // so a request whose popup was ignored waits for a client command instead of popping again.
  const queued = [...[...pending.values()].map((p) => ['knock', p]),
    ...Object.entries(ladders).flatMap(([kind, L]) => [...L.requests.values()].map((r) => [kind, r]))];
  const next = queued.find(([, p]) => !p.popped);
  if (!next) return;
  const [kind, rec] = next;
  rec.popped = true;
  // The /accept or /allow-cmd line logged with the request itself is still the way in.
  const client = hostClients()[0];
  if (!client) return console.log(`[${kind}] no client attached — no popup for ${rec.name}`);
  const child = spawn(TMUX, buildPopupArgs({
    session: opts.tmux, client, node: process.execPath, script: path.join(HERE, 'popup.mjs'),
    name: rec.name, ip: rec.ip || '', ttlS: Math.round(KNOCK_TTL / 1000), port: opts.port,
    secret: opts.hookSecret, kind, detail: popupDetail(kind, rec),
  }), { stdio: ['ignore', 'ignore', 'pipe'] });
  popupProc = child;
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  // A popup that fails anyway (the client detached between the check and now, tmux gone)
  // must not matter: host clients already have the knock frame and /accept still works.
  child.on('exit', (code) => {
    if (popupProc === child) popupProc = null;
    if (code) console.log(`knock popup failed (tmux exit ${code}): ${err.trim() || 'no output'}`);
    pumpPopups();
  });
  child.on('error', (e) => {
    if (popupProc === child) popupProc = null;
    console.log(`knock popup failed: ${e.message}`);
  });
  console.log(`[${kind}] popup for ${rec.name} on ${client} (tmux pid ${child.pid})`);
}

function daemon() {
  saveStatusRight();
  const http = createServer(onRequest);
  // Frame size is enforced by ws before hello/token, so keep it small instead of the ~100 MB
  // default an unauthenticated peer could throw at us. v0.13 raised it from 64 KB to fit ONE
  // upload chunk (64 KB of bytes = 87 KB of base64) plus its envelope; the transfer itself is
  // capped, gated and counted in onUploadChunk, not here.
  const wss = new WebSocketServer({ server: http, maxPayload: XFER_FRAME_MAX });
  wss.on('connection', onSocket);
  http.listen(opts.port, opts.host, () => {
    console.log(`claude-jam daemon on ${opts.host}:${opts.port}, session ${opts.sessionId}`);
    writeTokenFile();
    // Printed by the launcher too, but that copy scrolls away under the host's client; this
    // is the one the host can still read in the daemon window. The globs come with it: a
    // profile on another machine keeps its transcripts somewhere else entirely.
    if (opts.configDir) {
      console.log(`claude profile: ${opts.configDir}`);
      console.log(`tail globs: ${jsonlGlobs(opts.sessionId, os.homedir(), opts.configDir).join('  ')}`);
    }
    if (ttyd) startView();
    startTunnels();
    // The launcher prints this too, right before the host's client takes over the screen —
    // this is the copy that stays readable, in the `daemon` window, for when the host wants
    // it after the fact (`/join` in the client is the everyday way).
    printJoin();
    console.log(`state ${opts.state}`);
  });
  // The ttyd/cloudflared children are ours alone. tmux kill-session hangs up the daemon
  // window, and a SIGHUP would otherwise skip the exit handler and leave them orphaned.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopView(); stopTunnels(); stopPopup(); restoreStatusRight(); process.exit(0); });
  process.on('exit', () => { stopView(); stopTunnels(); stopPopup(); restoreStatusRight(); });
  setInterval(tailJsonl, 300).unref?.();
  startHeartbeat(wss);
}

// v0.17 T2: the `ws` README's own broken-connection pattern. Two things need it. One, a socket
// can be dead without being closed — a laptop that slept, a relay that dropped the connection
// without a FIN — and until now the ONLY cleanup path was ws.on('close'), so such a peer sat in
// the roster and held its name forever. Two, the mirror deliberately sends nothing while the
// screen is unchanged (frameDecision), which is exactly the silence Cloudflare's documented
// 100s WebSocket idle cap is watching for: a ping every 30s keeps the connection warm even
// through a long quiet turn. Sweeps every socket, admitted or still knocking. terminate() fires
// 'close', so the existing handler does the roster/mirror/ladder cleanup — nothing is duplicated.
const HEARTBEAT_GAP = Number(opts.heartbeat) > 0 ? Number(opts.heartbeat) : HEARTBEAT_MS;
function startHeartbeat(wss) {
  const timer = setInterval(() => {
    // The record ws itself carries: `alive` flips false on every tick and back on the pong.
    const { ping, terminate } = heartbeatSweep([...wss.clients].map((ws) => [ws, { alive: ws.jamAlive !== false }]));
    for (const ws of terminate) {
      const who = clients.get(ws)?.name || pending.get(ws)?.name || '?';
      console.log(`[heartbeat] ${who} missed a ping round — terminating`);
      ws.terminate();
    }
    for (const ws of ping) { ws.jamAlive = false; try { ws.ping(); } catch { /* closing */ } }
  }, HEARTBEAT_GAP);
  timer.unref?.();
  console.log(`heartbeat: ping every ${HEARTBEAT_GAP}ms, terminate on a missed round`);
}

function onRequest(req, res) {
  const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/health') {
    // Liveness is public (the launcher polls it); real names need the token.
    return reply(200, tokenMatches(req.headers['x-jam-token'], currentToken) ? { ok: 'ok', participants: names() } : { ok: 'ok' });
  }
  // popup.mjs answers a knock through here. Same guard as /hook: loopback plus the
  // internal secret, so a rotated friend token never reaches it.
  if (req.method === 'POST' && req.url === '/admit') {
    if (!isLoopback(req.socket.remoteAddress)) return reply(403, { error: 'loopback only' });
    if (!tokenMatches(req.headers['x-jam-secret'], opts.hookSecret)) return reply(403, { error: 'bad secret' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let m;
      try { m = JSON.parse(body); } catch { return reply(400, { error: 'bad JSON' }); }
      // Exactly the path a host client's frame takes. A request that expired or was already
      // answered in a client is a 404, and the popup exits silently. A popup cannot grant
      // STANDING approval (`always`) — one key, one request.
      const err = ladders[m?.kind]
        ? answerHost(m.kind, m?.name, m?.ok === true)
        : admit(m?.name, m?.ok === true);
      reply(err ? 404 : 200, err ? { error: err } : { ok: true });
    });
    return;
  }
  const hook = /^\/hook\/(\w[\w-]*)$/.exec(req.url || '');
  if (req.method === 'POST' && hook) {
    if (!isLoopback(req.socket.remoteAddress)) return reply(403, { error: 'loopback only' });
    // Hooks carry the internal secret, so `/token off` and every rotation leave them working.
    if (!tokenMatches(req.headers['x-jam-secret'], opts.hookSecret)) return reply(403, { error: 'bad secret' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { onHook(hook[1], body); reply(200, { ok: true }); });
    return;
  }
  reply(404, { error: 'not found' });
}

function onHook(event, body) {
  let payload = {};
  try { payload = JSON.parse(body); } catch { /* hooks must never break the session */ }
  if (event === 'stop') {
    // Stop fires the instant the turn ends, but claude flushes the turn's last record to
    // the JSONL a beat later (~100 ms measured) and the tail only polls every 300 ms.
    // Drain until the file goes quiet, so the final agent text is broadcast BEFORE
    // busy:false instead of after it.
    status.waiting = false;
    const gen = busyGen;
    drainTail().catch((e) => console.error('drain failed:', e.message)).then(() => {
      if (gen === busyGen) status.busy = false; // a new turn started meanwhile: leave it busy
      pushStatus();
    });
  } else if (event === 'notification') {
    const msg = String(payload.message || '');
    if (/permission|approve|allow/i.test(msg)) { status.waiting = true; pushStatus(); }
  }
}

const isLoopback = (ip) => { const s = String(ip || ''); return s.endsWith('127.0.0.1') || s === '::1'; };

// Both admission paths end here: the same welcome, the same roster broadcast.
// `loopback` is remembered per socket, not re-derived later: everything that can reach the
// real TUI (F3 keys, slash passthrough, window resize) needs host AND loopback, and a
// `host:true` claim from off-box was already downgraded to a friend by classifyHello.
function admitSocket(ws, name, host, loopback = false) {
  const me = { name, host, loopback, joinedAt: Date.now(), lastTyping: 0 };
  clients.set(ws, me);
  send(ws, {
    t: 'welcome', id: nextId++, ts: Date.now(), you: name, roster: names(),
    history: history.slice(),
    // join is the invite line and view the ttyd URL; only the host client gets them —
    // friends never see the token-bearing command or the view key. null (but present) for
    // the host while no token is set / no view is running.
    // v0.15: `tmux` rides with them for the same reason — it is what F3 attaches to, and
    // `host` here is already "claimed host AND loopback", i.e. exactly who may attach.
    session: {
      id: opts.sessionId, cwd: opts.cwd, hostName: opts.name, boot: BOOT,
      ...(host ? { ...joinInfo(), tmux: opts.tmux } : {}),
    },
  });
  rosterChanged({ joined: name });
  send(ws, { t: 'status', id: nextId++, ts: Date.now(), busy: status.busy, waiting: status.waiting });
  // Knocks and approval requests stay out of `history`, so a host client that connects (or
  // reconnects) while somebody is waiting would otherwise never hear about them.
  if (host) {
    for (const p of pending.values()) send(ws, { t: 'knock', id: nextId++, ts: Date.now(), name: p.name, ip: p.ip });
    for (const L of Object.values(ladders)) {
      for (const r of L.requests.values()) send(ws, { ...L.frame(r), id: nextId++, ts: Date.now() });
    }
    // v0.16: and the whole set again as one frame, which is what raises the approval bar.
    send(ws, { ...pendingFrame(), id: nextId++, ts: Date.now() });
  }
}

// The one admission decision, shared by `/accept`/`/deny` in a host client ({t:'admit'})
// and by the in-TUI popup (POST /admit). No name = the only pending knocker. Returns null
// when it acted, or the reason nothing happened.
function admit(name, ok) {
  const waiting = [...pending.entries()];
  let hit;
  if (name == null || name === '') {
    if (waiting.length !== 1) {
      return waiting.length ? `${waiting.length} people are waiting — name one` : 'nobody is waiting';
    }
    hit = waiting[0];
  } else {
    hit = waiting.find(([, p]) => nameTaken(name, [p.name]));
    if (!hit) return `nobody named "${name}" is waiting`;
  }
  const [sock, p] = hit;
  clearTimeout(p.timer);
  pending.delete(sock);
  if (ok) {
    admitSocket(sock, p.name, false, isLoopback(p.ip));
    // The mirror wish rode in on the hello that knocked; a client whose default view is the
    // mirror (v0.14) must not have to ask again after being let in.
    if (p.mirror) setMirror(sock, true);
    console.log(`[admit] ${p.name} accepted`);
  } else {
    send(sock, { t: 'knock', id: nextId++, ts: Date.now(), state: 'denied' });
    sock.close(4403, 'denied');
    console.log(`[admit] ${p.name} denied`);
  }
  pumpPopups();
  return null;
}

// `/accept [name]` / `/deny <name>` arrive as {t:'admit', name, ok} from a host client.
function onAdmit(ws, m) {
  const err = admit(m.name, m.ok);
  if (err) sendError(ws, err);
}

// `/token new|set <v>|off` from a host client. Admission is checked only at hello time,
// so rotating never disconnects anyone already in.
function onToken(ws, m) {
  if (m.op === 'new') currentToken = newToken();
  else if (m.op === 'off') currentToken = null;
  else if (m.op === 'set') {
    if (!validTokenValue(m.value)) return sendError(ws, 'token must be 8-64 chars of [A-Za-z0-9_-]');
    currentToken = m.value;
  } else return sendError(ws, `unknown token op: ${m.op}`);
  // The view key follows the token: a fresh generated one whenever the token goes away,
  // so an old key never keeps working. Same key (`/token set` with the current value) is
  // not worth a restart.
  if (ttyd) {
    const next = resolveViewKey(currentToken, newToken);
    if (next !== viewKey) { viewKey = next; restartView(); }
  }
  writeTokenFile();
  // Rotation never respawns cloudflared — tunnelHosts is untouched — but the join command
  // embeds the token and the view URL embeds viewKey, so both tunnel strings still change.
  const { join, view, tunnelJoin, tunnelView } = joinInfo();
  sendHosts({ t: 'token', token: currentToken, join, view, tunnelJoin, tunnelView });
  printJoin();
}

function onSocket(ws, req) {
  const ip = String(req.socket.remoteAddress || '');
  // v0.17 T2: the other half of startHeartbeat's sweep. The browser-standard WebSocket every
  // jam client uses answers protocol pings automatically and gives the application no say in
  // it, so there is nothing to write on the client side — this is the whole client contract.
  ws.jamAlive = true;
  ws.on('pong', () => { ws.jamAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return sendError(ws, 'bad JSON'); }
    const me = clients.get(ws); // set by admitSocket, on either admission path
    if (!me) {
      // A pending knocker can only wait: nothing it sends reaches claude, the roster or
      // the other participants.
      if (pending.has(ws)) return sendError(ws, 'waiting for host approval');
      if (m.t !== 'hello') return sendError(ws, 'say hello first');
      const c = classifyHello(m, currentToken, isLoopback(ip));
      if (!c.ok) { sendError(ws, c.error); return ws.close(c.code, c.error); }
      // Attribution is by name, and a knocker's name is reserved while it waits.
      if (nameTaken(c.name, [...names(), ...[...pending.values()].map((p) => p.name)])) {
        sendError(ws, `the name "${c.name}" is already taken here`);
        return ws.close(4409, 'name taken');
      }
      // `hello {mirror:true}` starts a client straight in mirror mode; the runtime
      // {t:'mirror'} frame (F2 / `/mirror`) is the same switch.
      if (c.admit === 'token') {
        admitSocket(ws, c.name, c.host, isLoopback(ip));
        if (m.mirror === true) setMirror(ws, true);
        return;
      }
      if (pending.size >= MAX_PENDING) {
        sendError(ws, 'too many people are waiting for approval');
        return ws.close(4429, 'too many knocks');
      }
      const timer = setTimeout(() => {
        pending.delete(ws);
        send(ws, { t: 'knock', id: nextId++, ts: Date.now(), state: 'expired' });
        ws.close(4408, 'knock expired');
        pumpPopups();
      }, KNOCK_TTL);
      pending.set(ws, { name: c.name, ip, timer, expires: Date.now() + KNOCK_TTL, mirror: m.mirror === true });
      send(ws, { t: 'knock', id: nextId++, ts: Date.now(), state: 'pending' });
      sendHosts({ t: 'knock', name: c.name, ip });
      console.log(`[knock] ${c.name} from ${ip} — /accept ${c.name} | /deny ${c.name}`);
      pumpPopups();
      return;
    }
    if (m.t === 'say') {
      const s = sanitize(m.text);
      if (!s.ok) return sendError(ws, s.error);
      // Check after sanitize: trim() alone leaves a leading zero-width space in place,
      // which would sneak "/exit" past this guard.
      // A message may not start with a slash: that is how a hand-rolled client would smuggle
      // a command past the approval gate by having claude read it as text in the prompt.
      // Commands go through {t:'slash'}, where the host+loopback rule and the hard list live.
      if (s.text.startsWith('/')) return sendError(ws, 'a /command is not a message — send it as a command and the host will be asked');
      const text = neutralizePrefixes(s.text);
      broadcast({ t: 'say', from: me.name, text });
      status.busy = true; startTurn(); pushStatus();
      enqueueInject(me.name, text, ws);
    } else if (m.t === 'chat') {
      const s = sanitize(m.text);
      if (!s.ok) return sendError(ws, s.error);
      broadcast({ t: 'chat', from: me.name, text: s.text });
    } else if (m.t === 'typing') {
      const now = Date.now();
      if (now - me.lastTyping < 1000) return;
      me.lastTyping = now;
      broadcast({ t: 'typing', from: me.name });
    } else if (m.t === 'mirror') {
      // View-only sugar: everybody may watch, nobody types through it.
      setMirror(ws, m.on !== false);
    } else if (m.t === 'slash') {
      onSlash(ws, me, m.text);
    } else if (m.t === 'cmd') {
      onLadderAnswer('cmd', ws, me, m);
      // v0.12: the session transcript, and the host's answer to a request for it.
    } else if (m.t === 'export') {
      onExport(ws, me);
    } else if (m.t === 'exportok') {
      onLadderAnswer('export', ws, me, m);
      // v0.13: a guest sending a file in (request, then the chunks once granted), the host's
      // answer, the host offering a file out, and a guest taking one.
    } else if (m.t === 'upload') {
      onUpload(ws, me, m);
    } else if (m.t === 'file') {
      onUploadChunk(ws, me, m);
    } else if (m.t === 'fileok') {
      onLadderAnswer('file', ws, me, m);
    } else if (m.t === 'offer') {
      onOffer(ws, me, m);
    } else if (m.t === 'get') {
      onGet(ws, me, m);
    } else if (m.t === 'key') {
      // F3 passthrough: the host's keyboard, straight into the TUI. This is the one path
      // where bytes are NOT sanitized — driving a permission prompt or the /model picker is
      // exactly what it is for — so the gate is everything: host flag AND loopback (the
      // client the launcher itself spawned), a per-frame size cap, and hex/literal encoding
      // that never reaches a shell. A guest gets a refusal and nothing else.
      if (!trusted(me)) return sendError(ws, 'F3 TUI control is the host\'s, on loopback only');
      typeKeys(m.b64);
    } else if (m.t === 'resize') {
      // The host's terminal grew or shrank. Nothing is attached to this tmux session, so the
      // claude window is only ever as big as somebody says — and the host's mirror is the
      // screen that has to fit. Guests never resize the room they are watching.
      if (!trusted(me)) return sendError(ws, 'host TUI only');
      // v0.15: `force` is the way back from an F3 attach. tmux resized the window to the
      // attaching client and the daemon never heard about it, so the size it remembers still
      // matches what the client is asking for and the no-op guard would swallow the request.
      if (m.force === true) windowSize = { w: 0, h: 0 };
      resizeClaudeWindow(m.w, m.h);
    } else if (m.t === 'admit') {
      if (!me.host) return sendError(ws, 'host only');
      onAdmit(ws, m);
    } else if (m.t === 'token') {
      if (!me.host) return sendError(ws, 'host only');
      onToken(ws, m);
    } else {
      sendError(ws, `unknown message type: ${m.t}`);
    }
  });
  ws.on('close', () => {
    const p = pending.get(ws);
    if (p) { clearTimeout(p.timer); pending.delete(ws); pumpPopups(); }
    // A guest who left has nothing waiting for approval any more, and a half-arrived upload
    // is dropped rather than written.
    for (const L of Object.values(ladders)) {
      const req = L.requests.get(ws);
      if (req) { clearTimeout(req.timer); L.requests.delete(ws); pumpPopups(); }
    }
    uploads.delete(ws);
    const me = clients.get(ws);
    // Drop the mirror subscription first: the last watcher leaving stops the capture timer.
    if (mirrors.has(ws)) setMirror(ws, false);
    if (me && clients.delete(ws)) rosterChanged({ left: me.name });
  });
  ws.on('error', () => { /* client vanished */ });
}

// ---------------------------------------------------------- approval ladder ----
// v0.14 built this for a guest's slash command; v0.12 (the session transcript) and v0.13 (a
// file upload) reuse it rather than growing a second mechanism. Per kind and per client: ONE
// request in flight, default deny, the same two-minute patience as a knock, the same popup,
// and `always` = standing approval for that person for the rest of this jam (daemon memory
// only, gone on restart). Each kind supplies only what differs: the frame a host client is
// shown, the wording, and what "approved" actually does.
const LADDER_TTL = 120000;

const ladders = {
  cmd: {
    label: 'command',
    frame: (r) => ({ t: 'cmdreq', name: r.name, cmd: r.detail }),
    ask: (r) => `${r.name} wants ${r.detail} — /allow-cmd ${r.name} | /allow-cmd ${r.name} always | /deny-cmd ${r.name}`,
    busy: (r) => `${r.detail} is still waiting for the host — one at a time`,
    expired: (r) => `${r.detail} expired — nobody approved it`,
    denied: (r) => `${r.detail} was denied by ${opts.name}`,
    run: (r, always) => runSlash(r.name, r.detail, ` (approved by ${opts.name}${always ? ' — standing' : ''})`),
  },
  // v0.12: the whole transcript, which is everything claude saw here.
  export: {
    label: 'export',
    frame: (r) => ({ t: 'exportreq', name: r.name }),
    ask: (r) => `${r.name} wants the session transcript — /allow-export ${r.name} | /allow-export ${r.name} always | /deny-export ${r.name}`,
    busy: () => 'your /export is still waiting for the host — one at a time',
    expired: () => '/export expired — nobody approved it',
    denied: () => `${opts.name} did not share the transcript`,
    run: (r) => sendExport(r),
  },
  // v0.13: a file into <cwd>/jam-uploads/, which claude is then told to look at.
  file: {
    label: 'file',
    frame: (r) => ({ t: 'filereq', name: r.name, file: r.detail, size: r.size }),
    ask: (r) => `${r.name} wants to send ${r.detail} (${humanBytes(r.size)}) — /accept-file ${r.name} | /accept-file ${r.name} always | /deny-file ${r.name}`,
    busy: (r) => `${r.detail} is still waiting for the host — one file at a time`,
    expired: (r) => `${r.detail} expired — nobody approved it`,
    denied: (r) => `${r.detail} was refused by ${opts.name}`,
    run: (r, always) => grantUpload(r, always),
  },
};
// requests: ws -> record {name, ws, detail?, size?, timer, popped}. always: lowercased names.
for (const l of Object.values(ladders)) { l.requests = new Map(); l.always = new Set(); }

const standing = (kind, me) => ladders[kind].always.has(me.name.toLowerCase());

function askHost(kind, ws, me, rec = {}) {
  const L = ladders[kind];
  const mine = L.requests.get(ws);
  if (mine) return sendError(ws, L.busy(mine));
  const r = { name: me.name, ws, popped: false, expires: Date.now() + LADDER_TTL, ...rec };
  r.timer = setTimeout(() => {
    L.requests.delete(ws);
    sendError(ws, L.expired(r));
    pumpPopups();
  }, LADDER_TTL);
  r.timer.unref?.();
  L.requests.set(ws, r);
  sendHosts(L.frame(r));
  console.log(`[${kind}] ${L.ask(r)}`);
  pumpPopups();
}

// The one decision, shared by the host client's command and by the in-TUI popup. No name =
// the only request of that kind waiting. Returns null when it acted, else why it did not.
function answerHost(kind, name, ok, always = false) {
  const L = ladders[kind];
  const waiting = [...L.requests.entries()];
  let hit;
  if (name == null || name === '') {
    if (waiting.length !== 1) {
      return waiting.length ? `${waiting.length} ${L.label} requests are waiting — name one`
        : `no ${L.label} request is waiting`;
    }
    hit = waiting[0];
  } else {
    hit = waiting.find(([, r]) => nameTaken(name, [r.name]));
    if (!hit) return `nothing is waiting from "${name}"`;
  }
  const [sock, r] = hit;
  clearTimeout(r.timer);
  L.requests.delete(sock);
  if (!ok) {
    sendError(sock, L.denied(r));
    console.log(`[${kind}] ${r.name}'s request denied`);
  } else {
    // Standing approval is per person and per kind, and never widens the hard command list —
    // guestSlashDecision re-checks that on every later command, so `always` cannot reach /clear.
    if (always) L.always.add(r.name.toLowerCase());
    L.run(r, always);
  }
  pumpPopups();
  return null;
}

// `/allow-cmd`, `/allow-export`, `/accept-file` and their denials all land here. Answering any
// of them acts on the real TUI or the host's disk, so the gate is F3's: host AND loopback.
function onLadderAnswer(kind, ws, me, m) {
  if (!trusted(me)) return sendError(ws, 'host TUI only');
  const err = answerHost(kind, m.name, m.op === 'allow', m.always === true);
  if (err) sendError(ws, err);
}

// ---------------------------------------------------------- slash commands ----
// v0.14: a `/command` jam does not own belongs to claude. From the host's client (loopback,
// `--host`) it is typed into the real TUI verbatim — no `[Name]:` prefix, so claude's own
// command palette runs it and any picker it opens shows up in everyone's mirror. From a
// guest it is a REQUEST on the ladder above, and the session-lifecycle commands cannot be
// approved at all.
function onSlash(ws, me, text) {
  const v = validSlashCommand(text);
  if (!v.ok) return sendError(ws, v.error);
  if (trusted(me)) return runSlash(me.name, v.text);
  switch (guestSlashDecision(v.text, standing('cmd', me))) {
    case 'refuse':
      return sendError(ws, `${slashName(v.text)} ends or wipes the session for everyone — ` +
        'the host runs that one, and it cannot be approved for a guest');
    case 'run':
      return runSlash(me.name, v.text, ` (${opts.name} approved ${me.name}'s commands for this jam)`);
    default:
      return askHost('cmd', ws, me, { detail: v.text });
  }
}

// Serialized on the injection queue: typing a command into the pane while a message is
// mid-paste would interleave two inputs in one prompt.
function runSlash(who, text, note = '') {
  broadcast({ t: 'sys', text: `${who} ran ${text} in the TUI${note}` });
  queue = queue.then(() => typeSlash(text)).catch((e) => console.error('slash failed:', e.message));
}

async function typeSlash(text) {
  await ensureReady();
  // Same courtesy wait as an injection: claude queues what it gets mid-response anyway.
  for (let i = 0; i < 8; i++) {
    if (/❯|^> ?$/m.test(capture().split('\n').slice(-5).join('\n'))) break;
    await sleep(250);
  }
  tmux('send-keys', '-t', CLAUDE_PANE, '-l', text);
  // The command palette filters as you type and Enter picks the highlighted row, so give it
  // a beat to settle on the exact match before submitting.
  await sleep(300);
  tmux('send-keys', '-t', CLAUDE_PANE, 'C-m');
}

// ----------------------------------------------- v0.12/v0.13: file transfers ----
// Both directions are the same frames: a `{t:'xfer'}` header saying what is coming, then
// `{t:'file', xfer, seq, done, b64}` chunks of 64 KB. base64 because a PNG has to survive a
// JSON text frame, and because nothing here is ever interpreted as text. Every cap and every
// file name is enforced HERE, on the daemon side: a client's own checks are a courtesy.
let xferN = 0;

function streamXfer(ws, header, data) {
  // The pump runs on setImmediate, where a throw would take the whole daemon (and everybody
  // else's session) with it. Nothing downstream of here may be surprised by its input.
  if (!Buffer.isBuffer(data)) {
    console.error(`[xfer] ${header.name}: nothing to send`);
    return sendError(ws, `${header.name}: nothing to send`);
  }
  send(ws, { ...header, id: nextId++, ts: Date.now() });
  // A few frames per tick, so a 50 MB transcript does not stall the hook endpoints.
  pumpFrames(xferFrames(header.xfer, data), (f) => send(ws, f), () => clients.has(ws));
}

// --- v0.12: the session transcript ---
// What claude saw, as the file claude wrote. The guest gets a copy of the JSONL, minus our own
// join-token block (best effort — see stripTokenBlock), and prints its own resume recipe.
function onExport(ws, me) {
  if (trusted(me) || standing('export', me)) return sendExport({ name: me.name, ws });
  askHost('export', ws, me);
}

function sendExport(rec) {
  const file = jsonlPath || findJsonl();
  if (!file) return sendError(rec.ws, 'there is no transcript on disk yet');
  let size;
  try { size = fs.statSync(file).size; } catch { return sendError(rec.ws, 'the transcript is not readable'); }
  if (size > EXPORT_MAX) {
    return sendError(rec.ws, `the transcript is ${humanBytes(size)}, over the ${humanBytes(EXPORT_MAX)} export cap`);
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return sendError(rec.ws, `could not read the transcript: ${e.message}`); }
  const data = Buffer.from(stripTokenBlock(text, currentToken), 'utf8');
  const xfer = `e${++xferN}`;
  console.log(`[export] ${rec.name} ← ${file} (${humanBytes(data.length)})`);
  broadcast({ t: 'sys', text: `${rec.name} took a copy of the session transcript (${humanBytes(data.length)})` });
  streamXfer(rec.ws, { t: 'xfer', xfer, kind: 'export', name: exportFileName(opts.sessionId), size: data.length, session: opts.sessionId }, data);
}

// --- v0.13: a guest sends a file in ---
// Approved uploads land in <cwd>/jam-uploads/ and nowhere else, 0644, never executed, never
// opened — then claude is TOLD about the path so it can Read it if it wants to.
const UPLOAD_DIR = 'jam-uploads';
const uploads = new Map(); // ws -> {name, detail, size, caption, xfer, parts, got, seq}

// A caption rides into claude's prompt, so it is sanitized exactly like a message — one line,
// no forged `[Name]:` attribution, short.
function fileCaption(v) {
  const s = sanitize(typeof v === 'string' ? v : '');
  return s.ok ? neutralizePrefixes(s.text.replace(/\s+/g, ' ')).slice(0, 200) : '';
}

function onUpload(ws, me, m) {
  if (uploads.has(ws)) return sendError(ws, 'one upload at a time — the last one is still arriving');
  const name = safeBaseName(m.name);
  if (!name) return sendError(ws, `${JSON.stringify(String(m.name).slice(0, 40))} is not a file name I will write — send a plain basename, no paths`);
  const size = Number(m.size);
  if (!Number.isInteger(size) || size < 0) return sendError(ws, 'the upload announced no size');
  if (size > UPLOAD_MAX) return sendError(ws, `${name} is ${humanBytes(size)}, over the ${humanBytes(UPLOAD_MAX)} upload cap`);
  const rec = { detail: name, size, caption: fileCaption(m.caption) };
  if (trusted(me) || standing('file', me)) return grantUpload({ name: me.name, ws, ...rec }, standing('file', me));
  askHost('file', ws, me, rec);
}

// Approved: the sender may start the chunks. Nothing is on disk yet.
function grantUpload(rec, always = false) {
  const xfer = `u${++xferN}`;
  uploads.set(rec.ws, { ...rec, xfer, parts: [], got: 0, seq: 0 });
  send(rec.ws, { t: 'xfergrant', id: nextId++, ts: Date.now(), xfer, name: rec.detail });
  console.log(`[file] ${rec.name} may send ${rec.detail} (${humanBytes(rec.size)})${always ? ' — standing' : ''}`);
}

function abortUpload(ws, why) {
  const up = uploads.get(ws);
  uploads.delete(ws);
  console.log(`[file] upload ${up?.detail ?? '?'} dropped: ${why}`);
  sendError(ws, `upload dropped: ${why}`);
}

function onUploadChunk(ws, me, m) {
  const up = uploads.get(ws);
  // No grant, no bytes: this is the gate that makes the host's approval mean something.
  if (!up || m.xfer !== up.xfer) return sendError(ws, 'no approved upload is in flight — /send asks the host first');
  if (typeof m.b64 !== 'string' || m.b64.length > XFER_FRAME_MAX) return abortUpload(ws, 'oversized or missing chunk');
  if (m.seq !== up.seq) return abortUpload(ws, `chunk ${m.seq} arrived where ${up.seq} was expected`);
  up.seq++;
  const buf = Buffer.from(m.b64, 'base64');
  up.got += buf.length;
  if (up.got > up.size || up.got > UPLOAD_MAX) return abortUpload(ws, `more bytes than the ${humanBytes(up.size)} it announced`);
  up.parts.push(buf);
  if (m.done !== true) return;
  uploads.delete(ws);
  if (up.got !== up.size) {
    return sendError(ws, `${up.detail}: ${humanBytes(up.got)} arrived of ${humanBytes(up.size)} — nothing written`);
  }
  writeUpload(me.name, up, Buffer.concat(up.parts));
}

function writeUpload(who, up, data) {
  const dir = path.join(opts.cwd, UPLOAD_DIR);
  let name;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // A second photo.png never overwrites the first, and the name was already reduced to
    // [A-Za-z0-9._-] with no separator in it, so this join cannot leave the directory.
    name = uniqueName(up.detail, (n) => fs.existsSync(path.join(dir, n)));
    if (!name) return sendError(up.ws, `too many files are already called ${up.detail}`);
    fs.writeFileSync(path.join(dir, name), data, { mode: 0o644 });
  } catch (e) { return sendError(up.ws, `could not write ${UPLOAD_DIR}/${up.detail}: ${e.message}`); }
  const rel = `${UPLOAD_DIR}/${name}`;
  console.log(`[file] ${who} → ${path.join(dir, name)} (${humanBytes(data.length)})`);
  // Injected like any message, so claude can Read the file and knows who sent it. The path is
  // text in a prompt — the daemon never runs or opens what it just wrote.
  const text = `sent a file: ${rel}${up.caption ? ` ${up.caption}` : ''}`;
  broadcast({ t: 'say', from: who, text });
  status.busy = true; startTurn(); pushStatus();
  enqueueInject(who, text, up.ws);
}

// --- v0.13: the host offers a file out ---
// `/send <path>` in the HOST's client. Nothing is pushed: every guest is told what is on offer
// and takes it with `/get`, which writes into their own ./jam-downloads/.
const offers = new Map(); // sanitized name -> {path, size, from}

function onOffer(ws, me, m) {
  if (!trusted(me)) return sendError(ws, 'only the host offers files — /send <path> uploads yours instead');
  const raw = typeof m.path === 'string' ? m.path.trim() : '';
  if (!raw) return sendError(ws, 'usage: /send <path>');
  const abs = path.resolve(opts.cwd, raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
  let st;
  try { st = fs.statSync(abs); } catch { return sendError(ws, `no such file: ${abs}`); }
  if (!st.isFile()) return sendError(ws, `${abs} is not a file`);
  if (st.size > EXPORT_MAX) return sendError(ws, `${humanBytes(st.size)} is over the ${humanBytes(EXPORT_MAX)} cap`);
  const name = safeBaseName(path.basename(abs));
  if (!name) return sendError(ws, `${path.basename(abs)} is not a name I can offer`);
  offers.set(name, { path: abs, size: st.size, from: me.name });
  console.log(`[file] ${me.name} offers ${abs} (${humanBytes(st.size)}) as ${name}`);
  broadcast({ t: 'offer', from: me.name, name, size: st.size });
}

function onGet(ws, me, m) {
  const all = [...offers.keys()];
  const asked = m.name == null || m.name === '' ? (all.length === 1 ? all[0] : null) : safeBaseName(m.name);
  if (!asked) {
    return sendError(ws, all.length ? `name one: /get ${all.join(' | ')}` : 'nothing has been offered yet');
  }
  const offer = offers.get(asked);
  if (!offer) return sendError(ws, `${asked} is not on offer${all.length ? ` — /get ${all.join(' | ')}` : ''}`);
  let data;
  try { data = fs.readFileSync(offer.path); } catch (e) { return sendError(ws, `could not read ${asked}: ${e.message}`); }
  if (data.length > EXPORT_MAX) return sendError(ws, `${asked} grew past the ${humanBytes(EXPORT_MAX)} cap`);
  const xfer = `d${++xferN}`;
  console.log(`[file] ${me.name} ← ${offer.path} (${humanBytes(data.length)})`);
  broadcast({ t: 'sys', text: `${me.name} took ${asked} (${humanBytes(data.length)})` });
  streamXfer(ws, { t: 'xfer', xfer, kind: 'file', name: asked, size: data.length }, data);
}

// ------------------------------------------------------- raw key passthrough ----
// v0.14 F3: base64 (so a frame carries an escape sequence intact) → tmux send-keys runs.
// Bad base64, an oversized frame or a decode that yields nothing is dropped silently: this
// is a keystroke, not a message, and an error line per stray byte would be noise.
const KEY_FRAME_MAX = 4096; // base64 chars, before decoding
function typeKeys(b64) {
  if (typeof b64 !== 'string' || !b64 || b64.length > KEY_FRAME_MAX) return;
  let text;
  try { text = Buffer.from(b64, 'base64').toString('utf8'); } catch { return; }
  for (const args of sendKeyArgs(text)) tmux('send-keys', '-t', CLAUDE_PANE, ...args);
  bumpActivity(); // a keystroke wants its echo on the next 40 ms frame, not the next 250 ms one
}

// --------------------------------------------------------------- injection ----
let queue = Promise.resolve();
let bufN = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueueInject(name, text, ws) {
  queue = queue.then(() => inject(name, text)).catch((e) => {
    console.error('inject failed:', e.message);
    if (ws) sendError(ws, `injection failed: ${e.message}`);
    // Nothing was submitted, so no Stop hook is coming to clear this.
    if (status.busy) { status.busy = false; pushStatus(); }
  });
}

const capture = () => tmux('capture-pane', '-p', '-t', CLAUDE_PANE).stdout || '';

// A fresh cwd makes claude ask "Is this a project you created or one you trust?".
// Nobody is watching this pane, so answer it — and note the highlighted default is
// "No, exit", so a blind Enter would kill the session. Move onto the trust option first.
// Runs before EVERY injection until it succeeds once. A first message can arrive while
// claude is still booting: back when one attempt was enough, an empty pane counted as
// "checked", the paste went nowhere and the dialog that rendered a second later got the
// next message's Enter — i.e. "No, exit". So poll until the input prompt is actually up.
// Once it is, never scan again: capture() is the whole pane, so later on an ordinary
// message containing "trust this folder" would send stray Downs into a live TUI.
let ready = false;
async function ensureReady() {
  if (ready) return;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const lines = capture().split('\n');
    if (lines.some((l) => /trust this folder/i.test(l))) {
      const cursor = lines.find((l) => l.trim().startsWith('❯')) || '';
      if (/trust this folder/i.test(cursor)) {
        tmux('send-keys', '-t', CLAUDE_PANE, 'C-m');
        await sleep(2000); // let the dialog go away before looking again
      } else {
        tmux('send-keys', '-t', CLAUDE_PANE, 'Down');
        await sleep(300);
      }
      continue;
    }
    // No dialog text, so a prompt glyph here is the real input box.
    if (/❯|^> ?$/m.test(lines.slice(-5).join('\n'))) { ready = true; return; }
    await sleep(250);
  }
  // Give up and paste anyway (Claude Code queues input), but stay un-ready so the next
  // injection re-checks instead of assuming a dialog can no longer appear.
}

async function inject(name, text) {
  const payload = `[${name}]: ${text}`;
  await ensureReady();
  // Wait for the input box. Claude Code queues text typed mid-response, so a timeout
  // is not fatal — paste anyway.
  for (let i = 0; i < 8; i++) {
    if (/❯|^> ?$/m.test(capture().split('\n').slice(-5).join('\n'))) break;
    await sleep(250);
  }
  const file = path.join(opts.state, 'inject.txt');
  const buf = `jam${++bufN}`;
  try {
    fs.writeFileSync(file, payload); // never argv, never a shell
    tmux('load-buffer', '-b', buf, file);
    tmux('paste-buffer', '-b', buf, '-d', '-p', '-t', CLAUDE_PANE);
    // Assert it landed before submitting; pressing Enter into a pane that never got the
    // paste would submit whatever was already there.
    // The probe must be ONE visual line: claude indents continuation/wrapped lines, so a
    // probe containing a newline (or wider than the pane) can never match the capture.
    // ponytail: probe is the message's own first chars, so two identical consecutive
    // messages can match a stale echo. Prepend a nonce line (see rr-ctl.sh) if it bites.
    const width = Number(tmux('display-message', '-p', '-t', CLAUDE_PANE, '#{pane_width}').stdout) || 80;
    const probe = payload.split('\n')[0].slice(0, Math.max(8, Math.min(40, width - 12)));
    for (let i = 0; i < 24; i++) {
      if (capture().split('\n').slice(-15).join('\n').includes(probe)) {
        tmux('send-keys', '-t', CLAUDE_PANE, 'C-m');
        return;
      }
      await sleep(250);
    }
    // Leave nothing in the input box, or the next injection submits both messages glued.
    tmux('send-keys', '-t', CLAUDE_PANE, 'C-u');
    throw new Error('pasted text never appeared in the claude pane');
  } finally {
    fs.rmSync(file, { force: true });
    tmux('delete-buffer', '-b', buf);
  }
}

// ------------------------------------------------------------- jsonl tail ----
let jsonlPath = null;
let offset = 0;
let partial = '';
// A poll can land mid-codepoint; StringDecoder holds the trailing bytes for next time.
let decoder = new StringDecoder('utf8');

function findJsonl() {
  for (const glob of jsonlGlobs(opts.sessionId, os.homedir(), opts.configDir)) {
    const hit = fs.globSync(glob)[0];
    // realpath so a --config-dir whose projects/ is symlinked to the default one (the usual
    // case on the host's own machine) settles on the same path either glob found it by.
    if (hit) { try { return fs.realpathSync(hit); } catch { return hit; } }
  }
  return null;
}

// Returns true when it consumed new bytes — drainTail uses that to know it is behind.
function tailJsonl() {
  if (!jsonlPath) {
    jsonlPath = findJsonl();
    if (!jsonlPath) return false;
    console.log('tailing', jsonlPath);
    // On resume the file already has history; start at its current size so old turns
    // are not re-broadcast. ponytail: friends who join after this point still see none
    // of the pre-resume history; add a `--replay N` flag later if that's wanted.
    if (opts.resume) { try { offset = fs.statSync(jsonlPath).size; } catch { /* file just vanished; keep offset 0 */ } }
  }
  let size;
  try { size = fs.statSync(jsonlPath).size; } catch { return false; }
  if (size < offset) { offset = 0; partial = ''; decoder = new StringDecoder('utf8'); }
  if (size === offset) return false;
  const fd = fs.openSync(jsonlPath, 'r');
  const buf = Buffer.alloc(size - offset);
  let read = 0;
  try { read = fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
  if (!read) return false;
  offset += read; // only what we actually got, so a short read is retried
  const lines = (partial + decoder.write(buf.subarray(0, read))).split('\n');
  partial = lines.pop() ?? '';
  for (const line of lines) for (const e of parseJsonlLine(line)) onTranscript(e);
  return true;
}

// Read the transcript until it stops growing (two quiet reads) or the budget runs out.
// Called on Stop: the turn is over, so "quiet" really means "we have it all".
async function drainTail(maxMs = 2000) {
  const deadline = Date.now() + maxMs;
  for (let quiet = 0; quiet < 2 && Date.now() < deadline;) {
    quiet = tailJsonl() ? 0 : quiet + 1;
    await sleep(100);
  }
}

function onTranscript(e) {
  // An assistant record (text OR the tool_use that just started running) means the
  // permission prompt was answered. A tool RESULT is deliberately NOT in that set: it rides
  // in a user record but is pure plumbing, and it must not touch busy, waiting or
  // attribution — only produce a `⎿` line.
  if ((e.kind === 'text' || e.kind === 'tool') && status.waiting) { status.waiting = false; pushStatus(); }
  // Agent text lands in everyone's terminal, so strip escapes here too.
  const text = stripControl(e.text);
  if (e.kind === 'user') {
    if (e.bridged) return; // already broadcast at injection time
    broadcast({ t: 'say', from: opts.name, text });
    startTurn();
    if (!status.busy) { status.busy = true; pushStatus(); }
  } else if (e.kind === 'text') {
    broadcast({ t: 'agent', kind: 'text', text });
  } else if (e.kind === 'tool') {
    broadcast({ t: 'agent', kind: 'tool', text });
  } else if (e.kind === 'tool-result') {
    const act = toolResultAction(toolResults++);
    if (act !== 'skip') broadcast({ t: 'agent', kind: 'tool-result', text: act === 'show' ? text : '…' });
  }
}

if (opts.daemon) daemon(); else launch();
