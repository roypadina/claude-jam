#!/usr/bin/env node
// End-to-end smoke: talk to a running jam daemon as "Tester", ask for "pong", and
// assert the round trip (injection -> JSONL -> agent text -> Stop hook status).
// usage: node scripts/smoke.mjs <ws-url> <token> [prompt]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, token, prompt = 'reply with the single word pong and nothing else'] = process.argv.slice(2);
if (!url || !token) { console.error('usage: node scripts/smoke.mjs <ws-url> <token> [prompt]'); process.exit(2); }

const got = { agent: null, statusIdle: null, sessionId: null, jsonl: false };

// The injected message must have reached the real transcript with its attribution.
function jsonlHasTester(id) {
  const f = fs.globSync(path.join(os.homedir(), '.claude', 'projects', '*', `${id}.jsonl`))[0];
  return !!f && fs.readFileSync(f, 'utf8').includes('[Tester]: ');
}
let sentAt = 0;
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
  if (got.agent && got.statusIdle) {
    got.jsonl = jsonlHasTester(got.sessionId);
    finish(got.jsonl ? 0 : 1);
  }
});
ws.addEventListener('error', (e) => { console.error('WS error', e.message || e); process.exit(1); });

function finish(code) {
  console.log('\n--- RESULT ---');
  console.log('session-id     :', got.sessionId);
  console.log('agent event    :', got.agent ? JSON.stringify(got.agent) : 'MISSING');
  console.log('status busy:false:', got.statusIdle ? JSON.stringify(got.statusIdle) : 'MISSING');
  console.log('jsonl [Tester]:  :', got.jsonl ? 'found' : 'MISSING');
  process.exit(code);
}
setTimeout(() => { console.error('\nTIMEOUT'); finish(1); }, Number(process.env.SMOKE_TIMEOUT || 150000));
