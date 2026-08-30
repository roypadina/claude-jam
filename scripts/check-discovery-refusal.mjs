#!/usr/bin/env node
// 0.23.3 check: with no mDNS tool, does discovery REFUSE — or does it quietly report an empty
// network? That distinction is the whole deferral. `dns-sd` is Apple's Bonjour CLI; it does not
// exist on Linux (avahi's tools are spelled differently and the avahi path was deliberately not
// built), so on Linux this is not a hypothetical branch — it is the ONLY branch, on every box.
//
// "nobody is hosting" and "this machine cannot look" are different answers, and a tool that
// conflates them sends somebody hunting for a jam that is announcing perfectly well. The pure half
// (`resolveDnssd` → `{ ok: false, why: DNSSD_MISSING }`) has unit tests. What has none is whether
// the real `claude-jam find` ASKS it and honours the answer — exactly the gap that made
// `check-terminal-gate.mjs` necessary, where the pure function was right and the caller passed it
// an empty environment.
//
// It costs nothing: no daemon, no tmux, no claude, no network — `JAM_DNSSD` points at a path that
// does not exist, so nothing is ever spawned. On the `ubuntu-latest` leg it also runs the NATIVE
// case, where there genuinely is no dns-sd, and prints what came back.
//   usage: node scripts/check-discovery-refusal.mjs
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DNSSD_MISSING, resolveDnssd } from '../platform.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SESSIONS = path.join(ROOT, 'sessions.mjs');
const NO_TOOL = { ...process.env, JAM_DNSSD: '/nonexistent/claude-jam-check-has-no-dns-sd' };

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

const find = (args, env) => {
  const r = spawnSync(process.execPath, [SESSIONS, 'find', ...args], { encoding: 'utf8', timeout: 60_000, env });
  if (r.error) throw new Error(`could not run sessions.mjs: ${r.error.message}`);
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

console.log(`--- 0.23.3 discovery refusal with no mDNS tool, on ${process.platform} ---`);
console.log(`      this machine natively: ${JSON.stringify(resolveDnssd())}`);

check('`find` with no dns-sd refuses non-zero, and the refusal says why and how to fix it', () => {
  const { status, out } = find([], NO_TOOL);
  ok(status === 1, `exit status ${status}, wanted 1 — a refusal is not a successful empty listing\n${out}`);
  // The whole message, not a paraphrase: one string, so the docs and the tool agree. JAM_DNSSD's
  // own "points at X, which is not there" wording is the override case and is checked below.
  ok(/is not there/.test(out), `it did not name the override that failed:\n${out}`);
  // And it must not have printed a table — an empty listing is the lie this check exists for.
  ok(!/no jams|jam\s+host\s+access/i.test(out), `it printed a listing as well as refusing:\n${out}`);
});

check('`find --json` refuses in JSON too — ok:false with the reason, never an empty jams array alone', () => {
  const { status, out } = find(['--json'], NO_TOOL);
  ok(status === 1, `exit status ${status}, wanted 1\n${out}`);
  let parsed;
  try { parsed = JSON.parse(out); } catch (e) { throw new Error(`not JSON (${e.message}):\n${out}`); }
  ok(parsed.ok === false, `ok is ${JSON.stringify(parsed.ok)}, wanted false — a script cannot tell "cannot look" from "nobody home"`);
  ok(typeof parsed.error === 'string' && parsed.error.length > 0, 'there is no error string to show anybody');
  ok(Array.isArray(parsed.jams) && parsed.jams.length === 0, 'it claimed to have found jams');
});

// The native answer, and on Linux it is the real one: there is no dns-sd on a Linux box unless
// avahi's compat package put one there. PRINTED on every platform, ASSERTED where it is knowable —
// a mac has /usr/bin/dns-sd and must keep working, which is the false positive for this check.
if (process.platform === 'darwin') {
  check('macOS still finds its own dns-sd — the refusal must not fire on a machine that has one', () => {
    const r = resolveDnssd();
    ok(r.ok === true, `resolveDnssd refused on macOS: ${r.why}`);
    ok(r.bin === '/usr/bin/dns-sd', `it resolved to ${r.bin}, not the system one`);
  });
} else if (process.platform === 'linux') {
  const native = resolveDnssd();
  if (native.ok) {
    console.log(`      NOTE  this Linux box HAS dns-sd at ${native.bin} (avahi's compat package), so `
      + 'the native path here is the working one, not the refusing one');
  } else {
    check('Linux: the native answer is the documented refusal, naming avahi-utils as the fix', () => {
      ok(native.why === DNSSD_MISSING, `the refusal is not DNSSD_MISSING: ${native.why}`);
      ok(/avahi-utils/.test(native.why), 'the message does not say how to get one on Linux');
      const { status, out } = find(['--json'], process.env); // no override: the real thing
      ok(status === 1, `native \`find --json\` exited ${status}, wanted 1\n${out}`);
      const parsed = JSON.parse(out);
      ok(parsed.error === DNSSD_MISSING, `the JSON error is not DNSSD_MISSING:\n${out}`);
      console.log('      Linux discovery is UNSUPPORTED and says so — this is that, measured');
    });
  }
}

console.log(`\n--- RESULT --- ${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
