#!/usr/bin/env node
// claude-jam terminal client. No dependencies: global WebSocket + readline.
import readline from 'node:readline';
import { parseClientLine, joinLines, labelWidth, wrapText, mdLite, userColor, nextBlock, onboardingLines } from './lib.mjs';

const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('ws'));
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
const NAME = flag('name');
const TOKEN = flag('token');
const IS_HOST = argv.includes('--host');
// No --token is normal now: the host may run knock-only, and then you wait to be accepted.
if (!url || !NAME) {
  console.error('usage: node client.mjs <ws-url> --name <Name> [--token <token>] [--host]');
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
let cont = []; // pending continuation lines
let lastTypingSent = 0;
let boot = null; // daemon boot id: event ids restart at 1 when it changes
let session = null; // welcome's session block; .join only ever set for the host
let labelW = labelWidth([]); // width of the `[Name]` column, recomputed on roster change
let lastTurn = null; // turnKey of the last emitted block, so blocks get a blank line between them
let block = null; // current open message block (nextBlock in lib.mjs), drives lastTurn/turnKey
let spin = 0;
let spinTimer = null;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });

function statusLine() {
  const t = [...typing.entries()].filter(([, at]) => Date.now() - at < 4000).map(([n]) => n);
  const bits = [];
  if (t.length) bits.push(`${t.join(', ')} ${t.length > 1 ? 'are' : 'is'} typing…`);
  // Back to dim after the orange bit: the whole status sits inside one dim bracket.
  if (state.busy) bits.push(`${C.accent}${SPIN[spin]} claude is working…${C.off}${C.dim}`);
  if (state.waiting) bits.push('⚠ waiting for host permission');
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
  for (const l of joinLines(session?.join, session?.view)) emit({ glyph: '*', text: l, textColor: C.dim, wrap: false });
}

// v0.10c: the onboarding block, on connect and on `/help`. Same text as the ink client, minus
// the Shift+Enter line's promise — see the `/mirror` and `/tools` answers below for what this
// renderer does not do.
function logOnboarding() {
  for (const l of onboardingLines(NAME, IS_HOST)) emit({ text: l, textColor: C.dim, bare: true });
  // The block is shared with the ink client, which can do all three of those; say so here
  // rather than promising a key this renderer never sees.
  emit({ text: '(--basic: F2/Shift+Enter and /tools are ink-only — trailing \\ still does multi-line)', textColor: C.dim, bare: true });
}

function render(ev) {
  switch (ev.t) {
    case 'say': {
      // Self is always green; everybody else gets a stable color hashed from their name, so
      // it survives reconnects and roster churn instead of depending on join order.
      const c = ev.from === NAME ? C.me : fg256(userColor(ev.from));
      return emit({ turnKey: blockKey('say'), label: `[${ev.from}]`, color: c, text: ev.text, textColor: c });
    }
    // Human-only: the agent never sees it, so it renders unmissable — label, prefix and text
    // all in the one color nothing else uses.
    case 'chat': return emit({ turnKey: blockKey('chat'), label: `[${ev.from}]`, color: C.chat, text: `[humans-only] ${ev.text}`, textColor: C.chat });
    case 'agent': {
      if (ev.kind === 'tool') return emit({ turnKey: blockKey('agent'), glyph: '⚙', text: ev.text, textColor: C.dim });
      if (ev.kind === 'tool-result') return emit({ turnKey: blockKey('agent'), glyph: '⎿', glyphColor: C.dimmer, text: ev.text, textColor: C.dimmer });
      return emit({ turnKey: blockKey('agent'), label: '[Claude]', color: C.accent, text: ev.text, md: true });
    }
    case 'roster': {
      roster = ev.roster;
      labelW = labelWidth(roster); // the column follows the longest name in the room
      if (ev.joined) sys(`${ev.joined} joined`);
      if (ev.left) sys(`${ev.left} left`);
      return;
    }
    case 'typing': if (ev.from !== NAME) { typing.set(ev.from, Date.now()); reprompt(); } return;
    case 'status': state = { busy: ev.busy, waiting: ev.waiting }; setSpinner(state.busy); return reprompt();
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
    case 'token': {
      if (session) { session.join = ev.join; session.view = ev.view; }
      return logJoin();
    }
    // v0.14: a slash command ran in the TUI, or a guest's request was approved.
    case 'sys': return sys(ev.text);
    case 'error': return emit({ glyph: '!', glyphColor: C.err, text: ev.text, textColor: C.err });
    default: return;
  }
}

function connect() {
  ws = new WebSocket(url);
  ws.addEventListener('open', () => {
    backoff = 1000;
    ws.send(JSON.stringify({ t: 'hello', name: NAME, token: TOKEN, host: IS_HOST || undefined }));
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
      for (const h of ev.history || []) if (!seen.has(h.id)) { seen.add(h.id); render(h); }
      sys(`here: ${roster.join(', ')}`);
      return;
    }
    if (ev.id != null) { if (seen.has(ev.id)) return; seen.add(ev.id); }
    render(ev);
  });
  ws.addEventListener('close', (e) => {
    // 4400/4401 bad name or token, 4403 denied, 4408 knock expired, 4409 name taken,
    // 4429 too many knocks — none of them get better by retrying.
    if (e.code >= 4400 && e.code <= 4429) {
      emit({ glyph: '!', glyphColor: C.err, text: `rejected: ${e.reason || 'auth'}`, textColor: C.err });
      process.exit(1);
    }
    setSpinner(false); // nothing is known about the turn while the socket is down
    sys(`disconnected, retrying in ${backoff / 1000}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 10000);
  });
  ws.addEventListener('error', () => { /* close handler does the retry */ });
}

const err = (text) => emit({ glyph: '!', glyphColor: C.err, text, textColor: C.err });
const sendMsg = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); else err('not connected'); };

rl.on('line', (raw) => {
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
    // v0.14: answering a guest's /command request.
    case 'cmd':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'cmd', op: act.op, name: act.name || undefined, always: act.always });
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
