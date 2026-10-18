#!/usr/bin/env bash
# Pull new code and rebuild — only when something changed, and only the container(s) the change touches
# (v15.4: `bot` = crypto, `forex` = forex; scripts/forex-paths.txt says which files belong to which).
# Runs every minute from cron (see install-auto-update.sh). Log: ~/bot-update.log
#   - checks GitHub every 5 minutes, or at once when the dashboard's "Update now" button asked
#     (Redis key update:request = "normal" | "force"; "force" rebuilds even without new code)
#   - writes what it did to Redis update:status (shown on the dashboard)
#
# The last SUCCESSFULLY deployed commit is kept in .deployed-sha, so a failed
# build (full disk, network blip…) is retried on the next run instead of being
# skipped forever because the code was already pulled.
set -euo pipefail
cd "$(dirname "$0")/.."

# Never run two updates at once.
exec 9>/tmp/solbot-update.lock
flock -n 9 || exit 0

# Older installs ran this every 5 min — switch to every minute (so the button reacts fast).
if crontab -l 2>/dev/null | grep -q '^\*/5 .*auto-update.sh'; then
  crontab -l | sed 's#^\*/5 \(.*auto-update.sh\)#* \1#' | crontab - || true
fi

rcli() { docker compose exec -T redis redis-cli "$@" 2>/dev/null || true; }
status() { # status <state> <message>
  local json
  json="$(printf '{"at":"%s","state":"%s","message":"%s","deployed":"%s","remote":"%s"}' "$(date -u '+%FT%TZ')" "$1" "$2" "${DEPLOYED:0:7}" "${REMOTE:0:7}")"
  rcli SET update:status "$json" EX 86400 >/dev/null
}

# Caddy's config is a single-file bind mount: `git pull` writes a NEW Caddyfile (new inode), so the running
# container keeps seeing the old one and `caddy reload` re-reads the old file. (v15.4: forex requests kept going to the
# crypto bot → forex broke.) Fix: when the file inside the container differs from the repo's, recreate the container.
heal_caddy() {
  if ! docker compose exec -T caddy cat /etc/caddy/Caddyfile 2>/dev/null | cmp -s - Caddyfile; then
    echo "$(date -u '+%F %T') Caddy runs an old config (or is down) — recreating it"
    docker compose up -d --force-recreate --no-deps caddy >/dev/null 2>&1 || true
  fi
}

REQ="$(rcli GETDEL update:request | tr -d '\r')"
MIN="$(date -u '+%M')"
# Nothing asked and not a 5-minute mark → done (no GitHub call).
# (Run by hand in a terminal → always check.)
if [[ -z "$REQ" && ! -t 1 && $((10#$MIN % 5)) -ne 0 ]]; then exit 0; fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
DEPLOYED="$(cat .deployed-sha 2>/dev/null || true)"
REMOTE=""
if ! git fetch -q origin "$BRANCH"; then
  status failed "can't reach GitHub"
  exit 1
fi
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [[ "$REMOTE" == "$DEPLOYED" && "$REQ" != "force" ]]; then
  heal_caddy
  status up_to_date "already running the newest code"
  exit 0
fi

echo "$(date -u '+%F %T') updating $BRANCH ${DEPLOYED:0:7} → ${REMOTE:0:7}${REQ:+ (asked from the dashboard: $REQ)}"
status updating "pulling ${REMOTE:0:7} and rebuilding (takes 1–3 min)"
PREV="$(git rev-parse HEAD)"
if ! git pull -q --ff-only origin "$BRANCH"; then
  echo "$(date -u '+%F %T') git pull failed (local changes on the server?) — run: cd /root/bot && git status"
  status failed "git pull failed — local changes on the server? (cd /root/bot && git status)"
  exit 1
fi

# The bot reports this version on the dashboard (spot a stuck update).
GIT_SHA="$(git rev-parse --short HEAD)"
export GIT_SHA
# Which containers does this change touch? (no deployed sha / diff fails / forced → both)
CRYPTO=0
FOREX=0
if [[ -z "$DEPLOYED" || "$REQ" == "force" ]] || ! CHANGED="$(git diff --name-only "$DEPLOYED" HEAD 2>/dev/null)"; then
  CRYPTO=1
  FOREX=1
else
  PARTS="$(printf '%s\n' "$CHANGED" | bash scripts/which-containers.sh)"
  [[ "$PARTS" == *crypto* ]] && CRYPTO=1
  [[ "$PARTS" == *forex* ]] && FOREX=1
fi
FLAGS=(-d --build)
[[ "$REQ" == "force" ]] && FLAGS+=(--force-recreate)
WHAT="nothing to restart (docs / dashboard / tests only)"
if [[ $CRYPTO == 1 && $FOREX == 1 ]]; then
  FLAGS+=(--remove-orphans)
  WHAT="crypto + forex"
elif [[ $CRYPTO == 1 ]]; then
  FLAGS+=(--no-deps bot)
  WHAT="crypto only (forex untouched)"
elif [[ $FOREX == 1 ]]; then
  FLAGS+=(--no-deps forex)
  WHAT="forex only (crypto untouched)"
fi
echo "$(date -u '+%F %T') restarting: $WHAT"
if [[ $CRYPTO == 1 || $FOREX == 1 ]] && ! docker compose up "${FLAGS[@]}"; then
  echo "$(date -u '+%F %T') BUILD FAILED — retrying in 5 min. Disk: $(df -h / | tail -1)"
  status failed "build failed — retrying in 5 min (disk: $(df -h / | tail -1 | awk '{print $5}') used)"
  exit 1
fi
# Caddy only reads its config at start: make sure it runs the repo's Caddyfile.
heal_caddy
echo "$REMOTE" > .deployed-sha
DEPLOYED="$REMOTE"
status done "updated to ${GIT_SHA}: ${WHAT}"
# Keep the disk from filling up with old images / build cache.
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --filter until=48h >/dev/null 2>&1 || true
echo "$(date -u '+%F %T') update done (${GIT_SHA}: ${WHAT})"
