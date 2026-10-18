#!/usr/bin/env bash
# Which containers a set of changed files touches (v15.4). Reads repo paths on stdin, one per line; prints
# "crypto", "forex", "crypto forex" or nothing. Rules in scripts/forex-paths.txt: forex-only files → forex, shared
# files → both, anything else under src/ → crypto, the rest (docs, dashboard, tests, scripts) → nothing.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ONLY_RE="$(awk '$1=="only"{print $2}' "$DIR/forex-paths.txt" | paste -sd'|' -)"
SHARED_RE="$(awk '$1=="shared"{print $2}' "$DIR/forex-paths.txt" | paste -sd'|' -)"
CRYPTO=0
FOREX=0
while IFS= read -r f || [[ -n "$f" ]]; do
  [[ -z "$f" ]] && continue
  if grep -Eq "$SHARED_RE" <<<"$f"; then
    CRYPTO=1
    FOREX=1
  elif grep -Eq "$ONLY_RE" <<<"$f"; then
    FOREX=1
  elif [[ "$f" == src/* ]]; then
    CRYPTO=1
  fi
done
OUT=""
[[ $CRYPTO == 1 ]] && OUT="crypto"
[[ $FOREX == 1 ]] && OUT="${OUT:+$OUT }forex"
echo "$OUT"
