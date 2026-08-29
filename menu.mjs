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
  sessionsTable, resolveTarget, validName,
  // v0.23: the Join screen starts with what is on this network, and Host names the jam.
  joinRows, joinPlanFor, JOIN_PASTE_VALUE, parseDnssdZone, discoveredJams,
  DISCOVERY_TYPE, DISCOVERY_DOMAIN, FIND_MS, validJamName, defaultJamName } from './lib.mjs';
import { listRows } from './sessions.mjs';
import { copyText, browseText } from './platform.mjs';

const h = React.createElement;
const HERE = path.dirname(new URL(import.meta.url).pathname);
// v0.21: the real executable. `jam` is still installed beside it as a deprecated alias that
// execs this same file, so both resolve — but nothing here, and nothing printed anywhere, uses
// that name.
const JAM = path.join(HERE, 'claude-jam');
const BIN = 'claude-jam';
// The screen to open on. Only `join` is offered, because `claude-jam join` with no argument is
// the one subcommand whose no-argument form is a question rather than a usage error.
const START = process.argv[2] === 'join' ? 'join' : 'main';

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
        { label: 'Join a jam            — pick one off this network, or paste a link', value: 'join' },
        { label: 'My jams               — what is running: attach, end, copy an invite', value: 'jams' },
        { label: 'End a jam             — tell everyone, then take it down', value: 'end' },
        { label: 'Quit', value: 'quit' },
      ],
      onChange: (v) => (v === 'quit' ? exit() : go(v)),
    }));
}

// The token row only exists in token mode, so it is only a STOP in token mode — a cursor that
// lands on a field nobody can see is a key that appears to do nothing.
// v0.23: `jamName` is the TMUX session (the identifier) and `display` is what the jam is
// called. Two rows, because they are two things and the old single "jam name" row meant only
// the first one.
const hostFields = (access) => ['cwd', 'name', 'display', 'jamName', 'access',
  ...(access === 'token' ? ['token'] : []), 'remote', 'view', 'announce', 'extra', 'go'];

function Host({ back }) {
  const [rows, setRows] = React.useState(null);
  const [form, setForm] = React.useState({
    cwd: process.cwd(), name: process.env.USER || 'Host', jamName: '', display: '', access: 'knock',
    token: '', remote: 'off', view: false, announce: true, extra: '',
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
      if (field === 'announce') return set('announce', !form.announce);
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
    h(Field, { label: 'jam name', value: form.display, placeholder: `${defaultJamName(form.cwd)} (this directory's name)`, current: field === 'display', focused: field === 'display' && editing, onSubmit: done('display') }),
    h(Field, { label: 'tmux session', value: form.jamName, placeholder: 'claude-jam (what `claude-jam end` takes)', current: field === 'jamName', focused: field === 'jamName' && editing, onSubmit: done('jamName') }),
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
    // v0.23. The row says what it publishes and to whom, because that is the decision being made
    // here — not "a toggle called announce".
    h(Box, null, h(Box, { width: 16, flexShrink: 0 }, h(Text, { color: field === 'announce' ? C.accent : C.dim }, `${field === 'announce' ? '❯' : ' '} announce`)),
      h(Text, { color: C.dimmer }, form.announce
        ? 'on — people on this LAN can find it by name (they still have to get in)'
        : 'off — reachable only by an address you hand out')),
    h(Field, { label: 'claude args', value: form.extra, placeholder: 'e.g. --model opus', current: field === 'extra', focused: field === 'extra' && editing, onSubmit: done('extra') }),
    h(Box, { marginTop: 1, flexDirection: 'column' },
      h(Text, { color: C.dim }, 'this runs:'),
      plan.ok ? h(Text, { color: C.ok, wrap: 'truncate' }, `  ${plan.command}`)
        : h(Alert, { variant: 'error' }, plan.error)),
    h(Box, { marginTop: 1 }, h(Text, { color: field === 'go' ? C.accent : C.dimmer },
      `${field === 'go' ? '❯' : ' '} ${plan.ok ? 'Enter starts it' : 'fix the error above first'}`)));
}

// v0.23: the Join screen now opens on what is on this network. The pick comes first because the
// pick is the common case; "paste a link or URL" is the last row and never disappears, because a
// link is still how somebody joins a jam that is not on their LAN (or is deliberately silent).
//
// DISCOVERY IS NOT A KEY, and this screen is where that has to be visible: picking a jam does
// not connect you to it, it fills in the address. A knock still waits for the host, a token jam
// still asks for the token, and an invite-only jam says so and sends you to the paste row.
function Discover({ back }) {
  const [state, setState] = React.useState({ loading: true, rows: [], why: '' });
  const [pick, setPick] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    browseText({ type: DISCOVERY_TYPE, domain: DISCOVERY_DOMAIN, ms: FIND_MS })
      .then((got) => alive && setState({ loading: false, why: got.ok ? '' : got.why,
        rows: got.ok ? discoveredJams(parseDnssdZone(got.text)) : [] }))
      .catch((e) => alive && setState({ loading: false, rows: [], why: e.message }));
    return () => { alive = false; };
  }, []);
  useInput((i, key) => { if (key.escape && !pick) back(); });

  if (state.loading) {
    return h(Box, { flexDirection: 'column' }, h(Head, { title: 'Join a jam' }),
      h(Spinner, { label: 'looking for jams on this network…' }));
  }
  if (pick) return h(JoinFound, { row: pick, back: () => setPick(null) });

  const rows = joinRows(state.rows, { bin: BIN });
  return h(Box, { flexDirection: 'column' },
    h(Head, { title: 'Join a jam',
      hint: state.rows.length
        ? `${state.rows.length} on this network · picking one does not get you in · Esc back`
        : 'nothing announcing on this network · Esc back' }),
    // A refusal carries its reason: no mDNS tool is not an empty network, and saying so is the
    // difference between "nobody is hosting" and "this machine cannot look".
    state.why ? h(Box, { marginBottom: 1 }, h(Alert, { variant: 'info' }, state.why)) : null,
    h(Select, {
      visibleOptionCount: Math.max(4, Math.min(rows.length, (process.stdout.rows || 24) - 8)),
      options: rows.map((r) => ({ label: r.label, value: r.value })),
      onChange: (v) => (v === JOIN_PASTE_VALUE ? back(true) : setPick(rows.find((r) => r.value === v).row)),
    }),
    state.rows.length
      ? h(Box, { marginTop: 1 }, h(Text, { color: C.dimmer, wrap: 'truncate' },
        'a found jam still needs a knock, a token or an invite link'))
      : null);
}

// The second half of a pick: the name (always) and the token (only for a token jam). joinPlanFor
// decides what is still missing and why, so the screen never has to know the rules twice.
function JoinFound({ row, back }) {
  const [name, setName] = React.useState(process.env.USER || '');
  const [token, setToken] = React.useState('');
  const [at, setAt] = React.useState(0);
  const [editing, setEditing] = React.useState(false);
  const plan = joinPlanFor(row, { name, token });
  const fields = row.access === 'token' ? ['name', 'token', 'go'] : ['name', 'go'];
  const field = fields[Math.min(at, fields.length - 1)];
  useInput((i, key) => {
    if (key.escape) { if (editing) return setEditing(false); return back(); }
    if (editing) return;
    if (key.upArrow) return setAt((x) => Math.max(0, x - 1));
    if (key.downArrow) return setAt((x) => Math.min(fields.length - 1, x + 1));
    if (key.return) {
      if (field === 'go') { if (plan.ok) runAndExit(plan.argv, { note: plan.command }); return; }
      setEditing(true);
    }
  });
  const done = (setter) => (v) => { setter(v); setEditing(false); setAt((x) => Math.min(fields.length - 1, x + 1)); };
  // What actually happens next, said before it happens — a knock is a wait, and a wait nobody
  // warned you about reads as a hang.
  const what = row.access === 'knock' ? `${row.host} is asked to let you in — you wait until they do`
    : row.access === 'token' ? 'the token gets you straight in, with no approval'
      : row.access === 'invite' ? 'invite-only: a knock is refused, so you need a link'
        : 'this jam did not say how it lets people in — a knock is the thing to try';
  return h(Box, { flexDirection: 'column' },
    h(Head, { title: row.jam, hint: `${row.host} · ${row.access} · ${row.address} · Esc back` }),
    h(Box, { marginBottom: 1 }, h(Text, { color: C.dimmer }, what)),
    h(Field, { label: 'your name', value: name, current: field === 'name', focused: field === 'name' && editing, onSubmit: done(setName) }),
    row.access === 'token'
      ? h(Field, { label: 'token', value: token, placeholder: 'the host has it — 8-64 of [A-Za-z0-9_-]',
        current: field === 'token', focused: field === 'token' && editing, onSubmit: done(setToken) })
      : null,
    h(Box, { marginTop: 1, flexDirection: 'column' },
      plan.ok
        ? h(React.Fragment, null, h(Text, { color: C.dim }, 'this runs:'),
          h(Text, { color: C.ok, wrap: 'truncate' }, `  ${plan.command}`))
        : h(Alert, { variant: plan.needs === 'link' ? 'warning' : 'info' }, plan.error)),
    h(Box, { marginTop: 1 }, h(Text, { color: field === 'go' ? C.accent : C.dimmer },
      `${field === 'go' ? '❯' : ' '} ${plan.ok ? 'Enter joins' : 'fill in the above'}`)));
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
            setMsg(copyText(link)
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
  // v0.23: `claude-jam join` with no argument opens straight on the Join screen, which is the
  // discovery list. The launcher decides that; this only honours it.
  const [screen, setScreen] = React.useState(START);
  const back = () => setScreen('main');
  React.useEffect(() => { if (handoff) exit(); });
  if (screen === 'host') return h(Host, { back });
  // Join is two screens: the discovered list, and the paste form the last row leads to. Esc from
  // the paste form goes BACK to the list rather than out, so a mis-pick is one key to undo — and
  // when the launcher was started as `claude-jam join`, Esc from the list leaves the menu.
  if (screen === 'join') {
    return h(Discover, { back: (toPaste) => (toPaste ? setScreen('join-paste') : (START === 'join' ? exit() : back())) });
  }
  if (screen === 'join-paste') return h(Join, { back: () => setScreen('join') });
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
