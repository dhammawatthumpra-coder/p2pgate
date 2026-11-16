#!/data/data/com.termux/files/usr/bin/bash
# Mux soak: isolated p2pgate server + HTTP target for an overnight run.
# Leaves three processes: target-http, p2pgate server, RSS sampler.
# usage: bash mux-termux.sh [sizeMB] [targetPort] [soakDir]
set -u

MB="${1:-8}"
TARGET_PORT="${2:-18081}"
D="${3:-$HOME/.p2pgate-soak}"
STATE="$D/state"
SRC_HTTP="$(cd "$(dirname "$0")" && pwd)/target-http.js"

mkdir -p "$D" "$STATE"

if [ ! -f "$D/big.bin" ] || [ "$(wc -c < "$D/big.bin")" -ne $((MB * 1024 * 1024)) ]; then
  echo "creating $MB MiB test file..."
  head -c $((MB * 1024 * 1024)) /dev/urandom > "$D/big.bin"
fi

SHA="$(sha256sum "$D/big.bin" | awk '{print $1}')"
BYTES="$(wc -c < "$D/big.bin" | tr -d ' ')"

# --- HTTP target (idempotent) -------------------------------------------
if ! pgrep -f "target-http.js $D/big.bin" > /dev/null 2>&1; then
  setsid nohup node "$SRC_HTTP" "$D/big.bin" "$TARGET_PORT" \
    > "$D/target.log" 2>&1 < /dev/null &
  sleep 2
fi
TARGET_PID="$(pgrep -f "target-http.js $D/big.bin" | head -n 1)"

# --- p2pgate server ------------------------------------------------------
if ! pgrep -f "$D/server.json" > /dev/null 2>&1; then
  HOME="$STATE" setsid nohup p2pgate server \
    --config "$D/server.json" --target-port "$TARGET_PORT" \
    > "$D/server.log" 2>&1 < /dev/null &
  sleep 10
fi
SERVER_PID="$(pgrep -f "$D/server.json" | head -n 1)"

if [ -z "${SERVER_PID:-}" ]; then
  echo "ERROR: p2pgate server did not start; see $D/server.log"
  exit 1
fi

# --- credentials ---------------------------------------------------------
SECRET="$(grep -m1 '^masterSecret:' "$STATE/.p2pgate/quickstart.txt" | awk '{print $2}')"
PASSWORD="$(grep -m1 '^password:' "$STATE/.p2pgate/quickstart.txt" | awk '{print $2}')"

cat > "$D/creds.txt" <<CREDS
SECRET=$SECRET
PASSWORD=$PASSWORD
SHA=$SHA
BYTES=$BYTES
MB=$MB
PORT=$TARGET_PORT
CREDS
chmod 600 "$D/creds.txt"

# --- RSS sampler ---------------------------------------------------------
if ! pgrep -f "soak-rss $D" > /dev/null 2>&1; then
  setsid nohup bash -c '
    D="$1"
    while true; do
      pid="$(pgrep -f "$D/server.json" | head -n 1)"
      if [ -n "$pid" ] && [ -r "/proc/$pid/status" ]; then
        rss="$(awk "/VmRSS/{print \$2}" "/proc/$pid/status")"
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),$pid,${rss:-0}" >> "$D/server-rss.csv"
      else
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),missing,0" >> "$D/server-rss.csv"
      fi
      sleep 300
    done
  ' soak-rss "$D" > /dev/null 2>&1 < /dev/null &
  sleep 1
fi

echo "=== soak ready ==="
echo "dir:      $D"
echo "server:   pid $SERVER_PID (log $D/server.log)"
echo "target:   pid ${TARGET_PID:-?} on 127.0.0.1:$TARGET_PORT"
echo "file:     $MB MiB, sha256 $SHA"
echo
echo "run this on the Windows machine:"
echo
echo "  powershell -ExecutionPolicy Bypass -File scripts\\soak\\mux-windows.ps1 \\"
echo "    -Secret $SECRET -Password $PASSWORD \\"
echo "    -ExpectedSha $SHA -ExpectedBytes $BYTES -MB $MB"
echo
echo "morning summary:"
echo "  node scripts/soak/summarize.js <csv>   # client csv is on Windows"
