#!/usr/bin/env node
// Knock approval inside the claude window: `tmux display-popup` runs this, it shows who is
// knocking, reads ONE key and posts the verdict back to the daemon.
// usage: popup.mjs <name> <ip> <ttl-seconds> <port>   (hook secret via JAM_HOOK_SECRET)
//
// Rule one, same as hooks.sh: never affect the daemon or the TUI. Every failure exits 0
// quietly, and an unanswered popup leaves the knock pending so `/accept` in a client works.
import { request } from 'node:http';
import { popupKey } from './lib.mjs';

const [name, ip, ttlS, port] = process.argv.slice(2);
const secret = process.env.JAM_HOOK_SECRET || '';

// A stack trace here would be painted over the host's TUI. There is nothing worth
// reporting from a popup, so die quietly instead.
process.on('uncaughtException', () => process.exit(0));

const C = { yellow: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m' };
const say = (s) => { try { process.stdout.write(s); } catch { /* popup already closed */ } };

say(`\n  ${C.yellow}⚑ ${name} wants to join${C.off} ${C.dim}(${ip})${C.off}\n\n` +
  `  [a]ccept · [d]eny · [i]gnore/Esc\n`);

const done = () => process.exit(0);
let answered = false;

// Aligned with the daemon's knock TTL: once the knock has expired there is nothing left to
// answer, so the popup takes itself off the screen.
const ttl = setTimeout(done, (Number(ttlS) || 120) * 1000);

function post(ok) {
  const body = JSON.stringify({ name, ok });
  const req = request({
    host: '127.0.0.1', port: Number(port), path: '/admit', method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-jam-secret': secret,
    },
  }, (res) => {
    // 404 = the knock expired or somebody answered it in a client first; the daemon is the
    // single source of truth, so the popup just says so and goes away.
    const late = res.statusCode !== 200;
    if (late) say(`\n  ${C.dim}too late (${res.statusCode})${C.off}\n`);
    res.resume();
    res.on('end', () => (late ? setTimeout(done, 800) : done()));
  });
  req.on('error', () => done());
  req.end(body);
}

// Raw mode so a single `a` counts without Enter. A piped stdin (the direct-run test) has no
// setRawMode at all — reading one byte works there just the same.
try { if (process.stdin.isTTY) process.stdin.setRawMode(true); } catch { /* not a tty */ }
process.stdin.resume();
process.stdin.once('data', (buf) => {
  clearTimeout(ttl);
  const k = popupKey(buf.toString('utf8')[0]);
  if (!k) return done();
  answered = true;
  say(`\n  ${k.ok ? 'accepting' : 'denying'} ${name}…\n`);
  post(k.ok);
});
process.stdin.on('end', () => { if (!answered) done(); });
process.stdin.on('error', () => { if (!answered) done(); });
