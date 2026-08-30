// v0.23.4 — the one line that has to run before ink is imported.
//
// ink asks `is-in-ci` whether it is running in CI, and if it decides yes it writes ONLY its
// <Static> output and RETURNS — the dynamic region is never painted until unmount
// (node_modules/ink/build/ink.js: `if (isInCi) { … this.lastOutput = output; return; }`). For a
// build log that is the right call. For this project it is fatal, because both of jam's ink
// surfaces are dynamic-only:
//   - the client's mirror view mounts with NO <Static> at all, on purpose (client-ink.mjs: the
//     alternate screen has no scrollback to reprint), so the live TUI, the chip row and the
//     prompt are all in the suppressed region;
//   - the launcher menu (menu.mjs) has no <Static> anywhere.
// Both therefore draw a COMPLETELY BLANK screen while still reading keys — measured 2026-08-30 in
// a Debian bookworm container: `CI=true node menu.mjs` paints nothing where the unset run paints
// the five-row menu, and `scripts/smoke-lifecycle.mjs` goes 19/19 → 4 failed, the three host-client
// steps timing out with the mirror never arriving.
//
// That measurement is also the answer to "is `--attach` broken on Linux": no. The Linux CI leg was
// the first run of that suite in ANY environment with `CI` set, and `CI` is the whole of it — the
// same container is 19/19 without it, and 19/19 with `CI=0` while `CONTINUOUS_INTEGRATION` and
// `GITHUB_ACTIONS` stay set. Nothing about the platform is involved, so WSL2 (SPEC W2) is clear.
//
// Why a module of its own, for one assignment: `is-in-ci` freezes its verdict when ink is FIRST
// imported, and `import` declarations are hoisted above the module body — so a statement written
// at the top of a file that imports ink runs too late, every time. A side-effecting module placed
// ABOVE the ink import is the only spelling that is ordered correctly, because ESM evaluates a
// graph in declaration order. `'0'` is `is-in-ci`'s own "not CI" value and it short-circuits the
// whole expression before `CONTINUOUS_INTEGRATION` or any `CI_*` key is looked at, which is what
// makes one assignment enough.
const CI_WAS = process.env.CI;
process.env.CI = '0';

// Put the caller's own value back once ink is loaded (its verdict is already frozen by then, so
// this cannot undo the fix). The menu shells into `claude-jam host`, which starts claude — and the
// environment claude runs in is none of ink's business.
export function restoreCi() {
  if (CI_WAS === undefined) delete process.env.CI;
  else process.env.CI = CI_WAS;
}
