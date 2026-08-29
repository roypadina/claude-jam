#!/usr/bin/env node
// claude-jam ink client (v0.6, extended by v0.7 mirror / v0.10 tool collapse / v0.10b
// newline keys / v0.10c onboarding / v0.14 unified mirror-first view). Reached through
// client.mjs; `--basic` picks client-basic.mjs.
//
// v0.14: this is the ONE surface — host and guests both run it, and the default view is the
// live mirror of the real claude TUI, with the transcript one F2 away. The host additionally
// gets F3 (raw keys into the TUI) and slash passthrough; the daemon enforces both, so this
// file's `--host` flag decides what to render, never what is allowed.
//
// The socket and every piece of state live in `store`, plain JS — React owns none of it, so a
// frame arriving before the first render just lands in the array and shows up when ink mounts.
// ink only renders: <Static> for the transcript (append-only, so history is never re-drawn and
// scrollback stays the terminal's own), then the live region (mirror frame / in-progress tool
// lines), the chat strip, a status row, and the input row.
//
// Visual rules are v0.5/v0.5.1 verbatim; what changed is who does the wrapping. A <Static>
// item is laid out with no width constraint (ink renders it in its own container), so the
// hanging indent needs an explicit width on the text Box — with one, ink wraps and aligns the
// continuation to the text column by itself and lib.mjs's wrapText is not needed here.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import React from 'react';
import { Box, Text, Static, render as inkRender, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { Select, Spinner, Badge } from '@inkjs/ui';
import { parseClientLine, inviteLines, labelWidth, mdLite, userColor, nextBlock, extractKeys, KEY_SEQS, PASSTHROUGH_SEQS, onboardingLines, fitFrame, toolTurnSummary, LIVE_TOOL_ROWS, humanBytes, resumeInstructions, xferFrames, pumpFrames, approvalBar, barKeyAction, APPROVAL_COMMANDS, claudeTarget, reconnectMessage, historyDivider, toolLiveLine,
  // v0.17 Batch P: the bell and its gate, @mentions, the RTT chip, jam's own autocomplete.
  BELL, bellAllowed, mentionsMe, rttText, commandMatches, COMMAND_HINTS_MAX,
  // v0.18: the host ended the jam — one line, exit 0, and no reconnect at a daemon that is
  // deliberately gone. /end is the other half, and it asks before it sends.
  endingNotice, confirmYes,
  // v0.22B/C: invite links (the address list a link carries, and what a minted one prints) and
  // the offer that follows a kick.
  INVITE_CONNECT_MS, inviteMintedLines, kickOffer,
  // v0.20: jam's tmux lives on its own socket, so F3's attach has to name it.
  // v0.33: and an adopted jam names a pane id instead of a window of its own.
  tmuxSocketArgs, TMUX_DEFAULT_SOCKET, tmuxAttachLine, attachTarget,
  // v0.31: the status row and the question block are both drawn from the daemon's classification
  // of the live pane, so a client can never show a prompt that is no longer on screen.
  promptStatusText, questionBlock,
  // v0.30-3: `↑`/`↓` walk what THIS client submitted, whatever the daemon did with it.
  historyPush, historyMove, parseHistoryFile, serializeHistory, HISTORY_LIVE,
  // v0.24: the live control panel, the relay switch, and the invite block that says which of
  // the lines in the log is the current one.
  menuTree, menuItems, joinBlock, relayPendingLine, REMOTE_MODES, MANUAL_FILE, menuRunsBare,
  KEY_HELP, WIKI_PAGES,
  // v0.25: which sound an event is worth, the three tiers, and the once-only knock repeat.
  notifyPrefs, notifyPlan, KNOCK_REPEAT_MS, knockRepeat,
  // v0.26: nudges, idle awareness, and the recipient's own phone config.
  NUDGE_ALL, IDLE_AFTER, AWAY_AFTER, idleBucket, idleText, whoReport,
  CONFIG_FILE, parseJamConfig, ntfyRequest,
  // v0.27: the two policies /menu shows and switches.
  UPLOAD_POLICIES, uploadPolicy,
  // v0.28: the mirror scrolls back through the host's real pane history, and the transcript
  // goes further back than the replay on demand.
  MIRROR_CHROME, SCREEN_HISTORY_MAX, SCREEN_PAGE_MAX, WHEEL_LINES, scrollStep, scrollStatusText,
  historyEdgeLine, historyPageDivider } from './lib.mjs';
import { xferStart, xferChunk, saveXfer, readForUpload, DOWNLOAD_DIR } from './xfer.mjs';
// v0.32 W0: anything that touches this machine's clipboard, desktop or dot-directories goes
// through the one module that knows what operating system this is.
import { clipboardImage, notify, playSound, copyText, configDir, historyFile, secureWrite,
  secureDir } from './platform.mjs';

const h = React.createElement;

const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('ws'));
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
const NAME = flag('name');
const TOKEN = flag('token');
const IS_HOST = argv.includes('--host');
// v0.22B: what an invite link unpacked into (client.mjs did the decoding). The secret rides in
// the hello; the address list is tried in order — tunnel first, LAN second — with
// INVITE_CONNECT_MS for each, because the tunnel address is the one that can be dead.
const INVITE = flag('invite');
const URLS = (flag('jam-addresses') || '').split(',').map((s) => s.trim()).filter(Boolean);
let addr = 0;
// No --token is normal now: the host may run knock-only, and then you wait to be accepted.
if (!url || !NAME) {
  console.error('usage: claude-jam join <invite-link>\n'
    + '       claude-jam join|node client.mjs <ws-url> --name <Name> [--token <token>] [--host] [--basic] [--no-sound]');
  process.exit(2);
}

// Claude Code's palette, in 256 colours: tmux pales the raw 8 into mud, and the warm greys
// have no 8-colour equivalent at all. Only errors are a plain red-ish accent. ink's own
// `ansi256(n)` colour form emits exactly the same bytes the readline client wrote by hand.
const C = {
  accent: 'ansi256(208)', // claude's orange: its label, the spinner, the prompt caret
  dim: 'ansi256(245)',    // warm grey: tools, system lines, the status row
  dimmer: 'ansi256(240)', // one step back again: tool results
  me: 'ansi256(114)',     // your own name, regardless of what userColor(name) would hash to
  chat: 'ansi256(213)',   // human-only chat: magenta, unmissable, no other element uses it
  err: 'ansi256(203)',
};
const fg256 = (n) => `ansi256(${n})`; // everybody else's stable per-name color (userColor)
const SPIN = ['✻', '✼', '✽', '✼']; // claude's own working glyph cycle
const TMUX = process.env.JAM_TMUX_BIN || 'tmux'; // v0.15: F3 attaches with this
// v0.20: which tmux server it attaches to — the welcome names it (host clients only). A daemon
// from before v0.20 names none, and then it is the shared server, exactly as it was.
let SOCKET = TMUX_DEFAULT_SOCKET;
// v0.15: how long a locally-echoed line stays under the mirror. The daemon's own broadcast of
// it normally clears it within a round trip; this is only the floor for a socket that died.
const ECHO_TTL = 5000;
// v0.28: the mirror lives in the terminal's ALTERNATE screen buffer, exactly as less, vim and
// tmux do. The transcript then owns the NORMAL buffer, its lines are the terminal's own
// scrollback, and flipping between the two loses nothing in either direction — which is what
// retired v0.15's 40-line re-feed after an F3 attach, and the README ceiling that went with it.
const SMCUP = '\x1b[?1049h';
const RMCUP = '\x1b[?1049l';
// How long one of the blocks that MUST be seen (the invite lines, the resume recipe) stays over
// the mirror. It is in the transcript either way; this is only how long the alternate screen
// keeps showing it. v0.24b's bug was these being visible for three system lines and then gone.
const NOTICE_TTL = 45000;
const NOTICE_ROWS = 12; // the most of one it will take from the frame
const NO_WRAP_W = 4096; // wider than any terminal: ink leaves the line alone, the terminal
// soft-wraps it, and an invite command stays one selectable run instead of gaining a newline.
const STRIP_ROWS = 3; // rows of chat/system lines kept under the mirror (v0.14 chat strip)

// ---------------------------------------------- v0.30-3: your own input history ----
// Nothing here talks to the daemon. `↑`/`↓` walk what THIS client submitted, so anything typed can
// be recalled and re-sent whatever the daemon did with it — which is the reason a lost message
// hurt as much as it did. The file is 0600 in the user's own config dir and capped, and every
// disk step is wrapped: a read-only home must cost recall, never the client.
const HISTORY_PATH = historyFile();
let history = [];
try { history = parseHistoryFile(fs.readFileSync(HISTORY_PATH, 'utf8')).reverse().slice(0, HISTORY_LIVE); }
catch { /* no file yet, or not readable — recall simply starts empty */ }
let histIdx = -1; // -1 = typing something new
let histDraft = '';

function rememberInput(text) {
  history = historyPush(history, text, HISTORY_LIVE);
  histIdx = -1;
  histDraft = '';
  try {
    secureDir(path.dirname(HISTORY_PATH));
    secureWrite(HISTORY_PATH, serializeHistory(history));
  } catch { /* the recall still works for this session */ }
}

// ------------------------------------------------------------------- state ----
// One store, no React. `entries` is append-only: <Static> renders each item exactly once.
const store = {
  entries: [],
  labelW: labelWidth([]), // width of the `[Name]` column, recomputed on roster change
  roster: [],
  // v0.31: `prompt` is the daemon's classification of the CLAUDE PANE right now — none |
  // question | permission | dialog. The status row and the question block are drawn from it, so
  // neither can outlive what is on screen.
  status: { busy: false, waiting: false, prompt: { kind: 'none' }, answers: 'anyone' },
  typing: new Map(), // name -> last typing ms
  cont: [], // pending lines of a multi-line message (trailing `\`, Shift+Enter, Alt+Enter)
  session: null, // welcome's session block; .join only ever set for the host
  // v0.14: the mirror of the real TUI is THE view — everyone, host included, opens on it.
  // F2 (or /mirror) flips to the transcript, which is where the full history lives.
  // v0.28: it starts FALSE and is turned on once the welcome block has been printed, so the
  // block a first-time guest needs (who is here, the keys, the invite lines, the replay) is
  // written to the NORMAL buffer and stays in their terminal's own scrollback. Entering the
  // mirror before it would have put all of it in an alternate screen that is thrown away.
  mirror: false,
  alt: false, // whether the alternate screen buffer is currently up (mirror === alt, after mount)
  // v0.28: where the mirror is scrolled to. `before === 0` IS live — there is no second flag, so
  // the state cannot claim to be scrolled and at the bottom at the same time. `paused` counts
  // live frames that arrived while scrolled: they are held, never dropped in silence.
  scroll: { before: 0, rows: [], maxBefore: 0, atTop: false, paused: 0, said: false,
    cap: SCREEN_HISTORY_MAX, w: 0, h: 0 },
  // v0.28: what the daemon's ring is holding, and the oldest event id this client has printed —
  // `/history` asks for the page older than that one.
  kept: 0,
  oldestId: null,
  passthrough: false, // v0.14 F3 fallback (host only): keys go straight to the claude TUI
  attached: false, // v0.15 F3: ink is unmounted and `tmux attach` owns the terminal
  echo: null, // v0.15: {text, at} — your own submitted line, painted before the frame catches up
  frame: null, // latest {rows, w, h} screen frame
  deferred: [], // entries that arrived while the mirror was up; flushed back on the way out
  tools: [], // v0.10: this turn's ⚙/⎿ lines, still collapsible
  toolsExpanded: false, // `/tools on` — never collapse
  lastTools: [], // the last completed turn's full tool log, for `/tools`
  // v0.16: every request waiting for the host, as the daemon last pushed it — the approval bar
  // is derived from this and nothing else. `armed` is single-key mode (off while you type,
  // back on Esc) and `hiddenKey` the one request whose bar was dismissed with i/Esc.
  pending: [],
  armed: true,
  hiddenKey: null,
  input: '', // what is in the input line, mirrored out of React for the single-key rule
  // v0.18-4: `/end` asked "really end this jam for everyone?" and the next submitted line
  // is the answer. Null the rest of the time.
  confirm: null,
  // v0.17 P5: the last heartbeat round trip the daemon measured for THIS socket, plus when it
  // arrived (this client's own clock, so a skewed daemon clock cannot make the link look stale).
  net: null,
  xfers: new Map(), // v0.12/v0.13: incoming transfers, xfer id -> assembling record
  upload: null, // a file read and waiting for the host's yes: {name, data, caption}
  offers: new Map(), // v0.13: what the host has offered, name -> {from, size}
  // v0.24: the live control panel. `menu` is null when it is closed; the rest is the state it
  // shows, which arrives on frames the client already receives.
  menu: null,
  grants: [], // v0.24C: the standing `always` grants, listed so they can be withdrawn
  remoteRows: null, // what the daemon says each relay mode can do here, and why not
  remoteBusy: false, // a switch is in flight: the panel shows a spinner instead of a list
  lastLink: null, // v0.24: the last invite link minted here, so the menu can copy it
  // v0.25: the three tiers, per client and per session. Absent means ON — the notifications
  // v0.17 shipped were unconditional, and a new toggle must not silence somebody who never
  // asked. `--no-sound` at launch, /menu → Notifications, /sound on|off.
  notify: { sound: !argv.includes('--no-sound'), notification: true, bell: true },
  // v0.26: name -> seconds since that person last touched a key, as THEY reported it. Coarse
  // seconds only; there is nothing in here that could carry content even by accident.
  idle: {},
  listeners: new Set(),
};
const touch = () => { for (const l of store.listeners) l(); };

const seen = new Set(); // dedupe replayed history across reconnects
let ws = null;
let backoff = 1000;
// v0.17 T3: consecutive failures, reset on a socket that actually opened. Five of them is the
// point where "retrying" stops being the useful thing to say — see reconnectMessage.
let attempts = 0;
let boot = null; // daemon boot id: event ids restart at 1 when it changes
let lastTypingSent = 0;
let seq = 0; // <Static> keys
let toTranscript = 0; // >0: emit() writes to the transcript even in mirror view (connect block)
let block = null; // current open message block (nextBlock in lib.mjs)
let lastTurn = null; // turnKey of the last emitted block, so blocks get a blank line between
let app = null; // ink instance, once mounted
let ending = false; // v0.18: the jam is over on purpose, so the close below must not retry
let openedMirror = false; // v0.28: the mirror opens once, after the first welcome block

// Leaving is unmount-then-print: ink clears its own two rows on unmount, so anything written
// afterwards is guaranteed to survive on screen instead of being erased by the next redraw.
// Deferred by a tick because `/quit` calls this from inside a React event handler, and
// unmounting the reconciler mid-commit wedges it instead of exiting.
function leave(code, text) {
  setImmediate(() => {
    try { app?.unmount(); } catch { /* never mounted, or already gone */ }
    // v0.28: back to the normal buffer BEFORE the parting line, or it is written into an
    // alternate screen that is discarded a microsecond later.
    restoreScreen();
    if (text) process.stdout.write(`${text}\n`);
    process.exit(code);
  });
}

// ------------------------------------------------------------- key filter ----
// v0.7 / v0.10b: F2 and the Shift/Alt+Enter spellings are pulled out of the byte stream
// BEFORE ink sees it, or ink's input machinery turns them into `[13;2u` in the text field.
// ink reads from the PassThrough below and never touches the real tty except through the
// setRawMode proxy, so raw mode, Ctrl-C and unmount all keep working.
const keys = new EventEmitter();
const inkStdin = new PassThrough();
inkStdin.isTTY = true;
inkStdin.setRawMode = (on) => { try { process.stdin.setRawMode?.(on); } catch { /* not a tty */ } return inkStdin; };
inkStdin.ref = () => inkStdin;
inkStdin.unref = () => inkStdin;
{
  const dec = new StringDecoder('utf8'); // a chunk can land mid-codepoint
  let hold = '';
  process.stdin.on('data', (buf) => {
    // v0.15: while `tmux attach` has the terminal the keyboard is its own. stdin is paused
    // for the duration; this is the belt to that braces — a byte read here would be a byte
    // tmux never sees.
    if (store.attached) return;
    // v0.24: while `/menu` is open the panel owns the keyboard, whole. Without this the filter
    // above claims `↑`/`↓` for input recall and Esc for the approval bar, so a Select in the
    // panel would never move and Esc would never close it — measured, not guessed.
    if (store.menu && !store.passthrough) return inkStdin.write(dec.write(buf));
    // v0.14: in passthrough mode the keyboard belongs to the claude TUI, so only F3 (the way
    // back) is still ours — everything else, escape sequences included, goes on the wire
    // untouched. ink never sees a byte of it, so nothing lands in the text field either.
    const r = extractKeys(hold + dec.write(buf), store.passthrough ? PASSTHROUGH_SEQS : KEY_SEQS);
    hold = r.hold;
    for (const k of r.keys) keys.emit(k);
    if (!r.text) return;
    if (store.passthrough) return sendKeys(r.text);
    // v0.16: the approval bar's single keys come out of the stream here, before ink's input
    // machinery can put them in the text field. Everything else falls through untouched.
    // v0.28: `G`/`g`/Esc return the mirror to live, ahead of the bar's own single keys and only
    // while something is scrolled and the input line is empty.
    const rest = barKeys(scrollKeys(r.text));
    if (rest) inkStdin.write(rest);
  });
  process.stdin.resume();
}

// ---------------------------------------------------------------- emitting ----
// Say/agent-text/chat are speech: no glyph, just `[Name]  text`. Tools, knocks, system lines
// and errors keep a one-column glyph. `kind` picks the message block (nextBlock in lib.mjs)
// this event belongs to; callers that pass no kind (system, knock, error) are untracked —
// they neither force a blank line nor break an open agent turn's gluing.
function blockKey(kind) {
  block = nextBlock(kind, block);
  return `${block.kind}:${block.seq}`;
}

// One transcript line: `[Label]` padded to one column, then a glyph column (one character for
// tools/knocks/system/errors, blank for speech), then the text. Each entry freezes the label
// width and the terminal width it was built at, because <Static> never re-renders it.
// `bare` skips the label/glyph gutter entirely (the onboarding block draws its own box).
function emit({ turnKey, label = '', color = C.dim, glyph = '', glyphColor = C.dim, text = '', textColor, md = false, wrap = true, bare = false, strip = false }) {
  // Blank line between blocks: the rhythm that makes a transcript readable. Tools and their
  // results glue to their turn's block, so they do not get one of their own.
  const gap = !!turnKey && lastTurn !== null && turnKey !== lastTurn;
  if (turnKey) lastTurn = turnKey;
  const entry = {
    key: ++seq, gap, label, color, glyph, glyphColor, md, wrap, bare,
    // `strip`: worth a row of the chat strip in mirror view. The mirror already shows
    // everything claude sees — its own output and the `[Name]:` messages typed into it — so
    // the strip is for what it cannot: humans-only chat, knocks, system lines and errors.
    strip,
    text: String(text), textColor,
    labelW: store.labelW, cols: process.stdout.columns || 80,
    at: Date.now(), // v0.28: how long a notice has been over the mirror
    // v0.28: a block that was forced into the transcript (`toTranscript`) while the mirror owns
    // the screen. It still goes to the transcript — nothing is lost — AND it is shown over the
    // frame for NOTICE_TTL, because v0.24b's bug was the host never seeing the tunnel URL.
    notice: store.mirror && toTranscript > 0,
  };
  // While the mirror is up the transcript is not on screen, so new lines wait in `deferred`
  // (the last few show as an overlay) and are flushed into the transcript, in order, when
  // the guest flips back. A NEW array, never a push: <Static> memoizes its slice on the
  // items reference, so an in-place mutation is silently dropped and the line never renders.
  // `toTranscript` is the one exception: the connect block (welcome, onboarding, history
  // replay) is printed once, above the mirror, or a first-time guest would open on a bare
  // screen with the instructions hidden behind F2.
  // v0.28: in the mirror view EVERYTHING queues, `toTranscript` included — the transcript view
  // owns the normal buffer, and a line written into the alternate screen would be thrown away
  // with it. One queue rather than two, so the order it is flushed in is the order it happened.
  if (store.mirror) store.deferred = [...store.deferred, entry];
  else store.entries = [...store.entries, entry];
  touch();
}

// v0.28: the oldest event id this client has printed. `/history` asks for the page BEFORE it,
// so a second `/history` continues where the first stopped instead of re-sending the same page.
function noteOldest(items) {
  for (const it of items || []) {
    if (it?.id == null) continue;
    if (store.oldestId == null || it.id < store.oldestId) store.oldestId = it.id;
  }
}

const sys = (text) => emit({ glyph: '*', text, textColor: C.dim, strip: true });
const err = (text) => emit({ glyph: '!', glyphColor: C.err, text, textColor: C.err, strip: true });

// ------------------------------------------- v0.17 P3/P4: being told you are needed ----
// Two moments are worth interrupting somebody for: claude is waiting for a permission answer, and
// somebody said your name. `\x07` is the portable half — every terminal already turns it into
// whatever that user configured — and on macOS a real notification goes with it, because a bell in
// a terminal on another desktop is a bell nobody hears. Rate-gated, so a burst is one nudge.
// Writing the bell straight to the real stdout is safe next to ink: it paints no cell, so it
// cannot land inside a frame and corrupt it.
//
// v0.25/v0.26 turn that into THREE independently switchable tiers plus a sound, because "make a
// noise" and "put a notification on my desktop" are different amounts of interruption and a
// person who wants one does not automatically want the other. `event` picks the sound —
// knock/join/nudge, and nothing for anything else — and lib's notifyPlan() is the single
// decision, so the toggles cannot be honoured in one code path and forgotten in another.
let lastBell = 0;
let lastRtt = ''; // v0.17 P5: the RTT chip as last rendered, so only a CHANGE costs a redraw
let lastNotices = 0; // v0.28: notices over the mirror, so one expiring costs one redraw
function alert(title, body, { event = '', phone = false, force = false } = {}) {
  const plan = notifyPlan({ event, prefs: store.notify, phone });
  // The 3-second gate is about the BELL and the desktop notification (a burst is one nudge). A
  // sound the human explicitly asked for — a nudge addressed to them — is `force`d past it,
  // because being told twice is better than a nudge you never heard.
  const gated = !force && !bellAllowed(lastBell, Date.now());
  if (!gated) lastBell = Date.now();
  if (plan.sound) playSound(plan.sound); // through the seam; a missing player is silence
  if (gated) return;
  if (plan.bell) { try { process.stdout.write(BELL); } catch { /* stdout closed */ } }
  if (plan.notification) notify(title, body); // macOS only, fire and forget, never throws
  if (plan.phone) toPhone(title, body);
}

// v0.26 tier 3, and the one piece of this feature that carries a secret. The ntfy topic is a
// bearer credential — anyone holding it can publish to that phone — so it lives ONLY here, in
// this person's own ~/.config/claude-jam/config.json, it is read by their own client, and it is
// POSTed by their own machine. It never travels in the protocol, never rides an invite link and
// never reaches the host or its logs. Read once at startup; failures are silent by design (a
// phone that did not buzz must never cost the client a frame or an exception).
const jamConfig = (() => {
  try { return parseJamConfig(fs.readFileSync(path.join(configDir(), CONFIG_FILE), 'utf8')); }
  catch { return { ok: true, ntfy: null, why: 'no config file' }; } // ENOENT is the normal case
})();
let phoneSaid = false;
function toPhone(title, message) {
  const req = ntfyRequest(jamConfig.ntfy, { title, message });
  if (!req) return;
  // Fire and forget: no await, no retry, and the catch swallows everything. One dim line, once
  // per session, if it never works — and the line never quotes the topic.
  fetch(req.url, { method: 'POST', headers: req.headers, body: req.body }).catch(() => {
    if (phoneSaid) return;
    phoneSaid = true;
    sys('the phone notification did not send (your ntfy server did not answer) — everything else is unaffected');
  });
}

// v0.25: a knock is the one arrival that is WAITING for you, so it rings the slow low sound —
// and it repeats ONCE after 30 s if nobody has answered. Once, never a loop: an alarm that will
// not stop is an alarm whose whole feature gets muted. The record is keyed by name so a host
// client reconnecting into a jam with knocks already pending re-renders them without re-ringing.
const knocks = new Map(); // name -> {at, repeated}
function armKnock(name) {
  if (!IS_HOST || !name || knocks.has(name)) return;
  const rec = { at: Date.now(), repeated: false };
  knocks.set(name, rec);
  alert('⚑ claude-jam', `${name} wants to join`, { event: 'knock' });
  const t = setTimeout(() => {
    // Still waiting? The `pending` frame is the daemon's own answer to that, and it is replaced
    // wholesale on every change — so a knock that has been accepted, denied or expired is simply
    // not in it any more, and this fires at nobody.
    const answered = !store.pending.some((p) => p.kind === 'knock' && p.name === name);
    if (!knockRepeat({ at: rec.at, repeated: rec.repeated, answered, now: Date.now() })) {
      return knocks.delete(name);
    }
    rec.repeated = true;
    alert('⚑ claude-jam', `${name} is still waiting to join`, { event: 'knock', force: true });
    knocks.delete(name);
  }, KNOCK_REPEAT_MS);
  t.unref?.();
}

// ------------------------------------------------- v0.26: idle awareness ----
// What is reported is ONE NUMBER: whole seconds since this human last typed or submitted here.
// No key, no text, no window title — there is nothing in this path that could carry content even
// by accident, and that is the property the docs promise.
//
// It is pushed only when the BUCKET changes (active → idle → away), not on a timer tick, so a
// quiet jam costs a handful of tiny frames an hour rather than one per person per heartbeat.
let activeAt = Date.now();
let idleSaid = null;
const localActivity = () => { activeAt = Date.now(); reportIdle(); };
function reportIdle() {
  const s = Math.round((Date.now() - activeAt) / 1000);
  const b = idleBucket(s);
  if (b === idleSaid) return;
  idleSaid = b;
  if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'idle', s }));
}
{
  // A quarter of the shortest bucket: coarse enough to be cheap, fine enough that `idle 2m`
  // appears within half a minute of it being true.
  const t = setInterval(reportIdle, Math.max(5000, (IDLE_AFTER * 1000) / 4));
  t.unref?.();
}

// The host's invite lines, wherever they are shown (welcome, /join, a /token reply).
//
// v0.24b, and the bug that made it necessary: these went through the ordinary emit path with
// `strip:true`, so in the MIRROR view — which is the default view since v0.14 — they landed in
// `deferred` and showed only in the three-row chat strip. Three system lines later they were
// gone, and the host had never seen the tunnel URL that had just come up. Reproduced against a
// stub daemon 2026-08-29: the {t:'token'} frame arrives, the line is simply pushed off screen.
//
// So the block is written to the TRANSCRIPT, the way a minted invite link already was
// (toTranscript, v0.22B), and it is ONE dated block rather than a fourth near-identical copy —
// the heading carries the time, and a dim line says the earlier ones are stale.
let printedJoin = false;
function logJoin() {
  const lines = joinBlock(store.session || {}, { now: Date.now(), hadEarlier: printedJoin });
  printedJoin = true;
  toTranscript++;
  for (const l of lines) emit({ glyph: '*', text: l, textColor: C.dim, wrap: false });
  // v0.24b: with --tunnel/--funnel the hostname is ~10s away. Say what is pending, rather than
  // leaving a LAN-only block that looks complete.
  const pend = store.session?.relayPending ? relayPendingLine(store.session.remote) : null;
  if (pend) emit({ glyph: '*', text: pend, textColor: C.dim, wrap: false });
  toTranscript--;
}

// v0.10c: what a client prints on connect and on `/help`. Dim, gutter-less, ≤10 rows.
function logOnboarding() {
  for (const l of onboardingLines(NAME, IS_HOST)) emit({ text: l, textColor: C.dim, wrap: false, bare: true });
}

// ---------------------------------------------------- v0.10: tool collapse ----
const emitTool = (t) => (t.kind === 'tool-result'
  ? emit({ turnKey: blockKey('agent'), glyph: '⎿', glyphColor: C.dimmer, text: t.text, textColor: C.dimmer })
  : emit({ turnKey: blockKey('agent'), glyph: '⚙', text: t.text, textColor: C.dim }));

// The turn ended (busy went false, or claude started talking again): fold this turn's tool
// lines into one summary, or — for a single tool call — print them inline as they always were.
function flushTools() {
  if (!store.tools.length) return;
  const tools = store.tools;
  store.tools = [];
  store.lastTools = tools;
  const summary = toolTurnSummary(tools);
  if (summary) emit({ turnKey: blockKey('agent'), glyph: '⚙', text: summary, textColor: C.dim });
  else for (const t of tools) emitTool(t);
}

function render(ev) {
  switch (ev.t) {
    case 'say': {
      // v0.15: the daemon has it. The echo stays up — the gap it exists to cover is the one
      // until the claude pane itself shows the line — but it stops saying "sending".
      if (ev.from === NAME && store.echo) store.echo = { ...store.echo, acked: true };
      // v0.17 P3: somebody said your name. Never your own line, whoever the daemon echoed it to.
      if (ev.from !== NAME && mentionsMe(ev.text, NAME)) alert(`${ev.from} in the jam`, ev.text);
      // Self is always green; everybody else gets a stable color hashed from their name, so
      // it survives reconnects and roster churn instead of depending on join order.
      const c = ev.from === NAME ? C.me : fg256(userColor(ev.from));
      return emit({ turnKey: blockKey('say'), label: `[${ev.from}]`, color: c, text: ev.text, textColor: c });
    }
    // Human-only: the agent never sees it, so it renders unmissable — label, prefix and text
    // all in the one color nothing else uses.
    case 'chat': {
      if (ev.from !== NAME && mentionsMe(ev.text, NAME)) alert(`${ev.from} in the jam`, ev.text);
      return emit({ turnKey: blockKey('chat'), label: `[${ev.from}]`, color: C.chat, text: `[humans-only] ${ev.text}`, textColor: C.chat, strip: true });
    }
    case 'agent': {
      if (ev.kind === 'tool' || ev.kind === 'tool-result') {
        // Collapse mode (default): the turn's tool lines live in the live region until the
        // turn ends. `/tools on` prints them straight into the transcript, as v0.6 did.
        if (store.toolsExpanded) return emitTool({ kind: ev.kind, text: ev.text });
        store.tools = [...store.tools, { kind: ev.kind, text: ev.text }];
        return touch();
      }
      flushTools(); // a new text block ends the tool run before it
      return emit({ turnKey: blockKey('agent'), label: '[Claude]', color: C.accent, text: ev.text, md: true });
    }
    case 'roster': {
      store.roster = ev.roster;
      store.labelW = labelWidth(ev.roster); // the column follows the longest name in the room
      // v0.26: coarse seconds per person, absent on a daemon older than this. `?? store.idle`
      // rather than `|| {}` — a frame that did not mention idle must not erase what we know.
      if (ev.idle) store.idle = ev.idle;
      // v0.22B: an invite join has no knock to announce it, so the roster line is the only
      // arrival anybody sees — it says HOW they got in.
      if (ev.joined) {
        sys(`${ev.joined} joined${ev.via && ev.via !== 'token' ? ` (${ev.via})` : ''}`);
        // v0.25: an AUTO-join — a token or an invite link — is somebody who is already in, so it
        // is one short chime and nothing is owed. `knock` is the other sound and it fires on the
        // knock itself (below), not here: by the time a knocker reaches the roster the host has
        // already answered them. The host is the only one who hears arrivals at all.
        if (IS_HOST && ev.joined !== NAME && (ev.via === 'token' || ev.via === 'invite')) {
          alert('claude-jam', `${ev.joined} joined`, { event: 'join' });
        }
      }
      if (ev.left) { delete store.idle[ev.left]; sys(`${ev.left} left`); } // no sound: see EVENT_SOUNDS
      return touch();
    }
    // v0.26: somebody is asking for YOU, or for the room. One frame reaches everybody — a nudge
    // is never secret — and this is where the recipient's own machine decides how loud it is:
    // the addressed client gets the highlighted line, the bell, the sound and (opt-in) the phone;
    // everybody else gets one dim line saying it happened.
    case 'nudge': {
      const mine = ev.to === NAME || (ev.to === NUDGE_ALL && ev.from !== NAME);
      if (ev.from === NAME) return sys(`you nudged ${ev.to}${ev.again ? ' again' : ''}`);
      if (!mine) return sys(`${ev.from} nudged ${ev.to}`);
      // The leading space is deliberate: 👋 is a DOUBLE-width cell and the glyph gutter is one
      // column wide, so without it the emoji and the name run together (measured on tmux 3.7c,
      // 2026-08-29). Every other glyph in this client is single-width and needs no such thing.
      emit({ glyph: '👋', glyphColor: C.chat, textColor: C.chat, strip: true,
        text: ` ${ev.from} is asking for you${ev.again ? ' (again)' : ''}${ev.text ? `: ${ev.text}` : ''}` });
      return alert(`👋 ${ev.from}`, ev.text || 'is asking for you',
        { event: 'nudge', phone: !!jamConfig.ntfy, force: true });
    }
    case 'typing': if (ev.from !== NAME) { store.typing.set(ev.from, Date.now()); touch(); } return;
    case 'status': {
      // v0.17 P3: the transition into waiting is the single most actionable moment in a jam, and
      // it used to be silent for anyone not looking.
      // v0.31: WHO gets rung now depends on what the screen says. A permission or a dialog is the
      // host's to answer, so only the host is interrupted; a QUESTION is anybody's, so everybody
      // is — that is the whole point of the split.
      const p = ev.prompt || { kind: ev.waiting ? 'permission' : 'none' };
      const was = store.status.prompt?.kind || 'none';
      if (p.kind !== was && p.kind !== 'none' && (IS_HOST || p.kind === 'question')) {
        alert('claude needs an answer', promptStatusText(p, { host: IS_HOST, answers: ev.answers }));
      }
      store.status = { busy: ev.busy, waiting: ev.waiting, prompt: p, answers: ev.answers || 'anyone' };
      if (!ev.busy) flushTools(); // the turn is over: collapse what it ran
      return touch();
    }
    // v0.17 P5: this socket's own round trip, measured by the daemon's heartbeat. Live state, not
    // transcript — the newest one replaces the last and nothing is kept.
    case 'net':
      store.net = { rtt: Number(ev.rtt), at: Date.now(), heartbeat: Number(ev.heartbeat) || undefined };
      return touch();
    // v0.7: the host's real screen. Live state, never transcript — the newest frame replaces
    // the previous one and nothing is kept.
    case 'screen': {
      store.frame = { rows: ev.rows || [], w: ev.w, h: ev.h };
      // v0.28: while the mirror is scrolled back, a live frame is HELD, never painted under the
      // reader — and counted, so the status row can say how many are waiting. A frame dropped in
      // silence is the same complaint in a smaller costume.
      if (store.scroll.before) {
        store.scroll = { ...store.scroll, paused: store.scroll.paused + 1 };
        return touch();
      }
      // v0.15: the mirror has caught up with your own submitted line, so the echo of it has
      // done its job. Matched on the head of the text, the same trick the daemon's injection
      // uses to prove its paste landed; the TTL is the fallback when it never appears.
      const head = store.echo?.text.split('\n')[0].slice(0, 24);
      if (head && (ev.rows || []).some((r) => r.includes(head))) store.echo = null;
      return touch();
    }
    // Knocks: `state` means it is about us waiting, `name` means somebody wants in.
    case 'knock': {
      if (ev.state === 'pending') return sys('waiting for host approval…');
      if (ev.state === 'denied') return leave(1, '! the host denied your request');
      if (ev.state === 'expired') return leave(1, '! nobody approved your request in time');
      // strip:false since v0.16 — the approval bar is the live surface for a request, and
      // repeating it in the 3-row strip only spends a row the mirror could have used. The
      // transcript still keeps the line, with the /accept syntax on it.
      // v0.25: a knock is the one arrival that WANTS something from you, so it gets the slow
      // low sound and it repeats once — see armKnock. The re-sends a reconnecting host client
      // gets for knocks already on screen are deduped by name, or a reconnect would ring twice.
      armKnock(ev.name);
      return emit({ glyph: '⚑', glyphColor: C.accent, text: `${ev.name} wants to join${ev.ip ? ` (${ev.ip})` : ''} — /accept ${ev.name} · /deny ${ev.name}` });
    }
    // v0.14: a guest wants to run one of claude's commands. Host clients only — and the
    // wording is the answer, so the host never has to remember the syntax.
    case 'cmdreq':
      return emit({
        glyph: '⌘',
        glyphColor: C.accent,
        text: `${ev.name} wants to run ${ev.cmd} — /allow-cmd ${ev.name} · /allow-cmd ${ev.name} always · /deny-cmd ${ev.name}`,
      });
    // v0.12: a guest wants the transcript. Host clients only, and the line is the answer.
    case 'exportreq':
      return emit({
        glyph: '⇩',
        glyphColor: C.accent,
        text: `${ev.name} requests the session transcript — /allow-export ${ev.name} · /allow-export ${ev.name} always · /deny-export ${ev.name}`,
      });
    // v0.17 P2: a guest wants ONE digit typed into the permission prompt that is up. Host clients
    // only, and the line is the answer — including which option that digit actually stands for,
    // because the host is approving the option, not the number.
    case 'permreq':
      return emit({
        glyph: '⏎',
        glyphColor: C.accent,
        text: `${ev.name} wants to answer the prompt with ${ev.choice}. ${ev.option} `
          + `— /allow-perm ${ev.name} · /allow-perm ${ev.name} always · /deny-perm ${ev.name}`,
      });
    // v0.13: a guest wants to send a file in. Host clients only.
    case 'filereq':
      return emit({
        glyph: '⇪',
        glyphColor: C.accent,
        text: `${ev.name} wants to send ${ev.file} (${humanBytes(ev.size)}) — /accept-file ${ev.name} · /accept-file ${ev.name} always · /deny-file ${ev.name}`,
      });
    // v0.13: the host offered a file to everyone; `/get` pulls it.
    case 'offer': {
      store.offers.set(ev.name, { from: ev.from, size: ev.size });
      return emit({
        glyph: '⇩',
        glyphColor: C.accent,
        text: `${ev.from} offers ${ev.name} (${humanBytes(ev.size)}) — /get ${ev.name} saves it to ./${DOWNLOAD_DIR}/`,
        strip: true,
      });
    }
    // v0.13: the host said yes — send the bytes we are holding.
    case 'xfergrant': return sendUpload(ev);
    // v0.12/v0.13: an incoming transfer — its header, then its chunks.
    case 'xfer': { xferStart(store.xfers, ev); return touch(); }
    case 'file': {
      const done = xferChunk(store.xfers, ev);
      return done ? saveIncoming(done) : undefined;
    }
    case 'token': {
      // Every invite string the daemon knows, tunnel pair included: a `/token` rotation
      // changes the credential inside all four. v0.24 adds the access/relay state the menu
      // shows, so `/menu` is a status page without a frame of its own.
      if (store.session) {
        Object.assign(store.session, { join: ev.join, view: ev.view, tunnelJoin: ev.tunnelJoin,
          tunnelView: ev.tunnelView, token: ev.token,
          // v0.23: absent means "this daemon did not say", so it is left alone rather than
          // overwritten with undefined — the same rule the three below already follow.
          ...(ev.jamName === undefined ? {} : { jamName: ev.jamName }),
          ...(ev.announce === undefined ? {} : { announce: ev.announce }),
          ...(ev.remote === undefined ? {} : { remote: ev.remote }),
          ...(ev.inviteOnly === undefined ? {} : { inviteOnly: ev.inviteOnly }),
          ...(ev.relayPending === undefined ? {} : { relayPending: ev.relayPending }) });
      }
      return logJoin();
    }
    // v0.24b: a relay came up (or moved). Its own event, in the transcript, with the whole join
    // command on it — the {t:'token'} refresh alone was the thing nobody saw.
    // Deliberately NOT toTranscript: in the mirror view (the default) that would print it above
    // the frame, where it scrolls out of sight in the same breath — which is the bug this event
    // exists to fix. `strip:true` puts it in the three-row chat strip the mirror leaves for
    // exactly this, and the deferred list is flushed into the transcript on the way back to it,
    // so nothing is lost either way.
    case 'relay': {
      emit({ glyph: '⇗', glyphColor: C.accent, text: ev.text, textColor: C.accent, wrap: false, strip: true });
      alert('claude-jam', ev.text);
      return;
    }
    // v0.24C: the standing `always` grants, which were invisible once given.
    case 'grants': {
      store.grants = Array.isArray(ev.items) ? ev.items : [];
      return touch();
    }
    // v0.24.1: the relay switch answered. `rows` is the menu asking what is possible.
    case 'remote': {
      if (ev.state === 'rows') { store.remoteRows = ev.rows || []; return touch(); }
      if (ev.state !== 'done') return;
      store.remoteBusy = false;
      if (store.session) store.session.remote = ev.mode;
      const n = (ev.reissued || []).length;
      if (ev.action === 'noop') return sys(`remote was already ${ev.mode} — nothing changed`);
      return sys(`remote is ${ev.mode} — nobody was disconnected`
        + (n ? `, ${n} invite link(s) re-issued` : '')
        + (ev.reissuePending ? '; the links are re-issued as soon as the hostname lands, or they would carry the old address' : ''));
    }
    // v0.16: the whole set of requests waiting for the host, pushed on every change. Host
    // clients only (the daemon sends it nowhere else), and it replaces the list wholesale so
    // the bar can never show something that has already been answered.
    case 'pending': {
      store.pending = Array.isArray(ev.items) ? ev.items : [];
      // Nothing waiting: forget which bar was dismissed and re-arm for the next one.
      if (!store.pending.length) { store.armed = true; store.hiddenKey = null; }
      return touch();
    }
    // v0.22B: a minted link (to the host who asked for it, never broadcast) or the reason an
    // invite was refused — which is followed by an ordinary knock, so this is information, not
    // the end of the road.
    case 'invite': {
      if (ev.state === 'refused') return err(ev.text);
      if (ev.state !== 'minted' || !ev.link) return;
      store.lastLink = { link: ev.link, name: ev.invite?.name || '' };
      toTranscript++; // the link belongs on screen even while the live TUI fills it
      for (const l of inviteMintedLines(ev.invite || {}, ev.link, 'claude-jam join')) {
        emit({ glyph: '*', text: l, textColor: C.dim, wrap: false });
      }
      toTranscript--;
      return;
    }
    // v0.22C: the host removed somebody. The victim gets this line, then a 4406 close (final —
    // the close handler above prints the reason and exits). The host gets the `kick` frame and,
    // if that person came in on a link, the offer to take the link back with them.
    case 'kicked': return err(`${ev.by || 'the host'} removed you from the jam`);
    case 'kick': {
      if (ev.state !== 'done') return;
      if (ev.via === 'invite' && !ev.revoked) {
        store.confirm = { kind: 'revoke', name: ev.name };
        return sys(kickOffer(ev.name, ev.via));
      }
      return sys(kickOffer(ev.name, ev.via));
    }
    // v0.18-7: the host ended the jam. One line, exit 0, and no reconnect — there is nothing
    // left to reconnect to, and an orderly end is not a failure.
    case 'ending': {
      ending = true;
      return leave(endingNotice(ev).code, `· ${endingNotice(ev).text}`);
    }
    // v0.14: something happened to the session everybody should know about — a slash command
    // was run in the TUI, a guest's request was approved.
    // v0.28: a page of the host pane's REAL history, colours included. It replaces whatever page
    // was held, and the daemon's own clamp is adopted wholesale — the client asked, the pane
    // answered, and what came back is the truth about how far it goes.
    case 'screen-history': {
      const cap = Number(ev.cap) || SCREEN_HISTORY_MAX;
      store.scroll = { ...store.scroll,
        before: Number(ev.before) || 0, rows: ev.rows || [], w: ev.w, h: ev.h,
        maxBefore: Number(ev.maxBefore) || 0, atTop: !!ev.atTop, cap };
      // Once, on the first scroll to the very top: what this jam kept, and where the whole
      // record is. The "once" rule is historyEdgeLine's, so it is a test and not a code reading.
      const line = historyEdgeLine({ atTop: store.scroll.atTop, shown: store.scroll.said,
        events: store.kept, paneLines: cap });
      if (line) { store.scroll.said = true; sys(line); }
      return touch();
    }
    // v0.28: `/history [n|all]` — the page of the transcript older than the oldest event this
    // client is holding. Printed under a dim divider that says what is still behind it.
    case 'history': {
      if (ev.kept != null) store.kept = Number(ev.kept) || 0;
      const items = (ev.items || []).filter((it) => it.id == null || !seen.has(it.id));
      for (const it of items) if (it.id != null) seen.add(it.id);
      if (!items.length) {
        return sys(ev.older
          ? 'nothing further back arrived — try /history again'
          : `that is everything this jam kept (${store.kept} event(s)) · /export for the complete transcript`);
      }
      noteOldest(items);
      const div = historyPageDivider({ shown: items.length, older: Number(ev.older) || 0 });
      if (div) emit({ text: div, textColor: C.dim, wrap: false, bare: true });
      for (const it of items) render(it);
      flushTools(); // a re-printed page has no `status` frame to end its turn
      return touch();
    }
    case 'sys': return sys(ev.text);
    case 'error': return err(ev.text);
    default: return;
  }
}

// ------------------------------------------------------------------ socket ----
// Which address this dial is aimed at. One entry (a plain ws:// URL) is the ordinary case; an
// invite link can carry several, and then the list is walked once, fast, before any backoff.
const target = () => (URLS.length ? URLS[addr % URLS.length] : url);

function connect() {
  const at = target();
  ws = new WebSocket(at);
  let opened = false;
  // A dead tunnel hostname does not refuse a connection, it hangs — so the only thing that moves
  // us to the next address is a clock. Only worth arming when there IS a next address.
  const dial = URLS.length > 1
    ? setTimeout(() => { if (!opened) { try { ws.close(); } catch { /* already gone */ } } }, INVITE_CONNECT_MS)
    : null;
  dial?.unref?.();
  ws.addEventListener('open', () => {
    opened = true;
    if (dial) clearTimeout(dial);
    backoff = 1000;
    attempts = 0;
    idleSaid = null; // v0.26: a daemon that just accepted this socket knows nothing about us yet
    // `mirror` in the hello subscribes from the very first frame — including through a knock,
    // where the welcome only comes when the host accepts. A reconnect repeats it: the daemon
    // knows nothing about the socket that died.
    // v0.22B: `invite` is checked BEFORE the token, and admits under the name the host bound to
    // the link. A refused invite is told to us and then knocks, so it always rides along.
    ws.send(JSON.stringify({
      t: 'hello', name: NAME, token: TOKEN, invite: INVITE, host: IS_HOST || undefined, mirror: store.mirror,
    }));
  });
  ws.addEventListener('message', (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.t === 'welcome') {
      store.session = ev.session;
      if (ev.session?.tmuxSocket) SOCKET = ev.session.tmuxSocket;
      store.roster = ev.roster;
      store.idle = ev.idle || {}; // v0.26: who is here AND how long since each of them typed
      store.labelW = labelWidth(ev.roster); // set before the replay, so history aligns
      toTranscript++; // the whole connect block goes on screen, mirror view or not
      // v0.23: the jam's NAME leads, because that is what a human calls the room they just
      // walked into; the session id stays, in the same 8-char form every other surface shows.
      sys(`jam ${ev.session.jamName ? `"${ev.session.jamName}" ` : ''}(${String(ev.session.id).slice(0, 8)}) — host ${ev.session.hostName}, cwd ${ev.session.cwd}`);
      if (IS_HOST) logJoin();
      logOnboarding(); // above the first messages; the replay comes after it
      // A restarted daemon reissues ids from 1, so old ids in `seen` would swallow
      // everything it sends. Drop them whenever the boot id changes.
      if (ev.session?.boot !== boot) { boot = ev.session?.boot; seen.clear(); }
      // v0.28: what the ring is holding behind the slice we were given, so `/history` and the
      // top-of-history line quote a real number.
      if (ev.kept != null) store.kept = Number(ev.kept) || 0;
      noteOldest(ev.history || []);
      let replayed = 0;
      for (const hist of ev.history || []) if (!seen.has(hist.id)) { seen.add(hist.id); replayed++; render(hist); }
      // v0.17 H1/H2: a replay has no turn boundary to collapse on — the `status` frame that
      // normally ends a turn arrives after this — so fold its tool lines here, or they would sit
      // in the live region and then land BELOW the divider that says they are history.
      flushTools();
      const divider = historyDivider(replayed);
      if (divider) emit({ text: divider, textColor: C.dim, wrap: false, bare: true });
      sys(`here: ${store.roster.join(', ')}`);
      toTranscript--;
      // v0.28: and NOW the mirror opens. Everything above went to the normal buffer, so it is in
      // this terminal's own scrollback for good; the alternate screen the mirror lives in would
      // have thrown it away. Once only — a reconnect while reading the transcript must not yank
      // the reader back into the live TUI.
      if (!openedMirror) { openedMirror = true; toggleMirror(true); }
      if (store.kept > replayed) {
        sys(`${store.kept - replayed} earlier event(s) are still kept — /history [n|all] prints them`);
      }
      sendResize(); // host only: fit the claude window to this terminal
      reportIdle(); // v0.26: say `active` now rather than at the next tick, so /who is useful at once
      return;
    }
    // Screen frames are a live view at 4/s: they must never enter the dedupe set (it would
    // grow without bound) and there is nothing to dedupe — only the newest one matters.
    if (ev.t !== 'screen' && ev.id != null) { if (seen.has(ev.id)) return; seen.add(ev.id); }
    render(ev);
  });
  ws.addEventListener('close', (e) => {
    if (dial) clearTimeout(dial);
    // 4400/4401 bad name or token, 4403 denied, 4406 removed by the host, 4408 knock expired,
    // 4409 name taken, 4429 too many knocks — none of them get better by retrying.
    // `leave` is deferred a tick, so this must return: otherwise the retry below is scheduled
    // and a "disconnected, retrying" line lands on top of the rejection first.
    if (e.code >= 4400 && e.code <= 4429) return leave(1, `! rejected: ${e.reason || 'auth'}`);
    // The jam ended on purpose: this close is the expected end of it, not a fault.
    if (ending) return;
    store.status = { busy: false, waiting: false, prompt: { kind: 'none' }, answers: store.status.answers }; // nothing is known while the socket is down
    attempts++;
    // v0.22B: while the invite's address list has not been walked once, the next address is tried
    // straight away — a dead tunnel must not cost a backoff before the LAN address gets a turn.
    // Once one has opened, every later reconnect stays on the address that worked.
    const more = !opened && attempts < URLS.length;
    if (more) addr++;
    const wait = more ? 0 : backoff;
    sys(more ? `no answer from ${at} — trying ${target()}` : reconnectMessage(attempts, wait));
    setTimeout(connect, wait);
    if (!more) backoff = Math.min(backoff * 2, 10000);
  });
  ws.addEventListener('error', () => { /* close handler does the retry */ });
}

const sendMsg = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); else err('not connected'); };

// v0.14: nothing is attached to the host's tmux session, so the claude window is exactly as
// big as this terminal says it should be. Host only (the daemon enforces it too) — a guest
// must never reshape the screen everybody else is watching. Silent when the socket is down:
// the reconnect sends it again.
// `force` is the way back from an F3 attach: tmux resized the claude window to whatever the
// attaching client was, without telling the daemon, so the daemon's no-op guard has to be
// stepped over once. Silent while attached — the size is tmux's for as long as it is there.
function sendResize(force = false) {
  if (!IS_HOST || store.attached || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({
    t: 'resize', w: process.stdout.columns || 80, h: process.stdout.rows || 24,
    ...(force ? { force: true } : {}),
  }));
}

// v0.14 F3: hand the keyboard to the real TUI (permission prompts, the trust dialog, an
// interactive /model or /compact picker) and take it back. Host only — the daemon refuses
// `key` frames from anyone else, so this check is courtesy, not the boundary. Turning it on
// forces the mirror view: typing blind into a transcript would be absurd.
function sendKeys(text) {
  if (ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ t: 'key', b64: Buffer.from(text, 'utf8').toString('base64') }));
}

// v0.15: F3's real answer. The host attaches to the tmux session — native latency, full
// fidelity (pickers, permission dialogs, mouse, colours), Ctrl-b d to come back — because a
// proxied keystroke waiting for the next capture-pane frame is 300-500 ms per key and no
// amount of tuning makes that feel like typing. A guest is told, once, whose keyboard it is;
// a host whose daemon predates this (no tmux name in the welcome) keeps the v0.14 proxy.
let f3Hint = false;
function onF3() {
  if (store.attached) return; // stdin belongs to tmux; this cannot actually fire
  // v0.33: an ADOPTED jam sends the pane id it is driving, because `<session>:claude` is jam's
  // own window naming and an adopted pane has whatever name its owner gave it.
  if (store.session?.tmuxTarget) return attachTmux(store.session.tmuxTarget);
  if (store.session?.tmux) return attachTmux(store.session.tmux);
  if (!IS_HOST) {
    if (f3Hint) return;
    f3Hint = true;
    return err('raw TUI control is the host\'s — ask them, or send a /command for approval');
  }
  togglePassthrough();
}

// Unmounting ink is what hands the terminal over, and an unmount is exactly what
// waitUntilExit() resolves on — so the mount loop at the bottom of this file, not this
// function, is what runs the attach and rebuilds the client afterwards.
let pendingAttach = null;
function attachTmux(session) {
  pendingAttach = session;
  store.attached = true;
  // Frames off first: nothing may paint over tmux's screen, and the daemon must not spend a
  // capture-pane on a client that cannot see it.
  if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'mirror', on: false }));
  // v0.28: the same unmount every view flip uses, so the "entries is what has NOT been written"
  // invariant holds here too — that is what retired the 40-line re-feed on the way back.
  unmountFlush();
}

function runAttach(session) {
  return new Promise((done) => {
    process.stdin.pause(); // or node and tmux race each other for the same bytes
    try { process.stdin.setRawMode?.(false); } catch { /* not a tty */ }
    // ink's parting frame is still on the primary screen and tmux draws on the alternate
    // one, restoring this on detach — so wipe the visible page (scrollback untouched).
    // v0.28: and if the mirror had the alternate screen, give it back FIRST. Buffers do not
    // nest: tmux's own rmcup on detach would drop us into the normal one and leave this client
    // believing it still had the alternate one.
    restoreScreen();
    process.stdout.write('\x1b[2J\x1b[H');
    // TMUX unset: a host who launched jam from inside tmux would otherwise be refused
    // outright ("sessions should be nested with care, unset $TMUX to force").
    const env = { ...process.env };
    delete env.TMUX;
    // The claude window by name, not the session's current one — a bare `attach` lands on
    // window 0, the daemon's log, which is not what F3 is for.
    // v0.20: `-L <socket>` — jam's own tmux server, named in the welcome. A daemon that predates
    // v0.20 sends none, and then it is the shared server, which is where it used to be.
    // v0.33: an adopted jam already sent a pane id, and a pane id IS the target.
    const child = spawn(TMUX, [...tmuxSocketArgs(SOCKET), 'attach', '-t', attachTarget(session)],
      { stdio: 'inherit', env });
    let over = false;
    const finish = (problem) => {
      if (over) return;
      over = true;
      store.attached = false;
      process.stdin.resume();
      // v0.28: nothing to re-feed. tmux drew on the alternate screen and gave the normal one
      // back untouched, so the whole transcript is exactly where it was — which is what the
      // 40-line ATTACH_KEEP tail, and the README ceiling that named it, existed to paper over.
      if (problem) err(problem);
      else sys('back from the TUI');
      // The window is the size the departing tmux client made it: put the host's own back
      // BEFORE the frames start again, so the first one is already the right shape.
      sendResize(true);
      if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'mirror', on: store.mirror }));
      done();
    };
    child.on('error', (e) => finish(`could not run ${tmuxAttachLine(SOCKET, session, attachTarget(session))}: ${e.message}`));
    child.on('exit', (code) => finish(code ? `${tmuxAttachLine(SOCKET, session, attachTarget(session))} exited ${code}` : null));
  });
}

function togglePassthrough(on) {
  const next = on ?? !store.passthrough;
  if (next === store.passthrough) return;
  if (next && !IS_HOST) return err('F3 TUI control is the host\'s — ask them, or send a /command for approval');
  store.passthrough = next;
  if (next) toggleMirror(true);
  // Ordinary system line: it shows in the chat strip now and lands in the transcript in the
  // order it happened. The status and input rows are what actually announce TUI control.
  sys(next ? 'TUI control ON — every key goes to claude\'s screen (Ctrl-C too). F3 hands it back.'
    : 'TUI control off — typing goes to the jam again.');
  touch();
}

// -------------------------------------- v0.28: which screen buffer each view owns ----
// The mirror renders in the terminal's ALTERNATE screen (`\x1b[?1049h`), exactly as less, vim
// and tmux do; the transcript owns the NORMAL one. That is the whole of Roy's "flipping views
// churns my scrollback": ink reprints its entire <Static> log — after `\x1b[3J`, which clears
// the scrollback — whenever its live region grows as tall as the terminal, and a full-screen
// mirror frame is exactly that tall. In the alternate buffer there is no scrollback to lose and
// no <Static> at all, so the reprint cannot happen and the transcript is never touched.
//
// ONE ink instance per buffer: <Static>'s index only ever moves forward, so the way to have it
// print into a different buffer is to mount again. Hence the invariant this file now keeps —
// `store.entries` is what has NOT yet been written to the terminal, ink's final render on
// unmount writes it, and it is emptied immediately afterwards. Anything arriving while the
// mirror is up waits in `store.deferred` and is flushed on the way back.
let pendingScreen = null; // 'alt' | 'normal': a view flip waiting for the unmount

const writeOut = (s2) => { try { process.stdout.write(s2); } catch { /* stdout closed */ } };

// Erase ink's live region, then unmount. clear() makes unmount's own final render a no-op for
// the dynamic rows (the output is unchanged, so ink writes nothing) while still letting it flush
// any <Static> item it had not written — which is why emptying `entries` here is safe.
function unmountFlush() {
  try { app?.clear(); } catch { /* never mounted */ }
  try { app?.unmount(); } catch { /* never mounted, or already gone */ }
  store.entries = [];
}

// A line that belongs OVER the mirror as well as in the transcript — `toTranscript` is what
// marks it as a notice (see emit), and this is the two-line spelling of that.
function overMirror(text) { toTranscript++; sys(text); toTranscript--; }

let hintedF2 = false;
function applyScreen(alt) {
  store.mirror = alt;
  store.alt = alt;
  writeOut(alt ? SMCUP : RMCUP);
  // v0.28 and the one thing the alternate screen costs: the connect block is printed to the
  // NORMAL buffer (so it is in this terminal's scrollback for good) and the mirror then covers
  // it. A first-time guest would otherwise lose the block that teaches them F2 exists — which is
  // the v0.10c complaint, in a new costume — so one row says where it went. Once per client.
  if (alt && !hintedF2) {
    hintedF2 = true;
    overMirror('the welcome block, the keys and the history are in the transcript — F2 shows it · /help reprints the keys');
  }
  // Coming back to the normal buffer: everything that arrived while the mirror was up is
  // flushed into the transcript, in order, and the fresh mount prints exactly those rows under
  // what is already in the terminal's scrollback. Nothing is reprinted and nothing is lost.
  if (!alt) { store.entries = [...store.entries, ...store.deferred]; store.deferred = []; }
}

// Deferred by a tick for the same reason leave() is: `/mirror` reaches here from inside a React
// event handler, and unmounting the reconciler mid-commit wedges it instead of exiting. By the
// time an immediate runs, React has committed whatever touch() queued, so the final render on
// unmount is writing the CURRENT transcript and not one line behind it.
function switchScreen(alt) {
  if (alt === store.alt) return;
  pendingScreen = alt ? 'alt' : 'normal';
  setImmediate(unmountFlush);
}

// The one place that puts the terminal back the way it was found. Called on the way out, on a
// signal, and on an uncaught error — a client killed while the mirror is up must never leave a
// human staring at an alternate screen with no shell in it.
function restoreScreen() {
  if (!store.alt) return;
  store.alt = false;
  // fs.writeSync, not process.stdout.write: this runs from a `process.on('exit')` handler too,
  // where an async write would never be flushed.
  try { fs.writeSync(1, RMCUP); } catch { /* the terminal is already gone */ }
}

// v0.7/v0.14: flip between the live TUI (the default view) and the transcript. F2 and
// `/mirror` are the same call; going back to the transcript flushes everything that arrived
// while the mirror was up, in order, so nothing is lost.
// v0.28: `store.mirror` is flipped by applyScreen rather than here, so the view and the buffer
// it lives in can never disagree — a mirror frame painted into the normal buffer would be
// exactly the scrollback churn this version removes.
function toggleMirror(on) {
  const next = on ?? !store.mirror;
  if (next === store.mirror) return;
  sendMsg({ t: 'mirror', on: next });
  if (next) { store.frame = null; setScroll(0); }
  else sys('transcript — F2 goes back to the live TUI');
  switchScreen(next);
  touch();
}

// ------------------------------------ v0.28: scrolling the mirror back ----
// The mirror used to be the CURRENT screen and nothing else, so a guest could not scroll back
// through the real TUI at all. PgUp/PgDn (Shift+↑/↓ a line at a time, the wheel if the terminal
// sends it) ask the daemon for the claude pane's own history; End, G or Esc comes back to live.
// A guest gets this exactly as the host does — it is a read of a screen they are already
// watching, and being unable to look back was the complaint.

// Rows the mirror region actually has. The same arithmetic fitFrame uses, so a page is one
// screenful and PgUp lands where a reader expects it to.
const mirrorRows = () => Math.max(4, Math.min((process.stdout.rows || 24) - MIRROR_CHROME, SCREEN_PAGE_MAX));

function askHistory() {
  if (ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ t: 'screen-history', before: store.scroll.before, rows: mirrorRows() }));
}

// One place decides what the scroll state is, so "back to live" cannot be half-done: the held
// page, the paused count and the at-top flag all go together.
function setScroll(before) {
  const n = Math.max(0, Math.floor(Number(before)) || 0);
  if (n === store.scroll.before && (n || !store.scroll.rows.length)) return;
  if (!n) {
    store.scroll = { ...store.scroll, before: 0, rows: [], paused: 0, atTop: false };
    return touch();
  }
  store.scroll = { ...store.scroll, before: n };
  askHistory();
  touch();
}

// Every scroll key, in one handler. Nothing happens outside the mirror view (the transcript is
// the terminal's own scrollback and belongs to the terminal) or while the TUI has the keyboard.
const SCROLL_BY = {
  pageup: 'pageup', pagedown: 'pagedown', lineup: 'lineup', linedown: 'linedown',
  wheelup: 'lineup', wheeldown: 'linedown', scrolltop: 'top', scrolllive: 'live',
};
function onScrollKey(name) {
  if (!store.mirror || store.passthrough || store.menu) return;
  const step = name === 'wheelup' || name === 'wheeldown' ? WHEEL_LINES : mirrorRows();
  // Until the daemon has answered once, the ceiling is the protocol's — otherwise the very
  // first PgUp would clamp against a maxBefore of 0 and do nothing at all.
  const maxBefore = store.scroll.maxBefore || SCREEN_HISTORY_MAX;
  setScroll(scrollStep({ key: SCROLL_BY[name], before: store.scroll.before, page: step, maxBefore }));
}

// `G` and `End` return to live, and so does Esc — but only while the input line is empty, the
// same rule the v0.16 approval bar's single keys already live under, so typing a capital G in a
// message is still typing a capital G.
function scrollKeys(text) {
  if (!store.scroll.before || store.input !== '' || store.passthrough) return text;
  let rest = '';
  let back = false;
  for (const ch of String(text)) {
    if (ch === 'G' || ch === 'g' || ch === '\x1b') back = true;
    else rest += ch;
  }
  if (back) setScroll(0);
  return rest;
}

// Registered once, outside React: a scroll key means the same thing whatever is being typed,
// and re-subscribing them on every keystroke (which is what the input-dependent effect below
// would do) is eight listeners of churn per character.
for (const k of Object.keys(SCROLL_BY)) keys.on(k, () => onScrollKey(k));

// ----------------------------------------------- v0.16: the approval bar ----
// Every pending request raises one row above the status row, and while nothing is typed a
// single key answers it. The daemon's `pending` frame is the only source of truth: an answer
// from anywhere — another host client, the tmux popup, an expiry — takes the bar down on the
// next push, and a late key is a harmless 404 in the ladder.

// Identity of one request, for "which bar did I dismiss".
const reqKey = (it) => (it ? `${it.kind}:${it.name}:${it.expires}` : '');
const barHidden = () => !!store.hiddenKey && store.hiddenKey === reqKey(store.pending[0]);
// Single keys are live only while the host has a bar on screen and the input line is empty and
// nothing has been typed since the bar appeared. All three, so the bar never offers a key that
// would not fire: clearing the line back to empty does not re-arm on its own — Esc does.
const barArmed = () => store.armed && !barHidden() && store.input === '';

// One key = the command the host would have typed, run through submit(). That is the whole
// point: the bar is not a second approval mechanism, it is a keyboard shortcut for the
// existing one (APPROVAL_COMMANDS in lib.mjs maps kind -> command).
function answerBar(ok) {
  const it = store.pending[0];
  const cmd = it && APPROVAL_COMMANDS[it.kind]?.[ok ? 'allow' : 'deny'];
  if (!cmd) return;
  submit(`${cmd} ${it.name}`);
}

// A stdin chunk while a request is waiting. Returns whatever still has to reach the input.
function barKeys(text) {
  if (!IS_HOST || !store.pending.length) return text;
  const { act, text: rest } = barKeyAction(text, { armed: barArmed(), input: store.input });
  switch (act) {
    case 'accept': answerBar(true); break;
    case 'deny': answerBar(false); break;
    // Dismissed, not answered: the request keeps waiting for a slash command or a popup.
    case 'ignore': store.hiddenKey = reqKey(store.pending[0]); touch(); break;
    case 'rearm': store.armed = true; store.hiddenKey = null; touch(); break;
    case 'disarm': if (store.armed) { store.armed = false; touch(); } break;
    default: break;
  }
  return rest;
}

// ------------------------------------------ v0.12/v0.13: the export and files ----
// A finished incoming transfer: write it, say where it went, and — for an export — print the
// recipe that revives it. Forced into the transcript (`toTranscript`) so it is readable while
// the live TUI fills the screen: nobody wants their instructions hidden behind an F2.
function saveIncoming(rec) {
  toTranscript++;
  try {
    const file = saveXfer(rec);
    sys(`saved ${file} (${humanBytes(rec.data.length)})`);
    if (rec.kind === 'export') {
      for (const l of resumeInstructions(rec.session, file, process.cwd())) {
        emit({ text: l, textColor: C.dim, wrap: false, bare: true });
      }
    }
  } catch (e) { err(`could not save the transfer: ${e.message}`); }
  toTranscript--;
}

// `/send <path>`: the host OFFERS the file to everyone (each guest pulls it with `/get`); a
// guest UPLOADS it, and the host has to accept before a byte moves.
function doSend(p) {
  if (IS_HOST) return sendMsg({ t: 'offer', path: p });
  let file;
  try { file = readForUpload(p); } catch (e) { return err(e.message); }
  stageUpload(file.name, file.data, '');
}

// `/paste`: the clipboard's image, the same upload path — for the host too, since a clipboard
// image has no path claude could be pointed at instead.
function doPaste(caption) {
  let img;
  try { img = clipboardImage(); } catch (e) { return err(e.message); }
  stageUpload(img.name, img.data, caption);
}

function stageUpload(name, data, caption) {
  store.upload = { name, data, caption };
  sendMsg({ t: 'upload', name, size: data.length, caption: caption || undefined });
  if (!IS_HOST) sys(`${name} (${humanBytes(data.length)}) — waiting for the host to accept it`);
}

// The grant names the file it is for, so a stale buffer (an earlier `/send` the host refused)
// can never go out under a later approval.
function sendUpload(ev) {
  const up = store.upload;
  if (!up) return err('a file was approved that I am no longer holding — /send it again');
  if (ev.name && ev.name !== up.name) return err(`${ev.name} was approved, but I am holding ${up.name}`);
  store.upload = null;
  sys(`sending ${up.name} (${humanBytes(up.data.length)})…`);
  pumpFrames(xferFrames(ev.xfer, up.data), (f) => sendMsg(f), () => ws?.readyState === 1);
}

// One submitted input row. Identical dispatch to the readline client, including the
// continuation buffer: a trailing `\` collects, the first line without one flushes.
function submit(raw) {
  rememberInput(raw); // v0.30-3: before anything else — even a line that turns out to be a typo
  localActivity();    // v0.26: a submit is activity even when the line turns out to be a command
  // v0.18-4: /end asked "really end this jam for everyone?", and this is the answer — taken
  // before anything is parsed, so a bare `y` can never become a message to claude. v0.22C adds
  // the second question of the same shape: revoke the link of the person you just kicked?
  if (store.confirm) {
    const q = store.confirm;
    store.confirm = null;
    const yes = confirmYes(raw);
    if (q.kind === 'end') {
      if (yes) { sendMsg({ t: 'end' }); sys('ending the jam for everyone…'); }
      else sys('nothing ended — the jam is still running');
    } else if (q.kind === 'revoke') {
      if (yes) sendMsg({ t: 'invite', op: 'revoke', target: q.name });
      else sys(`${q.name}'s invite link still works — /invite revoke ${q.name} takes it back later`);
    }
    return touch();
  }
  const a = parseClientLine(raw);
  if (a.kind === 'continue') { store.cont.push(a.text); return touch(); }
  const act = store.cont.length ? parseClientLine([...store.cont, raw].join('\n')) : a;
  store.cont = [];
  switch (act.kind) {
    case 'say':
      sendMsg({ t: 'say', text: act.text });
      // v0.15: paint it here, now. In the mirror view the only proof a message went anywhere
      // used to be the claude pane repainting, up to a frame away — long enough for a guest
      // to press Enter twice. Cleared by the daemon's own broadcast of the same line.
      store.echo = { text: act.text, at: Date.now(), acked: false };
      break;
    case 'chat': sendMsg({ t: 'chat', text: act.text }); break;
    // v0.26: the roster, with how long since each person last touched a key — which is what
    // makes a nudge purposeful instead of guesswork. The map arrives on the welcome and on
    // every roster frame; a daemon older than this sends none, and `idle unknown` says so.
    case 'who': sys(whoReport(store.roster, store.idle, { self: NAME })); break;
    case 'help': logOnboarding(); break;
    case 'mirror': toggleMirror(); break;
    // v0.28: further back than the replay you were given. It is a TRANSCRIPT command, so it
    // takes you to the transcript — printing history into an alternate screen that the next F2
    // throws away would be a strange way to answer "show me more".
    case 'history':
      toggleMirror(false);
      sendMsg({ t: 'history', n: act.n, before: store.oldestId ?? undefined });
      break;
    case 'tools':
      if (act.op) {
        store.toolsExpanded = act.op === 'on';
        if (store.toolsExpanded && store.tools.length) { const t = store.tools; store.tools = []; for (const x of t) emitTool(x); }
        sys(`tool lines ${store.toolsExpanded ? 'always expanded' : 'collapsed to one summary line per turn'}`);
      } else if (store.lastTools.length) {
        sys(`last turn's tools (${store.lastTools.filter((t) => t.kind === 'tool').length}):`);
        for (const t of store.lastTools) emitTool(t);
      } else sys('no completed tool calls yet');
      break;
    case 'join':
      if (!IS_HOST) err('host only');
      else if (!store.session) sys('not connected yet');
      else logJoin();
      break;
    case 'accept':
    case 'deny':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'admit', name: act.name || undefined, ok: act.kind === 'accept' });
      break;
    // v0.14: answering a guest's /command request. v0.12/v0.13: the same ladder for the
    // transcript and for a file — the daemon enforces host+loopback on all three.
    case 'cmd':
    case 'export-ok':
    case 'file-ok':
      if (!IS_HOST) err('host only');
      else {
        const t = { cmd: 'cmd', 'export-ok': 'exportok', 'file-ok': 'fileok' }[act.kind];
        sendMsg({ t, op: act.op, name: act.name || undefined, always: act.always });
      }
      break;
    // v0.12: ask for the session transcript (the host is asked first, unless it IS the host).
    case 'export':
      sendMsg({ t: 'export' });
      if (!IS_HOST) sys('asked the host for the session transcript…');
      break;
    // v0.13: a file out (host: an offer; guest: an upload the host must accept), the
    // clipboard's image, and taking something the host offered.
    case 'send': doSend(act.path); break;
    case 'paste': doPaste(act.caption); break;
    case 'get': sendMsg({ t: 'get', name: act.name || undefined }); break;
    // v0.17 F2/F3: only the daemon has the transcript and the cwd, so both are its answer to
    // give. `/files` comes back to this client alone; `/diff` is broadcast to everyone.
    case 'files': sendMsg({ t: 'files' }); break;
    case 'diff': sendMsg({ t: 'diff', path: act.path || undefined }); break;
    // v0.17 P2: only the daemon can see claude's screen, so it reads the options and it does the
    // typing; this end sends a digit and waits. A bare `/answer` just asks what the options are.
    case 'perm': {
      sendMsg({ t: 'perm', choice: act.choice ?? undefined, q: act.q ?? undefined, text: act.text ?? undefined });
      // v0.31: whether this goes straight through or to the host depends on what the pane is
      // showing, which the daemon decides — so say what will happen rather than guessing.
      const kind = store.status.prompt?.kind || 'none';
      const gated = !IS_HOST && (kind !== 'question' || act.choice === 'other' || store.status.answers === 'host');
      if (act.choice != null && gated) sys(`asked the host to answer ${act.choice} — nothing is typed until they say yes`);
      break;
    }
    // v0.30: what the daemon kept when it could not confirm a message reached claude.
    case 'outbox':
      sendMsg({ t: 'outbox', op: act.op });
      break;
    case 'perm-ok':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'permok', op: act.op, name: act.name || undefined, always: act.always });
      break;
    case 'token':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'token', op: act.op, value: act.value });
      break;
    // v0.14: not a jam command, so it is one of claude's. The host's client types it into
    // the real TUI; a guest's goes to the host for approval (the daemon decides — this
    // client's `--host` flag is a label, not a permission).
    case 'slash':
      sendMsg({ t: 'slash', text: act.text });
      if (!IS_HOST) sys(`${act.text} — sent to the host for approval`);
      break;
    // v0.18-4: end the whole jam. Host-only here and in the daemon, and it asks first —
    // this is the one jam command that takes the session away from everybody.
    case 'end':
      if (!IS_HOST) err('host only');
      else { store.confirm = { kind: 'end' }; sys('really end this jam for everyone? [y/N]'); }
      break;
    // v0.22B: mint a link, list them, take one back. Host-only here and in the daemon — a link
    // joins as that name with no approval, so it is a credential this client hands out.
    case 'invite':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'invite', op: act.op, name: act.name, maxUses: act.maxUses, ttl: act.ttl, target: act.target });
      break;
    case 'invites':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'invites' });
      break;
    // v0.22C: remove somebody who is already in. The daemon closes their socket; the offer to
    // revoke their link comes back on the `kick` frame.
    case 'kick':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'kick', name: act.name, revoke: act.revoke });
      break;
    // v0.24: the live control panel. Everything it offers is one of the cases above — it opens
    // an overlay, it never becomes a second way to do any of them.
    case 'menu':
      store.menu = { path: [], at: 0 };
      if (IS_HOST) { sendMsg({ t: 'grants' }); sendMsg({ t: 'remote' }); }
      break;
    // v0.24.1: off | tunnel | funnel while the jam runs. A bare `/remote` asks what is possible.
    case 'remote':
      if (!IS_HOST) err('host only');
      else if (act.mode == null) { sendMsg({ t: 'remote' }); sys(`remote: ${store.session?.remote || 'off'} — /remote ${REMOTE_MODES.join(' | ')}`); }
      else { store.remoteBusy = true; sys(`switching remote to ${act.mode}…`); sendMsg({ t: 'remote', mode: act.mode, reissue: act.reissue === true }); }
      break;
    // v0.26: get somebody to look at their screen. Anyone may send one — the daemon validates
    // the target, rate-limits it and answers with the refusal if there is one, so there is
    // nothing to check here that would only be checked twice and drift.
    case 'ping':
      sendMsg({ t: 'nudge', to: act.to, text: act.text, escalate: act.escalate });
      break;
    // v0.25: the keyboard-only half of /menu → Notifications. Bare `/sound` reports rather than
    // guessing which way you meant.
    case 'sound': {
      if (act.on != null) store.notify = { ...store.notify, sound: act.on };
      const p = notifyPrefs(store.notify);
      sys(`sound ${p.sound ? 'on' : 'off'} · notification ${p.notification ? 'on' : 'off'} · `
        + `bell ${p.bell ? 'on' : 'off'}${jamConfig.ntfy ? ' · phone configured' : ''}`
        + ' — /menu → Notifications switches each one');
      break;
    }
    case 'quit': return leave(0);
    case 'error': err(act.text); break;
    default: break;
  }
  touch();
}

// --------------------------------------------------------------- rendering ----
function useStore() {
  const [, bump] = React.useState(0);
  React.useEffect(() => {
    const l = () => bump((v) => v + 1);
    store.listeners.add(l);
    return () => { store.listeners.delete(l); };
  }, []);
  return store;
}

function Entry({ e }) {
  const gutter = e.labelW + 2 + (e.glyph ? 1 : 0); // '[Label]' + pad + space [+ glyph] + space
  const body = e.md ? e.text.split('\n').map(mdLite).join('\n') : e.text;
  // The block gap is a row of the entry itself, so it flushes with it and can never end up
  // separated from the line it belongs to. A single space, not '': ink measures an empty
  // Text as zero rows and the blank line disappears.
  const gap = e.gap ? h(Text, null, ' ') : null;
  if (e.bare) {
    return h(Box, { flexDirection: 'column' }, gap,
      h(Box, { width: NO_WRAP_W, flexShrink: 0 }, h(Text, { color: e.textColor }, body)));
  }
  return h(Box, { flexDirection: 'column' }, gap,
    h(Box, null,
      h(Box, { width: gutter, flexShrink: 0 },
        h(Text, { color: e.color, wrap: 'truncate' }, e.label),
        e.glyph
          ? h(Text, { color: e.glyphColor }, `${' '.repeat(Math.max(0, e.labelW - e.label.length) + 1)}${e.glyph}`)
          : null),
      // wrap:false keeps a join command or a URL on one logical line: an oversized Box means
      // ink adds no newline of its own and the terminal's soft wrap leaves it selectable.
      h(Box, e.wrap ? { width: Math.max(24, e.cols - gutter - 1) } : { width: NO_WRAP_W, flexShrink: 0 },
        h(Text, { color: e.textColor }, body))));
}

// v0.7: the host pane's own cells. Each row is printed verbatim (SGR intact, truncated
// ANSI-aware by ink) — no colors of our own, or they would fight the captured ones.
// `reserve` is rows something else below has taken this render (v0.17 P6's hint row): the frame
// gives one up rather than pushing the status and input rows off the bottom of the screen.
function Mirror({ frame, scroll, reserve = 0 }) {
  const cols = process.stdout.columns || 80;
  // v0.28: while scrolled, the page of the host pane's REAL history stands in for the live
  // frame. Same rows, same renderer, same truncation — it IS the same screen, further back.
  const back = scroll?.before ? { rows: scroll.rows, w: scroll.w, h: scroll.h } : null;
  if (!back && !frame) return h(Text, { color: C.dim }, 'waiting for the host\'s screen…');
  if (back && !back.rows.length) return h(Text, { color: C.dim }, 'reading the host\'s scrollback…');
  const fit = fitFrame(back || frame, cols, (process.stdout.rows || 24) - reserve);
  const hints = [
    fit.wider ? `host pane is ${(back || frame).w} cols wide, yours is ${cols}` : '',
    // While scrolled the page is exactly one screenful, so a crop notice there would be about
    // the page rather than about the pane and would read as a second, invented limit.
    !back && fit.croppedRows ? `${fit.croppedRows} row(s) above cut off` : '',
    back && scroll.atTop ? 'this is the oldest line the host\'s pane still has' : '',
  ].filter(Boolean).join(' · ');
  return h(Box, { flexDirection: 'column' },
    fit.rows.map((r, i) => h(Text, { key: i, wrap: 'truncate' }, r === '' ? ' ' : r)),
    hints ? h(Text, { color: C.dim }, `— mirror: ${hints}`) : null);
}

// v0.28: a block that MUST be seen while the mirror owns the screen — the invite lines, the
// resume recipe after an export. It is in the transcript too (see emit); this is the alternate
// screen's copy of it, and it steps aside after NOTICE_TTL.
function Notice({ items }) {
  if (!items.length) return null;
  return h(Box, { flexDirection: 'column' },
    items.map((e) => h(Entry, { key: `notice-${e.key}`, e: { ...e, gap: false } })));
}

// v0.16: one row, right above the status row, worded exactly like the tmux popup it stands in
// for — kind glyph, who, what, the keys, and a countdown to that request's own expiry.
function ApprovalBar({ items, armed, now }) {
  const bar = approvalBar(items, now, armed);
  if (!bar) return null;
  return h(Box, null, h(Text, { color: C.accent, wrap: 'truncate' }, bar.text));
}

// v0.31-2: the question itself, not just the fact that one exists — and in every client, in both
// views. A guest in the transcript view could see `⚠` and nothing else; now they see what is being
// asked, the numbered options, and the command that answers it. Drawn from the daemon's
// classification of the live pane, so it disappears the moment the picker does.
// The rows it will take, so the mirror can give them up rather than push the input row off the
// bottom of the screen. Same shape as the `hints` row's own reserve.
const questionText = (status) => questionBlock(status.prompt, { answers: status.answers, host: IS_HOST });

function QuestionBlock({ text }) {
  if (!text) return null;
  return h(Box, { flexDirection: 'column' },
    text.split('\n').map((line, i) => h(Text, {
      key: `q-${i}`,
      color: i === 0 ? C.accent : C.dim,
      bold: i === 0,
      wrap: 'truncate',
    }, line)));
}

function StatusBar({ status, typing, spin, mirror, passthrough, net, scroll }) {
  const now = Date.now();
  const who = [...typing.entries()].filter(([, at]) => now - at < 4000).map(([n]) => n);
  // v0.17 P5: who is typing, and how this connection is doing — both dim, on the right.
  const right = [
    who.length ? `${who.join(', ')} ${who.length > 1 ? 'are' : 'is'} typing…` : '',
    rttText(net, now, net?.heartbeat),
  ].filter(Boolean).join('  ·  ');
  // Which view you are in is always on screen: the mirror IS the default (v0.14), so the
  // chip's job is to make the F2 alternate discoverable long after the onboarding block
  // has scrolled away.
  // v0.28: while the mirror is scrolled back, the chip says so, says how far, says how many live
  // frames are being held for you, and says the key that ends it. Everything else on the row is
  // about the live screen and would be a lie about the one being read.
  const scrolled = mirror ? scrollStatusText(scroll || {}) : '';
  const view = mirror ? '⧉ live TUI' : '≡ transcript';
  if (scrolled) {
    return h(Box, { minHeight: 1 },
      h(Box, { flexGrow: 1 }, h(Text, { color: C.accent, wrap: 'truncate' }, scrolled)),
      right ? h(Text, { color: C.dim }, right) : null);
  }
  // v0.31: ONE source for this row — the daemon's classification of the pane. A permission still
  // says F3 (and now names the tool); a question says what claude is asking and that /answer
  // takes it; a dialog says the host is needed at the keyboard. Nothing on the pane is an empty
  // string, which is what makes a stale ⚠ impossible.
  // v0.20: F3 is bound to detach-client on jam's own tmux server, so the key that goes in is
  // also the key that comes out. Ctrl-b d still works and stays named for anyone whose host runs
  // with `--tmux-socket default`, where the bare binding is deliberately skipped.
  const waiting = promptStatusText(status.prompt, { host: IS_HOST, answers: status.answers });
  return h(Box, { minHeight: 1 },
    h(Box, { flexGrow: 1 },
      passthrough
        ? h(Text, { color: C.accent }, '⌨ TUI control — F3 returns')
        : h(React.Fragment, null,
          h(Text, { color: C.dimmer }, `${view}  `),
          status.busy ? h(Text, { color: C.accent }, `${SPIN[spin]} claude is working…`) : null,
          status.busy && waiting ? h(Text, { color: C.dim }, ' · ') : null,
          waiting ? h(Text, { color: C.accent, wrap: 'truncate' }, waiting) : null)),
    right ? h(Text, { color: C.dim }, right) : null);
}

// ------------------------------------------------- v0.24: /menu, the control panel ----
// Ink overlay over menuTree() (lib.mjs), which is the same data the completeness test walks —
// so a feature that is not in here fails the suite. EVERY action maps to a command that already
// exists: a leaf either submits its `/command` (when the command means something on its own) or
// puts it on the input line ready for its argument. The menu is discoverability, never a second
// implementation of anything.
const HERE_DIR = path.dirname(new URL(import.meta.url).pathname);

function manualLines() {
  try { return fs.readFileSync(path.join(HERE_DIR, MANUAL_FILE), 'utf8').split('\n'); }
  catch (e) { return [`could not read ${MANUAL_FILE}: ${e.message}`]; }
}

// Where the cursor is, as a path of ids from the tree root. Resolved fresh on every render, so
// the panel shows live state (who is here, what is pending, which relay is up) rather than a
// snapshot taken when it opened.
function nodeAt(tree, path) {
  let items = tree.sections;
  let node = tree;
  for (const id of path) {
    const hit = (items || []).find((i) => i.id === id);
    if (!hit) break;
    node = hit;
    items = hit.items;
  }
  return { node, items: items || [] };
}

function Pager({ lines, title, onClose }) {
  const rows = Math.max(6, (process.stdout.rows || 24) - 6);
  const [top, setTop] = React.useState(0);
  const max = Math.max(0, lines.length - rows);
  useInput((input, key) => {
    if (key.escape || input === 'q') return onClose();
    if (key.downArrow) return setTop((t) => Math.min(max, t + 1));
    if (key.upArrow) return setTop((t) => Math.max(0, t - 1));
    if (key.pageDown || input === ' ') return setTop((t) => Math.min(max, t + rows));
    if (key.pageUp || input === 'b') return setTop((t) => Math.max(0, t - rows));
    if (input === 'g') return setTop(0);
    if (input === 'G') return setTop(max);
  });
  return h(Box, { flexDirection: 'column' },
    h(Text, { color: C.accent, bold: true }, `── ${title} — ${top + 1}-${Math.min(lines.length, top + rows)} of ${lines.length} `),
    ...lines.slice(top, top + rows).map((l, i) => h(Text, { key: i, wrap: 'truncate', color: /^#/.test(l) ? C.accent : undefined }, l === '' ? ' ' : l)),
    h(Text, { color: C.dim }, '↑↓ / space / b · g top · G end · Esc closes'));
}

function Menu({ s }) {
  const [pager, setPager] = React.useState(null);
  const tree = menuTree({
    host: IS_HOST,
    state: {
      roster: s.roster, pending: s.pending, grants: s.grants,
      token: s.session?.token, inviteOnly: s.session?.inviteOnly, view: s.session?.view,
      remote: s.session?.remote, tunnelJoin: s.session?.tunnelJoin, replay: s.session?.replay,
      // v0.28: what the ring keeps, next to what a joiner is shown — two different numbers, and
      // a host needs both to answer "why can I only see this much".
      history: s.session?.history,
      // v0.23: the panel names the jam it belongs to, and the announce row shows whether the
      // LAN is actually being told — not merely whether it was asked for.
      jamName: s.session?.jamName, announce: s.session?.announce,
      // v0.25/v0.26: this client's own tiers, who is idle, and whether a phone is configured.
      // `ntfy` is a boolean and never the topic — the panel says "configured", never what.
      notify: s.notify, idle: s.idle, ntfy: !!jamConfig.ntfy,
      // v0.27: the two policies and what the session has spent, off the token frame.
      uploads: s.session?.uploads, exportPolicy: s.session?.exportPolicy,
      uploadQuota: s.session?.uploadQuota, uploadUsed: s.session?.uploadUsed,
    },
  });
  const here = nodeAt(tree, s.menu.path);
  const close = () => { store.menu = null; touch(); };
  const up = () => { store.menu = { path: s.menu.path.slice(0, -1), at: 0 }; touch(); };
  const down = (id) => { store.menu = { path: [...s.menu.path, id], at: 0 }; touch(); };
  const runCmd = (cmd) => { close(); if (menuRunsBare(cmd)) submit(cmd); else { store.input = cmd + ' '; setInputExternal(cmd + ' '); } };
  const say = (lines) => { close(); toTranscript++; for (const l of [].concat(lines)) sys(l); toTranscript--; };

  useInput((input, key) => {
    if (pager) return;
    if (key.escape) return s.menu.path.length ? up() : close();
  }, { isActive: !pager });

  if (pager) return h(Pager, { lines: pager.lines, title: pager.title, onClose: () => setPager(null) });

  // The special rows: everything that is not simply "run this command".
  const act = (item) => {
    if (item.items) return down(item.id);
    switch (item.id) {
      case 'help.manual': return setPager({ title: `${MANUAL_FILE} — the same text claude is given`, lines: manualLines() });
      case 'help.keys': return say(['keyboard:', ...KEY_HELP.map((k) => `  ${k.key.padEnd(12)} ${k.desc}`)]);
      case 'help.wiki': return say(['wiki: https://github.com/roypadina/claude-jam/wiki',
        ...WIKI_PAGES.map((w) => `  ${w}`)]);
      case 'session.attach': return IS_HOST ? (close(), onF3()) : say('F3 attaches the real TUI, and it is the host\'s key');
      case 'session.replay': return say(`replay: ${s.session?.replay ?? '?'} events of the transcript are shown to a joining guest (--replay at launch)`);
      case 'session.depth': return say(`this jam keeps ${s.session?.history ?? '?'} events (--history at launch); `
        + `${s.kept} are held right now — /history [n|all] prints further back, /export is the complete record`);
      case 'session.scroll': return say('in the live TUI: PgUp/PgDn page through the host\'s real pane history, '
        + `Shift+↑/↓ move a line, End or G returns to live (${SCREEN_HISTORY_MAX} lines back at most)`);
      case 'people.pending': return say(s.pending.length
        ? [`${s.pending.length} waiting:`, ...s.pending.map((p) => `  ${p.kind} from ${p.name}${p.detail ? ` — ${p.detail}` : ''}`),
          '  answer with a / d on the bar, or the /allow-… command on the line']
        : 'nothing is waiting for you');
      case 'people.grants': return down('people.grants');
      case 'invites.copy': {
        if (!s.lastLink) return say('no link has been minted in this client yet — Invites → Create a link');
        const ok = copyText(`${clientCmdName()} ${s.lastLink.link}`);
        return say(ok ? `copied ${s.lastLink.name}'s invite command — send it privately, it is a password`
          : `clipboard not available — the link is in the log above (${s.lastLink.name})`);
      }
      case 'invites.revoke': return runCmd('/invite revoke');
      case 'invites.reissue': return down('access.remote');
      case 'access.inviteonly': return runCmd(`/token invite-only ${s.session?.inviteOnly ? 'off' : 'on'}`);
      case 'access.view': { close(); sendMsg({ t: 'view', on: !s.session?.view }); return sys(`asking the daemon to turn the browser view ${s.session?.view ? 'off' : 'on'}…`); }
      // v0.23: the same shape as the view toggle — flip the boolean this client currently holds,
      // let the daemon do it, and let it answer on the `token` frame that carries the state.
      case 'access.announce': {
        const on = !s.session?.announce?.on;
        close();
        sendMsg({ t: 'announce', on });
        return sys(on
          ? 'asking the daemon to announce this jam on the local network…'
          : 'asking the daemon to stop announcing this jam on the local network…');
      }
      case 'access.remote': return down('access.remote');
      // v0.27: three-way toggles, cycled in place. The daemon owns the value and answers on the
      // token frame, exactly like the view and announce toggles above — the client never holds a
      // second copy of the truth.
      case 'access.uploads':
      case 'access.export': {
        const kind = item.id === 'access.export' ? 'export' : 'uploads';
        const now = uploadPolicy(kind === 'export' ? s.session?.exportPolicy : s.session?.uploads);
        const mode = UPLOAD_POLICIES[(UPLOAD_POLICIES.indexOf(now) + 1) % UPLOAD_POLICIES.length];
        close();
        sendMsg({ t: 'policy', kind, mode });
        return sys(`asking the daemon for ${kind}: ${mode}…`);
      }
      case 'access.quota': { close(); sendMsg({ t: 'policy', kind: 'quota-reset' }); return; }
      // v0.25/v0.26: the three tiers are THIS client's, so they flip here and go nowhere near
      // the wire. The phone row is read-only on purpose — the topic is a secret, and a panel
      // that could set it would be a panel that could show it.
      case 'notify.sound':
      case 'notify.notification':
      case 'notify.bell': {
        const k = item.id.slice('notify.'.length);
        store.notify = { ...notifyPrefs(store.notify), [k]: !notifyPrefs(store.notify)[k] };
        touch();
        return say(`${item.label.toLowerCase()} ${notifyPrefs(store.notify)[k] ? 'on' : 'off'}`);
      }
      case 'notify.phone': return say(jamConfig.ntfy
        ? ['phone: configured — a nudge addressed to you is POSTed by THIS client to YOUR topic.',
          `  the topic lives only in ${CONFIG_FILE} in your own config dir; it never reaches the host,`,
          '  an invite link, the protocol or any log — and nothing here will print it.']
        : ['phone: off. To turn it on, put this in ~/.config/claude-jam/config.json:',
          '  { "ntfy": { "server": "https://ntfy.sh", "topic": "<a long random word only you know>" } }',
          `  ${jamConfig.ok ? 'then restart this client.' : `(the file there now is unusable: ${jamConfig.why})`}`]);
      default: return item.run ? runCmd(item.run) : say(item.desc || 'nothing to do here');
    }
  };

  // ---- the two hand-written sub-panels: the relay switch and the standing grants ----
  if (s.menu.path.at(-1) === 'access.remote') {
    if (s.remoteBusy) {
      return h(Box, { flexDirection: 'column' },
        h(Text, { color: C.accent, bold: true }, '── Access · Remote '),
        h(Spinner, { label: 'starting the relay and waiting for its hostname…' }));
    }
    const rows = s.remoteRows || [];
    const cur = s.session?.remote || 'off';
    return h(Box, { flexDirection: 'column' },
      h(Text, { color: C.accent, bold: true }, '── Access · Remote '),
      h(Text, { color: C.dim }, `now: ${cur}${s.session?.tunnelJoin ? ` · ${s.session.tunnelJoin}` : ''}`),
      ...rows.filter((r) => r.disabled).flatMap((r) => String(r.reason).split('\n')
        .map((line, i) => h(Text, { key: `${r.value}-${i}`, color: C.dimmer, wrap: 'truncate' }, i ? `    ${line}` : `  ${r.value} unavailable: ${line}`))),
      h(Select, {
        options: [
          ...rows.filter((r) => !r.disabled).map((r) => ({ label: `${r.label}${r.value === cur ? '   (current)' : ''}`, value: r.value })),
          // The links minted before a change embed the old address list, so the offer lives in
          // the same step it is caused by (v0.22B's documented caveat, v0.24's answer to it).
          ...rows.filter((r) => !r.disabled && r.value !== cur).map((r) => ({ label: `${r.value} — and re-issue every invite link`, value: `${r.value}!` })),
          { label: 'Back', value: 'back' },
        ],
        onChange: (v) => {
          if (v === 'back') return up();
          const reissue = v.endsWith('!');
          const mode = reissue ? v.slice(0, -1) : v;
          close();
          store.remoteBusy = true;
          sys(`switching remote to ${mode}${reissue ? ' and re-issuing every invite link' : ''}…`);
          sendMsg({ t: 'remote', mode, reissue });
        },
      }));
  }
  if (s.menu.path.at(-1) === 'people.grants') {
    const list = s.grants || [];
    return h(Box, { flexDirection: 'column' },
      h(Text, { color: C.accent, bold: true }, '── People · Standing approvals '),
      h(Text, { color: C.dim }, list.length
        ? 'an `always` grant means that person is never asked again for that kind of request'
        : 'nobody holds one — a grant is given by adding `always` to an /allow-… command'),
      h(Select, {
        options: [...list.map((g) => ({ label: `withdraw ${g.name}'s standing ${g.kind}`, value: `${g.kind}:${g.name}` })),
          { label: 'Back', value: 'back' }],
        onChange: (v) => {
          if (v === 'back') return up();
          const [kind, ...rest] = v.split(':');
          close();
          sendMsg({ t: 'grants', op: 'revoke', kind, name: rest.join(':') });
          sendMsg({ t: 'grants' });
        },
      }));
  }

  const title = s.menu.path.length ? `${tree.title} · ${here.node.title || here.node.label}` : tree.title;
  // The widest label in THIS list, capped — a column that fits the shortest one runs every
  // other row together with its description.
  const width = Math.min(32, Math.max(14, ...here.items.map((i) => (i.title || i.label || '').length + 2)));
  return h(Box, { flexDirection: 'column' },
    h(Text, { color: C.accent, bold: true }, `── ${title} `),
    here.node.desc ? h(Text, { color: C.dim, wrap: 'truncate' }, here.node.desc) : null,
    h(Select, {
      visibleOptionCount: Math.max(6, Math.min(here.items.length + 1, (process.stdout.rows || 24) - 8)),
      options: [
        ...here.items.map((i) => ({
          label: `${(i.title || i.label).padEnd(width)}${i.value ? `[${i.value}] ` : ''}${i.desc || ''}`,
          value: i.id,
        })),
        { label: s.menu.path.length ? 'Back' : 'Close (Esc)', value: '..' },
      ],
      onChange: (v) => {
        if (v === '..') return s.menu.path.length ? up() : close();
        const item = here.items.find((i) => i.id === v);
        if (!item) return;
        if (item.items || (!s.menu.path.length && item.items !== undefined)) return down(item.id);
        return s.menu.path.length ? act(item) : down(item.id);
      },
    }),
    h(Text, { color: C.dimmer }, '↑↓ move · Enter · Esc back'));
}

// TextInput's value lives in React state, so prefilling it from outside needs a way in.
let setInputExternal = () => {};
const clientCmdName = () => 'claude-jam join';

function App() {
  const s = useStore();
  const [input, setInput] = React.useState('');
  const [spin, setSpin] = React.useState(0);
  // v0.24: `/menu` puts a command that needs an argument on the input line rather than running
  // it, so the panel needs a way to write into React's state from outside a component.
  setInputExternal = setInput;

  // The spinner runs ONLY while busy, and unref'd, so an idle client neither redraws nor
  // holds the loop open.
  React.useEffect(() => {
    if (!s.status.busy) { setSpin(0); return; }
    const t = setInterval(() => setSpin((i) => (i + 1) % SPIN.length), 220);
    t.unref?.();
    return () => clearInterval(t);
  }, [s.status.busy]);

  // v0.14: raw mode is held by ink's TextInput, and passthrough hides the input row — so
  // unmounting it put the tty back into canonical mode, where the terminal echoed every key
  // and released nothing until Enter (observed: `zz^[` printed into the client's own row
  // while claude got nothing). Passthrough holds raw mode itself. This effect runs after the
  // unmount's cleanup in the same commit, so it wins; F3 back remounts TextInput, which
  // takes over again.
  React.useEffect(() => {
    if (!s.passthrough) return;
    try { process.stdin.setRawMode?.(true); } catch { /* not a tty */ }
  }, [s.passthrough]);

  // Typing indicators expire on their own; this only needs to redraw the status row.
  React.useEffect(() => {
    const t = setInterval(() => {
      const before = s.typing.size;
      for (const [n, at] of s.typing) if (Date.now() - at >= 4000) s.typing.delete(n);
      let redraw = s.typing.size !== before;
      // v0.28: a notice over the mirror expires on a clock, and a frozen screen sends no frame
      // to redraw it away. Counting them is one comparison a second.
      const notices = s.mirror
        ? s.deferred.filter((e) => e.notice && Date.now() - e.at < NOTICE_TTL).length : 0;
      if (notices !== lastNotices) { lastNotices = notices; redraw = true; }
      // v0.17 P5: `⚠ stale Ns` has to appear, and count up, with no frame arriving to trigger a
      // render — but a healthy `~120ms` is the same string every tick, so it costs no redraw.
      const rtt = rttText(s.net, Date.now(), s.net?.heartbeat);
      if (rtt !== lastRtt) { lastRtt = rtt; redraw = true; }
      if (redraw) touch();
    }, 1000);
    t.unref?.();
    return () => clearInterval(t);
  }, [s]);

  // v0.10b: Shift+Enter / Alt+Enter push the row into the pending buffer instead of
  // submitting it — exactly where a trailing `\` puts it, so submit() needs no new path.
  // v0.7: F2 is the mirror toggle. Both come from the key filter above, never from ink.
  React.useEffect(() => {
    const onNewline = () => { store.cont.push(input); setInput(''); store.input = ''; touch(); };
    const onMirror = () => toggleMirror();
    const onPassthrough = () => onF3();
    // v0.30-3: recall. The draft is remembered on the first ↑ and handed back on the last ↓, so
    // walking the history and coming back never eats what was being typed.
    const walk = (dir) => {
      if (histIdx === -1) histDraft = input;
      const r = historyMove(history, histIdx, dir, histDraft);
      histIdx = r.idx;
      setInput(r.text);
      store.input = r.text;
      touch();
    };
    const onPrev = () => walk('up');
    const onNext = () => walk('down');
    keys.on('newline', onNewline);
    keys.on('mirror', onMirror);
    keys.on('passthrough', onPassthrough);
    keys.on('histprev', onPrev);
    keys.on('histnext', onNext);
    return () => {
      keys.off('newline', onNewline);
      keys.off('mirror', onMirror);
      keys.off('passthrough', onPassthrough);
      keys.off('histprev', onPrev);
      keys.off('histnext', onNext);
    };
  }, [input]);

  // v0.16: the bar counts down live, so anything pending needs a tick of its own.
  React.useEffect(() => {
    if (!s.pending.length) return;
    const t = setInterval(touch, 1000);
    t.unref?.();
    return () => clearInterval(t);
  }, [s.pending.length]);

  const onChange = (v) => {
    setInput(v);
    store.input = v; // the single-key rule needs this outside React (see barKeys)
    localActivity(); // v0.26: a keystroke is the whole definition of `active` — see reportIdle
    const now = Date.now();
    if (v && now - lastTypingSent > 1500) { lastTypingSent = now; sendMsg({ t: 'typing' }); }
  };

  // Live region, in order: the mirror frame (or the in-progress turn's tool lines), the
  // 3-row chat strip of what the mirror cannot show, the status row, the pending lines of a
  // multi-line message, and the input row.
  const liveTools = s.mirror || s.toolsExpanded ? [] : s.tools.slice(-LIVE_TOOL_ROWS);
  const strip = s.mirror ? s.deferred.filter((e) => e.strip).slice(-STRIP_ROWS) : [];
  // v0.15: only the mirror view needs the echo — the transcript prints the daemon's own copy
  // of the line within a round trip, and two of them would just read as a double send.
  const echo = s.mirror && s.echo && Date.now() - s.echo.at < ECHO_TTL ? s.echo : null;
  // v0.17 P6: jam's own commands, dim, while what is typed is a command NAME and nothing else.
  // claude's are not in here — the client cannot know them (they come from the host's plugins,
  // MCP servers and version), and guessing would be worse than showing nothing. The row costs the
  // mirror one frame row rather than pushing the input line off the screen, and it changes no
  // arming rule: an input starting with `/` is already non-empty, so the v0.16 single keys are off.
  const hints = s.passthrough ? [] : commandMatches(input);
  // v0.31: the question block sits above the status row in BOTH views, and the mirror gives up
  // exactly as many rows as it takes — a picker pushing the input line off the screen would be a
  // poor way to ask somebody a question.
  const qText = s.passthrough ? '' : questionText(s.status);
  const qRows = qText ? qText.split('\n').length : 0;
  // v0.28: the blocks that were forced into the transcript while the mirror owns the screen —
  // the invite lines, the resume recipe. They are in `deferred` like everything else (so the
  // flip back prints them in order) and they are ALSO shown here, whole, for NOTICE_TTL. v0.24b
  // fixed exactly this for the three-row strip; the alternate screen must not undo it.
  const notice = s.mirror
    ? s.deferred.filter((e) => e.notice && Date.now() - e.at < NOTICE_TTL).slice(-NOTICE_ROWS)
    : [];
  // v0.24: while the panel is open it owns the whole live region AND the keyboard. An input row
  // underneath would make one keystroke both a menu choice and a message; the mirror underneath
  // would push the panel off the bottom of a short terminal.
  // v0.28: <Static> belongs to the NORMAL screen buffer only. In the mirror view this ink
  // instance is drawing on the alternate screen, where a transcript would be thrown away on the
  // next flip — and where ink's own "live region is as tall as the terminal" path would reprint
  // the whole log after an `\x1b[3J` that clears the real scrollback. That reprint IS the churn
  // Roy reported; no <Static> here means it cannot happen.
  const transcript = s.mirror ? null : h(Static, { items: s.entries }, (e) => h(Entry, { key: e.key, e }));
  if (s.menu && !s.passthrough) {
    return h(Box, { flexDirection: 'column' }, transcript, h(Menu, { s }));
  }
  return h(Box, { flexDirection: 'column' },
    transcript,
    notice.length ? h(Notice, { items: notice }) : null,
    s.mirror
      ? h(Mirror, { frame: s.frame, scroll: s.scroll,
        reserve: (hints.length ? 1 : 0) + qRows + notice.length })
      : null,
    liveTools.length
      // Index keys on purpose: this region is redrawn every render (never <Static>), and two
      // identical tool lines in one turn are perfectly normal.
      ? h(Box, { flexDirection: 'column' }, liveTools.map((t, i) => h(Entry, {
        key: `live-${i}`,
        e: {
          gap: false, label: '', color: C.dim, glyph: t.kind === 'tool-result' ? '⎿' : '⚙',
          glyphColor: t.kind === 'tool-result' ? C.dimmer : C.dim, md: false, wrap: true, bare: false,
          // v0.17 F1: one ROW per tool call. A 20-line Edit diff rendered whole in here would
          // push the status and input rows off the bottom of the screen; the full diff is in
          // the transcript and in `/tools`.
          text: toolLiveLine(t.text), textColor: t.kind === 'tool-result' ? C.dimmer : C.dim,
          labelW: s.labelW, cols: process.stdout.columns || 80,
        },
      })))
      : null,
    s.mirror && strip.length
      ? h(Box, { flexDirection: 'column' },
        strip.map((e) => h(Entry, { key: `strip-${e.key}`, e: { ...e, gap: false } })))
      : null,
    echo
      ? h(Box, null, h(Text, { color: C.dim, wrap: 'truncate' },
        `❯ ${echo.text.split('\n')[0]} · ${echo.acked ? 'sent' : 'sending…'}`))
      : null,
    // v0.16: host-only, and gone while the TUI has the keyboard — a proxied keystroke must
    // not be able to answer a knock by accident.
    hints.length
      ? h(Box, null, h(Text, { color: C.dimmer, wrap: 'truncate' },
        `${hints.join('  ')}${hints.length >= COMMAND_HINTS_MAX ? '  …' : ''}`))
      : null,
    IS_HOST && !s.passthrough
      ? h(ApprovalBar, { items: barHidden() ? [] : s.pending, armed: barArmed(), now: Date.now() })
      : null,
    qText ? h(QuestionBlock, { text: qText }) : null,
    h(StatusBar, { status: s.status, typing: s.typing, spin, mirror: s.mirror, passthrough: s.passthrough, net: s.net, scroll: s.scroll }),
    s.cont.length && !s.passthrough
      ? h(Box, { flexDirection: 'column' },
        s.cont.map((l, i) => h(Text, { key: `cont-${i}`, color: C.dim }, l === '' ? ' ' : l)))
      : null,
    // While the keyboard belongs to the TUI there is nothing to type here, and a live prompt
    // would invite exactly the mistake F3 exists to prevent. Same one row either way.
    s.passthrough
      ? h(Box, null, h(Text, { color: C.dim }, '⌨ your keys are going to claude\'s screen — F3 to type in the jam again'))
      : h(Box, null,
        h(Text, { color: C.me }, NAME),
        s.cont.length ? h(Text, { color: C.dim }, ' …') : null,
        h(Text, { color: C.accent }, ' ❯ '),
        h(TextInput, { value: input, onChange, onSubmit: (v) => { setInput(''); store.input = ''; submit(v); } })));
}

// Ctrl-C in the terminal is ink's own (exitOnCtrlC): it unmounts, waitUntilExit resolves and
// the exit below runs. These are for a signal from outside, where ink sees nothing.
process.on('SIGINT', () => leave(0));
process.on('SIGTERM', () => leave(0));
// v0.28: the terminal goes back the way it was found, whatever ends this process. The `exit`
// hook is the belt — it fires for a plain return, a process.exit and an uncaught throw alike,
// and fs.writeSync is what makes it land from inside one. The explicit uncaughtException
// handler is the braces AND the readable half: leave the alternate screen FIRST, or the stack
// trace prints into a buffer that is about to be thrown away and nobody ever sees the error.
process.on('exit', restoreScreen);
process.on('uncaughtException', (e) => {
  restoreScreen();
  console.error(e?.stack || String(e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  restoreScreen();
  console.error(e?.stack || String(e));
  process.exit(1);
});
// Terminal resized: ink relays out on its own, and the host's claude window follows along.
process.stdout.on('resize', () => sendResize());

function mount() { app = inkRender(h(App), { patchConsole: false, stdin: inkStdin }); }
mount();
connect();
// v0.15: F3 attaches by unmounting ink, and waitUntilExit() resolves on ANY unmount — so a
// pending attach means "hand the terminal to tmux, then rebuild the client"; anything else
// (/quit, Ctrl-C, a rejection) is the real exit.
// v0.28: a view flip is the second reason to unmount. <Static>'s index only ever moves forward,
// so printing into a different screen buffer means mounting again — and the buffer is switched
// here, between the unmount and the mount, where nothing is on screen to be corrupted by it.
for (;;) {
  await app.waitUntilExit();
  if (pendingAttach) {
    const session = pendingAttach;
    pendingAttach = null;
    await runAttach(session); // restoreScreen() inside it hands tmux a clean normal buffer
    if (store.mirror) applyScreen(true); // and the mirror takes the alternate one back
    mount();
    continue;
  }
  if (pendingScreen) {
    applyScreen(pendingScreen === 'alt');
    pendingScreen = null;
    mount();
    continue;
  }
  break;
}
restoreScreen();
process.exit(0);
