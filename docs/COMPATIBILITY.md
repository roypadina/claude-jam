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
| **Linux** | ⚠️ **still unverified as a HOST.** 0.23.3 added a `ubuntu-latest` CI leg (the unit suite plus three real-entry-point checks, all of which exit before tmux) and ran all of it on real Linux — green, including the state-dir attack as two real uids. The tmux/claude/pty half got **one** attempt: `smoke-lifecycle` reached 6 of 19 steps in a container. See the Linux table below. | ⚠️ unverified by a human. The unit suite and the three checks are green on Linux; nobody has joined a jam from a Linux box |
| **Windows** (native) | ❌ **not built, and not planned.** See SPEC.md v0.32 **W3** — nothing reattaches to a running ConPTY, so the host's own operator would be the one person on the ~300 ms proxy path. | 🟡 **implemented, CI-tested on `windows-latest`, never run by a human.** Details below. |
| **Windows via WSL2** | 🟡 **integrated (0.23.6, SPEC.md v0.32 W2), never run on a real WSL install.** tmux, `claude` and the daemon all run inside the distribution. What W2 added: a WSL-aware state-dir refusal, `C:\`/`\\wsl$` path translation for `/send`, the Windows clipboard for `/paste`, and a localhost line in the join block. Every decision is a pure function asserted on all three CI legs; the WSL-only half is measured by **nothing**. See the table below and run `node scripts/check-wsl.mjs` on the machine. | ✅ use the Linux client inside WSL2 — same unverified status as Linux |

---

## Linux, capability by capability (0.23.3)

The `ubuntu-latest` leg landed in 0.23.3 and **has not run in GitHub Actions yet** — nobody could
push it. What it will run was instead run **locally on real Linux**, 2026-08-30: a Debian bookworm
container (linuxkit kernel, aarch64, node 22.23.2, tmux 3.3a) as the **non-root user `jamci` (uid
1001) with passwordless sudo**, chosen deliberately because that is the shape of a GitHub runner and
because root makes two of the branches unreachable. Rows below say `container` where that is what
measured them; it is a real Linux userland with a real `1777` `/tmp` and real uids, and it is
neither the GitHub runner nor a Linux desktop.

The leg exists for one specific reason: **0.23.2 fixed a local privilege escalation that macOS
cannot test.** `os.tmpdir()` on macOS is a per-user `0700` directory, so no other local user can
create `$TMPDIR/claude-jam-<port>` first; on Linux it is `/tmp`, mode `1777`, and getting there
first is the whole attack. Five adversarial reviews missed the finding because every one of them
ran on macOS.

| capability | on Linux | verified by |
| --- | --- | --- |
| the state-dir privacy gate | `lstat` + owner + mode on `$TMPDIR/claude-jam-<port>`, refusing before anything is written | ✅ **verified on Linux 2026-08-30 (container), all six checks** — `scripts/check-state-privacy.mjs` runs the real `host.mjs` against a planted `0777` dir, a symlink, an unsearchable parent (`EACCES` — reachable there, because the runner is not root) and **a directory created by a second real uid** via `sudo -u nobody`, planted under `/tmp` so the second uid can actually traverse to it (the first CI run used `os.tmpdir()` and failed on macOS for exactly that reason). That last one is the only place the 0.23.2 attack can be run at all, and it ran: `nobody` (uid 65534) plants a `0700` state dir, and `host.mjs` as uid 1001 exits 2 with `owned by uid 65534`. **That is the experiment TESTING.md has been asking for since 0.23.2.** Canary run on Linux too — neutering the gate turns three checks red and builds no jam |
| the gate's FALSE POSITIVE (an ordinary jam under a world-writable parent must start) | the gate `lstat`s the state dir, not its parent, so a `1777` `/tmp` is irrelevant | ✅ **measured on Linux 2026-08-30 (container)** against the real `/tmp` at mode `1777`, and on macOS against `/private/tmp`, which is `1777` there too. It is the first check in `check-state-privacy.mjs`, so it runs on every leg, and it `chmod`s the parent to `1777` and asserts that took, so it cannot go vacuous. A gate that refused every Linux host would be worse than the bug it fixes, and this is the check nobody runs |
| `os.tmpdir()` is `/tmp`, and `/tmp` is `1777` | the two facts the finding rests on, previously cited from POSIX and never measured | ✅ **measured 2026-08-30 (container)**: `os.tmpdir() = /tmp · mode 1777 · uid 0 · world-writable: true · TMPDIR unset`. Asserted on the Linux leg, and skipped out loud if `$TMPDIR` is set on the runner |
| join/knock/nudge sounds | `paplay` (freedesktop `.oga`) then `aplay` (ALSA `.wav`), per kind; nothing installed → silence | 🟡 **the decision is verified, the sound is not.** `linuxSoundPlan` is a pure function as of 0.23.3 and is asserted on every leg (player order, per-kind candidates, the `.oga`/`.wav` split, "nothing → silence"). A CI runner has no audio device, so the Linux leg PRINTS what it resolved rather than asserting a branch — measured 2026-08-30 (container): all three resolve to `null`, because there is no `/usr/share/sounds` at all, which is the correct "nothing installed → silence" answer. **Nobody has heard one, and `paplay`/`aplay` have never been spawned** — that needs a Linux desktop with the freedesktop theme |
| mDNS discovery (`claude-jam find`, the menu's Join screen) | ❌ **unsupported, and it says so.** `dns-sd` is Apple's CLI and Linux has none — **`avahi-utils` does NOT provide one** (measured 2026-08-30: it ships `avahi-browse` / `avahi-publish-service` only), and the avahi-native path was deliberately not built | ✅ **verified on Linux 2026-08-30 (container)**: the native answer is the documented refusal, and `find --json` exits 1 with `DNSSD_MISSING` naming `avahi-utils`. `scripts/check-discovery-refusal.mjs` asserts the refusal is non-zero and carries `DNSSD_MISSING` (which names `avahi-utils` as the fix) rather than a silent empty listing, in both the table and the `--json` shape. Green on macOS 2026-08-30, where it asserts the other direction: a machine that HAS `dns-sd` is not refused |
| hosting a jam (tmux, `claude`, `capture-pane`, injection, F3) | POSIX, and nothing in it is macOS-specific | 🟡 **PARTLY proven since 0.23.4, and the CI leg now carries it.** `smoke-lifecycle` is **19/19** in a Debian bookworm container (tmux 3.3a, node 22.23.2, `docker run --init`, non-root) — re-measured 2026-08-30 on 0.23.6, with `CI=true` and without, and again with WSL detection standing in. It builds real jams, attaches a real client on a real pty and presses F3, so tmux, the launcher and attach ARE exercised on Linux now. What is still unproven there: **injection** (no smoke types into a pane) and a real `claude` (every Linux run uses a stub). Nobody has watched an injection land on Linux. The 0.23.3 attempt below is kept because what a skip cost is only visible next to what it was — it got **6 of 19** steps. A jam PARTLY came up — a daemon answered `/health`, two jams listed `live`, and **S4 refused a planted state dir at the launcher level, writing nothing and building no session**. What did not: the pane's process was never seen (`claude 0`), F3 was not bound, and the pty steps timed out; the container had no controlling tty. `bind-key -T root F3` and `set-option @user` were probed on tmux 3.3a directly and BOTH WORK, so tmux version is not the cause. Nobody has pressed F3, seen a frame or watched an injection land on Linux |

---

## WSL2 as the Windows host, capability by capability (0.32 W2, 0.23.6)

**Nobody on this project has a Windows machine, so no row here says verified.** W2 was built the
way W1 was — every decision is a pure function in `lib.mjs`, asserted on macOS, `ubuntu-latest` and
`windows-latest` — and what is left is the set of facts only a real WSL2 install can answer.

Two things ARE measured on real Linux, because WSL2's platform is Linux and a Debian container is
the same userland: the Linux half of every path (`smoke-lifecycle` 19/19, tmux 3.3a) and the WSL
code paths themselves, reached with the `JAM_WSL_OSRELEASE` test hook (`/proc` cannot be
bind-mounted over — runc refuses it, measured 2026-08-30). Rows say `container (stood in)` where
that is what ran, and it means: **the real code, on a real filesystem, with a real daemon — but not
a WSL kernel**, so `wslpath`, `powershell.exe` and DrvFs were absent.

`node scripts/check-wsl.mjs` answers every row below on the machine it runs on, in PASS / FAIL /
NOT EXERCISED. On anything that is not WSL it prints NOT EXERCISED with the reason and exits 0.

| capability | how it works under WSL2 | verified by |
| --- | --- | --- |
| the daemon, tmux, `claude`, frames, injection, F3 | unchanged — this is Linux | see the Linux table above: `smoke-lifecycle` 19/19 in a container, injection and a real `claude` still unproven on any Linux |
| a state dir on a **Windows drive** (`/mnt/c/...`) | **refused**, and the refusal names DrvFs: without the `metadata` mount option every file reports mode 0777, and `chmod` there reports success and changes nothing, so the generic "chmod it or use another --port" advice is replaced | 🟡 **the refusal is measured, the FILESYSTEM is not.** 2026-08-30, container (stood in): a real `0777` dir at `/mnt/c/tmp/claude-jam-7777` and the real `host.mjs` → **exit 2**, the DrvFs message printed in full, **nothing written into the directory and no tmux session built**. What that does NOT show is DrvFs itself: the mount was ext4 wearing the shape. **This is TESTING.md experiment 3 and it is still open** — `check-wsl.mjs` reports which branch fires, and whether `chmod` is really the no-op the message claims |
| the DEFAULT state dir (`/tmp/claude-jam-<port>`) | the Linux filesystem, so an ordinary WSL jam starts normally | 🟡 measured in the container (stood in) — a real daemon came up with WSL detection on, and `smoke-lifecycle` is 19/19 both with detection on and off. Not measured on a real install, where `$TMPDIR` could be anything; `check-wsl.mjs` says which |
| `/send C:\Users\me\shot.png` and `\\wsl$\Ubuntu\home\me\x` | translated to `/mnt/c/...` and `/home/me/x`. Another distribution's `\\wsl$` path and any other UNC path are **refused by name** rather than guessed | 🟡 unit on all three legs (13 shapes, both refusals). **`wslpath` has never been asked whether it agrees** — that is the first thing `check-wsl.mjs` does, in both directions, and it is the row most likely to find something |
| the automount root | assumed `/mnt/`; `[automount] root` in `/etc/wsl.conf` can move it, and a wrong root shows up as `no such file: /mnt/c/...`, which names what was tried | ⚠️ unverified. Deliberately not parsed — see the comment on `WSL_MOUNT_ROOT`. `check-wsl.mjs` prints `/etc/wsl.conf` and checks `/mnt/c` exists |
| `/paste` (clipboard → PNG) | the Windows clipboard, through interop: the **same** PowerShell script W1 ships, run as `powershell.exe`, with the temp file named to Windows by `wslpath -w`. Interop off → a refusal saying so, and `/send` is unaffected | ⚠️ **unverified, and the least verifiable row here.** Its two halves are each proven elsewhere (the script on `windows-latest`; `wslpath` is WSL's own tool) and the join between them is not. Before W2 this was a flat refusal, so the failure mode is unchanged — an error line instead of an image |
| clipboard TEXT (`/invite` copying a link) | `clip.exe` through interop, instead of an `xclip` that is usually not installed and has no X selection to own | ⚠️ unverified |
| the join addresses | `os.networkInterfaces()` reports the **VM's** NAT address, which is not reachable from anywhere. The join block now adds a `localhost` line for Windows on the same PC, and says the rest needs mirrored networking, a portproxy or `--tunnel` | 🟡 the block is measured (container, stood in — the real daemon printed it under `Send this to a friend:`); the NETWORK claims are **Microsoft's documentation, not measurements**. `check-wsl.mjs` prints the two commands that settle them |
| Windows → WSL `localhost` forwarding | on by default (`localhostForwarding` in `.wslconfig`); jam binds `0.0.0.0`, which is the good case | ⚠️ **claim, not measurement.** Settle it with `curl.exe -s -m 3 http://localhost:7777/health` in Windows Terminal against a running jam |
| LAN guests reaching a WSL2 host | needs `networkingMode=mirrored` (Win 11 22H2+) or a `netsh interface portproxy` rule | ⚠️ **claim, not measurement.** Same URL from another machine, with the Windows IP |
| `--tunnel` (cloudflared) from inside WSL | an OUTBOUND connection from a Linux process, so NAT is irrelevant | ⚠️ unverified under WSL. Verified on macOS (130-minute soak); nothing about it is platform-specific, which is a reason to expect it and not a reason to write ✅ |
| `--funnel` (Tailscale) from inside WSL | needs `tailscaled` **inside the distribution**; the Windows Tailscale cannot serve a WSL port directly | ⚠️ unverified, and `--funnel` is unverified everywhere (see the deferral in TESTING.md) |
| the browser view (`--view`, ttyd) | ttyd binds inside WSL like the daemon; from Windows the URL is the localhost one the join block prints | ⚠️ unverified under WSL. `smoke-view` is macOS-only so far |
| mDNS discovery (`find`, the menu's Join screen) | ❌ unsupported — WSL2 is Linux, and Linux has no `dns-sd` | ✅ the refusal is verified on Linux (see the Linux table). Also: a NAT'd VM could not usefully advertise on the LAN anyway |

---

## The Windows client, capability by capability

Every row's "verified by" is literal. `CI` means a unit test on a real `windows-latest` GitHub
Actions runner, on the commit that is in `main`. `unit (macOS)` means the decision is asserted but
the Windows side of it has never executed. **No row here has been seen by a person.**

| capability | how it works on Windows | verified by |
| --- | --- | --- |
| `sessions.mjs` subcommands run directly | `node sessions.mjs <cmd>` — how the bash launcher dispatches `list`/`end`/`clean`/`invite`/`find`/`adopt` on POSIX | 🟡 **was BROKEN, fixed 0.23.3.** The entry-point guard compared `path.resolve(argv[1])` with `path.resolve(new URL(import.meta.url).pathname)`; on Windows that pathname is `/C:/…`, so the two never matched, the whole dispatch block was skipped, and **all ten subcommands exited 0 having done nothing.** Found by `check-discovery-refusal.mjs` on the `windows-latest` leg, as a `find` that reported no jams instead of refusing. Reachable only by calling `sessions.mjs` directly — via `claude-jam` these are refused by `windowsCli` with the WSL2 route — but a silent exit 0 is the worst possible shape. Now `fileURLToPath`, with a lint |
| `/menu → Help` reading MANUAL.md | `HERE_DIR` + `readFileSync` | 🟡 **was BROKEN, fixed 0.23.3.** Same root cause: `HERE_DIR` came off a file: URL's `.pathname`, so on Windows it was `/C:/…` and the client could not read its own manual. Nothing tested it — no test reads a file through that path on win32. Fixed and linted; **still never seen working on Windows**, like every other row here |
| starting the client at all | `npm i -g @roypadina/claude-jam` → `cli.mjs` (a node entry, because npm's Windows shim would otherwise try to run the bash launcher through `bash`) | ⚠️ **nothing.** The install has never been performed on Windows. `npm pack --dry-run` runs on both CI legs and contains every module a client imports |
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

For the WSL2 host row the first step is smaller than the matrix: run `node scripts/check-wsl.mjs`
inside the distribution and paste the output. It answers eight of the questions above before any
client is involved.

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
