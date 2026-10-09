#!/usr/bin/env bash
# Pull the latest code and restart the bot. Run on the VPS from the repo folder:
#   ./scripts/deploy.sh            (deploys the current branch)
#   ./scripts/deploy.sh main       (switches to and deploys "main")
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
[[ -f .env ]] || { echo "Missing .env — copy .env.example and fill it in first."; exit 1; }

echo "==> Updating to origin/$BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "==> Rebuilding and restarting"
docker compose up -d --build
docker image prune -f >/dev/null

echo "==> Status"
docker compose ps
echo "Follow logs with: docker compose logs -f bot"
