#!/usr/bin/env bash
# Container entrypoint: wires /config into /data, then runs the appservice and
# bbctl proxy side by side. If either exits, the other is stopped and the container
# exits non-zero so the restart policy brings both back together.
set -euo pipefail

cd /data

link_config() {
  local name="$1"
  if [ -f "/config/$name" ]; then
    ln -sf "/config/$name" "/data/$name"
  elif [ ! -f "/data/$name" ]; then
    echo "[entrypoint] missing /config/$name — mount your $name into /config" >&2
  fi
}

setup() {
  link_config config.yaml
  link_config registration.yaml
  # config.yaml's relative logoPath (assets/zalo-logo.png) resolves against /data
  [ -e /data/assets ] || ln -s /app/assets /data/assets

  # bbctl login: keep a writable copy in /data (bbctl rewrites its config)
  mkdir -p "$(dirname "$BBCTL_CONFIG")"
  if [ ! -s "$BBCTL_CONFIG" ]; then
    if [ -f /config/bbctl-config.json ]; then
      cp /config/bbctl-config.json "$BBCTL_CONFIG"         || { echo "[entrypoint] cannot read /config/bbctl-config.json — chmod 644 it on the host (rootless Podman)" >&2; exit 66; }
    elif [ -n "${MATRIX_ACCESS_TOKEN:-}" ]; then
      node -e 'process.stdout.write(JSON.stringify({environments:{prod:{access_token:process.env.MATRIX_ACCESS_TOKEN}}}))' > "$BBCTL_CONFIG"
    fi
    if [ -s "$BBCTL_CONFIG" ]; then chmod 600 "$BBCTL_CONFIG"; fi
  fi
}

run() {
  for name in config.yaml registration.yaml; do
    [ -f "/data/$name" ] || exit 64
  done
  if [ ! -s "$BBCTL_CONFIG" ]; then
    echo "[entrypoint] not logged in to Beeper. Provide /config/bbctl-config.json, set MATRIX_ACCESS_TOKEN," >&2
    echo "             or run once:  <docker|podman> compose run --rm zalo-bridge bbctl login" >&2
    exit 65
  fi

  node /app/src/index.ts &
  local bridge_pid=$!

  # Proxy forwards immediately on connect — wait for the appservice (/health) first
  local ready=0
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null http://127.0.0.1:29350/health 2>/dev/null; then
      ready=1
      break
    fi
    kill -0 "$bridge_pid" 2>/dev/null || { wait "$bridge_pid"; exit $?; }
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "[entrypoint] appservice never opened 127.0.0.1:29350 — check matrix.port in config.yaml" >&2
    kill -TERM "$bridge_pid" 2>/dev/null || true
    exit 1
  fi

  bbctl proxy -r /data/registration.yaml &
  local proxy_pid=$!

  trap 'kill -TERM "$bridge_pid" "$proxy_pid" 2>/dev/null; wait; exit 0' TERM INT
  set +e
  wait -n "$bridge_pid" "$proxy_pid"
  local code=$?
  set -e
  echo "[entrypoint] a process exited (code $code) — stopping the other" >&2
  kill -TERM "$bridge_pid" "$proxy_pid" 2>/dev/null || true
  wait || true
  exit $(( code == 0 ? 1 : code ))
}

setup
case "${1:-run}" in
  run) run ;;
  *) exec "$@" ;;  # e.g. `bbctl login`, `bbctl whoami`, `bash`
esac
