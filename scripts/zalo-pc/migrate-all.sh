#!/usr/bin/env bash
# Rebuild every chat in Beeper from Zalo PC, one at a time:
#   fresh CDP export of the chat → importer --rebuild --remove-old inside the container
#   (new room with the full ordered history, live-only messages carried over, verified
#   against the Beeper timeline, only then the old room is deleted).
# Resumable: chats recorded "OK <key>" or "OKMEDIA <key>" in <workDir>/done.txt are skipped
# on a re-run. OKMEDIA = every message is in the new room but some media could not be fetched
# (dead Zalo CDN host, no old-room copy) or a live message could not be carried over.
# Waits (instead of failing chats) while Beeper or Zalo PC is unreachable.
#
# Usage: scripts/zalo-pc/migrate-all.sh <workDir> <order.txt> <ownerZaloUid> [mediaDirInContainer]
#   order.txt: one thread key per line ("g<groupId>" or a DM peer uid), in the order to run
#   Zalo PC must run with --remote-debugging-port=9229; container name: zalo-beeper-bridge
#   CONTAINER_CLI=docker to use docker instead of podman; BRIDGE_CONTAINER=<name> for another
#   container; ZALO_CDP_URL=http://127.0.0.1:<port> for another Zalo PC debug port
#   BASELINE_DB=<path in container> (required): a bridge.db copy taken before the run; the
#   importer audits every old-room message against it before it deletes the old room
set -u
: "${BASELINE_DB:?set BASELINE_DB to the pre-migration bridge.db copy inside the container}"
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep container paths as-is
WORK=$1 ORDER=$2 OWNER=$3 MEDIA=${4:-}
# HERE = this script's dir (for export-cdp.mjs); C = container name; LOG/DONE/OUT live in <workDir>
# (pwd -W on Git Bash: with MSYS_NO_PATHCONV a /c/... path would reach Windows node unconverted)
HERE=$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })
C=${BRIDGE_CONTAINER:-zalo-beeper-bridge}
export ZALO_CDP_URL=${ZALO_CDP_URL:-http://127.0.0.1:9229} # also read by export-cdp.mjs
CLI=${CONTAINER_CLI:-podman}
LOG="$WORK/run.log" DONE="$WORK/done.txt" OUT="$WORK/export"
# Importer output lines matching NOISE (library deprecation/ghost-registration chatter) are dropped from the log
NOISE='deprecat|M_USER_IN_USE|already in use|User ID is in use|MatrixHttpClient|^\s*\}$|errcode'
# Problem lines that only concern media or live-message carry-over (graded OKMEDIA, not FAIL)
MEDIA_ONLY='^\[media\]|^\[import\] media of |live message\(s\) could not be carried over'
mkdir -p "$OUT"; touch "$DONE"
"$CLI" exec "$C" mkdir -p /data/import-export

# n = position in order.txt (skipped chats included), total = non-empty lines
n=0; total=$(grep -c . "$ORDER")
while read -r key; do
  [ -z "$key" ] && continue
  n=$((n+1)); grep -qE "^(OK|OKMEDIA) $key$" "$DONE" && continue
  # Block until Beeper (from host and container) and the Zalo PC CDP port all answer; re-check every 60s
  # (bash redirection, not curl -o /dev/null: MSYS_NO_PATHCONV hands curl.exe a literal /dev/null)
  until curl -s -m 15 -f https://matrix.beeper.com/_matrix/client/versions > /dev/null && curl -s -m 5 -f "$ZALO_CDP_URL/json/list" > /dev/null \
        && "$CLI" exec "$C" node -e 'fetch("https://matrix.beeper.com/_matrix/client/versions").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'; do
    echo "--- waiting for network / Zalo PC $(date '+%H:%M:%S')" >> "$LOG"; sleep 60
  done
  echo "=== [$n/$total] $key $(date '+%H:%M:%S')" >> "$LOG"
  # 1) fresh export of this one chat from Zalo PC; a failed export marks the chat FAIL
  if ! node "$HERE/export-cdp.mjs" "$OUT" "$key" >> "$LOG" 2>&1; then echo "FAIL $key" >> "$DONE"; continue; fi
  # 2) copy the export into the container (owned by the node user the importer runs as)
  "$CLI" cp "$OUT/conversations.json" "$C:/data/import-export/conversations.json"
  "$CLI" cp "$OUT/$key.ndjson" "$C:/data/import-export/$key.ndjson"
  # reactions sidecar (only written for chats with reactions); drop a stale copy otherwise
  if [ -f "$OUT/$key.reactions.json" ]; then "$CLI" cp "$OUT/$key.reactions.json" "$C:/data/import-export/$key.reactions.json"
  else "$CLI" exec "$C" rm -f "/data/import-export/$key.reactions.json"; fi
  "$CLI" exec "$C" chown -R node:node /data/import-export
  # 3) rebuild the chat in Beeper with the importer, keeping its filtered output for the verdict
  out=$("$CLI" exec -u node -w /data "$C" node /app/src/tools/import-zalo-export.ts /data/import-export --only "$key" \
        ${MEDIA:+--media-dir "$MEDIA"} --rebuild --remove-old --baseline-db "$BASELINE_DB" --own-uid "$OWNER" 2>&1 | grep -a -v -i -E "$NOISE")
  echo "$out" >> "$LOG"
  # OK: the importer reports 0 missing and nothing failed / unverified.
  # OKMEDIA: the same, except that the only problems are media downloads or live messages
  # that could not be carried over (the chat is complete; re-running does not bring them back).
  problems=$(echo "$out" | grep -a -E "failed|NOT imported|PROBLEMS|INCOMPLETE|WARNING")
  other=$(echo "$problems" | grep -a -v -E "$MEDIA_ONLY")
  if ! echo "$out" | grep -q "^\[import\] done: .* 0 missing$" || [ -n "$other" ]; then
    echo "FAIL $key" >> "$DONE"
  elif [ -n "$problems" ]; then
    echo "OKMEDIA $key" >> "$DONE"
  else
    echo "OK $key" >> "$DONE"
  fi
done < "$ORDER"
echo "=== ALL DONE $(date '+%H:%M:%S')" >> "$LOG"
