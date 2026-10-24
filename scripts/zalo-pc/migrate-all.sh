#!/usr/bin/env bash
# Rebuild every chat in Beeper from Zalo PC, one at a time:
#   fresh CDP export of the chat → importer --rebuild --remove-old inside the container
#   (new room with the full ordered history, live-only messages carried over, verified
#   against the Beeper timeline, only then the old room is deleted).
# Resumable: chats recorded "OK <key>" in <workDir>/done.txt are skipped on a re-run.
# Waits (instead of failing chats) while Beeper or Zalo PC is unreachable.
#
# Usage: scripts/zalo-pc/migrate-all.sh <workDir> <order.txt> <ownerZaloUid> [mediaDirInContainer]
#   order.txt: one thread key per line ("g<groupId>" or a DM peer uid), in the order to run
#   Zalo PC must run with --remote-debugging-port=9229; container name: zalo-beeper-bridge
set -u
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep container paths as-is
WORK=$1 ORDER=$2 OWNER=$3 MEDIA=${4:-}
# HERE = this script's dir (for export-cdp.mjs); C = container name; LOG/DONE/OUT live in <workDir>
HERE=$(cd "$(dirname "$0")" && pwd)
C=zalo-beeper-bridge
LOG="$WORK/run.log" DONE="$WORK/done.txt" OUT="$WORK/export"
# Importer output lines matching NOISE (library deprecation/ghost-registration chatter) are dropped from the log
NOISE='deprecat|M_USER_IN_USE|already in use|User ID is in use|MatrixHttpClient|^\s*\}$|errcode'
mkdir -p "$OUT"; touch "$DONE"
podman exec "$C" mkdir -p /data/import-export

# n = position in order.txt (skipped chats included), total = non-empty lines
n=0; total=$(grep -c . "$ORDER")
while read -r key; do
  [ -z "$key" ] && continue
  n=$((n+1)); grep -q "^OK $key$" "$DONE" && continue
  # Block until Beeper (from host and container) and the Zalo PC CDP port all answer; re-check every 60s
  # (bash redirection, not curl -o /dev/null: MSYS_NO_PATHCONV hands curl.exe a literal /dev/null)
  until curl -s -m 15 -f https://matrix.beeper.com/_matrix/client/versions > /dev/null && curl -s -m 5 -f http://127.0.0.1:9229/json/list > /dev/null \
        && podman exec "$C" node -e 'fetch("https://matrix.beeper.com/_matrix/client/versions").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'; do
    echo "--- waiting for network / Zalo PC $(date '+%H:%M:%S')" >> "$LOG"; sleep 60
  done
  echo "=== [$n/$total] $key $(date '+%H:%M:%S')" >> "$LOG"
  # 1) fresh export of this one chat from Zalo PC; a failed export marks the chat FAIL
  if ! node "$HERE/export-cdp.mjs" "$OUT" "$key" >> "$LOG" 2>&1; then echo "FAIL $key" >> "$DONE"; continue; fi
  # 2) copy the export into the container (owned by the node user the importer runs as)
  podman cp "$OUT/conversations.json" "$C:/data/import-export/conversations.json"
  podman cp "$OUT/$key.ndjson" "$C:/data/import-export/$key.ndjson"
  podman exec "$C" chown -R node:node /data/import-export
  # 3) rebuild the chat in Beeper with the importer, keeping its filtered output for the verdict
  out=$(podman exec -u node -w /data "$C" node /app/src/tools/import-zalo-export.ts /data/import-export --only "$key" \
        ${MEDIA:+--media-dir "$MEDIA"} --rebuild --remove-old --own-uid "$OWNER" 2>&1 | grep -a -v -i -E "$NOISE")
  echo "$out" >> "$LOG"
  # OK only when the importer reports 0 missing and nothing failed / unverified
  if echo "$out" | grep -q "^\[import\] done: .* 0 missing$" && ! echo "$out" | grep -q "failed\|NOT imported\|PROBLEMS\|WARNING"; then
    echo "OK $key" >> "$DONE"
  else
    echo "FAIL $key" >> "$DONE"
  fi
done < "$ORDER"
echo "=== ALL DONE $(date '+%H:%M:%S')" >> "$LOG"
