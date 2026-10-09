#!/usr/bin/env bash
# Pull new code and restart the bot — but only when something actually changed.
# Runs every 5 minutes from cron (see install-auto-update.sh). Log: ~/bot-update.log
set -euo pipefail
cd "$(dirname "$0")/.."

# Never run two updates at once.
exec 9>/tmp/solbot-update.lock
flock -n 9 || exit 0

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch -q origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
[[ "$LOCAL" == "$REMOTE" ]] && exit 0

echo "$(date -u '+%F %T') updating $BRANCH ${LOCAL:0:7} → ${REMOTE:0:7}"
git pull -q --ff-only origin "$BRANCH"
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
echo "$(date -u '+%F %T') update done"
