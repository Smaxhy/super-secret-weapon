#!/usr/bin/env bash
# One-time: run the auto-updater every minute (GitHub checked every 5 min, or at once from the dashboard button).
#   ./scripts/install-auto-update.sh
# To turn it off again:  crontab -l | grep -v auto-update.sh | crontab -
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
chmod +x "$DIR/scripts/auto-update.sh"
LINE="* * * * * $DIR/scripts/auto-update.sh >> \$HOME/bot-update.log 2>&1"
# Keep any other scheduled jobs; replace our line. (`crontab -l` fails when
# there is no crontab yet, and grep -v fails on empty input — both are fine.)
EXISTING="$(crontab -l 2>/dev/null | grep -v 'auto-update.sh' || true)"
printf '%s\n%s\n' "$EXISTING" "$LINE" | sed '/^$/d' | crontab -
crontab -l | grep -q 'auto-update.sh' || { echo "Failed to install the schedule"; exit 1; }
echo "Auto-update installed: runs every minute. Log: ~/bot-update.log"
