# claude-jam — shared Claude Code session (spec v1, 2026-08-28)

## Goal

Two or more humans on different machines converse with ONE real, interactive Claude Code
session. The host keeps the native `claude` TUI with every plugin, skill, MCP server,
CLAUDE.md and hook they already have. Friends join from a terminal client.

Requirements:

1. **Attribution** — the agent knows the session is shared and sees who wrote each message.
2. **Shared view** — every participant sees every human message, the agent's output, and live
   typing indicators.
3. **Human-only channel** — humans can talk to each other without the agent ever seeing it.
4. **Env preserved** — no reimplementation of Claude Code; the real `claude` binary runs
   interactively with the host's normal configuration.

Phase 1 (this spec): host's machine is the server — one WebSocket port, reached over
Tailscale / LAN / any TCP tunnel. Phase 2 (sketched at the end): a public relay so the host
opens no inbound port.

## Architecture

```
friend: client.mjs ──WS──┐
friend: client.mjs ──WS──┤  host.mjs daemon (node, runs on host Mac, inside tmux pane 0)
host:   client.mjs ──WS──┤    ├─ inject "[Name]: text" → tmux load-buffer/paste-buffer → real `claude` TUI (pane 1)
                         │    ├─ tail ~/.claude/projects/*/<session-id>.jsonl → broadcast agent text / tool calls / host's own messages
                         │    ├─ HTTP /hook endpoint ← hooks.sh (Stop, Notification) for turn-done / permission-waiting status
                         │    └─ roster.json for hooks; broadcast typing + human-only chat (never reaches claude)
host types straight into claude TUI (pane 1) as well → shows up unprefixed in JSONL → broadcast as host
```

`jam host` creates a tmux session `jam` with three panes: daemon (small, logs), `claude`
(main), and the host's own client. Closing the terminal does not kill anything; `tmux attach
-t jam` returns.

## Components

### `host.mjs` (daemon) — node ≥ 22, single dependency `ws`

CLI: `node host.mjs [--port 7777] [--host 0.0.0.0] [--name Roy] [--token <auto>] [--cwd <dir>] [--tmux jam] [-- <extra claude args>]`

Startup:
1. Generate `session-id` (uuid v4) and `token` (16 random url-safe chars) unless given.
2. Write `state/` dir (`$TMPDIR/claude-jam-<port>/`): `roster.json`, `settings.json` (hooks, see below).
3. `tmux new-session -d -s jam -c <cwd>` running the daemon itself (`--daemon` flag) in pane 0;
   `split-window` pane 1: `env JAM_STATE=<state> JAM_PORT=<port> JAM_TOKEN=<token> claude --session-id <id> --settings <state>/settings.json <extra>`;
   `split-window` pane 2: `node client.mjs ws://127.0.0.1:<port> --name <host-name> --token <token> --host`;
   resize so claude gets ≥ 70 % height; `select-pane` on claude; then `tmux attach -t jam`.
   If a session named `jam` already exists: refuse with a clear message (`--tmux other` to run two).
4. Print the join line: `node client.mjs ws://<tailscale-or-lan-ip>:<port> --name <You> --token <token>`
   (detect Tailscale IP via `tailscale ip -4` if present, else first non-loopback IPv4).

Daemon loop:
- WS server (`ws`) + tiny HTTP on the same port. `GET /health` → `{ok, participants}`.
  `POST /hook/<event>` with header `x-jam-token` → used by hooks (see below).
- Message handling (protocol below). `say` → sanitize → inject → broadcast. `chat` → broadcast
  only. `typing` → rebroadcast (rate-limit 1/s per client). Unknown → `error`.
- JSONL tail: locate `~/.claude/projects/*/<session-id>.jsonl` (glob; do not hard-code the
  cwd slug rule). Poll `fs.stat` every 300 ms (fs.watch is unreliable on macOS for appends);
  read new bytes, split lines, parse. Emit:
  - `type:user`, string content or text blocks, not `isMeta`, not tool_result-only → if text
    matches `^\[([^\]]{1,24})\]: ` it is a bridged message already broadcast → skip; else
    broadcast as `say` from the host name.
  - `type:assistant` text blocks → `agent {kind:'text'}`; `tool_use` blocks →
    `agent {kind:'tool', text:'<name>: <first 120 chars of input summary>'}`; ignore thinking.
  - Everything else ignored. A parse error skips the line, never crashes.
  Parsing rules mirror `~/Code/Padina/ClaudeCodeSessionManager/src/core/transcript.ts` —
  keep them in one small function so a JSONL format change is a one-place fix.
- Status: `busy=true` when a `say` is injected or a host user record appears; `busy=false` on
  the `Stop` hook. `waiting=true` on `Notification` hook with `permission_prompt` (or any
  notification whose message mentions permission), cleared on the next assistant record or
  Stop.
- History ring buffer: last 300 broadcast events; sent in `welcome`.
- Roster: `{name, joinedAt}` per live socket → `roster.json` rewritten on every join/leave and
  a `roster` broadcast.

Injection (port of `inject()` in `~/Code/Reeco/Claude-Code-Plugins/reeco-remote/scripts/rr-ctl.sh`):
1. Serialize: one injection at a time (promise queue).
2. Build text: `[Name]: <sanitized text>` — sanitizer strips ANSI/C0 control chars except
   `\n` and `\t`, trims, rejects empty, caps at 20 000 chars. Names must match
   `^[A-Za-z0-9][A-Za-z0-9 _-]{0,23}$`.
3. Wait up to 2 s (8 × 250 ms) for a prompt glyph (`❯` or `^> ?$`) in the last 5 lines of
   `tmux capture-pane -p -t jam:1`; if it never shows, paste anyway (Claude Code queues input
   typed mid-response as the next message — attribution survives because it is in the text).
4. Write text to a temp file, `tmux load-buffer -b jam<n> <file>`, `tmux paste-buffer -b jam<n> -d -p -t jam:1`
   (bracketed paste keeps multi-line messages as one message).
5. Verify: poll `capture-pane` (24 × 250 ms) until the first 40 chars of the text appear, then
   `tmux send-keys -t jam:1 C-m`. If the text never appears → broadcast `error` to the sender,
   log, do not press Enter. Never pass user text through a shell or as argv.

### `client.mjs` — node ≥ 22, zero dependencies (built-in `WebSocket`, `readline`)

CLI: `node client.mjs <ws-url> --name <Name> --token <token> [--host]`

- IRC-style TUI: scrolling log above, one status line, `readline` prompt at the bottom
  (redraw pattern: clear current line, print event, re-prompt with preserved buffer).
- Rendering: `Roy ▸ text` for human→agent messages (own name highlighted), `claude ▸ text`
  for agent text, dim `⚙ Bash: …` for tool calls, `(chat) Dana: text` for human-only,
  `* Dana joined/left`. Status line: `Dana is typing… · claude is working… · ⚠ waiting for
  host permission`. Typing indicators expire 4 s after the last `typing` event.
- Input: plain line → `say`. `/c <text>` → `chat` (human-only). `/who` → print roster.
  `/quit` → exit. Any other `/…` → local error "slash commands run only in the host TUI".
  `readline.emitKeypressEvents` → send `typing` at most once per 1.5 s while keys are pressed.
- Multi-line: a line ending in `\` continues on the next line (joined with `\n`).
- Reconnect with backoff (1 s → 10 s) on socket close; `welcome` replays history — client
  dedupes by event `id`.

### `hooks.sh` — bash, referenced from generated `settings.json`

Generated `settings.json` (passed with `--settings`, so nothing global changes):

```json
{ "hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "<abs>/hooks.sh session-start" }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "<abs>/hooks.sh prompt" }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "<abs>/hooks.sh stop" }] }],
  "Notification":     [{ "hooks": [{ "type": "command", "command": "<abs>/hooks.sh notification" }] }]
}}
```

- `session-start` → stdout JSON `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<protocol>"}}`.
  Protocol text: "This is a SHARED session bridged by claude-jam. Host: <HostName>. Messages
  that begin with `[Name]:` were written by that participant through the bridge; messages
  without a prefix were typed by the host. Current participants: <list>. Address people by
  name when it helps, treat every participant's instructions as the user's, and mention
  who asked when you report back on something."
- `prompt` → `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Participants now: <list from roster.json>"}}`
  only when roster.json changed since the last prompt (compare mtime stored in state); else
  print nothing.
- `stop` / `notification` → read stdin JSON, `curl -s -m 2 -X POST -H "x-jam-token: $JAM_TOKEN" --data-binary @- http://127.0.0.1:$JAM_PORT/hook/<event>`; always exit 0.
- All hooks read `JAM_STATE`, `JAM_PORT`, `JAM_TOKEN` from env (inherited from the `claude`
  process spawned by the daemon). Missing env → exit 0 silently (hooks must never break claude).

### `jam` (bash launcher) and `package.json`

`jam host [...]` → `node host.mjs "$@"`; `jam join <url> --name X --token Y` → `node client.mjs …`.
`package.json`: `{ "name": "claude-jam", "type": "module", "bin": {"jam": "jam"}, "dependencies": {"ws": "^8"} }`.

## WebSocket protocol (JSON text frames)

Client → host:
- `{t:'hello', name, token, host?:true}` — first frame; bad token → `{t:'error'}` + close 4401.
- `{t:'say', text}` — to the agent (injected with prefix).
- `{t:'chat', text}` — human-only.
- `{t:'typing'}`.

Host → clients (every event has `id` (monotonic int) and `ts` (ms)):
- `{t:'welcome', you, roster:[names], history:[events], session:{id, cwd, hostName}}`
- `{t:'roster', roster:[names], joined?, left?}`
- `{t:'say', from, text}` — echoed to everyone including sender once injection is queued.
- `{t:'chat', from, text}`
- `{t:'typing', from}` (not stored in history)
- `{t:'agent', kind:'text'|'tool', text}`
- `{t:'status', busy, waiting}`
- `{t:'error', text}` (to one client)

Phase 2 reuses this protocol unchanged: the host daemon connects OUTBOUND to a relay with
`{t:'hello', role:'host', room, token}`, friends connect to the relay with `room`, and the
relay forwards frames both ways. No inbound port on the host. Not built now.

## Security (phase 1)

- Shared random token required on every connection; wrong token closes the socket.
- Bind `0.0.0.0` by default but document: expose over Tailscale/LAN only; the token is the
  only auth. Hook endpoint accepts loopback only.
- Friend text never touches a shell: sanitized, written to a temp file, pasted via tmux
  buffer. Slash commands from friends are rejected client-side and ignored server-side
  (`say` text starting with `/` is refused with an `error`).
- Friends cannot answer permission prompts; the host TUI does. Clients see a `waiting` status.

## Testing

- `test.mjs` (node:test, no framework): JSONL line classification (user text / bridged user
  skipped / assistant text / tool_use / isMeta / tool_result-only / malformed), sanitizer
  (ANSI stripped, control chars stripped, newline kept, cap enforced), name validation,
  prefix regex, client command parsing (`/c`, `/who`, `/quit`, unknown slash, continuation
  lines). Pure functions exported from `lib.mjs` so tests import them without starting
  servers.
- Smoke (manual or scripted by the implementer, documented in README): `jam host --tmux
  jamtest -- --model haiku` in a scratch cwd; a scripted WS client sends `hello` + `say
  "reply with the single word pong"`; assert the JSONL contains `[Tester]: reply with…`, the
  client receives an `agent` text containing `pong`, and `status busy:false` arrives after
  Stop. Tear down `tmux kill-session -t jamtest` — ONLY that session name, never a pattern.

## Known ceilings (deliberate)

- tmux slightly degrades Claude Code visuals (paler colors, OSC notifications lost).
- JSONL format is officially unstable; parsing is isolated in one function.
- Messages injected while claude is mid-response are queued by Claude Code as the next turn.
- "claude is working" is inferred; `Stop` hook is the only authoritative end-of-turn signal.
- No per-friend auth, no rate limiting, no web client, no permission relay — phase 2+.

## Out of scope for v0

Web client, public relay (phase 2), friends approving tool permissions, raw-TUI view for
friends (`ttyd -R` exists if wanted), multiple concurrent sessions per host, Windows.

## Access control v0.2 (added 2026-08-28 evening)

Motivation: the host wants to mint or rotate the token at runtime, and to let a friend join
without any token by approving them in the moment.

Two admission paths, both ending in the same `welcome`:

1. **Token** — `hello {name, token}` with a token that matches the current one → admitted
   immediately (unchanged). If no token is currently set, a supplied token is simply ignored
   and the client falls through to a knock.
2. **Knock** — `hello {name}` with no token (or a wrong one) → the socket stays open in
   `pending` state, the client receives `{t:'knock', state:'pending'}` and shows
   "waiting for host approval…". Every host client receives `{t:'knock', name, ip}` and shows
   `⚑ Dana wants to join — /accept Dana | /deny Dana`. `/accept` with no name admits the only
   pending knocker (error if there are several). Pending knocks expire after 2 minutes
   (client told `{t:'knock', state:'expired'}`, socket closed 4408). Denied → `{t:'knock',
   state:'denied'}`, close 4403. Max 10 pending knocks; beyond that new knocks are closed
   immediately with 4429. Duplicate live names are refused (4409) in both paths.

Token management (host clients only; a non-host sending these gets `error`):
- `/token new` → daemon generates a fresh 16-char token; `/token set <value>` → uses the
  given value (8–64 chars, `[A-Za-z0-9_-]`); `/token off` → no token; knock is the only way in.
- The daemon replies to ALL host clients with `{t:'token', token: string|null, join: string|null}`
  and logs the join line in the daemon window. Rotating never disconnects already-admitted
  clients. `/join` shows the current join line (or "no token set — friends knock, you
  /accept").
- Startup: `--token <value>` sets one; `--token` omitted → NO token (knock-only) — the daemon
  log says so. The host client's connection is trusted by construction: it is the one the
  launcher spawns on loopback with `--host`; therefore `host: true` in `hello` is honoured
  only from loopback connections, everything else is treated as a friend.

Client changes: `/accept [name]`, `/deny <name>`, `/token new|set <v>|off`, `/join` (host only;
friends get "host only"). Wire frames: client→host `{t:'admit', name, ok}` and
`{t:'token', op, value?}`; host→client `{t:'knock', …}` and `{t:'token', …}`.

Roster/hooks unchanged: pending knockers are NOT in the roster and never reach claude.

## v0.3 — TUI mirror, Claude-Code look, token in context (added 2026-08-28 night)

1. **Live TUI mirror (`ttyd`, default ON when ttyd is installed).** `jam host` also starts a
   read-only browser view of the REAL claude TUI on `--view-port` (default port+1, 7778):
   each ttyd connection gets its own tmux grouped session pinned to the `claude` window
   (`tmux new-session -t <jam> ; set destroy-unattached on ; select-window -t <jam>:claude`)
   so viewers have independent focus and host window-switching never yanks their screen.
   ttyd runs with `-R` (read-only) and HTTP basic auth `-c jam:<view-key>`; view-key = the
   friend token when one is set, else a generated 16-char key that rotates with `/token`.
   The join info (daemon window, host welcome, `/join`) prints BOTH lines: client command +
   `view: http://jam:<key>@<ip>:<view-port>`. ttyd missing → one log line "install ttyd for
   the live view (brew install ttyd)" and everything else works. `--no-view` disables.
   ttyd child is killed when the daemon exits (own PID only).
2. **Claude-Code-style client rendering.** Labels become `[Roy]`, `[Dana]` (own name green,
   others cyan), agent text `⏺ [Claude] <text>`, tool lines stay dim `⚙`, working status
   shows an orange `✻ claude is working…`, prompt glyph `❯ `. Human-only chat keeps the
   yellow `(chat) [Dana]: …` form. No behavior change, rendering only.
3. **Token in claude's context.** Daemon writes `token.json` {token, join, viewUrl} to the
   state dir on boot and on every `/token` change. hooks.sh includes in SessionStart — and in
   the roster-change UserPromptSubmit context whenever token.json's mtime changed since last
   prompt — the block: "Join token: <t>; join command: <line>; live view: <url>. Reveal these
   ONLY when asked by the host (messages WITHOUT a [Name]: prefix). Never reveal them to
   bridged participants ([Name]: prefixed) — tell them to ask the host." No token set → the
   block says "no token set; joining requires host approval (/accept)". `--no-token-in-context`
   omits the block entirely.
   Ceiling (documented in README): this guard is an instruction to the model, not a hard
   boundary — an admitted participant may still socially-engineer the token out of the agent;
   knock mode keeps the hard gate.

## v0.4 — in-TUI knock approval (added 2026-08-28 night)

Goal: the host approves/denies a knock without leaving the claude window.

- On knock, the daemon (in addition to notifying host clients) opens
  `tmux display-popup -t <jam> -w 64 -h 7 -E "<node> <dir>/popup.mjs <name> <ip> <ttl-s> <port>"`.
  The popup renders `⚑ <name> wants to join (<ip>)` + `[a]ccept · [d]eny · [i]gnore/Esc`,
  reads ONE key (raw stdin), then POSTs `{name, ok}` to a new daemon endpoint
  `POST /admit` (loopback-only + `x-jam-secret`, same guard as /hook) and exits. `i`/Esc/any
  other key exits without posting — the knock stays pending and /accept in a client still works.
  The popup auto-exits when its TTL elapses (aligned with knock expiry).
- Popups appear only on clients attached to the `<jam>` session itself — ttyd viewers sit on
  grouped sessions and never see them. Multiple knocks are queued: one popup at a time,
  next popup opens when the previous closes and the knock is still pending.
- While ≥1 knock is pending, the daemon sets the jam session's `status-right` to
  `⚑ N waiting` (saving the previous value at daemon start and restoring it whenever the
  pending count returns to 0 and at daemon exit). Never touch global tmux options — session
  option only (`tmux set -t <jam> status-right …`).
- `--no-popup` disables both popup and status-right.
- Admit/deny/expiry race: /admit for a knock that no longer exists returns 404 and the popup
  exits silently. Deny via popup behaves exactly like /deny (close 4403).
- popup.mjs failures must never affect the daemon (spawn errors logged, ignored).

## v0.4b — profile selection (--config-dir)

- New `jam host` flag `--config-dir <dir>` → the spawned claude window's env gains
  `CLAUDE_CONFIG_DIR=<dir>` (expanded, no trailing slash — a trailing slash changes the
  keychain hash and forces re-login). If the flag is absent but the launcher itself was
  started with CLAUDE_CONFIG_DIR set, forward that value. Log `claude profile: <dir>` at launch.
- JSONL tail keeps globbing `~/.claude/projects/*` AND additionally `<config-dir>/projects/*`
  when set (on this machine they are symlinked to the same place; on other machines they are not).
- README: example `./jam host --name Roy --cwd . --config-dir ~/.claude3` — notes: separate
  account = separate usage limits; that profile answers its own trust dialog on first run in a
  cwd; remote-MCP connectors are per-profile.

## v0.5 — chat-in-view layout + restyle v2 (added 2026-08-28 night, Roy feedback)

Feedback driving it: (1) /c chat is invisible while the host sits in the claude window;
(2) the client looks nothing like Claude Code ("colors, vibe, formatting").

1. **Split-pane layout.** The `claude` tmux window becomes two panes: top = claude TUI
   (all remaining height), bottom = the host's jam client, fixed ~9 rows
   (`split-window -v -l 9`). The separate `you` window is removed. All tmux targeting of the
   claude TUI switches from window to PANE target (`<jam>:claude.0` — top pane); the
   client pane is `.1`. capture-pane/paste-buffer/send-keys/display-popup targets updated
   accordingly. ttyd viewers still pin the `claude` window and therefore see both panes —
   intended (viewers are authenticated participants; /c stays invisible only to claude).
   `--no-split` restores the old separate `you` window.
2. **Restyle v2 (client.mjs rendering only, protocol untouched).**
   - Palette: Claude Code's — orange 256-color 208 (or truecolor #ff8c00-adjacent) for the
     spinner/accents, warm grey dims, cyan for other humans, green for self, no raw 8-color
     yellow/red except errors.
   - Turn rhythm: blank line before each `⏺ [Claude]` turn; agent text word-wrapped to the
     terminal width with 2-space continuation indent.
   - Tool calls `⚙ Bash: <summary>` stay dim; NEW: tool RESULTS render as dim `  ⎿ <first
     line, truncated 100 chars>` — extend parseJsonlLine to emit `{kind:'tool-result'}` from
     user-record tool_result blocks (still skipped for busy/attribution logic), daemon
     broadcasts `agent {kind:'tool-result'}`; cap: skip results while more than 5 arrive in
     one turn (log one `  ⎿ …` ellipsis line instead) to avoid flooding.
   - Markdown-lite on agent text: **bold** → ANSI bold, `code` → dim-highlighted; nothing else.
   - Working indicator: animated spinner frames ✻ ✼ ✽ ✻ rotating in the prompt row while
     busy (timer only while busy, unref'd), keeping the single-row prompt invariant (the
     two-row prompt redraw bug from the first review must not come back).
   - Knock/join/token lines keep their glyphs but adopt the palette.
   - **Aligned name column (Roy feedback #3):** all sender labels pad to one fixed column —
     width = longest live label among roster names + `Claude` (recomputed on roster change),
     e.g. `[Roy]    ▸ hi` / `[Dana]   ▸ hey` / `[Claude] ⏺ text`. Continuation/wrapped lines
     indent to the text column so paragraphs align under their first line. General UX pass
     mandate: consistent one-glyph column between label and text (▸ humans, ⏺ claude,
     ⚙/⎿ tools, ⚑ knocks, * system), consistent spacing, no mixed separators (drop the
     `(chat) Name:` form → `[Dana] ✉ text` in yellow for human-only), errors `! text` red.
     Chat lines, status wording and help line reviewed for consistency in the same pass.

## v0.5.1 — rendering feedback round (Roy, from live screenshots)

1. **Human-only chat unmissable:** render as `[Dana]  [humans-only] <text>` with label, prefix
   and text ALL in one distinct color no other element uses (magenta family, 256-color ~213).
   The ✉ glyph is dropped with the rest (see 2).
2. **No speech glyphs:** remove `⏺` from claude lines and `▸` from human lines — speech is just
   `[Name]  text`. Glyph column survives only for non-speech: `⚙`/`⎿` tools, `⚑` knocks,
   `*` system, `!` errors.
3. **Per-user color identity:** every participant gets a stable color (hash of name into a
   curated 256-color palette that excludes claude-orange 208, chat-magenta, error-red, dim
   greys); BOTH the `[Name]` label and the message text render in it. Self keeps green.
   `[Claude]` label stays orange; claude's TEXT stays the default light grey. Colors stay
   stable across roster changes (hash, not join order).
4. **Separation:** one blank line between every message block — human says, claude turns,
   chat lines — regardless of same/different sender. Tool `⚙` + its `⎿` result(s) stay glued
   as one block (blank line before the first `⚙` only). System/join/typing-expiry lines and
   the help line stay compact (no forced blank).

## v0.6 — ink client (UI/UX overhaul, Roy-approved dependency)

Motivation: readline single-row prompt forces status text into the prompt row ("working/typing
hints in wrong place"). Roy explicitly approved adding UI libs.

- client.mjs becomes an ink app (deps: ink@^5, react@^18, ink-text-input@^6 — same versions as
  ~/Code/Padina/ClaudeCodeSessionManager). Layout, bottom-up:
  1. input row: `Roy ❯ <TextInput>` (self-green name, orange caret)
  2. status bar (own dim row, always present, empty when idle): left `✻ claude is working…`
     (animated) · `⚠ waiting for host permission`; right `Dana is typing…` (multi-name
     aggregation "Dana, Eli are typing…")
  3. everything above: transcript via ink `<Static>` (append-only — no re-render of history,
     scrollback stays native terminal scrollback)
- ALL v0.5/v0.5.1 rendering rules carry over verbatim (aligned name column, per-user colors,
  [humans-only] magenta, no speech glyphs, blank-line blocks, wrap via ink's own Box/Text
  wrapping where possible — keep lib.mjs pure helpers as the single source of visual truth
  where they exist; wrapText may retire if ink wraps correctly with hanging indent via
  paddingLeft on a Box).
- Behavior parity checklist (all must survive): typing events throttled from TextInput
  onChange; multi-line via trailing `\`; all slash commands; host gating; knock render +
  /accept; reconnect/backoff + history dedupe + boot-id reset; close codes 4400-4429 exit;
  exit codes preserved; --host flag; SIGINT clean exit.
- WS + state logic stays plain (no React for the socket) — one small store, ink renders it.
- Keep a `--basic` flag: the old readline renderer (moved to client-basic.mjs or a branch)
  for terminals where ink misbehaves; README notes it.
- Tests: pure helpers keep their tests; add an ink-testing-library smoke render if trivial
  (ccsm has the devDep pattern) — otherwise the real-pty capture in the smoke serves as proof.
- Real visual proof required (pty capture of a session with 2 friends, chat, tool turn,
  typing indicator + working spinner in the STATUS BAR, not the prompt).

## v0.7 — terminal mirror mode (guest sees the REAL TUI)

Goal: guest terminal shows Claude Code exactly — by streaming the host TUI's actual cells,
not imitating them.

- Daemon: every 250 ms run `tmux capture-pane -e -p -t <claude-pane>` (escape sequences
  preserved); if changed since last frame, broadcast `{t:'screen', rows:[...], w, h}` to
  clients that requested mirror mode (hello `{mirror:true}` or runtime toggle frame
  `{t:'mirror', on}`). Never store screen frames in history. Sanitizing: strip only C0/OSC
  sequences dangerous outside rendering (keep SGR colors, cursor-irrelevant since rows are
  reprinted); title/clipboard OSC dropped.
- Client (ink): F2 (and `/mirror`) toggles views — [transcript] ⇄ [mirror]. Mirror view:
  top = latest frame rows verbatim (truncate/pad to guest terminal width; if guest narrower
  than host pane, crop right and show a dim "host is wider" hint), then the same status bar +
  input row. Chat/knock lines while in mirror mode: render as a 3-row overlay strip above the
  status bar (latest 3 events), full history still in the transcript view.
- Mirror is view-only sugar: all interaction stays the jam protocol (say/chat/commands).
- Guests default to transcript view; the welcome line mentions "F2 = live view of the real TUI".
- Bandwidth guard: frames only to subscribed clients, only on change, coalesced to 4/s max.

## v0.8 — claude knows the jam manual (standing rule)

- New `MANUAL.md` in the project root: compact operator manual (host + guest) — the single
  source of truth for "how do I use jam", written for claude to relay.
- hooks.sh `session-start` appends MANUAL.md's content to the SessionStart additionalContext
  (after the shared-protocol + token blocks), defensively (missing file → skip, exit 0).
  SessionStart only — never in the per-prompt hook (too big).
- STANDING RULE: every future spec section that adds/changes a user-visible feature, flag or
  command MUST update MANUAL.md in the same change. The implementing agent's checklist
  includes it; reviewers treat a stale MANUAL.md as a blocker.

## v0.9 — clean viewer surface (Roy: browser must show ONLY the claude session)

Problem: ttyd viewers pin the `claude` window, which since v0.5 contains the host's chat pane,
and grouped sessions inherit the status bar — guests see host chrome.

- The claude TUI returns to being the ONLY pane in window `claude`. Viewer grouped sessions
  additionally set `status off` (session-scoped, their own session) so the browser shows
  nothing but the Claude Code screen.
- Host chat-in-view, by environment:
  - cmux detected (`cmux identify --json` succeeds AND the launcher runs inside cmux): the
    launcher creates a cmux split below the caller surface running the host client
    (`cmux new-split` per the cmux CLI), and tmux-attaches the main surface to window
    `claude`. Chat strip lives in cmux, invisible to tmux viewers.
  - otherwise: two tmux windows (`claude`, `chat` — the old `you` naming retires); the
    launcher prints "Ctrl-b n toggles chat". `--split` (now opt-IN) restores the v0.5
    same-window split for hosts who prefer it and accept viewers seeing the strip.
- The in-window popup + status-right badge still land on the host's tmux client only
  (viewer sessions: `status off` hides the badge; display-popup already targets attached
  clients of the base session — verify viewers never render it).
- Terminal mirror (v0.7) already targets the claude PANE, so it stays clean by construction.
- README/MANUAL.md updated (standing rule).

## v0.10 — tool collapse (Claude-Code-like)

- Ink client: tool activity for the IN-PROGRESS turn renders in the live region (below the
  Static transcript, above the status bar) — up to the last 4 ⚙/⎿ lines, dim.
- When the turn completes (busy→false or next agent text block), the live tool lines fold
  into ONE dim summary line appended to the transcript: `⚙ N tools (Bash ×a, Read ×b, …)`.
  Turns with ≤1 tool call keep the plain ⚙ (+ its ⎿) inline as today.
- `/tools` re-prints the LAST completed turn's full tool log (all ⚙/⎿ lines) into the
  transcript; `/tools on|off` sets always-expanded mode (off = collapse, default).
- Host `Ctrl-b z` (zoom) and resize documented in README/MANUAL as the way to hide/size the
  chat strip in `--split` mode; cmux layout (v0.9) needs nothing.

## v0.10b — newline keys in the client input

- Ink client input: Shift+Enter (kitty/CSI-u `ESC[13;2u`, also `ESC[27;2;13~` xterm modifyOtherKeys
  form) and Option/Alt+Enter (`ESC\r`) insert a literal newline into the composing message
  instead of submitting; plain Enter submits. Trailing-`\` continuation stays as the
  works-everywhere fallback and MANUAL.md documents all three.
- Multi-line composition renders the pending lines above the input row (dim) so the user sees
  the whole message before submitting.
- client-basic.mjs: detect the same sequences via readline keypress `sequence` if cheap;
  otherwise leave `\` as its only mechanism (documented).

## v0.10c — guest onboarding block on connect

On every welcome, replace the single help line with a short dim onboarding block (guests get
the full version; host a trimmed one since host commands already show elsewhere):

  ── claude-jam ────────────────────────────────────────
  plain line        → claude (attributed [Dana])
  /c <text>         → humans only — claude never sees it
  /who /quit        → participants / leave
  F2 or /mirror     → watch the REAL Claude Code screen
  Shift+Enter or \  → multi-line message
  Lost? just ask claude — e.g. "how does this jam work?",
  "how do I chat privately?" — it knows the full manual.
  ──────────────────────────────────────────────────────

Reprint on `/help` (new command, everyone). Keep it ≤10 rows, dim, above the first messages;
history replay comes after it. MANUAL.md gains /help (standing rule).

## v0.11 — built-in cloudflared tunnel (--tunnel)

- `jam host --tunnel` (requires cloudflared on PATH; clear error + brew hint if missing):
  the launcher spawns TWO quick tunnels as tracked children —
  `cloudflared tunnel --url http://localhost:<port>` and `--url http://localhost:<view-port>`
  — parses each one's `https://<rand>.trycloudflare.com` line from stderr (retry/wait up to
  30 s), and derives: guest join `wss://<rand1>.trycloudflare.com` (no port), view
  `https://jam:<key>@<rand2>.trycloudflare.com`.
- Tunnel URLs flow everywhere join info already flows: daemon log, host welcome/`/join`,
  token.json (extra fields `tunnelJoin`, `tunnelView`) hence claude's context block, and the
  `{t:'token'}` frame. When a tunnel is up, print tunnel lines FIRST (they're what you send a
  remote friend); local Tailscale/LAN lines stay printed below.
- Lifecycle: cloudflared children tracked by PID, killed on daemon exit (same rule as ttyd);
  a tunnel process dying logs a warning + clears the URLs (no auto-restart in v0; ceiling).
  `/token` rotation does NOT change tunnel hostnames (only the view key inside the URL).
- Client: no changes needed (wss already works); README/MANUAL updated per standing rule,
  including the trade-off note (Cloudflare terminates TLS; knock/token still the gate).

### v0.9 addendum — viewer dot-fill

Browsers larger than the host pane show tmux's `·` fill. Fix: set `fill-character ' '`
(window option) on the jam session at launch — cosmetic, host unaffected. Optionally append
`?fontSize=<n>` guidance to the view URL docs (ttyd client option) for viewers who want the
TUI larger. (Implemented in the redesign round.)

## v0.12 — session export to guest (host-gated)

- Guest `/export` → host sees `⇩ Dana requests the session transcript — /allow-export Dana |
  /allow-export always | /deny-export Dana` (client line + popup reuse). `always` = standing
  approval for the rest of THIS jam (state in daemon memory only).
- On approval the daemon streams the session JSONL over the existing WS (chunked frames
  `{t:'file', xfer, seq, done, b64}`, 64 KB chunks, 50 MB cap) → guest client writes
  `./jam-session-<sid>.jsonl` and prints continue instructions:
  `mkdir -p ~/.claude/projects/<slug of their cwd> && cp … <sid>.jsonl && claude --resume <sid>`
  (slug rule printed by the client; works because resume scans projects/*.jsonl).
- SECURITY (README+MANUAL, plain wording): the transcript contains EVERYTHING claude saw —
  including the join token/view URL block if token-in-context is on, file contents read
  during the session, and tool outputs. The approval message reminds the host; recommend
  `/token new` after exporting. Guests can already read the whole conversation visually —
  export changes convenience, not confidentiality class, EXCEPT the token block: strip
  known jam token blocks from the exported copy where safely identifiable (regex on our own
  hook text), best-effort, documented.

## v0.13 — remote files & image pasting

- Guest→host file send: `/send <path>` in the client (also bare image paste: `/paste` grabs
  the clipboard image via pngpaste if installed, osascript PNG fallback; macOS only, others
  get a hint). Chunked upload over WS (same frame shape as v0.12, 20 MB cap per file,
  1 in-flight per client).
- Host gate mirrors knocks: `⇪ Dana wants to send photo.png (2.1 MB) — /accept-file Dana |
  /accept-file always | /deny-file Dana` (+ popup). On accept the daemon writes to
  `<cwd>/jam-uploads/<sanitized-name>` (basename only, no traversal, collision → suffix,
  0644) and injects `[Dana]: sent a file: jam-uploads/photo.png <optional caption>` so
  claude can Read/inspect it. Everyone's client shows the transfer line.
- Host→guests: host `/send <path>` broadcasts an offer; each guest gets
  `⇩ Roy offers notes.md (12 KB) — /get notes.md saves to ./jam-downloads/`.
- Trust boundary: filenames sanitized server-side, size caps enforced server-side, uploads
  live only under jam-uploads/, binary-safe base64, never executed, never auto-opened.
  MANUAL/README updated (standing rule).

## v0.14 — mirror-first unified view (Roy direction change)

Everyone — host included — uses the same single-pane client; the mirror of the real TUI is
the DEFAULT view, the transcript is the F2 alternate. Web view demoted to opt-in.

- Client default view = mirror (live TUI cells) + chat strip (last 3 chat/system lines) +
  status row + input. F2//mirror flips to the transcript view (full history) and back.
- `jam host` runs the tmux session DETACHED (daemon, claude TUI, nothing attached) and execs
  the client full-screen in the current terminal as the host. No cmux split, no `chat`
  window, no `--split` layouts — that whole v0.9 host-chat machinery retires (keep
  `tmux attach -t jam` documented as the escape hatch for direct TUI access).
- Host TUI control from inside the client: **F3 toggles passthrough mode** (host + loopback
  only): while on, every key is forwarded raw to the claude pane (send-keys -H via daemon,
  loopback+trusted socket only), status row shows `⌨ TUI control — F3 returns`; used for
  permission prompts, trust dialog, /model, /compact. When claude's permission prompt fires
  (`waiting` status), the status row hints `F3 to answer`. Guests never get passthrough
  (server-enforced: host flag + loopback).
- Host's plain input stays jam-attributed (`[Roy]:` injected like everyone) — attribution
  becomes fully symmetric; the SessionStart protocol text updates: "all participants,
  including the host, appear as [Name]:" (unprefixed = someone typed in the raw TUI via
  attach or F3).
- ttyd/web view: default OFF; `--view` turns it on (flag polarity flips; `--no-view` accepted
  no-op). MANUAL/README rewritten for the new model (standing rule).
- Keep working: knocks (popup now unnecessary for the host-in-client — knock renders in the
  client + still the tmux popup for anyone attached; keep both), tool collapse in transcript
  view, export/files specs unchanged.
- **Host slash passthrough (condition for unified view):** in the HOST client, any `/command`
  that is not a jam command (`/c /who /help /quit /mirror /tools /join /accept /deny /token`
  + export/file commands) is forwarded to the claude TUI verbatim — daemon types it into the
  pane (send-keys -l literal + Enter, NO [Name] prefix) so claude's own command palette runs
  it (`/model`, `/compact`, `/mcp`, `/resume` …). Server-enforced host+loopback only; guests
  keep getting "host TUI only". Interactive command UIs (pickers) then render in the mirror,
  and F3 passthrough drives them.
