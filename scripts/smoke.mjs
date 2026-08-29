#!/usr/bin/env node
// End-to-end smoke: talk to a running jam daemon as "Tester", ask for "pong", and
// assert the round trip (injection -> JSONL -> agent text -> Stop hook status).
//
// v0.19: then ONE more turn, which is the only way to prove an appended system prompt is really
// in effect — ask claude about the rule and look for a word that exists NOWHERE else in anything
// jam hands it. "paraphrase" appears in buildSystemPrompt() and in no other file (README, MANUAL,
// hooks.sh, SPEC), so an answer carrying it cannot have come from the SessionStart context.
//
// v0.30: and then a THIRD turn — one multi-line message of ~6 KB. It is the shape that failed live
// (claude renders a multi-line paste as `[Pasted text …]`, which the old echo probe could never
// match) and it is over the 2 KB chunk cap, so it also proves a chunked payload reaches the real
// transcript whole. Asserted against the JSONL, not against the screen.
// usage: node scripts/smoke.mjs <ws-url> <token> [prompt]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, token, prompt = 'reply with the single word pong and nothing else'] = process.argv.slice(2);
if (!url || !token) { console.error('usage: node scripts/smoke.mjs <ws-url> <token> [prompt]'); process.exit(2); }

const got = { agent: null, statusIdle: null, sessionId: null, jsonl: false, sysprompt: null, big: null };

// v0.30: the two rules that failed live, against a REAL claude and a REAL transcript. One message,
// because each one costs a turn: it is multi-line (so claude renders it as `[Pasted text …]`, the
// shape that used to be called a failure) and comfortably over the 2 KB chunk cap (so it goes in
// as several pastes). What must be true afterwards is that the JSONL holds every byte of it.
const BIG_MARK = 'jam-v030-big';
const BIG_LINES = 120;
const BIG = [`reply with the single word ok and nothing else. ${BIG_MARK} follows, ignore it:`,
  ...Array.from({ length: BIG_LINES }, (_, i) => `${BIG_MARK} line ${i}: ${'y'.repeat(40)}`)].join('\n');

// The whole payload, with its attribution, has to be in the transcript claude actually read.
function jsonlHasBig(id) {
  const f = fs.globSync(path.join(os.homedir(), '.claude', 'projects', '*', `${id}.jsonl`))[0];
  if (!f) return null;
  const text = fs.readFileSync(f, 'utf8');
  // The JSONL holds the message as a JSON string, so compare against the encoded form.
  const want = JSON.stringify(`[Tester]: ${BIG}`).slice(1, -1);
  const seen = (text.match(new RegExp(`${BIG_MARK} line `, 'g')) || []).length;
  return { whole: text.includes(want), lines: seen, want: BIG_LINES + 1 };
}

// v0.19: the second turn. Deliberately asks about the SHAPE of the rule rather than for its text —
// a request to quote instructions is a prompt-injection shape and gets refused, and quite right.
const SYS_Q = 'One sentence, no preamble: does your instruction about revealing the join token '
  + 'say anything about a paraphrase, and who may be told? Use the word paraphrase if it appears.';
const SYS_RE = /paraphras/i;

// The injected message must have reached the real transcript with its attribution.
function jsonlHasTester(id) {
  const f = fs.globSync(path.join(os.homedir(), '.claude', 'projects', '*', `${id}.jsonl`))[0];
  return !!f && fs.readFileSync(f, 'utf8').includes('[Tester]: ');
}
let sentAt = 0;
let asked = false;
let bigAt = 0;
const ws = new WebSocket(url);

ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'Tester', token })));
ws.addEventListener('message', (m) => {
  const ev = JSON.parse(m.data);
  if (ev.t !== 'typing') console.log('EVENT', JSON.stringify(ev).slice(0, 400));
  if (ev.t === 'welcome') {
    got.sessionId = ev.session.id;
    ws.send(JSON.stringify({ t: 'say', text: prompt }));
    sentAt = Date.now();
    return;
  }
  if (ev.t === 'agent' && ev.kind === 'text' && /pong/i.test(ev.text) && !got.agent) got.agent = ev;
  // Only the Stop that lands after our message counts.
  if (ev.t === 'status' && ev.busy === false && sentAt && ev.ts > sentAt && !got.statusIdle) got.statusIdle = ev;
  if (got.agent && got.statusIdle && !asked) {
    got.jsonl = jsonlHasTester(got.sessionId);
    asked = true;
    ws.send(JSON.stringify({ t: 'say', text: SYS_Q }));
    return;
  }
  // The system-prompt answer: any agent text after the question that carries the marker word.
  if (asked && ev.t === 'agent' && ev.kind === 'text' && SYS_RE.test(ev.text) && !got.sysprompt) {
    got.sysprompt = ev.text;
    // v0.30: now the big multi-line one. Sent AFTER everything else, so a failure here cannot
    // hide any of the checks above.
    bigAt = Date.now();
    ws.send(JSON.stringify({ t: 'say', text: BIG }));
    return;
  }
  // v0.30: the daemon confirmed the send (busy went back to false), so the transcript is written.
  if (bigAt && ev.t === 'status' && ev.busy === false && ev.ts > bigAt && !got.big) {
    setTimeout(() => { got.big = jsonlHasBig(got.sessionId); finish(got.jsonl && got.big?.whole ? 0 : 1); }, 1500);
    bigAt = 0;
  }
  // Or it could not be confirmed at all, which v0.30 says must be an explicit, recoverable error.
  if (ev.t === 'error' && /couldn't confirm/.test(ev.text || '')) {
    got.big = { whole: false, kept: ev.text };
    finish(1);
  }
});
ws.addEventListener('error', (e) => { console.error('WS error', e.message || e); process.exit(1); });

function finish(code) {
  console.log('\n--- RESULT ---');
  console.log('session-id     :', got.sessionId);
  console.log('agent event    :', got.agent ? JSON.stringify(got.agent) : 'MISSING');
  console.log('status busy:false:', got.statusIdle ? JSON.stringify(got.statusIdle) : 'MISSING');
  console.log('jsonl [Tester]:  :', got.jsonl ? 'found' : 'MISSING');
  // v0.19: not fatal on its own — a jam launched with --no-system-prompt, or against a claude that
  // cannot take the flag, is a supported configuration and says so in the daemon log.
  console.log('system prompt    :', got.sysprompt
    ? `IN EFFECT — ${JSON.stringify(got.sysprompt.slice(0, 220))}`
    : 'not proved (check the daemon log for "shared-session contract →", or --no-system-prompt)');
  // v0.30: the multi-line, multi-chunk payload — the exact shape that failed live at 15:20.
  console.log(`v0.30 big paste  : ${BIG.length} chars / ${BIG_LINES + 1} lines →`, got.big
    ? (got.big.whole ? `WHOLE in the transcript (${got.big.lines}/${got.big.want} marked lines)`
      : `INCOMPLETE — ${got.big.kept || `${got.big.lines}/${got.big.want} marked lines in the transcript`}`)
    : 'MISSING');
  process.exit(code);
}
setTimeout(() => { console.error('\nTIMEOUT'); finish(1); }, Number(process.env.SMOKE_TIMEOUT || 150000));
