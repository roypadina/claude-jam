#!/usr/bin/env node
// claude-jam terminal client. No dependencies: global WebSocket + readline.
import readline from 'node:readline';
import { parseClientLine, inviteLines, labelWidth, wrapText, mdLite, userColor, nextBlock, onboardingLines, humanBytes, resumeInstructions, xferFrames, pumpFrames, reconnectMessage, historyDivider,
  // v0.17 Batch P: the bell, @mentions and the RTT chip work here too (P6's hint list does not —
  // this renderer only ever appends lines, it has no live region to draw one in).
  BELL, bellAllowed, mentionsMe, rttText,
  // v0.18: the host ended the jam — one line, exit 0, and no reconnect at a daemon that is
  // deliberately gone. /end is the other half, and it asks before it sends.
  endingNotice, confirmYes,
  // v0.22B/C: invite links (the address list a link carries, what a minted one prints) and the
  // offer that follows a kick.
  INVITE_CONNECT_MS, inviteMintedLines, kickOffer } from './lib.mjs';
import { xferStart, xferChunk, saveXfer, readForUpload, clipboardPng, desktopNotify, DOWNLOAD_DIR } from './xfer.mjs';

const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('ws'));
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
const NAME = flag('name');
const TOKEN = flag('token');
const IS_HOST = argv.includes('--host');
// v0.22B: what an invite link unpacked into (client.mjs decoded it). The secret rides in the
// hello; the address list is tried in order, tunnel first, with INVITE_CONNECT_MS each.
const INVITE = flag('invite');
const URLS = (flag('jam-addresses') || '').split(',').map((s) => s.trim()).filter(Boolean);
let addr = 0;
// No --token is normal now: the host may run knock-only, and then you wait to be accepted.
if (!url || !NAME) {
  console.error('usage: jam join <invite-link>\n'
    + '       jam join|node client.mjs <ws-url> --name <Name> [--token <token>] [--host]');
  process.exit(2);
}

// Claude Code's palette, in 256 colours: tmux pales the raw 8 into mud, and the warm greys
// have no 8-colour equivalent at all. Only errors are a plain red-ish accent.
const C = {
  off: '\x1b[0m',
  accent: '\x1b[38;5;208m', // claude's orange: its glyph, the spinner, the prompt caret
  dim: '\x1b[38;5;245m',    // warm grey: tools, system lines, the status bracket
  dimmer: '\x1b[38;5;240m', // one step back again: tool results
  me: '\x1b[38;5;114m',     // your own name, regardless of what userColor(name) would hash to
  chat: '\x1b[38;5;213m',   // human-only chat: magenta, unmissable, no other element uses it
  err: '\x1b[38;5;203m',
};
const fg256 = (n) => `\x1b[38;5;${n}m`; // everybody else's stable per-name color (userColor)
const SPIN = ['✻', '✼', '✽', '✼']; // claude's own working glyph cycle
const seen = new Set(); // dedupe replayed history across reconnects
const typing = new Map(); // name -> last typing ms
let state = { busy: false, waiting: false };
let roster = [];
let ws = null;
let backoff = 1000;
let attempts = 0; // v0.17 T3: consecutive failures, so the fifth can say something better
let cont = []; // pending continuation lines
let lastTypingSent = 0;
let boot = null; // daemon boot id: event ids restart at 1 when it changes
let session = null; // welcome's session block; .join only ever set for the host
let labelW = labelWidth([]); // width of the `[Name]` column, recomputed on roster change
let lastTurn = null; // turnKey of the last emitted block, so blocks get a blank line between them
let block = null; // current open message block (nextBlock in lib.mjs), drives lastTurn/turnKey
let spin = 0;
let spinTimer = null;
let net = null; // v0.17 P5: the last heartbeat round trip the daemon measured for this socket
let lastBell = 0;
let ending = false; // v0.18: the jam is over on purpose, so the close below must not retry
let confirming = null; // v0.18-4: `/end` asked, and the next line is the answer

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });

// v0.17 P3/P4: claude needs an answer, or somebody said your name. The bell is the portable half;
// macOS gets a real notification with it. Rate-gated, so a burst is one nudge.
function nudge(title, body) {
  if (!bellAllowed(lastBell, Date.now())) return;
  lastBell = Date.now();
  try { process.stdout.write(BELL); } catch { /* stdout closed */ }
  desktopNotify(title, body);
}

function statusLine() {
  const t = [...typing.entries()].filter(([, at]) => Date.now() - at < 4000).map(([n]) => n);
  const bits = [];
  if (t.length) bits.push(`${t.join(', ')} ${t.length > 1 ? 'are' : 'is'} typing…`);
  // Back to dim after the orange bit: the whole status sits inside one dim bracket.
  if (state.busy) bits.push(`${C.accent}${SPIN[spin]} claude is working…${C.off}${C.dim}`);
  if (state.waiting) bits.push(`⚠ waiting for permission${IS_HOST ? '' : ' — /answer shows the options'}`);
  const rtt = rttText(net, Date.now(), net?.heartbeat);
  if (rtt) bits.push(rtt);
  return bits.join(' · ');
}

function reprompt() {
  // Status goes INSIDE the prompt row. A two-row prompt (embedded '\n') makes
  // readline's redraw move up and clearScreenDown over the line log() just wrote,
  // so every event would be printed and immediately erased.
  const s = statusLine();
  rl.setPrompt(`${s ? `${C.dim}[${s}]${C.off} ` : ''}${C.me}${NAME}${C.off}` +
    `${cont.length ? `${C.dim} …${C.off}` : ''} ${C.accent}❯${C.off} `);
  rl.prompt(true);
}

// The spinner animates the prompt row and nothing else, so it is just a reprompt on a timer.
// It runs ONLY while busy, and unref'd, so an idle client neither redraws nor holds the loop.
function setSpinner(on) {
  if (on === !!spinTimer) return;
  if (on) { spinTimer = setInterval(() => { spin = (spin + 1) % SPIN.length; reprompt(); }, 220); spinTimer.unref(); }
  else { clearInterval(spinTimer); spinTimer = null; spin = 0; }
}

function log(line) {
  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(line + '\n');
  reprompt();
}

// Say/agent-text/chat are speech: no glyph, just `[Name]  text`. Tools, knocks, system lines
// and errors keep a one-column glyph. `kind` picks the message block (nextBlock in lib.mjs)
// this event belongs to; callers that pass no kind (system, knock, error) are untracked —
// they neither force a blank line nor break an open agent turn's gluing.
function blockKey(kind) {
  block = nextBlock(kind, block);
  return `${block.kind}:${block.seq}`;
}

// Every line in the log has the same shape: `[Label]` padded to one column, then a glyph
// column (one character for tools/knocks/system/errors, blank for speech), then the text —
// wrapped to the pane with the continuation indented to match wherever the first line's text
// actually started, so a paragraph stays a block instead of drifting back to the margin.
function emit({ turnKey, label = '', color = C.dim, glyph = '', glyphColor = C.dim, text = '', textColor = '', md = false, wrap = true, bare = false }) {
  const paint = (l) => (textColor ? `${textColor}${l}${C.off}` : l);
  // `bare` lines (the onboarding block) draw their own shape and skip the gutter entirely.
  if (bare) return log(String(text).split('\n').map(paint).join('\n'));
  const textCol = labelW + 2 + (glyph ? 1 : 0); // '[Label]' + pad + space [+ glyph] + space
  // wrap:false keeps a join command or a URL on one logical line — the terminal's own hard
  // wrap leaves it selectable in one go, an indent would not.
  const body = (wrap ? wrapText(text, Math.max(24, (process.stdout.columns || 80) - textCol - 1))
    : String(text).split('\n')).map((l) => (md ? mdLite(l) : l));
  const head = `${label ? `${color}${label}${C.off}` : ''}${' '.repeat(Math.max(0, labelW - label.length))} ` +
    `${glyphColor}${glyph}${C.off} ${paint(body[0] ?? '')}`;
  const rest = body.slice(1).map((l) => `${' '.repeat(textCol)}${paint(l)}`);
  // Blank line between blocks: the rhythm that makes a transcript readable. Tools and their
  // results glue to their turn's block, so they do not get one of their own.
  const gap = turnKey && lastTurn !== null && turnKey !== lastTurn ? '\n' : '';
  if (turnKey) lastTurn = turnKey;
  log(gap + [head, ...rest].join('\n'));
}

const sys = (text) => emit({ glyph: '*', text, textColor: C.dim });

// The host's invite lines, wherever they are shown (welcome, /join, a /token reply).
function logJoin() {
  for (const l of inviteLines(session || {})) emit({ glyph: '*', text: l, textColor: C.dim, wrap: false });
}

// v0.10c: the onboarding block, on connect and on `/help`. Same text as the ink client, minus
// the Shift+Enter line's promise — see the `/mirror` and `/tools` answers below for what this
// renderer does not do.
function logOnboarding() {
  for (const l of onboardingLines(NAME, IS_HOST)) emit({ text: l, textColor: C.dim, bare: true });
  // The block is shared with the ink client, which can do all of that; say so here rather
  // than promising keys and a view this renderer never has. v0.14: the live TUI is the
  // default view everywhere else, so a --basic guest should know what they are missing.
  emit({ text: '(--basic: transcript only — no live TUI view, no F2/F3, no Shift+Enter, no /tools.', textColor: C.dim, bare: true });
  emit({ text: ' Trailing \\ still does multi-line. Drop --basic for the full client.)', textColor: C.dim, bare: true });
}

function render(ev) {
  switch (ev.t) {
    case 'say': {
      // v0.17 P3: somebody said your name — never your own line.
      if (ev.from !== NAME && mentionsMe(ev.text, NAME)) nudge(`${ev.from} in the jam`, ev.text);
      // Self is always green; everybody else gets a stable color hashed from their name, so
      // it survives reconnects and roster churn instead of depending on join order.
      const c = ev.from === NAME ? C.me : fg256(userColor(ev.from));
      return emit({ turnKey: blockKey('say'), label: `[${ev.from}]`, color: c, text: ev.text, textColor: c });
    }
    // Human-only: the agent never sees it, so it renders unmissable — label, prefix and text
    // all in the one color nothing else uses.
    case 'chat': {
      if (ev.from !== NAME && mentionsMe(ev.text, NAME)) nudge(`${ev.from} in the jam`, ev.text);
      return emit({ turnKey: blockKey('chat'), label: `[${ev.from}]`, color: C.chat, text: `[humans-only] ${ev.text}`, textColor: C.chat });
    }
    case 'agent': {
      if (ev.kind === 'tool') return emit({ turnKey: blockKey('agent'), glyph: '⚙', text: ev.text, textColor: C.dim });
      if (ev.kind === 'tool-result') return emit({ turnKey: blockKey('agent'), glyph: '⎿', glyphColor: C.dimmer, text: ev.text, textColor: C.dimmer });
      return emit({ turnKey: blockKey('agent'), label: '[Claude]', color: C.accent, text: ev.text, md: true });
    }
    case 'roster': {
      roster = ev.roster;
      labelW = labelWidth(roster); // the column follows the longest name in the room
      // v0.22B: an invite join has no knock to announce it, so the roster line says HOW.
      if (ev.joined) sys(`${ev.joined} joined${ev.via && ev.via !== 'token' ? ` (${ev.via})` : ''}`);
      if (ev.left) sys(`${ev.left} left`);
      return;
    }
    case 'typing': if (ev.from !== NAME) { typing.set(ev.from, Date.now()); reprompt(); } return;
    case 'status': {
      // v0.17 P3: the host is who can always answer a prompt, so the host is who gets rung.
      if (IS_HOST && ev.waiting && !state.waiting) {
        nudge('claude needs an answer', 'a permission prompt is waiting in the jam');
      }
      state = { busy: ev.busy, waiting: ev.waiting };
      setSpinner(state.busy);
      return reprompt();
    }
    // v0.17 P5: this socket's own round trip, from the daemon's heartbeat.
    case 'net':
      net = { rtt: Number(ev.rtt), at: Date.now(), heartbeat: Number(ev.heartbeat) || undefined };
      return reprompt();
    // Knocks: `state` means it is about us waiting, `name` means somebody wants in.
    case 'knock': {
      if (ev.state === 'pending') return sys('waiting for host approval…');
      if (ev.state === 'denied') { emit({ glyph: '!', glyphColor: C.err, text: 'the host denied your request', textColor: C.err }); return process.exit(1); }
      if (ev.state === 'expired') { emit({ glyph: '!', glyphColor: C.err, text: 'nobody approved your request in time', textColor: C.err }); return process.exit(1); }
      return emit({ glyph: '⚑', glyphColor: C.accent, text: `${ev.name} wants to join${ev.ip ? ` (${ev.ip})` : ''} — /accept ${ev.name} · /deny ${ev.name}` });
    }
    // v0.14: a guest wants to run one of claude's commands (host clients only).
    case 'cmdreq':
      return emit({ glyph: '⌘', glyphColor: C.accent,
        text: `${ev.name} wants to run ${ev.cmd} — /allow-cmd ${ev.name} · /allow-cmd ${ev.name} always · /deny-cmd ${ev.name}` });
    // v0.12/v0.13: the transcript and file requests, same ladder, host clients only.
    case 'exportreq':
      return emit({ glyph: '⇩', glyphColor: C.accent,
        text: `${ev.name} requests the session transcript — /allow-export ${ev.name} · /allow-export ${ev.name} always · /deny-export ${ev.name}` });
    case 'filereq':
      return emit({ glyph: '⇪', glyphColor: C.accent,
        text: `${ev.name} wants to send ${ev.file} (${humanBytes(ev.size)}) — /accept-file ${ev.name} · /accept-file ${ev.name} always · /deny-file ${ev.name}` });
    // v0.17 P2: a guest wants one digit typed into the permission prompt (host clients only).
    case 'permreq':
      return emit({ glyph: '⏎', glyphColor: C.accent,
        text: `${ev.name} wants to answer the prompt with ${ev.choice}. ${ev.option} — /allow-perm ${ev.name} · /allow-perm ${ev.name} always · /deny-perm ${ev.name}` });
    case 'offer':
      return emit({ glyph: '⇩', glyphColor: C.accent,
        text: `${ev.from} offers ${ev.name} (${humanBytes(ev.size)}) — /get ${ev.name} saves it to ./${DOWNLOAD_DIR}/` });
    case 'xfergrant': return sendUpload(ev);
    case 'xfer': return xferStart(xfers, ev);
    case 'file': {
      const done = xferChunk(xfers, ev);
      return done ? saveIncoming(done) : undefined;
    }
    case 'token': {
      // Tunnel pair included (v0.14): a rotation changes the credential inside all four.
      if (session) Object.assign(session, { join: ev.join, view: ev.view, tunnelJoin: ev.tunnelJoin, tunnelView: ev.tunnelView });
      return logJoin();
    }
    // v0.22B: a minted link (only ever to the host who asked) or why an invite was refused —
    // which is followed by an ordinary knock, so it is information, not the end of the road.
    case 'invite': {
      if (ev.state === 'refused') return err(ev.text);
      if (ev.state !== 'minted' || !ev.link) return;
      for (const l of inviteMintedLines(ev.invite || {}, ev.link, 'jam join')) {
        emit({ glyph: '*', text: l, textColor: C.dim });
      }
      return;
    }
    // v0.22C: the host removed somebody. The victim gets this, then a 4406 close.
    case 'kicked': return err(`${ev.by || 'the host'} removed you from the jam`);
    case 'kick': {
      if (ev.state !== 'done') return;
      if (ev.via === 'invite' && !ev.revoked) confirming = { kind: 'revoke', name: ev.name };
      return sys(kickOffer(ev.name, ev.via));
    }
    // v0.18-7: the host ended the jam. Print the one line and leave with 0 — there is
    // nothing to reconnect to, and an orderly end is not a failure.
    case 'ending': {
      ending = true;
      const n = endingNotice(ev);
      emit({ glyph: '·', text: n.text, textColor: C.dim });
      return process.exit(n.code);
    }
    // v0.14: a slash command ran in the TUI, or a guest's request was approved.
    case 'sys': return sys(ev.text);
    case 'error': return emit({ glyph: '!', glyphColor: C.err, text: ev.text, textColor: C.err });
    default: return;
  }
}

// Which address this dial is aimed at: one plain ws:// URL normally, several when an invite link
// carried a list (tunnel first, LAN second).
const target = () => (URLS.length ? URLS[addr % URLS.length] : url);

function connect() {
  const at = target();
  ws = new WebSocket(at);
  let opened = false;
  // A dead tunnel hostname hangs rather than refusing, so only a clock moves us on.
  const dial = URLS.length > 1
    ? setTimeout(() => { if (!opened) { try { ws.close(); } catch { /* already gone */ } } }, INVITE_CONNECT_MS)
    : null;
  dial?.unref?.();
  ws.addEventListener('open', () => {
    opened = true;
    if (dial) clearTimeout(dial);
    backoff = 1000;
    attempts = 0;
    // v0.22B: `invite` is checked before the token and admits under the name the host bound to
    // the link; a refused one is explained and then knocks, so it always rides along.
    ws.send(JSON.stringify({ t: 'hello', name: NAME, token: TOKEN, invite: INVITE, host: IS_HOST || undefined }));
  });
  ws.addEventListener('message', (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.t === 'welcome') {
      session = ev.session;
      roster = ev.roster;
      labelW = labelWidth(roster); // set before the replay, so history aligns with what follows
      sys(`jam ${ev.session.id} — host ${ev.session.hostName}, cwd ${ev.session.cwd}`);
      if (IS_HOST) logJoin();
      // A restarted daemon reissues ids from 1, so old ids in `seen` would swallow
      // everything it sends. Drop them whenever the boot id changes.
      if (ev.session?.boot !== boot) { boot = ev.session?.boot; seen.clear(); }
      logOnboarding(); // above the first messages; the replay comes after it
      let replayed = 0;
      for (const h of ev.history || []) if (!seen.has(h.id)) { seen.add(h.id); replayed++; render(h); }
      // v0.17 H2: where the backlog ends and the live session begins.
      const divider = historyDivider(replayed);
      if (divider) emit({ text: divider, textColor: C.dim, bare: true });
      sys(`here: ${roster.join(', ')}`);
      return;
    }
    if (ev.id != null) { if (seen.has(ev.id)) return; seen.add(ev.id); }
    render(ev);
  });
  ws.addEventListener('close', (e) => {
    if (dial) clearTimeout(dial);
    // 4400/4401 bad name or token, 4403 denied, 4406 removed by the host, 4408 knock expired,
    // 4409 name taken, 4429 too many knocks — none of them get better by retrying.
    if (e.code >= 4400 && e.code <= 4429) {
      emit({ glyph: '!', glyphColor: C.err, text: `rejected: ${e.reason || 'auth'}`, textColor: C.err });
      process.exit(1);
    }
    // The jam ended on purpose: the socket closing is the expected end of it, not a fault.
    if (ending) return;
    setSpinner(false); // nothing is known about the turn while the socket is down
    attempts++;
    // v0.22B: walk the invite's address list once, fast, before any backoff.
    const more = !opened && attempts < URLS.length;
    if (more) addr++;
    const wait = more ? 0 : backoff;
    sys(more ? `no answer from ${at} — trying ${target()}` : reconnectMessage(attempts, wait));
    setTimeout(connect, wait);
    if (!more) backoff = Math.min(backoff * 2, 10000);
  });
  ws.addEventListener('error', () => { /* close handler does the retry */ });
}

const err = (text) => emit({ glyph: '!', glyphColor: C.err, text, textColor: C.err });
const sendMsg = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); else err('not connected'); };

// --------------------------------------- v0.12/v0.13: the export and files ----
// Same behaviour as the ink client: an incoming transfer is written to this client's own cwd,
// an export prints the recipe that revives it, and an upload waits for the host's yes.
const xfers = new Map();
let upload = null; // {name, data, caption} read and waiting for the host

function saveIncoming(rec) {
  try {
    const file = saveXfer(rec);
    sys(`saved ${file} (${humanBytes(rec.data.length)})`);
    if (rec.kind === 'export') {
      for (const l of resumeInstructions(rec.session, file, process.cwd())) emit({ text: l, textColor: C.dim, bare: true });
    }
  } catch (e) { err(`could not save the transfer: ${e.message}`); }
}

function doSend(p) {
  if (IS_HOST) return sendMsg({ t: 'offer', path: p });
  let file;
  try { file = readForUpload(p); } catch (e) { return err(e.message); }
  stageUpload(file.name, file.data, '');
}

function doPaste(caption) {
  let img;
  try { img = clipboardPng(); } catch (e) { return err(e.message); }
  stageUpload(img.name, img.data, caption);
}

function stageUpload(name, data, caption) {
  upload = { name, data, caption };
  sendMsg({ t: 'upload', name, size: data.length, caption: caption || undefined });
  if (!IS_HOST) sys(`${name} (${humanBytes(data.length)}) — waiting for the host to accept it`);
}

function sendUpload(ev) {
  if (!upload) return err('a file was approved that I am no longer holding — /send it again');
  if (ev.name && ev.name !== upload.name) return err(`${ev.name} was approved, but I am holding ${upload.name}`);
  const up = upload;
  upload = null;
  sys(`sending ${up.name} (${humanBytes(up.data.length)})…`);
  pumpFrames(xferFrames(ev.xfer, up.data), (f) => sendMsg(f), () => ws?.readyState === 1);
}

rl.on('line', (raw) => {
  // v0.18-4: /end asked "really end this jam for everyone?", and this is the answer —
  // taken before anything is parsed, so a bare `y` can never become a message to claude.
  // v0.22C adds the second question of the same shape: revoke the kicked person's link?
  if (confirming) {
    const q = confirming;
    confirming = null;
    const yes = confirmYes(raw);
    if (q.kind === 'end') {
      if (yes) { sendMsg({ t: 'end' }); sys('ending the jam for everyone…'); }
      else sys('nothing ended — the jam is still running');
    } else if (q.kind === 'revoke') {
      if (yes) sendMsg({ t: 'invite', op: 'revoke', target: q.name });
      else sys(`${q.name}'s invite link still works — /invite revoke ${q.name} takes it back later`);
    }
    return reprompt();
  }
  const a = parseClientLine(raw);
  if (a.kind === 'continue') { cont.push(a.text); return reprompt(); }
  const act = cont.length ? parseClientLine([...cont, raw].join('\n')) : a;
  cont = [];
  switch (act.kind) {
    case 'say': sendMsg({ t: 'say', text: act.text }); break;
    case 'chat': sendMsg({ t: 'chat', text: act.text }); break;
    case 'who': sys(`here: ${roster.join(', ')}`); break;
    case 'help': logOnboarding(); break;
    // The mirror needs a live region to redraw a whole screen into; this renderer only ever
    // appends lines. Same for tool collapse — here every ⚙/⎿ line goes straight to the log.
    case 'mirror': sys('the mirror view is ink-client only — run without --basic'); break;
    case 'tools': sys('tool lines are always inline in --basic; /tools needs the ink client'); break;
    case 'join':
      if (!IS_HOST) err('host only');
      else if (!session) sys('not connected yet');
      else logJoin();
      break;
    case 'accept':
    case 'deny':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'admit', name: act.name || undefined, ok: act.kind === 'accept' });
      break;
    // v0.14: answering a guest's /command request; v0.12/v0.13 the same for the transcript
    // and for a file. The daemon enforces host+loopback on all three.
    case 'cmd':
    case 'export-ok':
    case 'file-ok':
      if (!IS_HOST) err('host only');
      else {
        const t = { cmd: 'cmd', 'export-ok': 'exportok', 'file-ok': 'fileok' }[act.kind];
        sendMsg({ t, op: act.op, name: act.name || undefined, always: act.always });
      }
      break;
    case 'export':
      sendMsg({ t: 'export' });
      if (!IS_HOST) sys('asked the host for the session transcript…');
      break;
    case 'send': doSend(act.path); break;
    case 'paste': doPaste(act.caption); break;
    case 'get': sendMsg({ t: 'get', name: act.name || undefined }); break;
    // v0.17 F2/F3: the daemon owns both answers — the transcript and the cwd are its.
    case 'files': sendMsg({ t: 'files' }); break;
    case 'diff': sendMsg({ t: 'diff', path: act.path || undefined }); break;
    // v0.17 P2: only the daemon can see claude's screen, so it reads the options and does the
    // typing. A bare `/answer` asks what they are; `/answer <n>` offers one to the host.
    case 'perm':
      sendMsg({ t: 'perm', choice: act.choice ?? undefined });
      if (act.choice != null && !IS_HOST) sys(`asked the host to answer ${act.choice} — nothing is typed until they say yes`);
      break;
    case 'perm-ok':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'permok', op: act.op, name: act.name || undefined, always: act.always });
      break;
    case 'token':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'token', op: act.op, value: act.value });
      break;
    // v0.14: one of claude's own commands — typed into the TUI for the host, sent to the
    // host for approval for a guest. The daemon is what decides which.
    case 'slash':
      sendMsg({ t: 'slash', text: act.text });
      if (!IS_HOST) sys(`${act.text} — sent to the host for approval`);
      break;
    // v0.18-4: end the whole jam. Host-only here and in the daemon, and it asks first.
    case 'end':
      if (!IS_HOST) err('host only');
      else { confirming = { kind: 'end' }; sys('really end this jam for everyone? [y/N]'); }
      break;
    // v0.22B: mint a link, list them, take one back. Host-only here and in the daemon.
    case 'invite':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'invite', op: act.op, name: act.name, maxUses: act.maxUses, ttl: act.ttl, target: act.target });
      break;
    case 'invites':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'invites' });
      break;
    // v0.22C: remove somebody who is already in.
    case 'kick':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'kick', name: act.name, revoke: act.revoke });
      break;
    case 'quit': process.exit(0);
    case 'error': err(act.text); break;
    default: break;
  }
  reprompt();
});
rl.on('close', () => process.exit(0));

readline.emitKeypressEvents(process.stdin);
process.stdin.on('keypress', () => {
  const now = Date.now();
  if (now - lastTypingSent > 1500) { lastTypingSent = now; sendMsg({ t: 'typing' }); }
});

// Typing indicators expire on their own; refresh the prompt when one drops off.
setInterval(() => {
  const before = typing.size;
  for (const [n, at] of typing) if (Date.now() - at >= 4000) typing.delete(n);
  if (typing.size !== before) reprompt();
}, 1000).unref();
connect();
reprompt();
