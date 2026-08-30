# COMPATIBILITY

What has actually been run, on what build, on what date. **There is no "should work" row in this
file.** A capability is either verified — with a date and a machine — or it is listed as unverified
with the experiment that would settle it. SPEC.md v0.32 asked for this table in these words:
"never a claim without a run".

Two things are being tracked and they are not the same problem:

- **host** — the daemon, tmux, the `claude` TUI, `capture-pane` frames, injection, F3.
- **client** — a WebSocket, a raw-mode terminal and ink. No tmux, no claude, no pty.

---

## Platforms

| | host | client |
| --- | --- | --- |
| **macOS** (26, Apple silicon) | ✅ verified continuously — every release gate runs here | ✅ verified continuously |
| **Linux** | ⚠️ **still unverified as a HOST** — no Linux machine on this project, and no tmux/claude/pty path has ever run there. What changed in 0.23.3 is that a `ubuntu-latest` CI leg now runs the unit suite and three real-entry-point checks on every push; see the Linux table below for what that does and does not settle. | ⚠️ unverified by a human. The unit suite and the three checks run on `ubuntu-latest`; nobody has joined a jam from a Linux box |
| **Windows** (native) | ❌ **not built, and not planned.** See SPEC.md v0.32 **W3** — nothing reattaches to a running ConPTY, so the host's own operator would be the one person on the ~300 ms proxy path. | 🟡 **implemented, CI-tested on `windows-latest`, never run by a human.** Details below. |
| **Windows via WSL2** | 🟡 designed, not yet integrated (SPEC.md v0.32 **W2**). tmux and `claude` both run inside the distribution; the open work is paths across the `\\wsl$` boundary and port forwarding from Windows to WSL. | ✅ use the Linux client inside WSL2 — same unverified status as Linux |

---

## Linux, capability by capability (0.23.3)

The `ubuntu-latest` leg landed in 0.23.3 and **has not run yet at the time this table was
written** — it is committed, not measured, and no row below says otherwise. When the first run
happens, the rows marked ⏳ get its date and its result, exactly as the Windows rows did.

The leg exists for one specific reason: **0.23.2 fixed a local privilege escalation that macOS
cannot test.** `os.tmpdir()` on macOS is a per-user `0700` directory, so no other local user can
create `$TMPDIR/claude-jam-<port>` first; on Linux it is `/tmp`, mode `1777`, and getting there
first is the whole attack. Five adversarial reviews missed the finding because every one of them
ran on macOS.

| capability | on Linux | verified by |
| --- | --- | --- |
| the state-dir privacy gate | `lstat` + owner + mode on `$TMPDIR/claude-jam-<port>`, refusing before anything is written | ⏳ CI — `scripts/check-state-privacy.mjs` runs the real `host.mjs` against a planted `0777` dir, a symlink, an unsearchable parent (`EACCES` — reachable there, because the runner is not root) and **a directory created by a second real uid** via `sudo -u nobody`. That last one is the only place the 0.23.2 attack can be run at all. Green on macOS 2026-08-30 with the two-uid branch reported NOT EXERCISED |
| the gate's FALSE POSITIVE (an ordinary jam under a world-writable parent must start) | the gate `lstat`s the state dir, not its parent, so a `1777` `/tmp` is irrelevant | ✅ measured 2026-08-30 — on macOS against a real `1777` parent (`/private/tmp` is `1777` there too), and it is the first check in `check-state-privacy.mjs`, so it runs on every leg. A gate that refused every Linux host would be worse than the bug it fixes |
| `os.tmpdir()` is `/tmp`, and `/tmp` is `1777` | the two facts the finding rests on, previously cited from POSIX and never measured | ⏳ CI — asserted on the Linux leg (and skipped, out loud, if `$TMPDIR` is set on the runner) |
| join/knock/nudge sounds | `paplay` (freedesktop `.oga`) then `aplay` (ALSA `.wav`), per kind; nothing installed → silence | 🟡 **the decision is verified, the sound is not.** `linuxSoundPlan` is a pure function as of 0.23.3 and is asserted on every leg (player order, per-kind candidates, the `.oga`/`.wav` split, "nothing → silence"). A CI runner has no audio device, so the Linux leg PRINTS what it resolved rather than asserting a branch. **Nobody has heard one** — that needs a Linux desktop |
| mDNS discovery (`claude-jam find`, the menu's Join screen) | ❌ **unsupported, and it says so.** `dns-sd` is Apple's CLI and Linux has none unless avahi's compat package provides one; the avahi-native path was deliberately not built | ⏳ CI — `scripts/check-discovery-refusal.mjs` asserts the refusal is non-zero and carries `DNSSD_MISSING` (which names `avahi-utils` as the fix) rather than a silent empty listing, in both the table and the `--json` shape. Green on macOS 2026-08-30, where it asserts the other direction: a machine that HAS `dns-sd` is not refused |
| hosting a jam (tmux, `claude`, `capture-pane`, injection, F3) | POSIX, and nothing in it is macOS-specific | ⚠️ **nothing.** The nineteen smokes need a real tmux and (six of them) a real `claude`; none has ever run on Linux. This is the gap the CI leg does NOT close |

---

## The Windows client, capability by capability

Every row's "verified by" is literal. `CI` means a unit test on a real `windows-latest` GitHub
Actions runner, on the commit that is in `main`. `unit (macOS)` means the decision is asserted but
the Windows side of it has never executed. **No row here has been seen by a person.**

| capability | how it works on Windows | verified by |
| --- | --- | --- |
| starting the client at all | `npm i -g claude-jam` → `cli.mjs` (a node entry, because npm's Windows shim would otherwise try to run the bash launcher through `bash`) | ⚠️ **nothing.** The install has never been performed on Windows. `npm pack --dry-run` runs on both CI legs and contains every module a client imports |
| terminal check | Windows Terminal required; the legacy `cmd.exe` console refused by name, `JAM_ASSUME_ANSI=1` overrides | ✅ CI — `scripts/check-terminal-gate.mjs` spawns the real client entry point on the runner and asserts both directions |
| `%APPDATA%\claude-jam`, `%TEMP%` | `configDirPath` / `stateDir` through the platform seam | ✅ CI (and unit, macOS) |
| private files (no `0600`) | NTFS ACL: `icacls <path> /inheritance:r /grant:r <DOMAIN\user>:F` | ✅ CI — writes a real file in a real `%TEMP%`, reads the ACL back with the real `icacls`, asserts the grant list is **exactly** the current user |
| private *directories* (no `0700`) | the same call plus `(OI)(CI)` so what is created inside inherits it | 🟡 CI — **measured 2026-08-30: this does NOT reduce to one entry.** `icacls` exits 0 and the dir keeps `NT AUTHORITY\SYSTEM` and `BUILTIN\Administrators` alongside the owner (a second, uncached apply changes nothing). Not an exposure — both can read anything on the machine regardless, and no wider principal is granted, which is what CI now asserts. No Windows host exists, so no state dir is created on Windows today |
| `/paste` (clipboard → PNG) | `powershell.exe` + `Get-Clipboard -Format Image`; the path in the environment, never in the script | 🟡 CI proves the **failure** path end to end (powershell found, script parsed, "no image" surfaced, temp dir removed). A CI runner has no image on its clipboard, so a real paste has never happened |
| desktop notification | PowerShell toast: BurntToast if installed, else the WinRT `ToastText02` notifier under PowerShell's own AppId | ⚠️ unit only (argv shape, and that title/body are not in the script). **No toast has been seen.** |
| join / knock / nudge sounds | `System.Media.SoundPlayer` over a `.wav` from `%WINDIR%\Media`, else a per-kind `[console]::beep()` pattern | 🟡 CI resolves the table against the real `%WINDIR%\Media` and prints which branch a real runner takes. **No sound has been heard**, and which files exist on a given Windows build is still unknown |
| keys: F2, PgUp/PgDn, Shift+↑↓, Home/End, Esc | the xterm-compatible sequences Windows Terminal is documented to send | ⚠️ unit only, against a table taken **from documentation, not from a capture**. Nobody has pressed a key in Windows Terminal |
| Shift+Enter (newline) | **not available by default** — WT sends a bare CR. `\` at end of line works; a `sendInput` binding to `\\u001b[13;2u` in `settings.json` makes the key work | ⚠️ unit only (the CSI-u decode). The binding recipe is untested |
| F3 (attach the real TUI) | **deliberately absent.** It attaches tmux on the client's own machine; there is none, and no jam is hosted on Windows | ✅ unit — `canAttachTmux('win32') === false`, and the block a Windows client is shown never names F3 |
| `/send`, `/get`, `/export`, `/answer`, `/c`, `/ping`, F2 mirror | platform-independent: WebSocket frames and `node:fs` | ⚠️ unverified on Windows. The logic is the same code the macOS client runs and the release gate exercises |
| host key via `--host-key-file` | read through the seam; a Windows client is always a **guest** anyway, because host needs locality and there is no Windows host | ✅ unit |

### The cross-platform matrix SPEC.md v0.32 asks for

Not one cell of this has been run. It is here so the shape of the missing work is visible rather
than implied.

| | mac client | Windows client | WSL2 client |
| --- | --- | --- | --- |
| **mac host, LAN** | ✅ verified (release gates) | ❌ never run | ❌ never run |
| **mac host, `--tunnel`** | ✅ verified (130-minute soak, 2026-08-30) | ❌ never run | ❌ never run |
| **WSL2 host** | ❌ never run | ❌ never run | ❌ never run |

Each cell, when somebody runs it, owes: mirror rendering, F2 (and F3 where it exists), invites,
knock + approval, `/c`, `/send` + `/paste` both directions, `/answer`, `/export` + resume on the
other OS, sounds, notifications, scrollback.

---

## Runtime and tools

| | verified |
| --- | --- |
| node | 24.15.0 (macOS, 2026-08-30 runs). `engines` says **>= 22**, and CI runs the floor: node 22 on macOS and Windows |
| tmux | 3.7c (macOS). Host only |
| claude | 2.1.251 (macOS) |
| ttyd | 1.7.7 (macOS) — `--view` |
| cloudflared | 2026.8.2 (macOS) — `--tunnel` |
| tailscale | ⚠️ `--funnel` unverified: Funnel is not enabled on this tailnet and the installed build is the sandboxed App Store one |
| PowerShell | ⚠️ unverified. The Windows branches target **Windows PowerShell 5.1** (`powershell.exe`), because `Get-Clipboard -Format Image` is documented as 5.1-only and the WinRT type accelerator needs the same runtime. Not `pwsh` |

---

## How to add a row

Run the thing. Then write the date, the OS build, the tool versions and what you observed — and if
it half-worked, say which half. A row that says "verified" and means "read the code" is worse than
no row, because the next person stops checking.
