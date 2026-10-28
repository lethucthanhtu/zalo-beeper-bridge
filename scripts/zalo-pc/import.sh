#!/usr/bin/env bash
# One-command Zalo PC → Beeper history import (macOS; also works on Linux with Zalo PC
# under Wine or on Windows Git Bash with ZALO_APP pointing at Zalo.exe).
#
#   1. preflight: bridge container running, Beeper reachable, node present
#   2. Zalo PC: (re)starts it with the local debug port 9229 if needed (asks first)
#   3. lists your chats by NAME (from Zalo PC) and lets you pick them
#   4. runs migrate-all.sh (export → rebuild in Beeper → verify → delete old room), showing progress
#   5. prints the OK / FAIL summary
# Re-running is safe: chats already OK in work/done.txt are skipped.
#
# Usage: scripts/zalo-pc/import.sh [options]
#   -c KEY1,KEY2   thread keys to import ("g<groupId>" or a DM peer uid); omit to pick interactively
#   -w DIR         working dir (default: <repo>/work — gitignored, holds private messages)
#   -u UID         your own Zalo uid (default: read from the bridge log)
#   -m DIR         backup media folder INSIDE the container (README "Step 2"), optional
#   -n NAME        container name (default: zalo-beeper-bridge)
#   -r CLI         container runtime: podman (default) or docker
#   -p PORT        Zalo PC debug port (default: 9229)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
WORK="$HERE/../../work" CHATS="" OWN_UID="" MEDIA="" CONTAINER=zalo-beeper-bridge CLI=podman PORT=9229
while getopts "c:w:u:m:n:r:p:h" opt; do
  case $opt in
    c) CHATS=$OPTARG ;; w) WORK=$OPTARG ;; u) OWN_UID=$OPTARG ;; m) MEDIA=$OPTARG ;;
    n) CONTAINER=$OPTARG ;; r) CLI=$OPTARG ;; p) PORT=$OPTARG ;;
    *) sed -n '2,22p' "$0"; exit 0 ;;
  esac
done
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
CDP="http://127.0.0.1:$PORT/json/list"
# Zalo PC app bundle; override with ZALO_APP=/path/to/Zalo.app
ZALO_APP=${ZALO_APP:-/Applications/Zalo.app}

step() { printf '\n\033[36m▶ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✖ %s\033[0m\n' "$1" >&2; exit 1; }
up() { curl -s -m 10 -f "$1" > /dev/null; }

# --- 1. preflight -------------------------------------------------------------
step 'Preflight checks'
command -v node > /dev/null || fail 'node not found in PATH.'
command -v "$CLI" > /dev/null || fail "$CLI not found in PATH (use -r docker for Docker)."
state=$("$CLI" ps --filter "name=^${CONTAINER}\$" --format '{{.Status}}')
[ -n "$state" ] || fail "Container $CONTAINER is not running — run '$CLI compose up -d' first."
echo "  bridge: $state"
up https://matrix.beeper.com/_matrix/client/versions || fail 'Cannot reach Beeper (matrix.beeper.com).'
if [ -z "$OWN_UID" ]; then
  OWN_UID=$("$CLI" logs "$CONTAINER" 2>&1 | grep -o 'uid [0-9][0-9]*' | tail -1 | cut -d' ' -f2 || true)
  [ -n "$OWN_UID" ] || fail 'Could not read your Zalo uid from the bridge log — pass -u <uid>.'
fi
echo "  bridge Zalo uid: $OWN_UID (Zalo PC must be logged in to the SAME account)"

# --- 2. Zalo PC with the debug port ------------------------------------------------
step 'Zalo PC'
if ! up "$CDP"; then
  [ -d "$ZALO_APP" ] || fail "Zalo PC not found at $ZALO_APP (set ZALO_APP=...)."
  if pgrep -x Zalo > /dev/null; then
    printf '  Zalo PC is running WITHOUT the debug port. Close and restart it? (y/N) '
    read -r answer
    case $answer in [yY]*) ;; *) fail "Cancelled. Restart Zalo PC with --remote-debugging-port=$PORT yourself, then re-run." ;; esac
    osascript -e 'quit app "Zalo"' > /dev/null 2>&1 || pkill -x Zalo || true
    # wait for it to exit, so `open` starts a new instance that gets the flag
    for _ in $(seq 1 20); do pgrep -x Zalo > /dev/null || break; sleep 1; done
  fi
  open -a "$ZALO_APP" --args --remote-debugging-port="$PORT"
  echo '  Waiting for Zalo PC to start (log in if it asks)...'
  for i in $(seq 1 60); do
    up "$CDP" && break
    [ "$i" -eq 60 ] && fail 'Zalo PC did not open the debug port within 3 minutes.'
    sleep 3
  done
fi
echo "  Zalo PC ready on 127.0.0.1:$PORT (reachable from this machine only)"

# --- 3. pick chats -------------------------------------------------------------
EXPORT="$WORK/export"
mkdir -p "$EXPORT"
if [ -z "$CHATS" ]; then
  step 'Chats in Zalo PC'
  node "$HERE/export-cdp.mjs" "$EXPORT" --list || fail 'Could not read the chat list from Zalo PC.'
  # Same picker as import.ps1: pinned first, then by message count; prints the list, or
  # (with a selection argument) the chosen thread keys comma-separated
  pick() {
    node -e '
      const meta = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const list = [...meta.convs].sort((a, b) => (b.pinned - a.pinned) || ((b.numMsg ?? 0) - (a.numMsg ?? 0)));
      const nameOf = (c) => (c.isGroup ? meta.gmap[c.key.replace(/^g/, "")] ?? meta.gmap[c.key] : meta.fmap[c.key]) ?? "(no name)";
      const sel = process.argv[2];
      if (sel === undefined) {
        list.forEach((c, i) => console.log(`${String(i + 1).padStart(4)}. ${c.isGroup ? "👥" : "👤"} ${nameOf(c).padEnd(40)} ${String(c.numMsg ?? "?").padStart(7)} msgs  [${c.key}]`));
      } else {
        const s = sel.trim();
        const keys = s === "all" ? list : s === "groups" ? list.filter((c) => c.isGroup) : s === "dms" ? list.filter((c) => !c.isGroup)
          : s.split(",").flatMap((part) => {
              const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
              if (!m) return [];
              const from = +m[1], to = +(m[2] ?? m[1]);
              // 1-based; out-of-range numbers are ignored (0 must not wrap)
              return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => list[from + i - 1]).filter(Boolean);
            });
        console.log(keys.map((c) => c.key).join(","));
      }' "$EXPORT/conversations.json" "$@"
  }
  pick
  printf "\nPick chats: numbers/ranges (e.g. 1,3,5-8), 'groups', 'dms' or 'all': "
  read -r selection
  CHATS=$(pick "$selection")
fi
[ -n "$CHATS" ] || fail 'No chat selected.'
ORDER="$WORK/order.txt"
echo "$CHATS" | tr ',' '\n' | sed '/^$/d' > "$ORDER"
echo "  $(wc -l < "$ORDER" | tr -d ' ') chat(s) → $ORDER"

# --- 4. run the migration --------------------------------------------------------
step 'Import (export → rebuild in Beeper → verify → delete old room)'
LOG="$WORK/run.log" DONE="$WORK/done.txt"
touch "$LOG" "$DONE"
done_before=$(wc -l < "$DONE" | tr -d ' ')
seen=$(wc -l < "$LOG" | tr -d ' ')
# Prints the new progress lines of run.log ("=== [n/total] key", the importer verdict, waits)
show_progress() {
  local total
  total=$(wc -l < "$LOG" | tr -d ' ')
  [ "$total" -gt "$seen" ] && sed -n "$((seen + 1)),${total}p" "$LOG" | grep -E '^===|^\[import\] done|^--- waiting' | sed 's/^/  /' || true
  seen=$total
}
CONTAINER_CLI=$CLI bash "$HERE/migrate-all.sh" "$WORK" "$ORDER" "$OWN_UID" ${MEDIA:+"$MEDIA"} &
pid=$!
while kill -0 "$pid" 2> /dev/null; do sleep 2; show_progress; done
wait "$pid" || true
show_progress

# --- 5. summary ---------------------------------------------------------------
step 'Summary'
new=$(tail -n +"$((done_before + 1))" "$DONE")
ok=$(printf '%s\n' "$new" | grep -c '^OK ' || true)
failed=$(printf '%s\n' "$new" | grep '^FAIL ' || true)
echo "  OK: $ok   FAIL: $(printf '%s' "$failed" | grep -c . || true)   (details: $LOG)"
[ -n "$failed" ] && printf '%s\n' "$failed" | sed 's/$/ — re-run to retry; its old room was kept/; s/^/  /'
printf '\n\033[2mNote: Zalo PC still has its debug port open. Quit it and start it normally when done.\033[0m\n'
