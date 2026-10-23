#!/bin/bash
# Start a throwaway jam for the README GIF: real host daemon + tmux, a fake `claude` TUI painting a
# captured pane (fixtures/pane), fake names. Never touches a real session or port 7777.
# usage: bash docs/demo/demo-fixture.sh start|stop     then: vhs docs/demo/demo.tape
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BASE=/private/tmp/jamdemo
export TMPDIR=$BASE/tmp
case "${1:-start}" in
  start)
    rm -rf "$BASE"; mkdir -p "$BASE/bin" "$BASE/tmp" "$BASE/code/payments-api"
    echo demo > "$BASE/ctl"; : > "$BASE/log"
    cat > "$BASE/bin/claude" <<SH
#!/bin/sh
for a in "\$@"; do case "\$a" in --claude-jam-probe-unknown-flag) echo "error: unknown option '\$a'" >&2; exit 1;; esac; done
exec $(command -v node) $REPO/scripts/fake-tui.mjs $BASE/ctl $BASE/log $REPO/docs/demo/pane
SH
    chmod +x "$BASE/bin/claude"
    JAM_CLAUDE="$BASE/bin/claude" FAKE_TUI_W=100 node "$REPO/host.mjs" --tmux jamdemo --port 17777 \
      --view-port 17778 --name Alice --token demotoken --cwd "$BASE/code/payments-api" --no-attach >"$BASE/host.log" 2>&1
    TMUX_TMPDIR= tmux -L claude-jam-17777 resize-window -t jamdemo:claude -x 100 -y 28 || echo resize failed
    echo "jam up on ws://127.0.0.1:17777 (token demotoken)";;
  stop)
    node "$REPO/cli.mjs" end jamdemo >/dev/null 2>&1 || true;;
esac
