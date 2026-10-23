#!/bin/sh
# Renders icon-alpha.png (icon + ALPHA ribbon) with headless Edge. Drop "?alpha=1" for the plain icon.
set -e
d=$(cd "$(dirname "$0")" && pwd)
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --headless --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --window-size=512,512 --screenshot="$d/icon-alpha.png" \
  "file://$d/icon.html?alpha=1" >/dev/null 2>&1
