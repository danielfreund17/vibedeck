#!/usr/bin/env bash
# Install the built VibeDeck.app into /Applications and launch it.
# Quits any running copy first so the bundle swaps cleanly (tmux sessions
# persist and reattach). Run `npm run dist` first, or use `npm run install-app`
# which builds then calls this.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/mac-arm64/VibeDeck.app"
DEST="/Applications/VibeDeck.app"

if [ ! -d "$APP" ]; then
  echo "No built app at $APP — run 'npm run dist' first." >&2
  exit 1
fi

echo "quitting any running VibeDeck…"
osascript -e 'quit app "VibeDeck"' >/dev/null 2>&1 || true
for _ in $(seq 1 10); do
  pgrep -f "$DEST/Contents/MacOS/VibeDeck" >/dev/null 2>&1 || break
  sleep 0.5
done

echo "installing to /Applications…"
rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -cr "$DEST" 2>/dev/null || true

# The installed app reads its local config (ticket trackers) from
# <userData>/local; point that at this checkout's gitignored local/ so edits
# there apply without a rebuild.
USER_DATA="$HOME/Library/Application Support/vibedeck"
if [ -d "$ROOT/local" ]; then
  mkdir -p "$USER_DATA"
  if [ -L "$USER_DATA/local" ] || [ ! -e "$USER_DATA/local" ]; then
    ln -sfn "$ROOT/local" "$USER_DATA/local"
    echo "linked local config: $USER_DATA/local -> $ROOT/local"
  else
    echo "note: $USER_DATA/local exists and is not a symlink; leaving it alone"
  fi
fi

echo "launching…"
open "$DEST"
echo "✓ VibeDeck installed to /Applications and launched"
