#!/data/data/com.termux/files/usr/bin/sh

# p2pgate auto-start for Termux:Boot
#
# วิธีติดตั้ง:
#   1) ติดตั้งแอป Termux:Boot จาก F-Droid
#   2) mkdir -p ~/.termux/boot
#   3) คัดลอกไฟล์นี้ไปที่ ~/.termux/boot/start-p2pgate.sh
#   4) chmod +x ~/.termux/boot/start-p2pgate.sh
#   5) เปิดแอป Termux:Boot อย่างน้อยหนึ่งครั้ง แล้วรีสตาร์ทเครื่อง
#
# ตัวแปรที่ปรับได้:
#   P2PGATE_DIR  โฟลเดอร์โปรเจกต์ (ค่าเริ่มต้น: $HOME/p2pgate)

export PATH="$PREFIX/bin:$PATH"
umask 077

termux-wake-lock

# เปิด sshd ถ้ายังไม่ได้ทำงาน (ถ้ามี pgrep ให้ตรวจก่อน ไม่มีก็ลองเริ่มแบบ best effort)
if command -v sshd >/dev/null 2>&1; then
  if command -v pgrep >/dev/null 2>&1; then
    if ! pgrep -x sshd >/dev/null 2>&1; then
      sshd 2>/dev/null || true
    fi
  else
    sshd 2>/dev/null || true
  fi
fi

P2PGATE_DIR="${P2PGATE_DIR:-$HOME/p2pgate}"
LOG_DIR="$HOME/.p2pgate"
LOG_FILE="$LOG_DIR/server.log"
MAX_LOG_BYTES=1048576

# v1.3: Session PIN อยู่ในหน่วยความจำเท่านั้น และไม่เขียนลงไฟล์/log
# สำหรับโหมด headless แนะนำ:
#   - verificationMode "key-only" หรือ
#   - hybrid + trusted devices (fast-path) หรือ
#   - hybrid/two-step + Unattended Password

mkdir -p "$LOG_DIR" 2>/dev/null
chmod 700 "$LOG_DIR" 2>/dev/null

# ตัดไฟล์ log ให้เหลือ 0 ไบต์เมื่อใหญ่เกินกำหนด
# ใช้การ truncate แทนการ mv เพื่อให้โปรเซสที่กำลังเขียนไฟล์อยู่ไม่พัง
rotate_log() {
  [ -f "$LOG_FILE" ] || return 0

  size=$(wc -c < "$LOG_FILE" 2>/dev/null | tr -d ' ')
  [ -n "$size" ] || return 0

  if [ "$size" -ge "$MAX_LOG_BYTES" ]; then
    : > "$LOG_FILE"
  fi
}

# ตรวจขนาด log ทุก 60 วินาที แม้โปรเซสจะรันต่อเนื่องเป็นเวลานาน
(
  while true; do
    sleep 60
    rotate_log
  done
) &
rotate_pid=$!

cleanup() {
  kill "$rotate_pid" 2>/dev/null
}

trap cleanup EXIT
trap 'exit 0' INT TERM HUP

cd "$P2PGATE_DIR" 2>/dev/null || {
  echo "p2pgate: not found: $P2PGATE_DIR" >> "$LOG_FILE"
  exit 1
}

while true; do
  rotate_log
  echo "--- $(date -u '+%Y-%m-%dT%H:%M:%SZ') starting p2pgate server ---" >> "$LOG_FILE"
  if command -v p2pgate >/dev/null 2>&1; then
    p2pgate server >> "$LOG_FILE" 2>&1
  else
    node src/cli.js server >> "$LOG_FILE" 2>&1
  fi
  code=$?
  echo "--- $(date -u '+%Y-%m-%dT%H:%M:%SZ') p2pgate exited (code $code); restarting in 5s ---" >> "$LOG_FILE"
  sleep 5
done
