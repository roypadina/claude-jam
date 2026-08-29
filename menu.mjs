#!/usr/bin/env node
// v0.22A — `claude-jam` with no arguments.
//
// An ink launcher over the subcommands that already exist. THE RULE: this file builds argv and
// shells into `claude-jam <subcommand>`; it never re-implements one. So there is no second way to
// host a jam, no second way to join one and no second way to end one — and the Host screen prints
// the exact command before it runs it, which makes the menu a way to LEARN the CLI rather than a
// way to avoid it.
//
// Any argument at all (including --no-menu) means the caller knows what they want, and `jam`
// never gets here. A non-tty stdin prints usage, because a menu nobody can answer is a hang.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { Box, Text, render as inkRender, useApp, useInput } from 'ink';
import { Select, TextInput, Spinner, Alert, Badge } from '@inkjs/ui';
import { hostPlan, buildJoinArgv, remoteRows, ACCESS_MODES, resolveTailscale, funnelPrecheck,
  sessionsTable, resolveTarget, validName } from './lib.mjs';
import { listRows } from './sessions.mjs';
import { copyToClipboard } from './xfer.mjs';

const h = React.createElement;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const JAM = path.join(HERE, 'jam');
// Every NEW string in this batch names the product, not the binary (the rename batch ships
// `claude-jam` as the real bin with `jam` kept as an alias, so both resolve).
const BIN = 'claude-jam';

const C = { accent: 'yellow', dim: 'gray', dimmer: '#6b6b6b', err: 'red', ok: 'green' };

// ------------------------------------------------------------------ preconditions ----
// Asked once, when the Host screen needs them, because both are a process spawn: cloudflared's
// --version, and tailscale's status (which is also the only way to tell "no CLI" from "Funnel is
// not enabled for this tailnet" from "the App Store build is sandboxed").
function probeRelays() {
  let cloudflared = false;
  try { cloudflared = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' }).status === 0; } catch { /* no */ }
  const bin = resolveTailscale(null, process.env, fs.existsSync);
  let funnel = { ok: false, error: 'Tailscale Funnel was not checked' };
  try {
    const st = spawnSync(bin, ['status', '--json'], { encoding: 'utf8' });
    funnel = st.error
      ? { ok: false, error: `no tailscale CLI at ${bin} — fix: install Tailscale, or set JAM_TAILSCALE` }
      : funnelPrecheck(st.stdout);
  } catch (e) { funnel = { ok: false, error: e.message }; }
  return remoteRows({ cloudflared, funnel });
}

// ------------------------------------------------------------------------ running ----
// Leaving the menu is unmount-then-spawn: ink owns the terminal until it does not, and the
// subcommand needs a real tty of its own (the host client is another ink app).
let handoff = null;
function runAndExit(argv, { note = '' } = {}) { handoff = { argv, note }; }

// --------------------------------------------------------------------- little bits ----
const Head = ({ title, hint }) => h(Box, { flexDirection: 'column' },
  h(Box, null, h(Text, { color: C.accent, bold: true }, `── ${title} `), h(Text, { color: C.dimmer }, '─'.repeat(Math.max(3, 56 - title.length)))),
  hint ? h(Text, { color: C.dim }, hint) : null);

// `current` is where the cursor is, `focused` is whether that field has the keyboard. Two
// things, because a row you are standing on but not yet editing still has to look selected.
const Field = ({ label, value, current, focused, onChange = () => {}, onSubmit, placeholder = '' }) => h(Box, null,
  h(Box, { width: 16, flexShrink: 0 }, h(Text, { color: current ? C.accent : C.dim }, `${current ? '❯' : ' '} ${label}`)),
  focused
    ? h(TextInput, { defaultValue: value, placeholder, onChange, onSubmit })
    : h(Text, { color: current ? C.dim : C.dimmer }, value || placeholder || '—'));

// ------------------------------------------------------------------------- screens ----

function Main({ go, exit }) {
  return h(Box, { flexDirection: 'column' },
    h(Head, { title: `${BIN}`, hint: 'two or more humans, one real interactive Claude Code session' }),
    h(Select, {
      options: [
        { label: 'Host a jam            — start Claude Code here and let people in', value: 'host' },
        { label: 'Join a jam            — an invite link, or a ws:// URL', value: 'join' },
        { label: 'My jams               — what is running: attach, end, copy an invite', value: 'jams' },
        { label: 'End a jam             — tell everyone, then take it down', value: 'end' },
        { label: 'Quit', value: 'quit' },
      ],
      onChange: (v) => (v === 'quit' ? exit() : go(v)),
    }));
}

// The token row only exists in token mode, so it is only a STOP in token mode — a cursor that
// lands on a field nobody can see is a key that appears to do nothing.
const hostFields = (access) => ['cwd', 'name', 'jamName', 'access',
  ...(access === 'token' ? ['token'] : []), 'remote', 'view', 'extra', 'go'];

function Host({ back }) {
  const [rows, setRows] = React.useState(null);
  const [form, setForm] = React.useState({
    cwd: process.cwd(), name: process.env.USER || 'Host', jamName: '', access: 'knock',
    token: '', remote: 'off', view: false, extra: '',
  });
  const [at, setAt] = React.useState(0);
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => { setRows(probeRelays()); }, []);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const FIELDS = hostFields(form.access);
  const field = FIELDS[Math.min(at, FIELDS.length - 1)];
  const plan = hostPlan(form);

  useInput((input, key) => {
    // Esc is answered even mid-edit: a screen you cannot leave without finishing a field is a
    // trap, and the text input keeps whatever was typed for the next visit anyway.
    if (key.escape) { if (editing) return setEditing(false); return back(); }
    if (editing) return;
    if (key.upArrow) return setAt((i) => Math.max(0, i - 1));
    if (key.downArrow) return setAt((i) => Math.min(FIELDS.length - 1, i + 1));
    if (key.leftArrow || key.rightArrow || input === ' ' || key.return) {
      const d = key.leftArrow ? -1 : 1;
      if (field === 'access') {
        const i = ACCESS_MODES.indexOf(form.access);
        return set('access', ACCESS_MODES[(i + d + ACCESS_MODES.length) % ACCESS_MODES.length]);
      }
      if (field === 'remote') {
        const usable = (rows || []).filter((r) => !r.disabled).map((r) => r.value);
        if (!usable.length) return;
        const i = Math.max(0, usable.indexOf(form.remote));
        return set('remote', usable[(i + d + usable.length) % usable.length]);
      }
      if (field === 'view') return set('view', !form.view);
      if (field === 'go') { if (plan.ok) runAndExit(plan.argv, { note: plan.command }); return; }
      if (key.return || input === ' ') { setEditing(true); return; }
    }
  });

  const done = (k) => (v) => { set(k, v); setEditing(false); setAt((i) => Math.min(FIELDS.length - 1, i + 1)); };
  const remoteRow = (rows || []).find((r) => r.value === form.remote);
  return h(Box, { flexDirection: 'column' },
    h(Head, { title: 'Host a jam', hint: '↑↓ move · ←→/space change · Enter edits a text field · Esc back' }),
    h(Field, { label: 'directory', value: form.cwd, current: field === 'cwd', focused: field === 'cwd' && editing, onSubmit: done('cwd') }),
    h(Field, { label: 'your name', value: form.name, current: field === 'name', focused: field === 'name' && editing, onSubmit: done('name') }),
    h(Field, { label: 'jam name', value: form.jamName, placeholder: 'jam (the tmux session)', current: field === 'jamName', focused: field === 'jamName' && editing, onSubmit: done('jamName') }),
    h(Box, null, h(Box, { width: 16, flexShrink: 0 }, h(Text, { color: field === 'access' ? C.accent : C.dim }, `${field === 'access' ? '❯' : ' '} access`)),
      h(Badge, { color: form.access === 'knock' ? 'blue' : form.access === 'token' ? 'yellow' : 'magenta' }, form.access),
      h(Text, { color: C.dimmer }, form.access === 'knock' ? '  friends knock, you accept them'
        : form.access === 'token' ? '  anyone holding the token walks in'
          : '  invite links only — a knock is refused')),
    form.access === 'token'
      ? h(Field, { label: 'token', value: form.token, placeholder: '8-64 of [A-Za-z0-9_-]', current: field === 'token', focused: field === 'token' && editing, onSubmit: done('token') })
      : null,
    h(Box, null, h(Box, { width: 16, flexShrink: 0 }, h(Text, { color: field === 'remote' ? C.accent : C.dim }, `${field === 'remote' ? '❯' : ' '} remote`)),
      rows
        ? h(Box, null, h(Badge, { color: form.remote === 'off' ? 'gray' : 'green' }, form.remote),
          h(Text, { color: C.dimmer }, `  ${(remoteRow?.label || '').replace(/^\w+ — /, '')}`))
        : h(Spinner, { label: 'checking cloudflared and tailscale…' })),
    // Greyed rows are the point of this screen: an option you cannot pick must say why, with
    // the fix, instead of being silently absent.
    ...(rows || []).filter((r) => r.disabled).map((r) => h(Box, { key: r.value },
      h(Box, { width: 16, flexShrink: 0 }), h(Text, { color: C.dimmer }, `${r.value} — unavailable: ${r.reason}`))),
    h(Box, null, h(Box, { width: 16, flexShrink: 0 }, h(Text, { color: field === 'view' ? C.accent : C.dim }, `${field === 'view' ? '❯' : ' '} browser view`)),
      h(Text, { color: C.dimmer }, form.view ? 'on — ttyd serves the real TUI read-only' : 'off')),
    h(Field, { label: 'claude args', value: form.extra, placeholder: 'e.g. --model opus', current: field === 'extra', focused: field === 'extra' && editing, onSubmit: done('extra') }),
    h(Box, { marginTop: 1, flexDirection: 'column' },
      h(Text, { color: C.dim }, 'this runs:'),
      plan.ok ? h(Text, { color: C.ok, wrap: 'truncate' }, `  ${plan.command}`)
        : h(Alert, { variant: 'error' }, plan.error)),
    h(Box, { marginTop: 1 }, h(Text, { color: field === 'go' ? C.accent : C.dimmer },
      `${field === 'go' ? '❯' : ' '} ${plan.ok ? 'Enter starts it' : 'fix the error above first'}`)));
}

function Join({ back }) {
  const [input, setInput] = React.useState('');
  const [name, setName] = React.useState(process.env.USER || '');
  const [token, setToken] = React.useState('');
  const [at, setAt] = React.useState(0);
  const [editing, setEditing] = React.useState(true);
  const built = buildJoinArgv({ input, name, token });
  // A link carries the address, the name and the secret — so the name and token fields exist
  // only for the other case, and showing them next to a link would be a lie about what is used.
  const isLink = /^cjam\d/.test(input.trim());
  const fields = isLink || !input.trim() ? ['input', 'go'] : ['input', 'name', 'token', 'go'];
  const field = fields[Math.min(at, fields.length - 1)];
  useInput((i, key) => {
    if (key.escape) { if (editing) return setEditing(false); return back(); }
    if (editing) return;
    if (key.upArrow) return setAt((x) => Math.max(0, x - 1));
    if (key.downArrow) return setAt((x) => Math.min(fields.length - 1, x + 1));
    if (key.return) {
      if (field === 'go') { if (built.ok) runAndExit(built.argv, { note: built.command }); return; }
      setEditing(true);
    }
  });
  const done = (setter) => (v) => { setter(v); setEditing(false); setAt((x) => Math.min(fields.length - 1, x + 1)); };
  return h(Box, { flexDirection: 'column' },
    h(Head, { title: 'Join a jam', hint: 'paste an invite link (cjam1_…) or a ws:// URL · Esc back' }),
    h(Field, { label: 'link or URL', value: input, placeholder: 'cjam1_… or ws://10.0.0.5:7777',
      current: field === 'input', focused: field === 'input' && editing, onChange: setInput, onSubmit: done(setInput) }),
    isLink
      ? h(Box, null, h(Box, { width: 16, flexShrink: 0 }), h(Text, { color: C.dimmer },
        'the link carries the address, the name and the secret — nothing else to type'))
      : null,
    !isLink && input.trim()
      ? h(React.Fragment, null,
        h(Field, { label: 'your name', value: name, current: field === 'name', focused: field === 'name' && editing, onSubmit: done(setName) }),
        h(Field, { label: 'token', value: token, placeholder: 'blank = knock, the host accepts you',
          current: field === 'token', focused: field === 'token' && editing, onSubmit: done(setToken) }))
      : null,
    built.warn ? h(Box, { marginTop: 1 }, h(Alert, { variant: 'warning' }, built.warn)) : null,
    h(Box, { marginTop: 1, flexDirection: 'column' },
      built.ok
        ? h(React.Fragment, null, h(Text, { color: C.dim }, 'this runs:'),
          h(Text, { color: C.ok, wrap: 'truncate' }, `  ${built.command}`))
        : h(Alert, { variant: input.trim() ? 'error' : 'info' }, built.error)),
    h(Box, { marginTop: 1 }, h(Text, { color: field === 'go' ? C.accent : C.dimmer },
      `${field === 'go' ? '❯' : ' '} ${built.ok ? 'Enter joins' : 'paste something above'}`)));
}

// My jams / End a jam are the same table; `mode` only decides which action is offered first.
function Jams({ back, mode }) {
  const [rows, setRows] = React.useState(null);
  const [pick, setPick] = React.useState(null);
  const [msg, setMsg] = React.useState('');
  const [asking, setAsking] = React.useState(false);
  React.useEffect(() => { listRows().then(setRows).catch(() => setRows([])); }, []);
  useInput((i, key) => { if (key.escape && !asking) (pick ? setPick(null) : back()); });

  if (!rows) return h(Box, { flexDirection: 'column' }, h(Head, { title: 'My jams' }), h(Spinner, { label: 'looking for jams…' }));
  const live = rows.filter((r) => r.name);
  if (!live.length) {
    return h(Box, { flexDirection: 'column' }, h(Head, { title: 'My jams' }),
      h(Text, { color: C.dim }, rows.length
        ? `no jam is running — ${rows.length} state dir(s) left over (${BIN} clean removes them)`
        : `no jam is running yet — Host a jam starts one`),
      h(Box, { marginTop: 1 }, h(Text, { color: C.dimmer }, 'Esc back')));
  }
  if (asking) {
    // Copy-invite needs a name, because an invite link is name-bound: that is what stops a
    // forwarded link from becoming somebody else's colour and attribution.
    return h(Box, { flexDirection: 'column' }, h(Head, { title: `Invite somebody to ${pick.name}` }),
      h(Box, null, h(Text, { color: C.accent }, '❯ their name  '),
        h(TextInput, {
          placeholder: 'Yossi',
          onSubmit: (v) => {
            setAsking(false);
            if (!validName(v)) return setMsg('! a name is 1-24 chars of letters, digits, space, _ or -');
            const r = spawnSync(JAM, ['invite', v, '--jam', pick.name], { encoding: 'utf8' });
            const link = (r.stdout || '').split('\n').map((l) => l.trim()).find((l) => /cjam\d_/.test(l));
            if (!link) return setMsg(`! could not mint a link: ${((r.stderr || r.stdout || '').trim().split('\n')[0]) || 'no answer'}`);
            setMsg(copyToClipboard(link)
              ? `copied — send it privately, it joins as ${v} with no approval:\n  ${link}`
              : `mint ok, clipboard not available — copy this by hand:\n  ${link}`);
          },
        })));
  }
  if (pick) {
    return h(Box, { flexDirection: 'column' },
      h(Head, { title: pick.name, hint: `port ${pick.port} · ${pick.cwd || ''}` }),
      h(Select, {
        options: [
          { label: `Attach my client        ${BIN} host --attach --tmux ${pick.name}`, value: 'attach' },
          { label: `Copy an invite link     ${BIN} invite <Name> --jam ${pick.name}`, value: 'invite' },
          { label: `End this jam            ${BIN} end ${pick.name}`, value: 'end' },
          { label: 'Back', value: 'back' },
        ],
        onChange: (v) => {
          if (v === 'back') return setPick(null);
          if (v === 'invite') return setAsking(true);
          if (v === 'attach') return runAndExit(['host', '--attach', '--tmux', pick.name, '--port', String(pick.port)]);
          return runAndExit(['end', pick.name]);
        },
      }),
      msg ? h(Box, { marginTop: 1 }, h(Text, { color: /^!/.test(msg) ? C.err : C.ok }, msg)) : null);
  }
  return h(Box, { flexDirection: 'column' },
    h(Head, { title: mode === 'end' ? 'End a jam' : 'My jams', hint: 'Esc back' }),
    h(Box, { flexDirection: 'column', marginBottom: 1 },
      sessionsTable(rows, Date.now()).split('\n').map((l, i) => h(Text, { key: i, color: C.dimmer, wrap: 'truncate' }, l || ' '))),
    h(Select, {
      options: live.map((r) => ({ label: `${r.name}  (port ${r.port}, ${r.state}${r.participants.length ? `, ${r.participants.join(', ')}` : ''})`, value: r.name })),
      onChange: (v) => {
        const row = resolveTarget(rows, v);
        if (!row.ok) return;
        if (mode === 'end') return runAndExit(['end', v]);
        setPick({ name: v, port: row.row.port, cwd: row.row.cwd });
      },
    }));
}

function App() {
  const { exit } = useApp();
  const [screen, setScreen] = React.useState('main');
  const back = () => setScreen('main');
  React.useEffect(() => { if (handoff) exit(); });
  if (screen === 'host') return h(Host, { back });
  if (screen === 'join') return h(Join, { back });
  if (screen === 'jams') return h(Jams, { back, mode: 'jams' });
  if (screen === 'end') return h(Jams, { back, mode: 'end' });
  return h(Main, { go: setScreen, exit });
}

// A menu nobody can answer is a hang, so a pipe/cron gets the usage text `--help` prints.
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  const r = spawnSync(JAM, ['--help'], { stdio: 'inherit' });
  process.exit(r.status ?? 2);
}
const app = inkRender(h(App), { patchConsole: false });
await app.waitUntilExit();
if (handoff) {
  // Printed AFTER the unmount so it survives on screen: the menu's whole promise is that it
  // teaches the command line, and the command line is only taught if you can see it.
  process.stdout.write(`\n$ ${handoff.note || [BIN, ...handoff.argv].join(' ')}\n\n`);
  const r = spawnSync(JAM, handoff.argv, { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}
process.exit(0);
