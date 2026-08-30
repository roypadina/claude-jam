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
- **Guest slash commands (host-gated):** a guest's non-jam `/command` becomes a request:
  guest sees `sent to host for approval`, host client (and popup) shows
  `⌘ Dana wants to run /compact — /allow-cmd Dana | /allow-cmd always | /deny-cmd Dana`.
  Approved → daemon types it into the TUI exactly like a host slash passthrough, and
  broadcasts `* Dana ran /compact (approved by Roy)`. `always` = standing approval for that
  guest for THIS jam. Dangerous by nature (commands change the session for everyone) —
  default deny, never auto-approve, and `/allow-cmd always` excludes `/exit`, `/clear`,
  `/resume` (session-lifecycle commands stay host-only, hard list server-side).

## v0.14 — the full ceiling list (moved out of the README, 2026-08-29)

The public README keeps a short list. This is all of them.


- tmux slightly degrades Claude Code visuals — paler colors, OSC notifications lost.
- The JSONL format is officially unstable. All parsing lives in `parseJsonlLine` in `lib.mjs`,
  so a format change is a one-place fix.
- A message injected mid-response is queued by Claude Code as the next turn, not merged.
- `busy` is inferred; the `Stop` hook is the only authoritative end-of-turn signal. It fires
  before claude has flushed the turn's last record, so the `Stop` handler drains the JSONL
  tail until the file goes quiet (≤ 2 s) and only then pushes `busy:false` — so the final
  `agent` text now always arrives before `busy:false`, instead of ~300 ms after it.
- Injection verifies by looking for the message's own first visual line (up to 40 chars, less
  on a narrow pane) in the pane, so two identical consecutive messages could match a stale
  echo. Nonce-prefix it if that ever bites.
- Friends cannot answer permission prompts; the host does that with F3 (or by attaching).
  A friend's slash command runs only after the host approves it, and never at all if it is
  `/exit`, `/clear` or `/resume`.
- Admission is per person (`/accept`), but there are still no per-friend credentials: once in,
  everybody is equally trusted, and `/deny` cannot kick somebody who is already admitted.
- A knock popup that is answered elsewhere (a client's `/accept`, or the knock expiring) stays
  on screen until a key or its TTL closes it, and it holds the queue while it is there — the
  daemon is the source of truth, so it just gets a 404. A knock that arrives while nobody is
  attached gets no popup at all, and none is re-opened when a client attaches later.
- `status-right` is snapshotted once, when the daemon starts. Changing it yourself while jam
  is running means the next restore puts the daemon's snapshot back, not your newer value.
- The claude window is sized for the host's mirror, and `resize-window` pins it: an attaching
  client (a `tmux attach`, a second browser viewer) gets blank padding instead of reshaping it,
  and if something does take the size the daemon only puts it back once nobody is attached —
  while you are attached, the size is yours. Two viewers of different sizes means the smaller
  picture wins for one of them; that is tmux, not jam.
- The host's client tracks its terminal, not the other way round: on a terminal that never
  reports a size (a pipe, some CI shells) the window falls back to 80x19 and the mirror is that
  small for everyone. Resize the terminal once and it corrects itself.
- More than five tool results in one turn collapse to a single `⎿ …`; the full output is in
  the host's TUI, and the count resets on the next turn.
- The live tool region shows the last four `⚙`/`⎿` lines, and which of the two you see is up
  to the turn: seven `tool_use` blocks in ONE assistant record arrive together, so the four
  newest lines can all be `⎿` results. `/tools` after the turn has the whole list.
- `/tools` remembers one turn — the last completed one. A summary line scrolled off the screen
  cannot be expanded again; the host's TUI keeps everything.
- The mirror streams the pane as it is, so a guest with a shorter terminal sees the **bottom**
  of it and a host pane much taller than the guest's window looks half empty (that blank space
  is really there). Cropping is reported, never compensated for; the `⚙`/status rows and the
  input box are always in the kept part, which is what a watcher wants.
- Mirror frames are not history: a client that flips to the mirror before the first frame
  arrives sees `waiting for the host's screen…` for up to 250 ms, and a reconnect re-subscribes
  from scratch. Nothing older than "now" is ever streamed.
- The transcript printed before the mirror went up stays on screen above the frame (`<Static>`
  output belongs to the terminal, not to ink). Lines that arrive *during* the mirror are held
  back and flushed on the way out, so ordering survives, but the frame is drawn under whatever
  was already there.
- The key filter holds a partial escape sequence only when it is longer than one byte, so a
  chunk boundary falling exactly after the `ESC` of `ESC[13;2u` leaks `[13;2u` as text. A
  terminal writes a sequence in one `write()`, so this has not been observed; the alternative
  (holding a lone `ESC`) would swallow the Escape key.
- `Shift+Enter` needs a terminal that actually sends `ESC[13;2u` / `ESC[27;2;13~` (kitty,
  Ghostty, WezTerm, iTerm2 with CSI-u on, tmux passing them through); `Option+Enter` needs
  Alt-as-ESC. A trailing `\` is the mechanism that works everywhere, and `--basic` has only
  that one.
- The live view, the tool collapse, the newline keys and F2/F3 are ink-only: `--basic` appends
  lines and never redraws, and it reads stdin through readline instead of the key filter. It is
  a transcript-only client, and its onboarding footer says so.
- Markdown-lite is applied per logical line, so a `**bold**` or `` `code` `` span that straddles
  an explicit newline renders with its markers visible instead of styled. (In `--basic` it is
  applied per already-wrapped line, so a soft wrap breaks a span there too.)
- The transcript is append-only, so a line keeps the label-column width and the terminal width
  it was drawn at: widening the column (a long name joining) or resizing the terminal aligns
  everything from that point on, not what is already on screen. Redrawing history is what
  `<Static>` exists to avoid.
- The invite/view lines are handed to the terminal unwrapped on purpose, so they stay one
  selectable run. On a pane narrower than the line (~85 columns) that means a soft wrap; the
  copy is still whole, but a terminal that does not reflow on copy will paste a newline into
  the command.
- ink needs raw mode on stdin. With a pipe or a heredoc the client falls back to `--basic`
  automatically; a terminal ink dislikes for any other reason needs the flag by hand.
- `--config-dir` picks the profile; it cannot log it in. A brand-new profile lands in claude's
  first-run onboarding, which only you can answer, in the `claude` window.
- The token-in-context guard ("reveal only to the host") is an instruction to the model, not
  a boundary. And a `kill -9` of the daemon orphans the ttyd child — that pid is logged at
  launch.
- `--tunnel`: a dead `cloudflared` child is never auto-restarted (v0 ceiling) — its line just
  disappears from `/join`/the daemon log until the host restarts with `--tunnel` again. The
  tunnel hostnames are fixed for the daemon's whole life; only `/token` off/on can drop or
  regenerate the *credential* inside the URL, never the host itself. Cloudflare's edge
  terminates TLS, so it (and anyone who can see its logs) is a party to the connection the
  same way any TLS-terminating proxy is — the join token / knock approval is what actually
  gates who gets in, same trust model as the LAN case. No IP allow-listing on a quick tunnel:
  the URL itself is the only thing standing between a stranger and a knock/wrong-token attempt.
- F3 passthrough is raw by design: the host's bytes reach claude unsanitized (that is what
  answering a prompt means). The gate is the socket — `--host` **and** loopback, i.e. the client
  the launcher spawned — plus a size cap per frame. Anything else on loopback that speaks the
  protocol could claim the same trust; on a shared machine, that is the boundary to know about.
- Slash passthrough types the command and presses Enter after 300 ms. claude's palette filters
  as you type and Enter picks the highlighted row, so a command whose name is a prefix of
  another could in principle submit the neighbour; every real command name we tried resolved to
  itself. A picker that opens instead is normal — drive it with F3.
- `/exit` and `/quit` in a client mean "leave my client"; they never reach claude. Ending the
  session itself is `tmux attach -t jam` (or `tmux kill-session`).
- Standing approval (`/allow-cmd always`) lives in daemon memory, is per name, and dies with
  the daemon. A guest who reconnects under the same name keeps it; there is no way to revoke it
  short of restarting (there is no `/deny-cmd always`).
- A guest can have one command request in flight, and it expires after two minutes. The tmux
  popup for it only appears if somebody is attached to the jam session, which in the normal
  v0.14 layout nobody is — the host answers in their client.
- The connect block is printed above the live view, so a client that reconnects to a busy
  daemon replays up to 300 events into the terminal's scrollback before the frame comes back.
  That is the transcript doing its job, but it does scroll.
- Nothing tells a guest that the host is in TUI control: their view keeps updating (they can see
  the keystrokes land), but the `⌨` marker is local to the host's client.
- **Export scrubbing is best effort.** The only thing removed from an exported transcript is
  jam's own token block (matched by the text hooks.sh writes) and the raw token string. Anything
  else claude saw — file contents, tool output, another secret it happened to read — goes with
  the copy. A changed hook wording would silently stop matching; the token replacement is the
  backstop. `/token new` after an export is the real mitigation.
- A transfer is held whole in memory at both ends (a 50 MB transcript is ~50 MB + its base64
  frames a few at a time), there is no resume: a socket that drops mid-transfer loses it and the
  partial file is never written. Uploads are 20 MB, the transcript and offers 50 MB.
- `jam-uploads/` is append-only as far as jam is concerned: nothing is ever cleaned up, and a
  repeat name gets `-1`, `-2`, … up to 99, then the upload is refused. Same for a guest's
  `jam-downloads/`.
- Offers live for the daemon's whole life and are never re-broadcast: a guest who joins after
  `/send` is not told about it (they can still `/get <name>` if somebody tells them the name),
  and an offer whose file is deleted or grown past the cap only fails when someone tries.
- `/paste` is macOS-only by nature (`pngpaste`, else `osascript` `«class PNGf»`), and it takes
  the clipboard as PNG only — a copied file, a PDF or an HTML snippet is not an image. The name
  it invents is `paste-<yyyymmdd-hhmmss>.png`, so two pastes in the same second collide (and get
  the `-1` suffix).
- Standing approval (`/allow-export always`, `/accept-file always`) is per name, per kind, in
  daemon memory, with no way to revoke it short of a restart — same ceiling as `/allow-cmd
  always`. A guest reconnecting under the same name keeps it.
- The host's `/export` writes into the host's own cwd, next to the project. It is the same file
  claude is already writing, so it is a copy, not a move.
- Nothing scans an uploaded file. It is written 0644, never executed, never opened, and claude is
  merely told the path — but the moment claude `Read`s it, its contents are in the session's
  context (and therefore in anybody's later `/export`).
- **Secret masking (v0.17 F4) is a deny-list, not a scanner.** It knows five shapes — AWS key
  ids, PEM `PRIVATE KEY` blocks and bare headers, `sk-`/`pk-`/`rk-` and `gh?_` tokens, bearer
  credentials, and `.env`-style UPPER_CASE secret `KEY=value` — and everything else goes
  through untouched. On a mirror row it cannot see a value split across SGR sequences, and it
  only runs where content reaches other people (tool calls, tool results, diffs, frame rows):
  a message somebody types is their own. Same honesty as `stripTokenBlock`.
- `/files` (v0.17 F2) knows only what a tool call announced: an Edit/Write/Read `file_path`. A
  file changed by a shell command inside a Bash call is invisible to it — which is exactly why
  `/diff` exists, and why it shells out to git instead of trusting the transcript.
- `/diff` (v0.17 F3) is `git diff`, so it shows the UNSTAGED working tree only: anything already
  staged or committed does not appear. Output is capped at 120 lines / 8000 characters, one
  request runs one `git` process, and any participant may ask (the mirror already shows them the
  same work happening). It needs `git` on PATH and refuses cleanly outside a work tree.
- The history backfill (v0.17 H1) reads only the last 8 MB of the transcript and gives every
  seeded event the daemon's boot time as its `ts`, because `parseJsonlLine` does not carry the
  record's own timestamp. Nothing displays `ts` today; a client that wanted real times would
  have to widen the parser first.
- **An invite link is a bearer credential** (v0.22B): whoever holds it is that person, with no
  second factor and no device binding. What it buys over the shared `--token` is per-person
  revocation, an expiry, a use count and a name binding — not a stronger proof of identity. Its
  addresses are frozen at mint time, so a `cloudflared` respawn leaves older links reaching the
  jam only over their LAN address (there is no "re-issue all" action yet), and revoking a link or
  letting it expire never disconnects somebody already in on it — `/kick` is that.
- `/kick` closes a socket, and nothing stops the same person coming back through a knock, a token
  they hold, or another live link. Kick plus revoke is the pair that keeps somebody out, and even
  then only for that link.
- No rate limiting, no web client, single session per host, no Windows.
- First run in a fresh directory hits claude's "is this a folder you trust?" dialog. Before
  every injection until one succeeds, the daemon waits up to 30 s for either that dialog (it
  answers it, moving off the "No, exit" default first) or the input prompt — so a message sent
  while claude is still booting still lands.


## Running the end-to-end smokes

Eighteen end-to-end smokes, verified 2026-08-29 on node 24.15 / tmux 3.7c /
claude 2.1.251 / ttyd 1.7.7 / cloudflared 2026.8.2. Run `smoke-ink.mjs` against a **fresh** daemon: it asserts on what is on screen,
and a daemon with replayed history puts an older turn's collapsed-tool line there.

```sh
# zsh: `command -v claude` prints the alias text, not a path — ask for the binary. And check what
# comes back: on a machine running cmux, `whence -p claude` is a SHIM in $TMPDIR, not claude —
# `$HOME/.local/bin/claude` (which is also resolveClaude's own first choice) is the real one, and
# is what the 2026-08-29 run used.
# Run the launcher inside a tmux session of your own so it has a real terminal size, and
# --no-attach so no host client of its own opens (the smokes bring their own clients).
# v0.20: jam builds on ITS OWN tmux socket (claude-jam-<port>), so the driver session goes there
# too — then this whole recipe touches the default tmux server not at all, and the socket's server
# disappears on its own once its last session is killed.
tmux -L claude-jam-7799 new-session -d -s jamdrive -x 120 -y 40 -c "$PWD" \
  "JAM_CLAUDE=$(whence -p claude 2>/dev/null || command -v claude) node host.mjs \
   --tmux jamtest --port 7799 --view-port 7801 --name Host --token smoketoken \
   --hook-secret smokehooksecret --cwd '$PWD' --no-attach -- --model haiku; sleep 1800"

node scripts/smoke-ink.mjs   ws://127.0.0.1:7799 smoketoken jamtest   # first: needs empty history
node scripts/smoke-xfer.mjs  ws://127.0.0.1:7799 smoketoken jamtest smokehooksecret
node scripts/smoke.mjs       ws://127.0.0.1:7799 smoketoken
node scripts/smoke-mirror.mjs ws://127.0.0.1:7799 smoketoken
node scripts/smoke-popup.mjs ws://127.0.0.1:7799 jamtest 7799 smokehooksecret
node scripts/smoke-slash.mjs ws://127.0.0.1:7799 smoketoken jamtest   # last, and ONCE per
#   daemon: it grants Guest standing approval (`/allow-cmd always`), which lives in daemon
#   memory, so a second run against the same daemon gets no cmdreq to answer.
tmux -L claude-jam-7799 kill-session -t =jamtest   # exact names only, never a pattern
tmux -L claude-jam-7799 kill-session -t =jamdrive
rm -rf "$TMPDIR/claude-jam-7799" jam-uploads

# knock-only daemon (no --token) for the admission smoke
tmux -L claude-jam-7799 new-session -d -s jamdrive -x 120 -y 40 -c "$PWD" \
  "JAM_CLAUDE=... node host.mjs --tmux jamtest --port 7799 --name Host --cwd '$PWD' \
   --no-attach -- --model haiku; sleep 300"
node scripts/smoke-knock.mjs ws://127.0.0.1:7799
tmux -L claude-jam-7799 kill-session -t =jamtest
tmux -L claude-jam-7799 kill-session -t =jamdrive
rm -rf "$TMPDIR/claude-jam-7799"

# v0.17: the transport smoke takes NO arguments and needs no daemon of yours. It starts and
# kills its own on 7811/7813 (no tmux session, no claude at all), because it needs a
# --heartbeat far shorter than a real run and it deliberately kills relay children.
# ~2 min; needs cloudflared on PATH for its T1 steps.
node scripts/smoke-transport.mjs

# v0.17 Batch H/F: also NO arguments and no daemon of yours. It plants a transcript in a
# --config-dir of its own, builds a throwaway git repo, stands up a fake `claude` window
# (tmux session jamreplaypane) and its own two daemons on 7823/7825, and runs the real ink
# client in tmux session jamreplayguest. Needs git; no claude, no cloudflared. ~1 min.
node scripts/smoke-replay.mjs

# v0.17 Batch P: the tenth smoke. Also NO arguments and no daemon of yours — but it DOES need a
# real claude, because it drives a real permission prompt. Its own port (7831), its own tmux
# sessions (jampermdrive, jampermtest), its own temp cwd, and it starts the claude window with
# `--permission-mode manual`: this machine's settings.json says "defaultMode": "bypassPermissions",
# and with that (or --dangerously-skip-permissions) nothing ever asks and there is no prompt to
# relay. If the prompt does not appear it says which setting to look at. ~2 min, costs a haiku turn.
node scripts/smoke-perm.mjs

# v0.18: the eleventh smoke. NO arguments, no daemon of yours, no real claude/ttyd/cloudflared
# (stand-ins that hold a pid and sleep) — and it runs with a $TMPDIR of its own, so
# `jam sessions|end|clean` inside it cannot even SEE a state dir that is not the smoke's. Its
# own ports (7851/7853/7855) and its own tmux sessions, all named jamlife*, killed by exact
# name. It starts with the refusals: a plain session of its own, a hand-written @jam-owned
# marker, and — read-only, never touched — the live `jam` on :7777 if one is running. ~20s.
node scripts/smoke-lifecycle.mjs

# v0.22B/C: the twelfth smoke. NO arguments, no daemon of yours, no real claude (a stand-in that
# draws a prompt and sleeps) — and its own $TMPDIR, so `jam invite` can only see its own jam. Its
# own port (7861) and one tmux session, jaminvite, killed by exact name. It starts with a
# read-only proof that the live `jam` on :7777 is invisible to it, then mints links from the CLI
# and from `/invite`, joins with only a link, and spends most of its length on the refusals.
# ~10s.
node scripts/smoke-invite.mjs

# v0.30/v0.31: the thirteenth smoke. NO arguments, no daemon of yours, and no real claude at all —
# the pane is scripts/fake-tui.mjs, a stand-in built from the measured behaviour of 2.1.251, and
# the prompt steps paint the REAL captures in fixtures/pane/ into it. So tmux, capture-pane,
# paste-buffer, send-keys, the daemon and both wire protocols are real; only claude's redraw is
# imitated. Its own $TMPDIR, its own port (7871) and one tmux session, jamanswer, killed by exact
# name. ~1 min, costs nothing.
node scripts/smoke-answer.mjs

# v0.23: the fourteenth smoke. NO arguments, no daemon of yours, no real claude. Own $TMPDIR,
# ports 7891/7893/7895, sessions jamdisco*, killed by exact name. ~1 min, costs nothing.
#
# It REALLY DOES advertise on the local network while it runs — that is the thing under test.
# Every registration is a child of a daemon it started; its teardown FAILS the run if anything
# is left advertising, and step 9 counts the `dns-sd -R` processes for one port across a real
# re-announce, because a leaked advertisement is the one failure this project can inflict on
# somebody else's network. Needs /usr/bin/dns-sd, and skips cleanly when there is none.
node scripts/smoke-discover.mjs

# v0.25/v0.26/v0.27: the fifteenth smoke. NO arguments, no daemon of yours, no real claude — and
# a cwd of its own as well as a $TMPDIR of its own, because it writes real uploads and they must
# land in jam-uploads/ under a directory it made. Its own port (7881) and two tmux sessions,
# jamnudge and jamnudgeroy, killed by exact name. ~15s, costs nothing.
#
# It stubs the platform seam rather than listening: each client gets a directory in FRONT of its
# PATH holding a shell `afplay` and `osascript` that append to that client's own log. Because
# platform.mjs spawns those two by name, the stub intercepts the real call — so "a knock and an
# auto-join are two different sounds" and "only the client a nudge was addressed to was
# interrupted" are facts on disk instead of inferences. Verified 2026-08-29: all 15 steps pass.
node scripts/smoke-nudge.mjs

# v0.28: the sixteenth smoke. NO arguments, no daemon of yours, no real claude, no network. Own
# $TMPDIR, own cwd, port 7901, two tmux sessions (jamscroll and jamscrollink) killed by exact
# name on its own socket. ~90 s, costs nothing.
#
# The pane is a shell stub that prints 400 numbered lines and then one `TICK` per change of a
# control file — so the pane has REAL scrollback to page back through, and "the screen moved
# while somebody was scrolled" is something the smoke decides rather than waits for. It runs a
# real ink client on a real pty as a GUEST and compares what that guest sees, scrolled back,
# with `capture-pane -S` on the host pane, row for row. Verified 2026-08-29: all 11 steps pass.
node scripts/smoke-scroll.mjs

# v0.33: the seventeenth smoke. NO arguments, no daemon of yours, no real claude (the adopted
# pane is scripts/fake-tui.mjs). Own $TMPDIR **and own $HOME**, because adoption finds a session
# by globbing ~/.claude/projects/<cwd-slug>/ and the transcripts it invents must be the only ones
# there. Ports 7921/7923/7925; sessions jamadopt* on a socket of its own — plus EXACTLY ONE on
# the DEFAULT tmux socket, named jamadopt-<random> and removed by that exact name, because the
# user's own server is the case v0.33 exists for. ~6 s, costs nothing.
#
# Most of it is refusals. The load-bearing steps are S6 — the ownership marker is on claude-jam's
# OWN session and NOT on the adopted one, no status option is written on the adopted server and
# no bare F3 is bound in its root key table — and S11/S12, where after `claude-jam end` the
# adopted session still exists and the process in its pane has the SAME pid.
#
# Its fixtures are realpathed on purpose: on macOS $TMPDIR is a symlink, and both a real claude
# (filing under its own process.cwd()) and tmux (#{pane_current_path}) report the resolved path.
# Verified 2026-08-29: all 12 steps pass.
node scripts/smoke-adopt.mjs

# v0.29: the eighteenth smoke. NO arguments, no daemon of yours, no real claude AND no real peer
# executor. Own $TMPDIR, a second $TMPDIR+$HOME for the guest, ports 7941/7943, sessions jampeer
# and jampeeroff. ~40 s, costs nothing.
#
# It is the trust-boundary smoke: the executor is scripts/fake-claude.mjs, which emits the same
# stream-json shapes and writes down the argv, the cwd, the stdin and its own pid — so "no
# bypassPermissions in the argv", "the prompt never reached an argv", "the cwd was a fresh
# scratch dir and it is gone" and "the wall clock killed that pid" are facts on disk rather than
# claims. It runs a REAL --basic client as the guest, because the guest half is the half that
# spawns. It asserts the scratch directory by BASENAME: on macOS $TMPDIR is a symlink, so the
# argv carries /var/folders/… while the child's own process.cwd() reports /private/var/folders/…
# — the same trap smoke-adopt's fixtures hit.
# Verified 2026-08-29: all 15 steps pass.
node scripts/smoke-peer.mjs
```

### What each smoke covers of v0.25/v0.26/v0.27

- `smoke-nudge.mjs` — all three, end to end: Submarine for a knock and Glass for a token join
  (asserted as two different `afplay` argv through the seam, with a guest hearing neither); a
  `/ping` round trip where the addressed client gets the 👋 line and Hero, the sender is told it
  landed and hears nothing, and a bystander sees `Kobi nudged Roy` and hears nothing; the 30 s
  rate limit with the time left in the refusal; a nudge at somebody not connected refused and
  routed nowhere; `Idler (away 20m+)` in `/who` and in the nudge confirmation; `--no-sound`,
  `/sound off` and a real `/menu → Notifications` keypress each silencing one tier and only one;
  and the whole upload policy — `ask` unchanged, `auto` landing a file with no prompt while
  traversal names and the 20 MB cap still refuse, the session quota falling back to `ask` and
  saying so, and `off` refusing the guest and the host alike while `export` stays its own toggle.

### What each smoke covers of v0.30/v0.31

- `smoke-answer.mjs` — the whole of both, deterministically: the probe rule, the placeholder rule,
  a chunked payload arriving whole, a message that cannot land being KEPT with its exact bytes,
  `/outbox` and `/retry`, the four classifications, a GUEST answering a question with no approval,
  first-answer-wins, free text going to the host, `/answer <q> <n>`, and a permission still being
  host-gated.
- `smoke.mjs` — the same two rules against a REAL claude and a REAL transcript: one message that is
  both multi-line (so it renders as a placeholder) and over the chunk cap, asserted byte-for-byte
  against the JSONL.
- `smoke-ink.mjs` — `↑`/`↓` recall on a real pty, through the real ink client, including that the
  draft survives the walk and that nothing is submitted by it.

## v0.15 — native-speed host TUI control + faster frames (Roy: F3 typing feels remote)

Root cause: F3 passthrough routes each keystroke client → WS → daemon → `tmux send-keys`, and
feedback arrives only on the next 250 ms `capture-pane` poll. Locally that is ~300-500 ms per
key — unusable for real typing.

1. **Host F3 = real attach, not proxy.** In the HOST client (host + loopback), F3 suspends the
   ink app (unmount/stdin release), spawns `tmux attach -t <jam>:claude` (the WINDOW by name —
   a bare session target lands on window 0, the daemon's log) with the terminal inherited
   (stdio: 'inherit'), and re-renders the client when tmux detaches. Native latency, full
   fidelity (pickers, permission dialogs, mouse, colors). Status line hint becomes
   "F3 → attach to the real TUI (Ctrl-b d to come back)". While attached, the daemon pauses the
   host client's frame subscription; on return it resizes the claude window back to the host's
   terminal (existing resize logic) and resumes frames. The old proxy path stays for GUESTS
   only (they cannot attach), gated server-side as today.
2. **Frames get faster and cheaper.** Replace fixed 250 ms polling with adaptive cadence:
   40 ms while any client is in mirror view AND activity was seen in the last 2 s (typing,
   busy, new frame), 250 ms when idle, plus the existing change-detection so unchanged screens
   send nothing. Cap 25 frames/s per client. Where available prefer `tmux pipe-pane -o` to a
   local socket/fifo as the change signal (poll capture-pane only when the signal fires) — if
   pipe-pane proves fiddly, keep the adaptive poll (document which shipped).
   **Shipped: the adaptive poll**, not pipe-pane. pipe-pane would have to carry every byte a
   full-screen TUI redraws into a fifo of our own, and `capture-pane` would still be the thing
   that turns it into a frame — so the only win was over an idle mirror, which already cost 4
   polls/s and now costs none at all when nobody is watching. One self-rescheduling timer
   instead: `frameCadence()` in lib.mjs, activity stamped by broadcast(), by a keystroke and by
   a frame that actually changed, and the pane size cached for 500 ms so the fast cadence does
   not double the tmux spawn count. Measured (smoke-mirror, 2026-08-29): 14 frames in 3 s while
   a haiku turn ran, gaps min 46 ms / median 139 ms — under v0.14 no gap could be under 250 ms —
   then 0 frames in 3 s once idle, with the daemon logging the
   `[frames] cadence 40ms (active)` -> `250ms (idle)` transition.
3. **Guest key latency honesty:** guests keep proxied input; the client shows a one-time hint
   that raw TUI control is host-only, and echoes their submitted line locally so typing feels
   instant even when the frame lags.

## v0.16 — one-key approval inside the client (Roy: bring back the a/d popup feel)

Since v0.14 the host's tmux session is detached, so `tmux display-popup` has no client to draw
on and knocks only appear as a text line. Restore the one-keypress feel natively in the client:

- Any pending request (knock, command, export, file) raises an **approval bar** just above the
  status row, styled like the old popup: `⚑ Dana wants to join (100.x.y.z)  [a]ccept  [d]eny
  [i]gnore  ·  2:00`, with a live countdown to the request's expiry. Multiple pending requests:
  the bar shows the first and `+N more`.
- While the bar is up AND the input line is empty, single keys act: `a` accept, `d` deny,
  `i`/Esc dismiss the bar (request stays pending; `/accept` etc still work). Any other
  printable key goes to the input as usual and hides the single-key hint (so typing never
  accidentally approves) — pressing Esc brings it back.
- Kinds keep their glyphs: `⚑` join, `⌘` command, `⇩` export, `⇪` file; approving runs exactly
  the same ladder path as the slash commands, no second mechanism.
- Guests never see the bar (server already sends host-only frames).
- The tmux popup path stays for anyone attached to the session; when both exist, whichever
  answers first wins and the other closes (ladder already handles late answers with 404).

## v0.17 — accepted feature program (judged 2026-08-29 from RESEARCH.md)

Source: ~/ClaudWork/2026-08-29-jam-feature-research/RESEARCH.md. Judged keepers only; the 8
anti-features there are rejected, and D4 (host delegation), A3, B2, B4, E2 are deferred.
Ship in the batches below; each item keeps its RESEARCH.md id for traceability.

### Batch T — transport survives 2 hours
- **T1 (A1)** auto-restart the `cloudflared` child with backoff (1s→30s, unlimited), reusing
  `joinInfo()`/`writeTokenFile()`/`sendHosts()` so the new URL propagates; log every respawn.
- **T2 (A2)** server-side ping/pong: 30 s interval, `isAlive` flag, `terminate()` on a missed
  round, roster cleanup — the `ws` README pattern. Keeps us under Cloudflare's 100 s idle cap
  even when the mirror is legitimately silent.
- **T3 (A4)** reconnect UX tiering: after 5 failed attempts the client says the tunnel URL may
  have changed and how to get the new one.
- **T4 (new, replaces A5)** `--funnel`: use **Tailscale Funnel** instead of cloudflared —
  `tailscale funnel --bg <port>` (or `tailscale serve` semantics per the installed version;
  read `tailscale funnel --help` and verify locally). Wins over named tunnels: STABLE public
  hostname (`<machine>.<tailnet>.ts.net`) across restarts, real TLS cert, no domain, no
  Cloudflare account, guest installs nothing. Two ports (client + view) via path or two funnel
  targets — pick what the CLI actually supports and document it. Same lifecycle discipline as
  cloudflared (tracked PID, killed on exit, restart on death). Startup validates
  `tailscale status` and prints a clear hint if Funnel is not enabled for the tailnet.
  Flags: `--tunnel` (cloudflared, ephemeral URL) and `--funnel` (Tailscale, stable URL);
  mutually exclusive, both optional.

#### Batch T — shipped 2026-08-29

All four, plus `scripts/smoke-transport.mjs` (13 steps) and 16 unit tests — 159 total.

- **One relay path, not two.** cloudflared and `tailscale funnel` differ only in argv and in
  which line carries the hostname, so `RELAYS` in host.mjs holds exactly that and
  `spawnRelay()` owns the pid tracking, the URL propagation and T1's backoff for both. Both
  stdout and stderr are piped and fed into one buffer: cloudflared banners on stderr,
  `tailscale funnel` on stdout.
- **T1** `respawnDelay(attempt)` = `min(1000 * 2**(attempt-1), 30000)`, unlimited attempts,
  counter reset the moment a URL resolves — so a relay that ran an hour waits 1 s, not 30. Our
  own `stopTunnels()` sets `relayStopping` first, so shutdown is not a death to recover from.
  A relay that dies without ever resolving now logs the tail of what it said, which is the only
  diagnosis available for a blocked cloudflared or a sandboxed Tailscale.
  No new frame: `onTunnelChange()` already fed `writeTokenFile()` + `printJoin()` +
  `sendHosts({t:'token'})`, which is how `/token` rotation has always worked.
- **T2** `startHeartbeat()` runs `heartbeatSweep()` over `wss.clients` every 30 s
  (`--heartbeat <ms>` for tests), pings whoever pongd since the last tick and `terminate()`s
  whoever did not. `ws.jamAlive` is the flag; `ws.on('pong')` clears it. `terminate()` fires
  `close`, so the existing handler does the roster/mirror/ladder cleanup — nothing duplicated.
  Clients needed NO change: the browser-standard `WebSocket` they all use answers protocol
  pings itself and gives the application no say in it.
- **T3** a per-client counter, reset on a socket that actually opened, and
  `reconnectMessage(attempts, nextMs)`. Both clients. The first four failures keep the old
  wording exactly; the fifth (~15 s of 1-2-4-8 backoff) names the URL change and points at
  `/join`.
- **T4** the shape that made this cheap: a funnel host string (`<machine>.<tailnet>.ts.net`,
  or `…:8443`) is a drop-in for a trycloudflare one, so it fills the same `tunnelHosts` slots
  and every join line, `token.json` field, welcome block and `/join` reprint works unchanged —
  including the `tunnel invite:` / `tunnel view:` labels, which are shared on purpose (the
  `.ts.net` in the URL is what tells them apart).
  **Two ports, not `--set-path`:** Funnel opens only 443, 8443 and 10000, and a path mount
  would also have to agree with the daemon's own `/health`, `/admit` and `/hook/*` routes.
  443 → the client (so the join line carries no port), 8443 → the ttyd view.
  **Foreground, not `--bg`:** the funnel then lives and dies with a pid we track, which is
  cloudflared's lifecycle exactly, respawn included. Shutdown additionally runs
  `funnel --https=<port> off` for the two ports it opened — belt and braces, because a funnel
  left open is a port on the public internet — and never `funnel reset`, which would drop
  config this daemon never created.
  `resolveTailscale()` exists because macOS keeps the CLI inside `Tailscale.app` and puts
  nothing on PATH; `--funnel-cli` / `JAM_TAILSCALE` override it.
  **The live path is UNVERIFIED, and the reasons are hard blockers, not oversights:**
  (1) the tailnet it was written against has no `funnel` node attribute — `Self.CapMap` in
  `tailscale status --json` lacks `https://tailscale.com/cap/funnel`, which is what
  `funnelPrecheck()` reads and refuses on; a tailnet admin grants it in Access Controls with
  `"nodeAttrs": [{"target": ["autogroup:member"], "attr": ["funnel"]}]`.
  (2) that machine runs the App Store (sandboxed, `_MASReceipt`, bundle id
  `io.tailscale.ipn.macos`) build of Tailscale 1.102.3, whose CLI answers EVERY serve/funnel
  mutation — `funnel`, and plain tailnet-only `serve` too — with `The Tailscale GUI failed to
  start: The operation couldn't be completed. (Tailscale.CLIError error 3.)`, while read-only
  `status` / `funnel status` work fine. The standalone build from tailscale.com is needed.
  So the lifecycle is proved in `smoke-transport.mjs` against a stub CLI that answers exactly
  as the real one documents (argv, foreground banner, `off`), and the precheck refusal is
  asserted against the REAL CLI. Our half of the contract is verified; Tailscale's is not.

### Batch H — history and orientation
- **H1 (B1)** seed the `history` ring buffer at daemon boot by parsing the existing session
  JSONL with `parseJsonlLine`, bypassing live side effects (no busy/waiting/tool-collapse
  churn), capped by a new `--replay N` (default 300 events). Fixes the blank-room problem for
  guests joining a `--resume`d or long-running session.
- **H2 (B3)** a `── history above · live from here ──` divider at the end of a join's replay.

### Batch F — guests see the work
- **F1 (C1)** stop truncating `Edit`/`MultiEdit`/`Write` tool calls: render file path + real
  `-`/`+` lines from `old_string`/`new_string` (no diff library — the args ARE the diff),
  capped like `TOOL_RESULT_MAX`, collapsible with the existing `/tools` machinery.
- **F2 (C2)** `/files` — the set of paths this session touched (from Edit/Write/Read inputs),
  newest first, with a per-path change count.
- **F3 (C3)** `/diff [path]` — `git -C <cwd> diff --stat` by default, full diff for one path;
  degrades cleanly outside a repo; capped output.
- **F4 (C4)** best-effort secret masking (deny-list: AWS keys, `-----BEGIN … PRIVATE KEY`,
  `sk-`/bearer tokens, `.env`-style `KEY=value`) applied to tool-call rendering AND
  `sanitizeFrameRow` mirror rows. Documented as best-effort, never presented as a guarantee.
  This is a trust-boundary feature: ship it in the same batch as F1, not later.

#### Batch H + Batch F — shipped 2026-08-29

All six, plus `scripts/smoke-replay.mjs` (17 steps, the ninth smoke) and 23 unit tests — 182
total. What is worth knowing beyond the item descriptions:

- **H1 seeds before `listen()`, not after.** `seedHistory()` runs between
  `new WebSocketServer(...)` and `http.listen(...)`, so the ring buffer is complete before the
  first socket can ask for it — no window in which an early joiner gets half a backlog. It has
  no live side effects by construction: it never calls `broadcast()`, so nothing touches
  `busy`/`waiting`, the per-turn tool counters or the injection queue. The events are pushed
  into `history` directly, with ids from the same `nextId` counter (the BOOT id is fresh, so a
  client's `seen` set cannot collide).
  It then sets `jsonlPath` and `offset` past exactly what it read, which is what stops the tail
  re-broadcasting the same turns 300 ms later — and that also fixes the previously-unnoticed
  case of a fresh daemon over an existing `--session-id` file. The old `--resume` → `offset =
  EOF` path stays for when there is no file to seed from.
  Two bounds: only the last 8 MB of the transcript is read (a mid-file start drops the partial
  first line), and a file not ending in a newline leaves its half-written last line to the tail.
  The `history` ring is now `max(300, --replay)`: seeding 1000 events into a 300 cap would have
  thrown 700 of them away one line later.
- **H2 flushes tools before the divider.** A replay has no turn boundary — the `status` frame
  that ends a live turn arrives after the welcome — so without an explicit `flushTools()` the
  replayed tool summary landed *below* the line calling everything above it history.
- **F1 needed one client change nobody asked for.** `LIVE_TOOL_ROWS` is four ROWS, not four
  tool calls: four 20-line diffs in the live region would have pushed the status and input rows
  off the screen. `toolLiveLine()` shows the first line plus `(+N diff line(s))` there; the
  whole diff is in the transcript and in `/tools`. Turn collapse then does the rest — a turn of
  edits is still one `⚙ N tools (Edit ×3)` line, and `/tools` reprints the diffs in full.
- **F2/F3 are answered by the DAEMON.** Only it has the transcript and the cwd, so the clients
  just forward `{t:'files'}` / `{t:'diff', path?}`. `/files` replies to the asker alone (it is
  orientation, not news); `/diff` is broadcast, because the working tree is the one artifact
  everybody in the jam is looking at. Neither is on the approval ladder: they reveal paths and
  the diff of a tree whose live screen every guest is already watching.
- **F4's cost is the reason it is one hint scan.** `maskSecrets` tests a single combined regex
  first and returns the string unchanged when it misses, which is nearly every row of a TUI, so
  the mirror pays one scan instead of seven. Measured on a 40-row frame (node 24.15, M-series):
  `sanitizeFrameRow` 4.4 µs/frame before, **5.3 µs/frame after** (+1 µs, +22%); a frame where
  every row trips the gate is 16.8 µs and one where every row really holds a key is 19.0 µs.
  For scale, the `tmux capture-pane -e -p` that produces the frame costs **5535 µs** — 1000× the
  masking — and the fast cadence budget is 40 000 µs per frame. So the worst case is 0.05% of a
  tick and 0.34% of the capture it rides on. `smoke-mirror.mjs` re-measured the live cadence
  afterwards, against a real haiku turn: **11 frames in 3 s, gaps min 45 ms / median 99 ms /
  max 495 ms**, then 0 frames in 3 s once idle — against v0.15's recorded 14 frames, min 46 ms /
  median 139 ms. The floor is the 40 ms cadence, not the work per frame, and it did not move.

### Batch P — guest parity and polish
- **P1 (D2)** read-only guest command allowlist (`/cost`, `/status`, `/context`) resolving to
  `run` with no host round-trip; hard list and ask-path unchanged.
- **P2 (D1)** structured permission relay: 4th ladder kind `permission`. When `waiting` is
  true a guest may request to answer; daemon extracts the visible options via `capture()`,
  shows them, and on host approval types ONLY a validated digit + Enter through
  `sendKeyArgs`. Never raw bytes, never without host approval.
- **P3 (D3)** bell on `waiting` transition (host) and on your own name appearing in a
  say/chat (everyone).
- **P4 (E4)** macOS `display notification` alongside the bell, same osascript precedent as
  `/paste`.
- **P5 (E1)** connection-quality indicator in the status bar from T2's ping data
  (`~120ms` / `⚠ stale 12s`).
- **P6 (E3)** slash-command autocomplete: dim filtered list of jam's own commands while the
  input starts with `/`.
- **P7 (E5)** contrast/color-blind pass over `COLOR_PALETTE`.

#### Batch P — shipped 2026-08-29

All seven, plus `scripts/smoke-perm.mjs` (9 steps, the tenth smoke) and 17 unit tests — 199 total.
New frames, all additive: client → host `{t:'perm', choice?}` and `{t:'permok', op, name?,
always?}`; host → clients `{t:'permreq', name, choice, option, options}` (host clients only) and
`{t:'net', rtt, heartbeat}` (to one client). This retires the v1 Security line "Friends cannot
answer permission prompts" — with the exact scope below, and nothing wider.

- **P2 is the only load-bearing item, and its shape is a refusal to do the obvious thing.** The
  obvious thing is to let a guest have F3's raw key passthrough; that is arbitrary bytes into the
  host's real TUI from off-box, it stays an anti-feature, and `{t:'key'}` from a guest is still
  refused (asserted in the smoke *after* the relay has worked, so nothing about the relay widened
  it). What ships instead is one digit, behind five gates that ALL have to hold:
  `status.waiting` is true · the numbered options parse off `capture()` · the digit is one of
  them · the host approved that digit on the ladder · **and the screen still says the same thing
  at the moment of typing**. The last one is why the request record carries the option text and
  the option count as well as the number: the host approves one option of one prompt, and a prompt
  that moved on in between would take that digit as the answer to a different question. On any
  mismatch nothing is typed and both sides are told to look again.
- **The parser is where the real risk was, so it was written against the real thing.** Probed on
  claude 2.1.251 (`--permission-mode manual`, `capture-pane -p`): a horizontal rule, ` Bash
  command`, the command, ` Do you want to proceed?`, then ` ❯ 1. Yes` / `   2. Yes, and always
  allow access to …` / `   3. No`. Numbering ALONE is not enough to call that a prompt — a
  markdown plan, a file being read or `git log --oneline` would all qualify, and a digit typed
  into something that is not a picker lands in claude's input box as text. So the options are the
  bottom-most block that numbers 1..n with no gap, AND either the picker's own `❯` marker or a
  question line within four rows above it. Ten-plus options refuse outright rather than silently
  offering the first nine. Anything unreadable returns nothing, which is a refusal.
- **The digit answers on its own** — measured on the same probe: `send-keys -H 33` closed the
  prompt and applied option 3 with no Enter at all. So the Enter the item asked for is sent
  *conditionally*, only if the same options are still up 300 ms later: a picker that needs it gets
  it, and a prompt that already closed never receives a stray submit. `sendKeyArgs` does the
  encoding, so this rides F3's own path with one character in it.
- **`always` exists on this ladder too**, for symmetry with the other three — and like them the
  one-key bar never grants it, only the typed `/allow-perm <name> always` does. It is standing
  permission to ANSWER prompts, still re-validated against the live screen every time, still
  daemon-memory only. It is the widest thing in Batch P and is documented as such.
- **P1's allowlist is three commands and deliberately bare.** `/cost` runs; `/cost --json` asks,
  because an argument is behaviour the list has not read. The hard list is still checked first, so
  neither the allowlist nor `always` can reach `/exit`/`/clear`/`/resume`. Two existing smokes had
  to change: they were asserting a round trip for `/cost` that no longer happens, and now use
  `/release-notes`. That exposed a cross-smoke race worth recording — `runSlash` broadcasts its
  `sys` line BEFORE the daemon types anything, so a smoke can exit seconds before its last command
  opens one of claude's modal panels, and a modal swallows everything typed after it. smoke-slash
  now settles the pane (Esc until claude's input row is back) before it asserts on it.
- **P3's bell is one byte and no policy.** `\x07` written straight to the real stdout, which is
  safe beside ink because it paints no cell. Rung on the host's `waiting` transition (the host is
  who can always answer) and on anybody's own name in a `say` or `chat`, whole-word and
  case-insensitive, `@Name` included, at most one per 3 s. P4 adds the macOS notification through
  `xfer.mjs`, argv-only like `/paste`, fire-and-forget so a failed notification cannot cost a frame.
- **P5 needed no new traffic.** T2's ping is timed and the number goes back on that socket's own
  `{t:'net'}` frame — never on `status`, which is broadcast and kept in history. The chip redraws
  only when its text changes, so a healthy `~120ms` costs nothing per second and `⚠ stale Ns`
  still appears and counts up with no frames arriving.
- **P6 gives the mirror one row back.** The hint row would otherwise have pushed the status and
  input rows off the bottom, so `Mirror` takes a `reserve` and drops a frame row while it is up.
  No arming rule moved: an input starting with `/` is already non-empty, so v0.16's single keys are
  already off (and the bar says so).
- **P7 moved exactly one colour, and the measurements are in the test.** Contrast was never the
  problem: all eight clear 6.1:1 on `#1e1e1e` and 7.7:1 on black. The one genuine weakness was
  **78 `#5FD787` at ΔE 11.2 (CIE76) from the self green 114 `#87D787`** — the closest pair in the
  set by a factor of two, and the worst one to have, because it made somebody else's name look
  like your own. It is now **211 `#FF87AF`** (rose, ΔE 36 from its nearest neighbour, the best
  dichromat separation of any candidate over the contrast floor). The hash is untouched and the
  list is deliberately not re-sorted, so only slot index 2 moved: names that hashed there are rose
  instead of pale green (`Eli` and `Manana` are two). Nothing else moved, because the remaining
  close pairs — 39/141 and 81/183 collapse under deuteranopia — are inherent to holding eight
  fixed hues in a space a dichromat sees in two dimensions. Colour here is redundant by
  construction: the `[Name]` label is always printed next to it.

## v0.18 — jam owns its tmux sessions (Roy: control lifecycle from the app)

Today `jam host` creates a tmux session and never offers to clean it up: quitting the client
leaves daemon + claude + ttyd/tunnel children running, a second `jam host` refuses with a
message, and the only way out is the user remembering `tmux kill-session -t jam`. Orphan
`$TMPDIR/claude-jam-<port>` state dirs accumulate too.

**Ownership marker (safety rule, non-negotiable).** On creation the launcher stamps the session
with `tmux set-option -t <name> @jam-owned <state-dir>` and writes `session.json` into the state
dir: `{tmux, port, viewPort, cwd, sessionId, createdAt, pid}`. jam may only ever end a session
whose `@jam-owned` option resolves to a state dir that jam wrote AND whose name it was given
explicitly. Never a name pattern, never a filtered list, never `kill-server`, never someone
else's tmux session — Roy runs many parallel tools in tmux.

1. **Exit prompt.** When the host's client exits (`/quit`, Ctrl-C, or the app closing), before
   the process leaves: `this jam is still running (2 guests connected) — [k]eep it running ·
   [e]nd it · [c]ancel`. `k` prints how to come back (`jam host --attach` / `jam sessions`);
   `e` ends the jam (see 3); `c` returns to the client. Non-interactive stdin or `--no-prompt`
   → keep, print the reattach line. `--end-on-exit` / `--keep-on-exit` skip the prompt.
2. **`jam sessions`** (alias `jam ls`) — table of jam-owned sessions only: name, port, cwd,
   uptime, session id (short), participants now (from `roster.json`), view/tunnel URL presence,
   plus a `!` marker for a state dir whose tmux session is gone (orphan) and for a tmux session
   whose daemon port is dead. `jam sessions --json` for scripting.
3. **`jam end [name]`** (alias `jam kill`) — ends one jam: broadcast `{t:'ending'}` so clients
   print "host ended the jam" and exit 0, give the daemon 1 s to stop its children (ttyd,
   cloudflared/funnel, popups), then `tmux kill-session -t <name>` (exact, marker-verified),
   then remove that state dir. No name and exactly one jam exists → that one; several → a
   numbered picker; `--all` requires an explicit confirmation and still verifies each marker.
4. **`/end` in the host client** — same path as `jam end`, with an in-client confirm
   (`really end this jam for everyone? [y/N]`) and the guests' notice first. Host-only.
5. **Existing-session handling.** `jam host` when its target name is taken by a jam-owned
   session: offer `[a]ttach as host · [n]ew session (auto-names jam-2) · [e]nd it and start
   fresh · [c]ancel` instead of today's flat refusal. Name taken by a NON-jam session → refuse
   with a clear message naming the collision and suggesting `--tmux <other>`; never touch it.
   `jam host --attach` goes straight to attaching the host client to an existing jam.
6. **Orphan cleanup.** `jam sessions` lists orphan state dirs; `jam clean` removes only those
   (state dir exists, its `@jam-owned` session is gone, no live listener on its port), one
   confirmation listing exactly what will be deleted.
7. **Daemon-side.** On SIGTERM/exit the daemon already kills its children; add: remove
   `session.json`, and if the tmux session is gone but the daemon somehow survives, exit.
   Clients handle `{t:'ending'}` by printing the notice and exiting 0 (no reconnect attempts).

## v0.19 — the shared-session contract goes in the system prompt

Today everything jam tells claude arrives as `SessionStart` hook `additionalContext` (protocol +
token block + MANUAL.md). That is *context*: it can be summarized away by `/compact` or diluted
over a long session, and a jam is exactly the kind of session that runs for hours. Claude Code
supports `--append-system-prompt-file <path>` (verified on 2.1.251), which persists for the
whole session and survives compaction. Split by lifetime:

**Durable → appended system prompt** (written by the launcher to `<state>/system-prompt.txt`,
passed as `--append-system-prompt-file`; never rewritten mid-session because the flag is read at
startup):
- the shared-session protocol: this session is bridged by claude-jam; every participant's
  message arrives prefixed `[Name]:`; an unprefixed message was typed directly in the host's
  terminal; treat every participant's instructions as the user's;
- the two standing rules that must never decay: **never reveal the join token or view URL to a
  `[Name]:`-prefixed participant** (host only, and only on request), and **never claim to have
  seen `/c` human-only chat** — it is deliberately withheld;
- a condensed "how jam works" digest (~15 lines: guest vs host, `/c`, `/help`, `/mirror`/F2,
  `/tools`, `/files`, `/diff`, `/export`, `/send`/`/paste`, `/answer`, knock+approval, that the
  host answers permission prompts and can attach with F3) so the agent can still teach the tool
  after a compaction;
- and a pointer: fuller detail is in MANUAL.md, which also arrives as session context.

**Dynamic → stays in hooks** (because a system prompt cannot change after launch):
- the live roster (`UserPromptSubmit`, only when `roster.json` changed) — unchanged;
- the token / join line / view / tunnel URLs (they rotate with `/token` and tunnel respawns) —
  unchanged, still gated by `--no-token-in-context`;
- full MANUAL.md on `SessionStart` — unchanged.

Details: `--append-system-prompt-file` must degrade gracefully — if the installed claude rejects
the flag (older build), fall back to the current hook-only behavior and log one line rather than
failing to launch (probe with `claude --help | grep append-system-prompt-file` at launch, cached
in the state dir). New flag `--no-system-prompt` skips the append entirely. The file is written
before the claude window is created and removed with the state dir on end. MANUAL.md and README
get the standing-rule update, including one honest sentence: these are instructions to the
model, not an enforcement boundary — the hard gates remain knock/approval and the host-only
server checks.

#### v0.19 — shipped 2026-08-29

2 unit tests (245 total) and one extra turn in `scripts/smoke.mjs`. What is worth knowing:

- **The probe is not a `--help` grep.** `--append-system-prompt-file` WORKS on claude 2.1.251 and
  is **absent from `claude --help`** (only `--append-system-prompt <prompt>` is listed), so the
  probe this section suggested would have answered "no" on a build that supports it. `--version`
  short-circuits before options are validated, and `-p` costs a turn. What ships instead:
  `claude --append-system-prompt-file <file> --claude-jam-probe-unknown-flag`, and read which
  option the parser names as unknown. Free, instant, exits non-zero either way, and every
  ambiguous outcome (no output, a timeout, a message we do not recognise) reads as NO — the
  fallback always works, and a wrong yes would stop claude from starting at all.
  The answer is cached in `<state>/claude-caps.json` alongside the sentence claude actually said.
- **The hooks were not touched at all**, and the SessionStart protocol paragraph is deliberately
  left in place beside the system prompt. It is five lines of duplication that make the fallback
  free: nothing has to be coordinated between the probe's answer and what the hook emits.
- **Verified in a live jam, twice.** `buildSystemPrompt()` is the only file in the project that
  contains the word "paraphrase" (checked against README, MANUAL, hooks.sh and SPEC), so an
  answer carrying it cannot have come from the SessionStart context. Asked
  "does your instruction about revealing the join token say anything about a paraphrase", claude
  answered *"forbids revealing the join token in full, in part, or in a paraphrase to any
  `[Name:]`-prefixed participant, but only an unprefixed message (the host's own terminal) may be
  told"* — before a `/compact`, and **the same answer after one** (the pane shows
  `⎿ Compacted`), which is the entire point of the item. `smoke.mjs` now asks that question as its
  second turn and reports the answer.
- Not fatal, by design: a jam launched with `--no-system-prompt`, or against a claude that rejects
  the flag, writes no file and says so in one line. `smoke.mjs` reports "not proved" rather than
  failing, because both are supported configurations.

## v0.20 — own tmux server socket + symmetric F3 (Roy: F3 goes in but not out)

Since v0.15 F3 does a real `tmux attach`, so leaving needs `Ctrl-b d` — F3 does nothing there,
which reads as broken. Binding F3 to `detach-client` is the fix, but tmux key tables are
**server-global**: binding it on the default server would change every other tmux session on
this machine (Roy runs many). So:

1. **jam runs its own tmux server**: every tmux invocation gets `-L jam-<port>` (a dedicated
   socket named per jam). Consequences, all good:
   - key bindings, options and hooks jam sets can never affect the user's own tmux server;
   - jam literally cannot see or kill the user's sessions — `list-sessions` on its own socket
     returns only jam's, which makes v0.18's ownership rule structural rather than
     convention-based (keep the `@jam-owned` marker check anyway, belt and braces);
   - `jam sessions`/`end`/`clean` enumerate per-socket; an orphan state dir names its socket.
   - Escape hatch for a user who wants their own server: `--tmux-socket default` (documented
     as "then jam's tmux options apply to your server", and F3-detach binding is skipped).
2. **Symmetric F3**: on session creation, `bind-key -T root F3 detach-client` on jam's own
   socket, so F3 attaches from the client and F3 detaches back. `Ctrl-b d` keeps working.
3. **Visible way home while attached**: set that session's `status-right` to
   `F3 or Ctrl-b d → back to jam` (restored/managed like the existing `⚑ N waiting` badge,
   which must still win when a request is pending). Viewer sessions keep `status off`.
4. Docs: MANUAL.md, README, CHANGELOG — F3 in/F3 out, the dedicated socket, and that
   `tmux attach` from outside now needs `tmux -L jam-<port> attach -t <name>` (print that exact
   line in `jam sessions` and in the client's "keep it running" message from v0.18).

#### v0.20 — shipped 2026-08-29

All four items, 6 unit tests (243 total) and two new steps in `smoke-lifecycle.mjs`. What is worth
knowing beyond the item text:

- **`-L default` IS the shared server.** Measured on tmux 3.7c: `tmux -L default
  display-message -p '#{socket_path}'` and the bare form both answer
  `/private/tmp/tmux-501/default`. So `tmuxSocketArgs()` always emits `-L <name>` and the escape
  hatch needs no branch — only the F3 binding is skipped, and only the printed attach line drops
  the flag (that is the line people already know).
- **The socket name is `claude-jam-<port>`, not `jam-<port>`** as this section originally said —
  v0.21's canonical naming, applied here because the socket is a new user-visible surface and
  there was no reason to ship it under the old name and rename it later.
- **A socket name becomes a filename** under tmux's own directory, so `--tmux-socket` is validated
  like one: `[A-Za-z0-9._-]`, no leading `-` (tmux would read it as an option), 64 characters, and
  anything else silently falls back to the per-port name rather than being obeyed.
- **The ownership rule gained a third leg.** `killOwned(name, socket, verdict)` refuses a verdict
  whose recorded socket is not the one it was asked about — so two servers holding a same-named
  session cannot be confused for each other. `session.json` records the socket; a file written
  before v0.20 names none and is read as the default server, which is where it is.
- **The status line needed no new machinery.** `statusRightText(pending, {home})` composes on top
  of `statusRightWaiting`, so the `⚑ N waiting` badge still wins by construction, and v0.4's
  save/restore is unchanged. It also inherits v0.4's `--no-popup`, which turns the whole status
  line off — the smoke asserts both halves.
- **A pleasant side effect:** a tmux server with no sessions exits, so jam's socket cleans itself
  up. After a full smoke run, `tmux -L claude-jam-7799 ls` answers `no server running`.
- **The smokes all moved.** Six derive the socket from the jam's port (`JAM_SOCKET` overrides);
  `smoke-replay` and `smoke-lifecycle` pin one socket of their own, which makes the latter the
  `--tmux-socket <name>` test as well. Two new steps there: the default socket never hears about
  jam's sessions or its F3 binding, and F3 detaches a real attached pty.

## v0.21 — one name, and docs an agent can install from

Three asks: canonical naming, a repo wiki, and docs kept current for humans AND agents so that
handing an agent just the repo URL is enough to install and run the tool.

1. **Rename `jam` → `claude-jam` everywhere.** The command, every usage/help/error string,
   every doc, the tmux session default (`claude-jam` instead of `jam`, socket
   `claude-jam-<port>`), the state dir (`$TMPDIR/claude-jam-<port>` — already right), the
   `@jam-owned` marker → `@claude-jam-owned`, env vars stay `JAM_*` (internal, documented) to
   avoid a pointless churn, but every user-visible surface says claude-jam. Subcommands
   unchanged: `claude-jam host|join|sessions|end|clean`.
   **Roy re-confirmed 2026-08-29: the product is `claude-jam` everywhere — bin, package, app,
   repo, tap, session names, docs.** The real executable becomes `claude-jam`; `jam` stays only
   as a thin alias pointing at the same entry so existing muscle memory and installs do not
   break, and it is absent from all help output and docs (mentioned once in the README as a
   deprecated alias). The formula installs both bins. CHANGELOG notes the rename.
   Also rename: default tmux session `jam` → `claude-jam`, socket `claude-jam-<port>` (already
   right), `@jam-owned` → `@claude-jam-owned`, every printed attach line, every usage string,
   every error/hint mentioning the command, the launcher's own name in `sessions`/`end`/`clean`
   output, and the wiki/README/MANUAL prose. Internal `JAM_*` env vars stay (documented).
   A test asserts no user-visible string emits a bare `jam ` command form.
2. **Repo wiki** (`git@github-padina:roypadina/claude-jam.wiki.git`, already initialized with a
   Home page). Clone to `~/Code/Padina/claude-jam.wiki` (sibling, like AgentCliMenu.wiki) and
   build these pages, each short and task-shaped, cross-linked from Home:
   - `Home` — what it is, 60-second quickstart, page index.
   - `Install` — brew (tap) and from-source paths, prerequisites (node, tmux; optional ttyd,
     cloudflared, tailscale), verification commands and expected output.
   - `Agent-Install` — **the page an agent is pointed at**: a numbered, copy-pasteable,
     non-interactive script of exactly what to run to install and verify, what to check after
     each step, what may prompt a human (Tailscale admin, Funnel enablement, first-run trust
     dialog), and what must never be done (no `tmux kill-server`, no pattern kills). Ends with
     a self-test block whose expected output is stated.
   - `Hosting-a-Jam` — host flow, flags, access modes, ending a jam.
   - `Joining-a-Jam` — guest flow, all client commands, mirror/F2/F3, multi-line keys.
   - `Remote-Access` — LAN/Tailscale, `--tunnel`, `--funnel` (incl. the two admin steps),
     what breaks over 2 hours and what we do about it.
   - `Files-and-Export` — `/send`, `/paste`, `/get`, `/export` + resume recipe.
   - `Security-Model` — the gates that are real (knock/approval ladder, host+loopback checks,
     digit-only permission relay) vs the guards that are only instructions to the model
     (system-prompt rules, token-in-context), secret masking honesty, `bypassPermissions`
     warning.
   - `Architecture` — tmux + WS + JSONL tail, the frame pipeline, ladders, hooks; pointers to
     SPEC.md sections rather than duplicating them.
   - `Troubleshooting` — the real ones we hit: F3/`Ctrl-b d`, trust dialog, cmux `claude` shim,
     spend limits, sandboxed Tailscale, orphan sessions, dot-fill.
3. **`AGENTS.md` in the repo root** — the in-repo counterpart of `Agent-Install`: how an agent
   should work ON this project (layout, `node --test test.mjs`, the ten smokes and their order,
   the commit-per-change convention, the hard tmux/kill rules, where SPEC.md fits) plus a
   pointer to the wiki. README gets a short "For agents" section linking both.
4. **STANDING RULE (extends v0.8's MANUAL.md rule).** Every change that alters a user-visible
   surface — flag, command, key, access mode, install step — updates in the SAME change:
   `README.md`, `MANUAL.md` (claude's own copy), `CHANGELOG.md` (unreleased section), and the
   affected wiki page(s). A doc-drift check belongs in the release step: before tagging, verify
   every command in README/wiki Install/Agent-Install actually runs. Stale docs are a defect.

## v0.22 — no-argument launcher menu, invite links, and a live host menu

### A. `claude-jam` with no arguments → interactive launcher
Ink app (add `@inkjs/ui` ^2 — Select/TextInput/Spinner/Alert/Badge, by ink's own author, same
React 18 + ink 5 stack we already ship; no other new deps). Screens:
1. **Main**: `Host a jam` · `Join a jam` · `My jams` (from v0.18 `sessions`) · `End a jam` · `Quit`.
2. **Host**: cwd (default `process.cwd()`, editable), name (default `$USER`), access mode
   (knock / token / invite-links-only), remote (`none` / `--tunnel` / `--funnel`, greyed with
   the reason when the binary or capability is missing), browser view on/off, extra claude args.
   Shows the exact `claude-jam host …` command it will run before running it — so the menu
   teaches the CLI instead of hiding it.
3. **Join**: paste an invite link OR a ws URL; name and token fields appear only when the input
   is not a link (a link carries both).
4. **My jams**: the v0.18 table, with attach / end / copy-invite actions.
Everything the menu does is an existing subcommand — the menu builds argv, never a second code
path. `--no-menu` (or any argv) keeps today's behavior; a non-tty stdin prints usage as now.

### B. Invite links (no approval, no typing a name)
A link is a single opaque string a host hands out: `claude-jam join <link>` is the guest's whole
command — the link carries the address(es), the guest's name, and a per-invite secret.

- **Format**: `cjam1_<base64url(json)>`, json = `{v:1, jam:<sessionId short>, name:"Yossi",
  secret:<24 url-safe chars>, ws:["wss://<tunnel-host>","ws://<lan-ip>:<port>"], exp:<epoch s>}`.
  Version prefix so a future format is a clean error, not a crash. The client tries the
  addresses in order (tunnel first, then LAN) with a 3 s connect timeout each.
- **Server side**: invites live in the daemon (and in the state dir so a restart keeps them),
  each `{secret-hash, name, uses, maxUses, expires, revoked}`. `hello {invite:"<secret>"}` →
  validate hash, expiry, uses, not revoked, name not currently taken → **admit immediately with
  the embedded name, no knock, no ladder**. Anything invalid → the normal knock path (never a
  silent failure), with a clear reason to the guest.
- **Defaults**: multi-use (so a reconnect works), 24 h expiry, name-bound, revocable. A revoked
  or expired invite disconnects nobody already admitted (they stay until they leave).
- **Security wording (README/MANUAL/wiki, honest):** an invite link IS a credential — anyone
  holding it joins as that name with no approval. Treat it like a password, send it over a
  private channel, `/invite revoke` when done. Per-invite secrets are strictly better than the
  shared `--token` (revocable individually, name-bound, expiring), and the shared token stays
  for quick throwaway cases.
- **Ephemeral-tunnel caveat**: a cloudflared respawn changes the hostname, so links minted
  before it keep working only via their LAN address. The host menu shows a warning and a
  one-key "re-issue all links" action; `--funnel` (stable hostname) avoids it entirely.
- CLI parity: `claude-jam invite <Name> [--uses N] [--expires 24h]`, `claude-jam invites`,
  `claude-jam invite revoke <Name|id>` — the menu drives these.

### C. `/menu` in the client — the live control panel (host)
Ink overlay (Select-driven, Esc closes, everything it does maps to an existing command):
- **People**: who is here, RTT, invite vs token vs knock, actions: remove (`/kick <name>` —
  close 4406, drop from roster, optionally revoke their invite so they cannot walk back in),
  approve/deny anything pending, grant/withdraw standing approvals (`always` grants from the
  ladders, listed and individually revocable — today they are invisible once given).
- **Invites**: list with name/uses/expiry/status, create (name + uses + expiry), copy, revoke,
  re-issue all after a tunnel change.
- **Access**: token new/set/off, invite-only toggle, view (ttyd) on/off, tunnel/funnel start-stop.
- **Session**: `/join` lines, `/files`, `/diff`, `/export` (for the host's own copy), `--replay`
  size, end the jam (v0.18 `/end`), attach to the TUI (F3 hint).
- **Guests** get a reduced `/menu`: what they can do (`/c`, `/mirror`, `/tools`, `/files`,
  `/diff`, `/export`, `/send`, `/answer`, `/help`) with one-key launch, no host controls.
`/menu` is discoverability: every feature we ship must appear there, and the standing doc rule
(v0.21) extends to it — a new user-visible feature that is not reachable from `/menu` is a defect.

#### v0.22B + the `/kick` half of v0.22C — shipped 2026-08-29

The invite half only (A, the no-argument launcher menu, and the rest of C's live `/menu` panel are
not built). 16 unit tests and `scripts/smoke-invite.mjs`, the twelfth smoke — 245 tests in all
after v0.19 and v0.20 landed alongside it.
What is worth knowing beyond the item text:

- **The version is in the PREFIX as well as the payload.** `cjam1_` is matched by
  `/^cjam(\d{1,3})_(…)$/`, so a `cjam2_` link is recognised as an invite and refused as a
  *version* ("update claude-jam") instead of failing as a JSON parse error. A link that kept the
  prefix and edited `v` inside is tampering, and says so.
- **An expired link is refused but still hands back its contents.** `decodeInvite` returns
  `{ok:false, reason:'expired', invite}` — the addresses and the name are exactly what the
  fall-through knock needs, and the *daemon's* clock is what actually decides expiry, so a client
  cannot lie its way in. Every other decode failure has nothing to connect to and exits 2.
- **The name comes off the RECORD, never off the hello.** `checkInvite` returns the bound name and
  `admitSocket` uses it, so a guest cannot rename themselves into somebody else's colour or
  attribution by editing their own command line. The smoke asserts it by sending a different name.
- **Five gates, each with its own reason** (`malformed`, `unknown`, `revoked`, `expired`,
  `used-up`, `name-taken`), all of them ending in the same sentence: *knocking instead*. That
  wording is the contract — a refused invite is never a dead end, because a link is a shortcut
  past the approval, not past the door.
- **`via` is new on every admission** (`host`/`token`/`knock`/`invite`) and rides on the roster
  frame, which is what makes an invite arrival visible at all: there is no knock line to see, so
  `* Yossi joined (invite)` is the only announcement. (v0.25's join sound is NOT built.)
- **One parser, two surfaces.** `parseInviteCommand` serves `/invite …` and
  `claude-jam invite …`, and one `inviteOp()` in the daemon serves the `{t:'invite'}` frame and
  `POST /invite` (loopback + hook secret, the same guard as `/admit` and `/end`). The CLI needed
  no new file: `sessions.mjs` already knew how to find a jam and talk to it.
- **`/kick` is told-then-closed-then-dropped**: the victim gets a `kicked` frame, the room gets a
  `sys` line, the socket closes 4406 (inside the 4400-4429 band every client already treats as
  final, so nobody reconnects), and the roster entry goes on the socket's own `close` handler —
  the one path that cannot leave a ghost. The revoke is *offered* on the reply frame (and
  `/kick <name> revoke` does both), because revoking is the wider action of the two.
- Not built here, and still open from v0.22B: the "re-issue all links after a tunnel change"
  one-key action (it belongs with the v0.24 relay switch), and the launcher menu that would drive
  all of this.

#### v0.22A + all of v0.22C, v0.24, v0.24.1, v0.24.2 and v0.24b — shipped 2026-08-29

Everything of v0.22 and v0.24 except v0.23 (named jams and mDNS discovery, which is untouched).
280 unit tests. What is worth knowing beyond the item text:

- **One tree, two renderers, and a test with teeth.** `menuTree()` in lib.mjs is the whole
  product surface as data; `menu.mjs` (the launcher) and the `/menu` overlay in client-ink.mjs
  are renderers over it, and `menuGaps()` is the completeness check. The check requires a
  DESCRIPTION of at least eight characters, not merely an entry — otherwise a generated row per
  `JAM_COMMANDS` entry would make the test vacuously true. Adding a command to `JAM_COMMANDS`
  with no `COMMAND_HELP` line fails four tests (verified by adding `/summon`); adding a
  `HOST_FLAGS` row with an empty description fails the flag half.
- **`menuRunsBare()` asks the parser, not a list.** "One-key run" only makes sense for a command
  that means something on its own, so the menu runs `/who` and puts `/kick ` on the input line —
  decided by whether `parseClientLine('/kick')` is a usage error. Nothing to keep in sync.
- **The panel has to take the keyboard whole.** The client pulls `↑`/`↓` out of the byte stream
  for input recall and hands Esc to the approval bar *before ink sees them* (v0.10b's key
  filter). With the panel open, a Select therefore never moved and Esc never closed it. The fix
  is one early return in the stdin handler, and it is the reason `/menu` is an overlay that owns
  the live region rather than a widget beside the input row.
- **v0.24b was not a delivery bug.** Reproduced against a stub daemon: `{t:'token'}` reaches a
  connected host client exactly as designed. The client rendered it into the MIRROR view's
  three-row deferred strip — the mirror being the default view since v0.14 — where three
  ordinary `sys` lines pushed it off within 1.5 s. So the announcement is a one-line `relay`
  event with `strip:true` and deliberately NOT `toTranscript`: the transcript is where it would
  scroll away, the strip is where the host is looking, and the deferred list is flushed into the
  transcript on the way back, so nothing is lost either way.
- **A re-issue has to wait for the hostname.** The first cut re-issued at switch time and the
  live run proved it worthless: the daemon logged `minted … → ws://100.86.8.97:7881`, i.e. the
  LAN address the re-issue exists to replace. It is now deferred to the `ready` branch of
  `onTunnelChange()`; turning a relay OFF still re-issues immediately, because the LAN address
  is already final.
- **A re-issue is a NEW link, and says so.** The daemon keeps only the hash of each secret, so a
  link cannot be re-encoded with new addresses. Re-issuing mints a fresh link per name (same
  uses, same remaining expiry) and revokes the old record — which is the honest version, and
  means the old links stop working.
- **`--invite-only` closes the KNOCK door only.** A valid token and the host's own loopback
  client are classified before it, so it never locks the host out of their own jam; the refusal
  is a 4405 close with the reason, never a silent hang.
- **Invite-only rides on `/token`, not a command of its own**, because it is the same question —
  how people get in — and the reply is the same `token` frame that already carries the access
  state. `/menu` and `/remote` are the only two names added to `JAM_COMMANDS`.

## v0.23 — named jams and LAN discovery

Guests on the same network should be able to find jams instead of being handed a URL.

1. **A jam has a name.** `claude-jam host --jam-name "reeco debugging"` (default: the cwd's
   basename, so it is never empty). The name shows in the launcher menu, `claude-jam sessions`,
   the client's welcome, `/menu`, and the discovery listing. It is cosmetic — never used for
   auth or paths.
2. **Advertise over mDNS/DNS-SD, no new dependency.** macOS ships `dns-sd`; advertise with
   `dns-sd -R "<jam name>" _claude-jam._tcp local <port> <txt...>` as a tracked child (same
   lifecycle discipline as ttyd/cloudflared: killed on exit, respawned with backoff on death).
   TXT record carries ONLY: `jam=<name>`, `host=<host display name>`, `id=<8-char session id>`,
   `access=knock|token|invite`, `view=yes|no`, `v=<jam version>`. **Never** the token, an invite
   secret, the cwd, or any path. If `dns-sd` is absent (Linux) try `avahi-publish-service`;
   if neither exists, skip discovery with one log line and no error.
   The implementer must verify `dns-sd -R`/`-B` output parsing against the real binary and, if
   parsing proves unreliable in practice, may fall back to the `bonjour-service` npm package —
   report which shipped and why.
3. **Find jams.** `claude-jam find` (alias `discover`) browses `_claude-jam._tcp` for ~3 s and
   prints a table: jam name, host, access mode, address:port, view. `--json` for scripting.
   In the launcher menu, **Join a jam** starts with the discovered list (Select), plus
   "paste a link or URL" as the last row; `claude-jam join` with no argument does the same.
   Picking a knock jam connects and knocks; a token jam prompts for the token; an invite-only
   jam says so and asks for a link.
4. **Privacy, stated plainly.** Advertising tells everyone on the local network that this jam
   exists, its name and the host's display name — that is the point, and it is a leak on an
   untrusted network (café wifi). Default is ON for LAN; `--no-announce` disables it, and the
   launcher menu has an "announce on the network" toggle. Discovery never bypasses a gate:
   a found jam still requires knock approval, a token, or an invite link. Tunnels are not
   advertised (mDNS is link-local by design, and a tunnel is for people who are not here).
5. Docs: README, MANUAL (so claude can explain "how do I find Roy's jam"), wiki
   `Joining-a-Jam` + `Security-Model` (the privacy note), CHANGELOG. `/menu` gains the
   announce toggle and shows the jam name.

#### v0.23 — shipped 2026-08-29

All five items. 306 unit tests (283 + 23) and a fourteenth smoke,
`scripts/smoke-discover.mjs`. What is worth knowing beyond the item text:

- **`dns-sd -Z` shipped, not `bonjour-service`, and not an avahi fallback.** The parsing was
  verified against the real /usr/bin/dns-sd before a line of it was written, and `-Z` was chosen
  over `-B`/`-L` on measured grounds: it is the only mode that returns the instance name, the
  port, the target host and the whole TXT record together, in one child, in a stable zone-file
  layout. `-B` returns names with neither port nor TXT (a second `-L` per name to fill them in);
  `-L` prints TXT backslash-escaped, which is strictly harder to read back than `-Z`'s quoted
  strings. Two other measurements decided design points: dns-sd **flushes on a pipe** (first
  chunk within milliseconds, complete), so a streaming parse works and no pty is needed; and a
  browse for a type nobody advertises **prints nothing at all**, so "no output" is the empty
  answer rather than a failure to detect. The npm fallback was never needed. The avahi half of
  item 2 is a **stated deviation**: avahi-browse prints a different format, there is no avahi
  here to verify a parser against, and a parser written from a man page is the confident wrong
  fix the `-Z` parser exists to avoid. `dns-sd` is looked for on any platform (Bonjour ships it
  on Windows, avahi's compat package on Linux), and a machine with none skips discovery with one
  line and the fix — which is what the item asked for in that case anyway.
- **The TXT record is an allow-list, not a redaction pass.** `discoveryTxt()` builds six keys out
  of whatever object it is handed, so a caller who spreads a whole session in — token, hook
  secret, view key, invite links, cwd, state dir — still publishes six keys. A deny-list would
  have to be remembered; this cannot be forgotten. Asserted twice: against that exact object in
  the unit suite, and against the RAW record dns-sd hands back, with a token set and an invite
  minted, in the smoke.
- **Two names, deliberately.** `--tmux` stays the identifier (a tmux-legal word, what `end`
  takes) and `--jam-name` is the label. They are usually different words, so `sessions` grew a
  column, session.json records both, and the Host screen has a row for each. The launcher
  resolves the cwd default ONCE and passes it to the re-exec'd daemon already resolved — two
  processes computing it independently is how they end up disagreeing about the jam's name.
- **An access mode the TXT did not state is `?`, never a cheerful "knock".** A refusal carries
  its own reason in this codebase, and so does an unknown; the Join screen then offers a knock as
  the thing to try, because the daemon is the one that decides and it will say no if it means no.
- **Re-announcing compares first.** The TXT states the access mode, so a token rotation, an
  invite-only flip and a view toggle must all re-register (dns-sd takes its TXT on the argv).
  Comparing before acting is what makes it safe to call from `onTunnelChange()`, which also fires
  on every relay flap and would otherwise drop the jam off the network and put it back each time
  cloudflared reconnects.
- **The smoke's teardown found a real leak — in the smoke.** `killMine` used one socket for every
  session, but `tmuxSocketFor()` names a server per port, so three of four kills silently did
  nothing and left daemons running with live advertisements on the network. Every step had
  already passed; nothing else would have noticed. The teardown check is now a FAILING step
  rather than a warning, because an advertisement left on somebody's network is not a note to
  read later.

## v0.24 — the menu is the whole product surface (amends v0.22C)

Two additions Roy asked for explicitly.

1. **Relays are runtime-controllable, not launch-only.** A jam started plain must be able to go
   remote later, and back:
   - `/menu → Access → Remote`: `off` · `tunnel (cloudflared)` · `funnel (tailscale)`, switchable
     while the jam runs. Starting spawns the relay child(ren) through the SAME code the launcher
     uses (`startTunnels`/`startFunnel` — one path, no duplicate), waits for the hostname with a
     spinner, then propagates everywhere the existing `onTunnelChange()` already reaches:
     `joinInfo()` → `token.json` → claude's context → `printJoin()` → `{t:'token'}` to host
     clients → the menu's own live view. Stopping kills the tracked children and clears the URLs.
   - Because links minted earlier embed the old address list, switching relays offers
     **"re-issue all invite links"** in the same step (v0.22B), and says how many links were
     re-issued. Guests already connected are never dropped by a relay change.
   - CLI parity for scripting: `claude-jam remote <off|tunnel|funnel> [--jam <name>]` talking to
     the daemon over the loopback control endpoint (same guard as `/admit`).
   - Preconditions surface as reasons, not silence: cloudflared/tailscale missing, Funnel not
     enabled for the tailnet, sandboxed App Store Tailscale — each shown inline in the menu row
     with the exact fix.
2. **Every feature, and the guides, live in the menu.** `/menu` gains a **Help & guides**
   section: a searchable list of every jam command with its one-line description and one-key
   run; the keyboard reference (F2 mirror, F3 attach/detach, Shift+Enter, Esc re-arm, `a`/`d`);
   the MANUAL.md sections rendered inline (scrollable, since MANUAL.md is the same text claude
   is given, so a human and the agent read one source); and links to the wiki pages
   (Install, Hosting, Joining, Remote-Access, Files-and-Export, Security-Model, Troubleshooting).
   - **Completeness is enforced by a test**, not by discipline: a unit test asserts every entry
     in `JAM_COMMANDS` (and every documented flag of `host`) appears somewhere in the menu tree
     with a description, and fails when a new command is added without a menu entry. Same rule
     for the guest's reduced menu (it must list exactly what a guest may do).
   - The menu shows current state next to each toggle (view on/off, announce on/off, access mode,
     relay + URL, replay size, participants, standing approvals) so it doubles as the status page.

**Shipped 2026-08-29** — see the notes under v0.22B above. `announce on/off` is the one item not
built, because v0.23 (mDNS) is not built; everything else in v0.24, v0.24.1, v0.24.2 and v0.24b
is in, plus `--invite-only` and a runtime on/off for the browser view, which v0.22C's Access
section needed and which did not exist.

## v0.24b — invite-line noise and the missing relay-up announcement

Observed live (14:25): the host's welcome printed only the LAN invite line because cloudflared
had not resolved yet; nothing announced the tunnel when it came up ~10 s later; and a later
`/join` then printed the full set, leaving three near-identical lines in the log with no
indication which was current.

- **Announce a relay when it becomes ready**: when `onTunnelChange()` resolves a NEW hostname,
  host clients get a distinct one-line event — `tunnel ready: <join line>` (and the same for
  funnel / for a hostname change after a respawn) — not a silent `{t:'token'}` that only
  refreshes state. Verify the push actually reaches a connected host client (it did not
  visibly do so in the observed run; treat that as a bug to reproduce and fix, not just a
  wording change).
- **At boot, say what is pending instead of printing a soon-stale line**: with `--tunnel`/
  `--funnel` the welcome shows `tunnel: starting…` under the LAN invite, replaced by the real
  line when it lands.
- **`/join` replaces rather than appends**: one compact block with a heading
  (`── invite ─────`), the current lines, and a dim `(earlier invite lines above are stale)`
  when the log already holds some — or better, tag every printed invite line with a short
  timestamp so "which one is live" is unambiguous. Same for `{t:'token'}` refreshes.

## v0.25 — audible join events (Roy: a knock sound, and a different one for auto-join)

Extends v0.17 P3/P4 (bell + desktop notification on `waiting`/mention) to arrivals, with two
distinguishable sounds so the host knows without looking whether someone needs approving.

- **Knock** (someone is waiting for you): `afplay /System/Library/Sounds/Submarine.aiff` — a
  slow "knock" tone — plus the existing terminal bell as the fallback, plus a macOS
  notification `⚑ <Name> wants to join`. Repeats once after 30 s if still unanswered, then
  stops (never a loop).
- **Auto-join** (token or invite link: they are already in): `Glass.aiff`, quieter semantics —
  one short chime, notification `<Name> joined`, no repeat.
- **Leave**: no sound (avoid noise); roster line only.
- Implementation: one `notifySound(kind)` helper next to the existing bell/osascript code
  (`spawn('afplay', [path], {stdio:'ignore'})`, non-blocking, failure ignored, macOS-only —
  Linux tries `paplay`/`aplay` if present, else silent). Host client only; guests never get
  arrival sounds. Verify the files exist at startup once and remember the answer.
- Controls: `--no-sound` flag, a `/menu → Access/Notifications` toggle (sound on/off,
  notifications on/off, bell on/off) persisted for the session, and `/sound on|off` for the
  keyboard-only path. Respect it everywhere, including the v0.17 `waiting` bell.
- Docs: README, MANUAL (so claude can answer "turn off the sounds"), wiki Hosting page,
  CHANGELOG; and the sounds must appear in the `/menu` completeness test (v0.24).

**Shipped 2026-08-29.** All of it, with three notes. (1) The helper is `alert(title, body,
{event, phone, force})` in each client rather than a `notifySound(kind)` — the sound was never
the only tier, and one function deciding all of them (through lib's pure `notifyPlan()`) is what
makes `--no-sound` silence the sound and nothing else. (2) The knock repeat re-reads the daemon's
own `pending` frame rather than a client-side timer flag, so a knock that was accepted, denied or
expired in the meantime fires at nobody. (3) `platform.mjs` gained `soundFile(kind)`, which stats
once per kind and remembers the answer — including a remembered *no*. The Linux `paplay`/`aplay`
branch is written but marked UNVERIFIED in the source: there is no Linux box here to check it
against, and the project's rule is to say so rather than to pretend.

## v0.26 — nudges: any human can get another's attention

Mentions already ring a bell (v0.17 P3), but only if the person is watching that terminal.
A nudge is an explicit, addressed "look at the screen" that every participant can send, and
that each recipient's own machine decides how to surface.

- **Command**: `/ping <Name> [message]` (alias `/nudge`), `/ping all [message]`, from anyone —
  host and guests alike. The addressed client shows `👋 Roy is asking for you: <message>` as a
  highlighted line (not a chat line), and everyone else sees a dim `* Roy nudged Yossi`, so a
  nudge is never secret.
- **Wire**: `{t:'nudge', from, to:'<Name>|all', text}` → daemon validates the target is in the
  roster, rate-limits **one nudge per sender→target per 30 s** (and per sender→all per 60 s)
  with a clear refusal, then routes it. Never queued for someone offline: the sender is told
  `Yossi is not connected` instead.
- **Local surfacing, decided by the recipient, not the sender** (three tiers, all toggleable
  in `/menu → Notifications`):
  1. in-terminal: highlighted line + bell + `Hero.aiff` (distinct from the knock/join sounds);
  2. macOS notification via the existing helper (`👋 <from>` / the message);
  3. **phone**, opt-in: if the recipient has `~/.config/claude-jam/config.json` with
     `{ "ntfy": { "server": "https://ntfy.sh", "topic": "<their topic>" } }`, their own client
     POSTs the nudge to that topic. The topic is a secret that stays on the recipient's machine
     — it is never sent to the host, never in an invite link, never in the protocol. Failures
     are silent (one dim line at most).
- **Idle awareness** (makes nudging purposeful instead of guesswork): each client reports a
  coarse `idle` seconds value (no keystroke and no submit) on the existing heartbeat; `/who`,
  the roster and `/menu → People` show `active` / `idle 4m` / `away 20m+`, and the nudge
  confirmation says which state the target was in. Nothing keystroke-content is ever reported —
  only "time since last local activity".
- **Escalation, opt-in per sender action**: `/ping <Name> !` repeats the nudge once after 60 s
  if the target has not become active — and only once, never a loop.
- Docs: README, MANUAL (claude must be able to explain "how do I get Roy's attention"), wiki
  Joining/Hosting + Security-Model (the ntfy topic stays local), CHANGELOG; `/ping` and the
  notification toggles appear in `/menu` (v0.24 completeness test covers it).

**Shipped 2026-08-29.** As specified, with two implementation notes worth recording. (1) ONE
frame goes to everybody (`{t:'nudge', from, to, text}`) rather than a private frame plus a public
one: the client decides whether it is the addressee, which is the same place the three tiers are
decided, and it makes "a nudge is never secret" true by construction. It is sent with a new
`sendAll()` that does **not** write history — an interruption is not something to re-read on
join. (2) Idle is pushed only when the BUCKET changes (active → idle → away), not on every
heartbeat, and through the same `sendAll()`; a per-heartbeat roster broadcast would have evicted
the actual transcript from the replay ring one quiet minute at a time. The daemon never learns
anything about a phone: `parseJamConfig`/`ntfyRequest` are client-side and a unit test asserts the
topic appears in nothing but the URL of a request that client makes itself.

## v0.27 — upload policy: auto-allow files from already-admitted guests

Today every `/send` and `/paste` asks the host (per-person `always` exists but must be granted
one guest at a time). Roy wants a session-level choice.

- **Policy**, settable at launch (`--uploads ask|auto|off`, default `ask` — unchanged) and at
  runtime from `/menu → Access → Uploads` (three-way toggle, current value shown):
  - `ask` — today's behavior: every transfer hits the approval ladder.
  - `auto` — anyone already admitted (knock-approved, token, or invite link) may send files and
    pasted images with no prompt. The transfer line still appears for everyone, and the host
    still sees `⇪ Yossi sent screenshot.png (2.1 MB) → jam-uploads/…` in the log — visible, just
    not gated.
  - `off` — refuse all uploads with a clear reason, regardless of any standing per-person grant.
  Per-person `always` grants keep working under `ask` and are listed/revocable in
  `/menu → People` (v0.22C).
- **What NEVER relaxes, in any policy** (these are the actual protections, not the prompt):
  basename sanitizing and traversal refusal; the 20 MB per-file cap; one transfer in flight per
  client; writes confined to `<cwd>/jam-uploads/`; nothing executed, nothing auto-opened;
  announced-vs-actual byte mismatch still drops the upload.
- **New guard that `auto` makes necessary — a session quota**: 40 files or 200 MB total per
  session (whichever first), after which the policy falls back to `ask` with one line saying so
  (`upload quota reached — asking again`). Prevents an `auto` session from quietly filling the
  disk; host can raise it with `--upload-quota <n>[MB|files]` or reset it from the menu.
- **Export stays separate and stays `ask` by default** — a transcript is the whole conversation,
  including file contents claude read; it gets its own `--export ask|auto|off` toggle in the
  same menu section, and the docs say plainly why the two defaults differ.
- Docs: README, MANUAL (claude should be able to answer "why didn't it ask me this time"), wiki
  Files-and-Export + Security-Model, CHANGELOG; both toggles appear in `/menu` (v0.24 test).

**Shipped 2026-08-29**, exactly as written, plus the one decision the spec left implicit: `off`
refuses the HOST's own `/paste` too. "Refuse all uploads, regardless of any standing per-person
grant" reads as a hard stop, a hard stop with an exception is not one, and the refusal names the
menu row that undoes it — so it is one keypress to reverse and impossible to mistake for a bug.
The order in `onUpload()` is load-bearing and commented as such: one-in-flight, basename,
traversal, size cap, and only THEN the policy. The quota is spent where the bytes land rather
than where they were announced, so a dropped mismatch costs the session nothing.

## v0.28 — real scrollback (Roy: "I can only see very little")

**SHIPPED 2026-08-29.** All five items. Five things the implementation found that the spec did
not know:

1. **The scrollback churn had a specific, measurable cause**, and it was not repainting as such.
   In ink 5.2.1 `onRender` takes a different path once the live region is as tall as the
   terminal: it writes `ansiEscapes.clearTerminal` — whose `\x1b[3J` clears the terminal's SAVED
   LINES — and then reprints the whole `<Static>` log. `fitFrame` sizes a mirror frame to exactly
   that height. So the alternate screen is the right fix for a second reason: in the mirror view
   there is now no `<Static>` at all, so the branch has nothing to reprint and nothing to clear.
2. **`<Static>`'s index only moves forward**, so one ink instance cannot print into two buffers.
   The client therefore mounts again on every view flip, which forces one invariant to be written
   down and kept: `store.entries` is what has NOT yet reached the terminal, ink's final render on
   unmount writes it, and it is emptied immediately afterwards. That invariant is also what
   retired the F3 re-feed.
3. **The client has to OPEN on the transcript** and enter the mirror once the welcome block is
   printed. Entering the alternate screen first would have put the block a first-time guest needs
   into a buffer that the first F2 throws away — the v0.24b bug, in a new costume. The same
   problem for later `toTranscript` blocks (the invite lines) is solved by drawing them over the
   mirror for 45 s as well as queueing them for the transcript.
4. **`#{history_size}`, not `history-limit`**, is what "as far back as it goes" has to come from:
   the limit is what the pane MAY keep, and a jam two minutes old has almost none of it. Measured
   on the smoke's own pane: 373 lines above a 30-row window.
5. **The ring and the replay had to become two numbers.** They were one, which is why the
   complaint had no answer that did not also flood every new arrival. `--replay` bigger than
   `--history` is now one line at boot rather than a short replay nobody can explain.

Three distinct gaps make the client feel amnesiac next to a normal Claude Code session:
(a) the mirror repaints the same terminal region, churning the native scrollback the transcript
wrote, so flipping views loses history; (b) the mirror shows only the CURRENT screen — the
host's pane scrollback is never sent, so a guest cannot scroll back through the real TUI at all;
(c) returning from an F3 attach re-feeds only the last 40 transcript lines.

1. **Mirror renders in the alternate screen buffer.** Entering mirror view emits `smcup`
   (`\x1b[?1049h`), leaving emits `rmcup` — exactly how `less`/`vim`/tmux behave. The transcript
   view then owns the normal buffer, its lines stay in the terminal's real scrollback, and
   flipping F2 ⇄ mirror is lossless in both directions. Same treatment for the F3 attach path
   (tmux already does it) so a return no longer needs a re-feed at all; the 40-line re-feed and
   its README ceiling go away.
2. **Scrollable mirror = the host's real pane history.** In mirror view, `PgUp`/`PgDn`
   (and `Shift+↑/↓`, and wheel events when the terminal sends them) enter a scroll mode: the
   client asks `{t:'screen-history', before:<row-offset>, rows:<n>}` and the daemon answers from
   `tmux capture-pane -e -p -S -<n> -E -<m>` on the claude pane — the actual scrollback, colors
   included, capped at the last 2000 lines and served in ≤200-row pages (cached per offset for
   2 s so PgUp spam costs one capture). The status row shows `⧉ mirror · scrolled back N lines
   — End/G returns to live`; live frames pause while scrolled (never silently dropped: the row
   says how many arrived) and resume on End/`G`/Esc.
3. **Transcript history is no longer a 300-event stump.** `--replay N` accepts `all`; the ring
   buffer becomes a bounded deque sized by `--history` (default 2000 events, cap 20000) and a
   joining client receives `min(--replay, history)`. New `/history [n|all]` re-prints further
   back on demand (paged, dim divider per page). `/export` remains the exact, complete record.
4. **Say what the limits are, where they bite.** The client prints, once, on first scroll to the
   top: `— that is as far back as this jam kept (N events · host pane 2000 lines) · /export for
   the full transcript`. No silent truncation anywhere.
5. Docs: README, MANUAL (claude must answer "how do I scroll back"), wiki Joining-a-Jam +
   Troubleshooting, CHANGELOG; the keys join the `/menu` keyboard reference (v0.24 test).

## v0.29 — peer tasks: the host's agent can dispatch to a guest's own Claude (judged)

Source: ~/ClaudWork/2026-08-29-jam-distributed-agents/RESEARCH.md. Judged: build Design A
(host-side MCP tool + per-task guest approval + the guest's OWN `claude -p`), skip MCP sampling
(deprecated, unimplemented) and skip the Agent SDK as the executor (it authenticates with an API
key, so it would pool nothing). Design B's shared queue survives only as the documented fallback
for a guest who declines automation — no code.

**The compliance frame is part of the feature, not a footnote.** Every task runs on the guest's
machine, in their own already-authenticated Claude Code, spending their own quota, and ONLY after
that guest approves that specific task. No credential ever crosses the wire; the host never sees
a guest's token; nothing is ever executed on a guest's behalf without their explicit consent.
README/MANUAL/wiki state this, state that a guest may decline anything, and state the open
question (whether a coordinated multi-account fan-out counts as ordinary individual usage) so
nobody discovers it later. Feature is OFF by default: `--peer-tasks` on the host, and a guest
opt-in (`/peer on`) before they can be dispatched to at all.

1. **Host side.** An in-process MCP server exposes to the host's own claude:
   `list_peers()` → `[{name, capable, busy, tasksToday, tokenBudgetLeft?}]`, and
   `dispatch_to_peer({peer, prompt, allowedTools?, maxTurns?, schema?})` → the peer's result, so
   the host agent uses it exactly like the built-in Agent tool (including structured output when
   `schema` is given). Registered via the generated `--settings` (never the user's global config).
2. **Wire.** New `peertask` frames on the existing protocol, modelled on the `ladders` table in
   `host.mjs` but with the direction inverted (host asks, guest approves):
   `{t:'peertask', id, prompt, allowedTools, maxTurns, deadline}` →
   `{t:'peertask-ack'|'peertask-decline'}` → `{t:'peertask-progress', text}` (streamed) →
   `{t:'peertask-result', ok, text|json}`. Progress and result are ALSO broadcast into the
   transcript attributed `[Dana → task]` so the whole room sees what was asked and what came back.
3. **Guest side.** The guest's client shows the FULL prompt, the tool whitelist, the caps and who
   asked, then `[a]ccept · [d]ecline · [n]ever this session`. On accept it spawns
   `claude -p --output-format stream-json --allowedTools <list> --max-turns <n>
   --permission-mode plan|acceptEdits(never bypass) --settings <generated>` in a **fresh scratch
   dir** (`$TMPDIR/claude-jam-peer-<id>`), never the guest's repo, with the guest's own MCP
   servers disabled, and streams the output back. Cancel any time with `Esc`.
4. **Non-negotiable controls** (from the research's trust-boundary section):
   per-task approval; default tool whitelist is read-only research (`WebSearch`, `WebFetch`,
   `Read`, `Grep`, `Glob` inside the scratch dir) with `Bash`/`Write`/`Edit` requiring the guest
   to opt in per task; scratch cwd only; no guest MCP servers; hard caps on turns AND wall-clock
   (`--max-turns` is a proxy, not a spend cap — say so); a per-guest daily task/consent counter
   they can zero; an audit log both sides can read (`/peers log`); and prompt-injection treated
   as bidirectional — the host's prompt is untrusted input on the guest's machine, and the
   guest's result is untrusted input in the host's context (results are quoted, never executed,
   and never auto-applied to files).
5. **Failure honesty.** Decline, timeout, cap-hit and crash are all distinct results the host
   agent sees, with partial output preserved. A busy or offline peer is reported, never queued
   silently.
6. Docs per the standing rule, plus a wiki page `Peer-Tasks` covering the compliance frame,
   what a guest is agreeing to, and how to say no.

**SHIPPED 2026-08-29.** All six items. Five things the implementation found that the spec did not
know, all of them checked against `claude --help` on 2.1.251 rather than assumed:

1. **`--max-turns` DOES NOT EXIST** on 2.1.251. The wire keeps `maxTurns` (it is the cap the guest
   consents to and the number in the audit line), but it is enforced by COUNTING the
   `{"type":"assistant"}` events in the stream and killing the child by pid — which is strictly
   stronger than a flag anyway. `--max-budget-usd` does exist and is a real spend cap; it was NOT
   adopted, because it cannot be tested without spending and an inert or refusing flag would break
   every task. Recorded in TESTING.md for the campaign to decide.
2. **`--restricted` is the flag that gives the spec's "confined to the scratch dir"**, and it does
   more than that: it also makes claude ignore the guest's user, project and local settings files
   (which is what stops a machine whose own default is `bypassPermissions` from handing that to
   work somebody else asked for) and it refuses `bypassPermissions` outright. `--allowedTools`
   alone would NOT have confined `Read` to the directory. `--tools` is passed as well, so the
   built-in set really is the whitelist rather than merely the pre-approved part of it.
3. **The MCP server is registered with `--mcp-config`, not `--settings`.** The spec said
   `--settings`; a settings file has no `mcpServers` key on 2.1.251 and passing one would have
   registered nothing, silently. The load-bearing half of that requirement — a GENERATED file jam
   controls, never the user's global config — is unchanged and is what `--mcp-config` does.
   Deliberately additive (no `--strict-mcp-config` on the HOST): turning off the host's own MCP
   servers because they enabled a claude-jam feature would be a regression nobody asked for. The
   GUEST's spawn is the opposite, and gets `--strict-mcp-config` with no config at all.
4. **It is a stdio server in a tiny process (`peer-mcp.mjs`), not literally in-process.** Hand-
   rolling Streamable HTTP (sessions, SSE, protocol-version negotiation) to keep it inside the
   daemon would have been much more code and much more to get wrong for no gain: the shim is a
   pipe, and every decision still belongs to the daemon, reached over the same loopback+secret
   endpoint `hooks.sh` and `claude-jam end` already use. Verified against the real claude 2.1.251
   with `claude mcp get` under a throwaway `CLAUDE_CONFIG_DIR` — "✔ Connected", no turn spent.
5. **`/peer never` is per SOCKET, not per name.** "Never this session" means the guest's client
   session: a name-keyed refusal would outlive a reconnect and a person who changed their mind
   could never opt back in. The client holds the flag too, so no host can clear it.

Also added beyond the spec, because the spec's list implied them: `deadlineMs` on
`dispatch_to_peer` (the wall clock is the cap that actually ends things, so it had to be
askable), `/peer accept tools` as a distinct TYPED gate for `Bash`/`Write`/`Edit` (the spec said
"opt in per task" — a keypress is not a distinct act), and `/peer reset` for the daily counter the
spec said a guest could zero.

An ADOPTED jam cannot have the tools at all: `--mcp-config` is read once at claude's startup and
an adopted claude was started by somebody else. Said out loud at launch rather than discovered.

## v0.30 — big pastes must not fail, and a message must never be lost (URGENT, observed live)

**SHIPPED 2026-08-29.** All four items, plus the fixture corpus. Three things the implementation
found that the spec did not know:

1. It is not only *big* pastes. Measured on 2.1.251, **any** paste carrying a newline collapses to
   `[Pasted text #N +M lines]` — from three lines up — so every multi-line message ever sent had
   this failure available to it.
2. **The last three rows of the pane are not the input box.** They are chrome that changes on its
   own (`⏸ manual mode on · ← for agents` becomes `paste again to expand` after a paste), so
   diffing them as the spec described would have reported a landed paste that never landed.
   `inputAreaRows()` finds the real box instead — from the last prompt row to the rule that closes
   it.
3. **A pty drops what a busy TUI does not read in time.** An 8 KB `paste-buffer` into a pane
   mid-redraw arrived 4.2 KB short with no error anywhere. So the chunk is 2 KB, not the ~8 KB the
   spec asked for, and each piece is verified against the count in its own placeholder — a short
   count is a truncation, and the message is kept rather than half-sent.

Also measured and worth keeping: one `Ctrl-U` kills one visual line rather than the whole input, so
clearing a wrapped box means repeating it; the box writes `❯` + U+00A0 while an option row writes
`❯` + a plain space; and `sanitize`'s 20 000-character cap, not the paste path, is what limits how
big a message can be — the spec's "200 KB brief" is a file, not a message.

Observed 2026-08-29 15:20: a long multi-line message failed with `injection failed: pasted text
never appeared in the claude pane`, and `Ctrl-U` then wiped it from the input box. Cause: Claude
Code 2.1.x renders a large paste as `[Pasted text +NN lines]`, so the echo probe — the first ~40
chars of the payload's first line (`inject()` in host.mjs) — can never match. Recovery was only
possible because `broadcast()` runs before `enqueueInject()`, i.e. by luck, not design.

1. **Verification accepts every way a landed paste can look.** Success = the probe text appears
   **OR** a paste placeholder appears (`/\[Pasted text( #\d+)?( \+\d+ lines)?\]/i` — match on the
   family, not one exact string) **OR** the input area changed from the pre-paste capture (diff
   the last 3 rows captured immediately before `paste-buffer`). Only if none of the three holds
   after the poll budget is it a failure. Add a test corpus of real pane captures (plain short
   text, wrapped long line, placeholder form, empty box) so a future Claude Code rendering change
   fails a test rather than a user's message.
2. **Never destroy the payload.** Before pasting, write it to `<state>/outbox/<ts>-<name>.txt`
   (0600); delete only after verified submission. On failure: keep the file, do NOT press
   `Ctrl-U` blindly — capture the box first, and only clear if something is actually in it; then
   tell the sender `couldn't confirm your message reached claude — kept at <path> · /retry to
   send it again` and broadcast nothing new. `/retry` (host and the original sender) re-sends the
   newest kept payload; `/outbox` lists what is kept; a verified send prunes it.
3. **Client-side input history** (missing entirely today, and the reason a lost message hurts):
   `↑`/`↓` walk your own last 50 submissions (per client, in memory + `~/.config/claude-jam/
   history` capped at 200 lines, 0600), so anything typed can be recalled and re-sent whatever
   the daemon did.
4. **Chunk very large payloads.** Above ~8 KB, split on line boundaries into ≤8 KB pastes into
   the same input box (paste-buffer per chunk, verify each landed by the rules in 1, Enter only
   after the last) so a 200 KB brief cannot trip a single-shot placeholder/timeout edge.
5. Docs: README (a "your message was kept" troubleshooting entry), MANUAL (claude must be able to
   say where a failed message went), wiki Troubleshooting, CHANGELOG; `/retry`, `/outbox` and the
   `↑`/`↓` recall go in `/menu` (v0.24 completeness test).

## v0.31 — questions are not permissions: classify the prompt, let anyone answer (observed live)

**SHIPPED 2026-08-29.** All five items. What the implementation learned from the real pickers:

- An `AskUserQuestion` is recognised by any ONE of three measured signals — a checkbox header, a
  `Type something.` free-text option, or a `to navigate` footer. A numbered picker with none of
  them is classified as a **permission**, deliberately: being wrong that way costs the host one
  approval; being wrong the other way would hand a guest a tool grant.
- A multi-question form draws a tab bar whose answered tabs flip from an empty box to a crossed
  one, and focus advances to the first unanswered on its own — so "which question is on screen" is
  observable rather than guessed. Only that one can be answered, because moving between tabs is a
  Tab keypress, i.e. raw keyboard.
- The review step at the end of a form ("Ready to submit your answers?") is still a question, and
  has no focused tab, so it is not given one.
- Measured: a bare digit answers an `AskUserQuestion` picker on its own, exactly as it answers a
  permission prompt — so the v0.17 typing path needed no change.
- The hook was demoted further than the spec asked: it does not trigger a sound of its own, it
  triggers a *look at the screen*. The bell then fires on the classified transition, so it too can
  never be about a prompt that is not there.

Observed 2026-08-29 15:26: the status row said `⚠ waiting for permission` while the pane was
actually showing an **AskUserQuestion** picker, and the flag stayed up after the questions were
answered. Root causes: one `waiting` boolean fed by the Notification hook regardless of what the
prompt is, cleared only when the next assistant record happens to arrive.

1. **Derive the state from the pane, not from a hook event.** The frame pipeline already captures
   the pane 25×/s; classify the CURRENT frame into `none | question | permission | dialog`
   (AskUserQuestion header + numbered options + `Other`; a tool-approval prompt naming a tool;
   the trust/onboarding dialogs) with one pure, tested classifier over captured rows. The hook
   event may still trigger the sound/notification, but the STATUS is whatever the screen says,
   so it can never go stale. Frames already stop when nobody watches — poll the classifier on the
   same cadence and cache it.
2. **Distinct, honest wording**, and the question itself is shown, not just its existence:
   - question → `⚠ claude is asking: <first line>` and the numbered options rendered as a
     highlighted block **in every client, in both views** (a guest in transcript view must see
     it), with `/answer <n>` right there.
   - permission → `⚠ waiting for permission (<tool>)` — unchanged host-gated behavior.
   - dialog → `⚠ claude needs the host at the keyboard — F3`.
3. **Anyone may answer a question; only the host may grant a permission.** A question is a
   product decision, not a security grant:
   - `question`: any participant's `/answer <n>` goes straight through — validated against the
     options visible in the CURRENT frame, digit-only, first answer wins (others told
     `already answered by Dana`), and the room sees `* Dana answered: 2. Mix both`.
     `--answers host|anyone` (default `anyone`) and a `/menu → Access` toggle for hosts who want
     it locked.
   - `permission`: the v0.17 P2 ladder stays exactly as it is (guest requests, host approves,
     digit-only, five gates).
   - `Other`/free-text options: host only, because typing arbitrary text into the TUI is raw
     keyboard access (`/answer other <text>` for the host; a guest asking for that gets the
     ladder, i.e. host approval, and the text is shown to the host before it is typed).
4. **Multi-question forms** (AskUserQuestion can ask several at once): the block shows question
   1..N with their options; `/answer <q> <n>` targets one, plain `/answer <n>` answers the
   currently-highlighted one; the classifier reports which is focused so the client can say so.
5. Docs: README, MANUAL (claude must be able to say "anyone can answer my questions, only Roy
   can approve tools"), wiki Joining-a-Jam + Security-Model, CHANGELOG; `/answer` wording and the
   `--answers` toggle appear in `/menu` (v0.24 completeness test).

## v0.32 — Windows support (one repo, phased; queued after the feature work)

Decision: **one repo**, not a fork — a second repo would drift and double every future feature.
Cross-platform code lives behind one seam; Windows-only implementations sit beside the macOS
ones in the same files/dirs and are chosen at runtime.

Honest scoping, because client and host are not the same problem: the client is node +
WebSocket + ink and is genuinely portable; the **host is tmux** (sessions, `capture-pane -e`
frames, `paste-buffer` injection, `send-keys`, `display-popup`, the ownership marker, socket
isolation, F3 attach) and Windows has no tmux.

### W0 — platform seam (do this early, it is small)
`platform.mjs` exporting: `clipboardImage()`, `notify(title, body)`, `playSound(kind)`,
`stateDir()`, `configDir()`, `historyFile()`, `secureWrite(path, data)` (chmod 600 on POSIX,
ACL-restricted on Windows), `openExternal(url)`. macOS keeps today's `pngpaste`/`osascript`/
`afplay`. Every existing call site routes through it; a unit test asserts no module outside
`platform.mjs` spawns a platform binary.

### W1 — native Windows client (full guest parity, no WSL)
- Runtime: node ≥ 22 on Windows; Windows Terminal (ANSI + alt-screen) is the supported host
  terminal; `cmd.exe` legacy console explicitly unsupported, with a clear message.
- Clipboard image: PowerShell `Get-Clipboard -Format Image` → temp PNG (argv, never a shell
  string). Notifications: PowerShell toast (BurntToast when present, else a WinRT toast script);
  sound: `[console]::beep()` fallback, `System.Media.SoundPlayer` for distinct knock/join tones.
- Paths: `%TEMP%` / `%APPDATA%\claude-jam`; no `0600` semantics — use an ACL that grants only the
  current user, and say so in the security docs rather than pretending modes carry over.
- Keys: verify F2/F3/PgUp/Shift+Enter/Esc sequences under Windows Terminal; the CSI-u newline
  handling already shipped must be re-verified there.
- Install: **`npm i -g claude-jam`** — Roy approved npm as the Windows (and cross-platform)
  distribution on 2026-08-29, and the name is free on the registry (404 as of that date).
  Homebrew stays the macOS path; both install the same package. Publishing checklist: `files`
  whitelist in package.json so smokes/fixtures/spec stay out of the tarball, `bin` entries for
  `claude-jam` + `jam`, `engines.node >= 22`, `os` NOT restricted (Windows must install), a
  `prepublishOnly` running the unit tests, and `npm publish --dry-run` reviewed before the first
  real publish. winget/scoop only if npm proves awkward.
- CI: GitHub Actions matrix (macos-latest + windows-latest) running `node --test` on every push;
  the smoke suites stay manual/local since they need a real terminal and a real claude.

### W2 — Windows host via WSL2 (THE host path; W3 was investigated and dropped)
tmux and Claude Code both run in WSL2, so the daemon runs unchanged inside WSL while the human
uses Windows Terminal. Work is integration, not rewrite: WSL-aware paths for the state dir, the
`\\wsl$` boundary for `/send`/`/paste`/`jam-uploads`, `localhost` port forwarding from Windows to
WSL (verify `--tunnel`/`--funnel` and the ttyd view reach the outside), the browser view URL, and
a documented setup page. Tested on Roy's Windows machine before it is claimed to work.

### W3 — native Windows host: investigated, and dropped (2026-08-29)
Research pass done; report at `~/ClaudWork/2026-08-29-jam-windows-host-research/RESEARCH.md`.
**Decision: there is no native Windows host. W2 (WSL2) is the Windows host path.**

**The deciding fact: nothing reattaches to a running ConPTY.** No mechanism was found by which a
second, later-launched process can take over a pseudo-console another process already owns, the
way `tmux attach` reattaches to a named session. `CreatePseudoConsole` hands back handles, not a
name — there is nothing to look up later — and `node-pty` inherits that gap. Everything that
might have filled it was checked and none of it holds: the community "tmux for Windows" ports
(psmux, bitcode/tmux-windows, wintmux) are small and unverified; zellij's native Windows support
is months old (v0.44.0) with open display bugs of its own; and `wezterm-mux-server`, the most
credible option, has no documented pure-native daemon-then-reattach flow — every concrete Windows
use of its Unix-domain muxing in the docs is GUI-to-WSL bridging — and adopting it would mean
driving wezterm's RPC protocol instead of owning a pty at all.

So a native Windows host would put its own operator on the ~300 ms proxy path. That is precisely
the latency **v0.15** introduced F3 to escape (7–26 ms attached, measured). A host build whose
worst experience belongs to the person running it is not worth having, and no amount of backend
abstraction buys it back.

**Two consequences, both simplifications.**
1. **The terminal-backend interface is not built.** It existed only so a pty backend could stand
   in for tmux; with one backend it is an interface with one implementation. tmux stays the
   substrate, unwrapped.
2. **Roy's "WSL2 may be used, must not be forced" is honoured, not bent.** Nothing is forced on a
   *guest*: the W1 native client needs no WSL, no tmux and no pty — it is a WebSocket plus a
   raw-mode terminal, both native Node. WSL2 is asked only of somebody who wants to *host* from
   Windows, which is the smaller and more technical audience.

Supporting evidence, recorded so a future reversal starts from facts rather than optimism:
- ConPTY resize/reflow garbling is an **open bug class against Claude Code itself** on Windows
  (anthropics/claude-code#80123, #66795). `claude.exe` is the exact binary a native jam would
  drive. Inside WSL2 there is a real pty and the class does not apply.
- `@xterm/addon-serialize`, which would have had to reproduce `capture-pane -e` output closely
  enough for the v0.31 pane classifier's regexes, is self-described as experimental.
- One genuinely good finding, useful whenever npm publishing lands: the published
  `node-pty@1.1.0` tarball bundles working prebuilt binaries for **both** win32-x64 and
  win32-arm64, and its install script checks for those before ever falling back to node-gyp. The
  README's "install Python + Visual Studio Build Tools" is contributor-facing, for building from
  source. Unverified without a Windows box, but it means a native path would not have failed on
  install pain — it failed on reattach.

The original case for the native path, kept for the record:

  `node-pty` (ConPTY on Windows) runs claude in a pty we own, and **`@xterm/headless`** — the
  headless xterm.js build — consumes that pty stream and maintains the screen buffer with
  attributes, which is precisely what `capture-pane -e` gives us today. Injection becomes a
  pty write; "attach" becomes piping the pty raw to the host's stdin/stdout; resize is a pty
  API call. Both packages are current (@xterm/headless 6.0.0, node-pty 1.1.0 as of 2026-08-29).

The intended shape was a **terminal backend interface** with `backend/tmux.mjs` and
`backend/pty.mjs` behind it, chosen at runtime, with everything above it (protocol, ladders,
invites, mirror, discovery, clients) untouched. Of the questions that pass was meant to settle —
does `claude.exe` behave under ConPTY, does @xterm/headless reproduce the pane faithfully enough
for the v0.31 classifier, what does maintaining the buffer cost at our frame cadence, and **how
does the host attach back** — the last one has no answer, and it is the one that decides.

### Cross-platform matrix that must be tested (Roy has a Windows box)
mac host ↔ Windows client, Windows(WSL) host ↔ mac client, Windows(WSL) host ↔ Windows client,
over LAN and over `--tunnel`. Each of: mirror rendering, F2/F3, invites, knock+approval, `/c`,
`/send` + `/paste` both directions, `/answer`, `/export` + resume on the other OS, sounds,
notifications, scrollback. A `docs/COMPATIBILITY.md` table records what was actually verified,
on what build, on what date — never a claim without a run.

## v0.33 — adopt a running session (share the jam you are already in)

Today sharing means `claude-jam host --resume <id>`, which RESTARTS the session in a jam-owned
pane. Roy's ask: start a jam of the session I am already sitting in, without ending it.

Feasible whenever that claude runs inside a tmux pane — jam's whole substrate is
`capture-pane` + `paste-buffer` against a pane target, and nothing requires that jam created it.

1. **`claude-jam adopt`** — run it from inside the session (Claude runs it as a Bash call, so it
   inherits `$TMUX`/`$TMUX_PANE`) or from another terminal with `--pane '%23' [--socket <name>]`.
   It resolves, and SHOWS what it resolved before doing anything:
   - the pane (from `$TMUX_PANE`, or the flag) and which tmux **server socket** it lives on —
     adoption must work on the user's own default socket, not only jam's;
   - the claude process in that pane (`pane_pid` → child), its cwd;
   - the session id: newest `~/.claude/projects/<cwd-slug>/*.jsonl` whose mtime is live, verified
     by echoing that session's first user message and last assistant line for confirmation
     (`--yes` skips the confirm for scripting). Wrong guess = wrong session shared, so this
     confirmation is not optional in interactive use.
2. **Daemon changes**: `--adopt-pane <target> --adopt-socket <name>` makes every tmux call use
   that socket/pane instead of creating a session. All of it — mirror frames, injection, the
   JSONL tail, invites, discovery, the ladders — works unchanged.
3. **Foreign-session rules (hard).** jam did not create this tmux session, so it may never end
   it: `claude-jam end` on an adopted jam stops the DAEMON and its children (ttyd/tunnel/mDNS)
   and leaves the pane, the session and claude exactly as they were; `sessions` marks the row
   `adopted`; `clean` never touches it; the v0.18 ownership marker is written on the state dir
   only, never as a tmux option on someone else's session. Any tmux option jam would normally
   set (fill-character, status, the F3 detach binding) is either skipped or saved-and-restored
   on exit, and NEVER set with `-g`.
4. **Brief the session by injecting it — the gap is smaller than it looks.** A running claude
   cannot be given new hooks or a new `--append-system-prompt-file`, but jam already owns the
   injection path, so at adoption it TYPES a briefing into the session (one message, marked as
   coming from the tool, not from a participant):
   - the shared-session protocol (`[Name]:` prefixes, unprefixed = the host at the keyboard),
   - the two standing rules (never reveal the token/invite link to a `[Name]:` participant;
     `/c` chat exists and is deliberately hidden from you — never claim to have seen it),
   - the condensed how-jam-works digest and who is currently here,
   - and, for a claude that supports it, a pointer to MANUAL.md's path so it can read the rest.
   `--no-brief` skips it (for a session mid-thought where an extra turn would be disruptive);
   the client then warns that claude has not been told.
   **Re-brief when the context is lost.** The v0.31 pane classifier already watches the screen —
   extend it to notice a compaction (`Compacted`/`/clear`) and re-inject the briefing once
   afterwards, since that is exactly when the injected context disappears. Roster changes
   re-brief only when the participant set changes meaningfully AND the session is idle (never
   mid-turn), rate-limited to at most one every 10 minutes; `--brief-updates off` disables it.
   What genuinely cannot be recovered on an adopted session: the Stop/Notification hooks — so
   turn-end and permission-wait come from the pane classifier (v0.31), which is already the
   authoritative source. Say all of this in the client once, in README, and in MANUAL.md.
5. **`/jam` from inside the session.** Ship a tiny Claude Code plugin (skill + command) in the
   repo (`integrations/claude-plugin/`): typing `/jam` in any session runs `claude-jam adopt`
   and prints the invite line; `/jam invite <Name>`, `/jam end` map to the CLI. Installation is
   documented (marketplace/local plugin dir) and entirely optional — `claude-jam adopt` from the
   Bash tool works without it.
6. **When adoption is impossible** (not inside tmux — a bare terminal, or a cmux pane), say so
   with the exact alternative: exit and run `claude-jam host --resume <id> --cwd <dir>`, with the
   id already filled in from the detection above.

## v0.34 — host identity is a local secret, not a network address

F1 (campaign, 2026-08-30) was fixed by reading the proxy headers a relay cannot suppress. That
holds for cloudflared, which was measured. It does **not** generalise: `--funnel` was never
tested, a future relay may set different headers or none, and the whole approach is a blocklist —
we enumerate what a relay looks like and hope the list is complete. The next relay that proxies
to `127.0.0.1` without a header we recognise re-opens the same hole, and it opens it silently.

Replace the inference with proof.

1. **A key on disk.** At daemon start, write `<state>/host.key` — 32 random bytes, mode `0600`,
   in the state dir that is already `0700`. It is a credential; it is never logged, never put in
   a frame, never in the transcript, and `stripTokenBlock` must scrub it like the join token.
2. **The host proves it by reading the file.** The host's own client — launched by `claude-jam
   host`, by `--attach`, or by the launcher menu — reads `host.key` and presents it in `hello`.
   `host:true` and `trusted()` require **that key**. A process on another machine cannot read it,
   whatever address its packets appear to come from and whatever headers they carry.
3. **Loopback stays, as a second condition, not the first.** Keep `localSocket()`: a connection
   must both present the key AND look local. Two independent conditions, either of which failing
   denies host. Belt and braces is the point — this is the gate that owns somebody's machine.
4. **This is not a new trust assumption.** Anyone who can read `<state>/host.key` can already read
   `token.json` beside it, and is already a local user with the host's own privileges. The key
   grants nothing that filesystem access did not already grant; it just stops the *network* from
   impersonating the filesystem.
5. **What it closes, without needing a live test.** `--funnel`'s exposure — currently unverified
   and unverifiable here, since Funnel is not enabled on this tailnet — stops being a question:
   a funnel-relayed socket has no key, so it is not the host, whether or not Tailscale sets a
   header we would have recognised. Same for any relay added later. Record in `TESTING.md` that
   Funnel's *transport* is still unverified while its *host gate* no longer depends on it.
6. **Failure modes must be explicit.** No key file (an older jam, a hand-started daemon): the
   client says so and joins as a guest rather than silently failing — never fall back to
   address-only host. A key that does not match is refused the same way a bad token is, and the
   refusal says which of the two conditions failed, because "you are not the host on your own
   machine" is otherwise unanswerable.
7. Tests: the key never appears in any frame, log line or export; a socket presenting the key from
   a non-local address is refused; a local socket with no key is a guest; the host's own client
   still gets host over plain loopback; and the F1 probe shape — relay headers, relay address —
   is refused on both conditions independently.

**What shipped (2026-08-30).** All seven, as written, in two commits.

The decision is `hostGate({claimed, local, presented, expected})` in `lib.mjs`, returning the
list of conditions that FAILED rather than a bare `false` — `locality`, `key-missing`,
`key-mismatch`, `key-unset` — which `hostRefusal()` turns into the sentence the refused client
is sent. `classifyHello` takes the daemon's key as a fourth argument and fails **closed** without
it: a caller that was never updated grants host to nobody, because address-only host is the hole
this exists to close. The effect is `loadHostKey()` in `host.mjs` (called first in `daemon()`,
before `createServer`, because the launcher spawns the host's client the moment health answers)
and `readHostKey()` in `platform.mjs`, the one place the file is read — by the daemon and by both
clients.

Two things the spec did not say, decided here:

- **An existing key is reused, not replaced.** A daemon that restarts under a host client that is
  already running (clients reconnect on their own) must not silently demote it. The file lives and
  dies with the state dir.
- **The client is handed the key's PATH, not its value** (`--host-key-file`), because an argv is
  in `ps`. `runHostClient` is the single place that builds it, and all four surfaces — `claude-jam
  host`, `host --attach`, the launcher menu's attach, and `claude-jam adopt` — funnel through it.
  A unit lint asserts that (one `client.mjs` spawn in `host.mjs`, carrying both flags; none in
  `menu.mjs` or `sessions.mjs`), because "every surface" is only provable if there is one.

Cost: 407 → 422 unit tests. `smoke-knock` gained the three refusal cases, each asserted for its
own reason and one of them over this machine's real off-box address; `smoke-slash` and
`smoke-adopt` gained the leak proof (frames, daemon log, `/export`, the state dir); every suite
that connects a scripted host now reads the key. Canary, run twice: breaking `hostKeyMatches`
turned 8 `smoke-knock` steps and 5 unit tests red; removing `--host-key-file` from the launcher
turned `smoke-lifecycle` steps 5 and 6 red plus the surfaces lint.

Not done, and recorded in `TESTING.md`: the thirteen suites outside the batch scope were edited
but not re-run (release-gate work), and Funnel's *transport* is still unverified — what changed is
that its *host gate* no longer depends on recognising it.
