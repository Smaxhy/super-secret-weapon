#!/usr/bin/env bash
# One-time: make the VPS check for new bot code every 5 minutes and apply it.
#   ./scripts/install-auto-update.sh
# To turn it off again:  crontab -l | grep -v auto-update.sh | crontab -
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
chmod +x "$DIR/scripts/auto-update.sh"
LINE="*/5 * * * * $DIR/scripts/auto-update.sh >> \$HOME/bot-update.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'auto-update.sh' ; echo "$LINE" ) | crontab -
echo "Auto-update installed: checks every 5 minutes. Log: ~/bot-update.log"
