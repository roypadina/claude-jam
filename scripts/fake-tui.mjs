#!/usr/bin/env node
// A stand-in for the claude TUI, built from the MEASURED behaviour of claude 2.1.251 (the
// captures in fixtures/pane/). It exists so smoke-answer.mjs can drive the daemon's paste
// verification, its outbox and its prompt classifier deterministically, for free, and — crucially
// — through a REAL tmux pane, so `capture-pane`, `paste-buffer` and `send-keys` are all the real
// ones. What it imitates, and why each detail is here:
//   - the input box is a rule, a `❯` + U+00A0 row (+ indented continuations), a rule, then chrome;
//   - a bracketed paste carrying a newline collapses to `[Pasted text #N +M lines]`, counter
//     climbing per paste — the exact failure v0.30 exists for;
//   - Enter submits and clears the box, and the submitted text is appended to a log so a test can
//     assert the payload arrived WHOLE;
//   - Ctrl-U kills one visual line, not the whole input.
// Two extra modes a real claude does not have, driven by a control file the smoke writes:
//   deaf         swallow every byte and never redraw — a pane a message cannot land in
//   <fixture>    paint fixtures/pane/<fixture>.txt verbatim; a digit is logged, and the picker
//                stays up until the smoke says otherwise — so "first answer wins" can be driven
//                against the SAME prompt
// usage: fake-tui.mjs <ctl-file> <log-file> [fixtures-dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [ctlFile, logFile, fixturesDir] = process.argv.slice(2);
if (!ctlFile || !logFile) { console.error('usage: fake-tui.mjs <ctl> <log> [fixtures]'); process.exit(2); }
const FIXTURES = fixturesDir || path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'fixtures', 'pane');

const W = Number(process.env.FAKE_TUI_W) || 100;
const RULE = '─'.repeat(W);
const NBSP = ' ';
const say = (line) => fs.appendFileSync(logFile, `${line}\n`);

let buf = '';        // what is really in the box
let chips = [];      // one per paste that collapsed: {lines}
let pastes = 0;
let mode = 'box';
let painted = null;

function read(f, dflt = '') { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return dflt; } }

// The box as claude draws it: the placeholder chips first (one per collapsed paste), then any
// typed remainder. Wrapped at the pane width with a two-space hanging indent.
function boxRows() {
  const shown = chips.map((c) => `[Pasted text #${c.n} +${c.lines} lines]`).join('') + typed;
  if (!shown) return [`❯${NBSP}`];
  const out = [];
  let rest = shown;
  const first = W - 2;
  out.push(`❯${NBSP}${rest.slice(0, first)}`);
  rest = rest.slice(first);
  while (rest) { out.push(`  ${rest.slice(0, W - 2)}`); rest = rest.slice(W - 2); }
  return out;
}

let typed = '';
const transcript = [];

// Everything claude draws sits at the BOTTOM of the pane — the input box four rows up from the
// last, under its own rule. Painting from the top instead is not a cosmetic difference: the
// daemon looks for the prompt glyph in the last few rows before it pastes, and would wait out its
// whole 30-second budget on every message. (Found exactly that way.)
const H = () => process.stdout.rows || 32;
function bottom(rows) {
  const h = H();
  const fitted = rows.length > h ? rows.slice(-h) : [...Array(h - rows.length).fill(''), ...rows];
  return `\x1b[2J\x1b[H${fitted.join('\r\n')}`;
}

function paint() {
  if (mode === 'deaf') return;
  if (mode !== 'box') {
    const file = path.join(FIXTURES, `${mode}.txt`);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = `(no fixture ${mode})`; }
    if (painted === mode) return;
    painted = mode;
    // A capture is a whole screen; keep its BOTTOM, which is where every prompt block lives.
    process.stdout.write(bottom(text.replace(/\n+$/, '').split('\n')));
    return;
  }
  painted = null;
  process.stdout.write(bottom([...transcript.slice(-8), RULE, ...boxRows(), RULE,
    '  [fake-tui] | stand-in | claude-jam smoke', '  ready']));
}

// The control file is polled rather than signalled: the smoke writes a word, the pane follows.
setInterval(() => {
  const want = read(ctlFile, 'box') || 'box';
  if (want !== mode) { mode = want; painted = null; say(`MODE ${mode}`); paint(); }
}, 120).unref?.();

// DECSET 2004. tmux sends the `\x1b[200~`/`\x1b[201~` markers around a `paste-buffer -p` ONLY to
// an application that has asked for them — and claude asks. Without this line the payload arrives
// raw, every newline in it submits a line of its own, and nothing ever collapses to a placeholder.
// (Found exactly that way: the first run of this smoke submitted a nineteen-line message as
// nineteen messages.)
process.stdout.write('\x1b[?2004h');
process.stdin.setRawMode?.(true);
process.stdin.resume();
let hold = '';
process.stdin.on('data', (b) => {
  if (process.env.FAKE_TUI_TRACE) say(`RAW ${b.length}`);
  let s = hold + b.toString('utf8');
  hold = '';
  if (mode === 'deaf') { say(`DEAF swallowed ${s.length} bytes`); return; }
  while (s) {
    // A bracketed paste. tmux `paste-buffer -p` wraps the payload in these.
    const open = s.indexOf('\x1b[200~');
    if (open === 0) {
      const close = s.indexOf('\x1b[201~');
      if (close < 0) { hold = s; return; } // the rest is still coming
      // A terminal sends CR for a line break inside a bracketed paste, and so does tmux — the
      // payload's own `\n` never survives the pty. Normalising here is what a real TUI does, and
      // without it a nineteen-line paste looks like one long inline line. (Found exactly that way.)
      const body = s.slice(6, close).replace(/\r\n?/g, '\n');
      s = s.slice(close + 6);
      if (mode !== 'box') { say(`PASTE ignored (${mode})`); continue; }
      if (body.includes('\n')) {
        pastes++;
        // NEWLINES, which is what claude 2.1.251 counts: a 19-line paste shows `+18 lines`.
        chips.push({ n: pastes, lines: (body.match(/\n/g) || []).length });
        buf += body;
        say(`PASTE ${body.length} bytes, ${(body.match(/\n/g) || []).length} newlines -> chip #${pastes}`);
      } else {
        buf += body;
        typed += body;
        say(`PASTE ${body.length} bytes inline`);
      }
      paint();
      continue;
    }
    const ch = s[0];
    s = s.slice(1);
    if (mode !== 'box') {
      if (/[1-9]/.test(ch)) say(`KEY ${ch}`);
      else say(`KEY ${JSON.stringify(ch)} (${mode})`);
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (buf) { transcript.push(`❯${NBSP}${buf.split('\n')[0].slice(0, W - 2)}`); say(`SUBMIT ${JSON.stringify(buf)}`); }
      else say('SUBMIT (empty)');
      buf = ''; typed = ''; chips = [];
      paint();
      continue;
    }
    if (ch === '\x15') { // Ctrl-U — measured: kills ONE visual line, not the whole input
      if (typed) typed = typed.slice(0, Math.max(0, typed.length - (W - 2)));
      else if (chips.length) chips.pop();
      buf = chips.length || typed ? buf.slice(0, Math.max(0, buf.length - (W - 2))) : '';
      say('CTRLU');
      paint();
      continue;
    }
    if (ch === '\x03') { say('SIGINT'); process.exit(0); }
    buf += ch; typed += ch;
    paint();
  }
});

// A real claude refuses an unknown option and exits, which is what the launcher's
// --append-system-prompt-file probe reads; the stand-in is started directly, not probed, but the
// smoke's JAM_CLAUDE shim does that part.
say('READY');
paint();
setInterval(() => {}, 1 << 30);
