# SOAK test record

บันทึกผลการรัน p2pgate ทิ้งไว้เป็นเวลานาน (overnight / 24 ชม.)
ใช้เป็นหลักฐานความเสถียรและเป็น template สำหรับรอบถัดไป

---

## 1. รอบล่าสุด — 2026-11-15 → 2026-11-16 (overnight)

| รายการ | ค่า |
|---|---|
| ระยะเวลา | ประมาณ 10–12 ชั่วโมง (ข้ามคืน) |
| Server | Termux (Redmi 14C), `p2pgate server` |
| Client | Windows, `p2pgate client` (service/task) |
| Version | 1.8.4 เป็นอย่างน้อย (เริ่มก่อน 1.9.0 ออก; ไม่ได้รีสตาร์ตระหว่างรอบ) |
| การเชื่อมต่อ | tunnel ตรง (direct DHT) |

### ผลลัพธ์

| เกณฑ์ | ผล |
|---|---|
| process ยังทำงานเช้าวันถัดไป | ✅ ยังอยู่ |
| tunnel ใช้งานได้อีกครั้ง | ✅ ต่อ SSH ใหม่ได้ |
| SSH session ที่เปิดค้าง | ❌ หลุดเมื่อเน็ตตัด — **คาดไว้แล้ว** |
| auth failure / lockout | ไม่พบ |
| crash / restart loop | ไม่พบ |

### ข้อสรุป

- **ผ่าน** ในด้านความเสถียรของ process และการ reconnect
- SSH ที่หลุดไม่ใช่บั๊ก: p2pgate เป็น TCP tunnel ไม่มี session resumption
  - ถ้าต้องการทำงานต่อเนื่อง ให้ใช้ `tmux`/`screen` บน Server
  - ฝั่ง Client ใช้ `autossh` ถ้าต้องการ reconnect อัตโนมัติของ SSH
- **ยังไม่ได้เก็บตัวเลข** reconnect count และ memory (ดูหัวข้อ 2)

---

## 1.1) mux บนอุปกรณ์จริง — 2026-11-16

ทดสอบ `--mux` ข้ามเครื่อง (Windows → Termux) ด้วย server ชั่วคราว (password mode,
target = sshd 8022) เพื่อไม่แตะ config หลัก

| รายการ | ค่า |
|---|---|
| Server | Termux (Redmi 14C), p2pgate 1.12.0, node v24.22.3 |
| Client | Windows, p2pgate 1.12.0 (repo), node v24 |
| auth | password mode (challenged) |
| carrier | 1 session, `maxChannels=128` |

ผลลัพธ์:

| เกณฑ์ | ผล |
|---|---|
| carrier establish | ✅ ครั้งเดียว (`AUTH OK ... target=mux`) |
| 3 connections ผ่าน carrier | ✅ channel 1, 2, 3 (`MUX OPEN ... -> 127.0.0.1:8022`) |
| banner SSH ครบทุก connection | ✅ `SSH-2.0-OpenSSH_10.6` |
| เวลา connection แรก | 2,623 ms (รวม DHT + carrier) |
| เวลา connection ถัดไป | 100 ms, 101 ms |
| self-test บน Termux (`npm test` ใน `npm root -g/p2pgate`) | ✅ 60 checks |

หมายเหตุ: ตัวเลข 100 ms คือ channel open + RTT; ไม่มี DHT lookup ซ้ำ
การทดสอบนี้ใช้ server ชั่วคราวแล้วลบทิ้ง; server หลักบน Termux อัปเกรดเป็น
1.12.0 และรีสตาร์ตแล้ว (trusted device ยังใช้ fastpath → mux fallback ตามดีไซน์)

---

## 1.2) mux — โอนไฟล์ขนาดใหญ่ (1.12.1) — 2026-11-16

ทดสอบซ้ำหลังแก้ truncation/backpressure (Windows, Node 24, client+server อยู่เครื่องเดียว)

| การทดสอบ | ผล |
|---|---|
| mux upload+echo 8 MiB | SHA-256 ตรง |
| mux upload+echo 32 MiB | SHA-256 ตรง (~6.7 MB/s, RSS peak ~149 MB รวม payload ของ test) |
| mux download 16 MiB (target ส่งก่อน) | SHA-256 ตรง (~4.9 MB/s) |
| mux 8 channels พร้อมกัน × 4 MiB, carrier เดียว | ตรงทุก channel |
| abort กลางทาง (เขียน 2 MiB แล้วตัด socket) | connection ถัดไปใช้ได้ปกติ |
| dedicated stream 16 MiB × 3 รอบ | ตรงทุกครั้ง |

หมายเหตุ: ก่อน 1.12.1 ปลายข้อมูลหายได้เงียบ ๆ ทั้ง mux และ stream ปกติ
(`destroy()` ก่อน flush) — ถ้าโอนไฟล์ด้วย 1.11.x/1.12.0 ควรเช็ก checksum ปลายทาง

---

## 2. วิธีเก็บตัวเลขสำหรับรอบถัดไป

### Client (Windows)

```powershell
$log = "$env:USERPROFILE\.p2pgate\service.log"
if (-not (Test-Path $log)) { $log = "$env:USERPROFILE\.p2pgate\client.log" }

"established: " + (Select-String $log -Pattern 'TUNNEL established').Count
"peer-not-found: " + (Select-String $log -Pattern 'PEER_NOT_FOUND').Count
"stream-closed retries: " + (Select-String $log -Pattern 'retrying once').Count
```

### Server (Termux)

```sh
p2pgate status
free -m
grep -c 'AUTH OK' ~/.p2pgate/audit.log 2>/dev/null || true
```

### เกณฑ์ผ่าน (24 ชม.)

| ตัวชี้วัด | ผ่านเมื่อ |
|---|---|
| process ยังอยู่ | ✅ |
| reconnect | ≤ 2–3 ครั้ง/ชม. |
| auth failure | 0 |
| lockout | 0 |
| memory | โตไม่เกิน ~2 เท่าจากตอนเริ่ม |

---

## 3. Template สำหรับรอบถัดไป

```text
วันที่เริ่ม / สิ้นสุด:
Version:
Server (device, OS, node):
Client (device, OS, node):
เครือข่าย (Wi-Fi / 4G / สลับ):
ระยะเวลา:

process ยังอยู่:            yes / no
reconnect count:           n
PEER_NOT_FOUND:            n
auth failure:              n
lockout:                   n
memory เริ่ม / สิ้นสุด:      a MB / b MB
SSH session หลุด:          n ครั้ง (สาเหตุ: ...)
ปัญหาอื่น:
สรุป:                      pass / partial / fail
```

---

## 4. บันทึกที่เกี่ยวข้อง

- [`TESTING.md`](../TESTING.md) — manual acceptance test
- [`docs/SERVICE.md`](SERVICE.md) — รันเป็น service (Termux/systemd/Windows)
- [`docs/HANDOFF.md`](HANDOFF.md) — สถานะโปรเจกต์และ invariants
