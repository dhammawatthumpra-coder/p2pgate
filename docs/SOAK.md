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

## 1.3) 1.12.1 ข้ามเครื่อง — 2026-11-16 (Windows ↔ Termux)

ทดสอบหลัง publish 1.12.1: Termux เป็น server + HTTP target (8 MiB random),
Windows เป็น client (`-p` password mode), วัด SHA-256 สองฝั่ง

| โหมด | bytes | เวลา | SHA-256 |
|---|---|---|---|
| `--mux` | 8,388,608 | 4,062 ms (~2.0 MB/s) | ตรง (`f562b30c…`) |
| dedicated stream | 8,388,608 | 3,637 ms (~2.2 MB/s) | ตรง |

- `npm test` บน Termux (global 1.12.1) → **66 checks PASSED**
- server หลักบน Termux อัปเกรดเป็น 1.12.1 และรีสตาร์ตแล้ว (pid 21674)
- ระหว่างทดสอบ server หมุน slot ตามรอบชั่วโมงได้โดย session ที่เปิดอยู่ไม่หลุด
- หมายเหตุ: `curl` บน Windows มี probe แปลก ๆ (`0.0.0.20:80`) ที่ถูก allowlist ปฏิเสธ
  จึงใช้ Node HTTP client เป็นตัววัดหลัก (curl ไม่ใช่ตัวชี้วัดที่เชื่อถือได้ในเครื่องนี้)

---

## 1.4) mux soak คืน 2026-11-16 → 17 (ถูกตัดกลางคัน)

รอบแรกของ soak mux (4 MiB ทุก 3 นาที, ตั้งเป้า 9 ชม.)

| รายการ | ค่า |
|---|---|
| รอบที่ทำได้ | 119/180 (หยุดเอง 02:39:43) |
| ผ่าน / ล้ม | 109 / 10 |
| failure | ก้อนเดียว 00:33–01:20 (ECONNRESET → timeout) ฟื้นเอง |
| carriers | 11 (reconnect 10 ครั้ง จากเน็ตขาด) |
| throughput | min 0.87 / avg 2.60 / max 4.39 MB/s |
| client RSS | 51.4 – 67.7 MB (นิ่ง) |
| server RSS | 59 – 70 MB (นิ่ง) |

สาเหตุที่หยุด: ไม่ใช่ p2pgate — ไม่มี reboot (boot 13 พ.ย.), ไม่มี sleep/resume,
ไม่มี Application Error/WER ของ node, และ client ไม่ได้ log error อะไร
เหลือแค่แถวสุดท้าย `ok=true` แล้วหายทั้ง client และสคริปต์พร้อมกัน
⇒ ถูกฆ่าจากภายนอก (process tree) จึงย้ายไปรันผ่าน Task Scheduler ในรอบถัดไป
(`scripts/soak/runner.ps1` + `watch.ps1`)

ระหว่างก้อน failure: server log แสดงทุกรอบว่าได้รับ `GET` (72 B) แล้วส่งไฟล์ไปได้
320 KB–1.2 MB ก่อน session ปิดโดยไม่มี error ฝั่ง server ⇒ เส้นทางฝั่ง client ตาย
(Windows มี 32 events ของ Hyper-V vSwitch NIC disconnect ในช่วงเวลาเดียวกัน)

---

## 1.5) mux soak 4 ชม. ผ่านสะอาด — 2026-11-17

รันผ่าน Task Scheduler (ไม่ผูกกับ shell ใด ๆ), 4 MiB ทุก 3 นาที, 4 ชั่วโมง

| รายการ | ค่า |
|---|---|
| รอบ | **79/79 ผ่าน** (0 failure) |
| carriers | **1** (ไม่มี reconnect ตลอด 4 ชม.) |
| throughput | min 0.92 / avg 1.90 / max 3.04 MB/s |
| client RSS | 21.8 – 67.3 MB (ไม่ไต่) |
| server RSS | 55.2 – 68.6 MB (49 samples, ไม่ไต่) |
| ปริมาณข้อมูล | ~316 MB ผ่าน carrier เดียว (`in=5,688 out=331,365,263`) |
| runner | `END exit=0 elapsed=240m` |
| watchdog | ไม่ทำงาน (ไม่มี `watchdog.log`) |

เทียบกับ run 1 (9 ชม. ตั้งใจ, ถูกฆ่าตอน 02:39): 109/119 ผ่าน, มี outage
47 นาทีจากเน็ตฝั่ง Windows และฟื้นเอง — run 2 แสดงว่าเมื่อเส้นทางนิ่ง
carrier เดียวอยู่ได้ทั้ง 4 ชั่วโมงโดยไม่มี error และ memory ไม่รั่ว

---

## 1.6) mux บน trusted device 4 ชม. — 2026-11-17 (1.13.0)

รันผ่าน Task Scheduler, 4 MiB ทุก 3 นาที, server เป็น `registry` + `key-only`
(ไม่ใช้ password) เพื่อบังคับเส้นทาง **fast path + mux**

| รายการ | ค่า |
|---|---|
| รอบ | **80/80 ผ่าน** (0 failure) |
| carriers | **1** — ไม่มี reconnect ตลอด 4 ชม. (`fastpath=1` ทั้ง carrier) |
| throughput | min 0.91 / avg 2.05 / max 3.50 MB/s |
| client RSS | 22.4 – 67.2 MB (10 รอบแรกเฉลี่ย 40.9 → 10 รอบท้าย 28.3) |
| server RSS | 42.8 – 74.1 MB (66.6 → 51.9) |
| ข้อมูล | ~335 MB ผ่าน carrier เดียว (`in=5,760 out=335,559,760`) |
| runner | `END exit=0 elapsed=243m` + `REPORT written` |
| watchdog | ไม่ทำงาน (ไม่มี `watchdog.log`) |

สรุป: mux บน fast path (phase 15) นิ่งทั้ง 4 ชั่วโมง, memory ไม่ไต่ (ลดลงด้วยซ้ำ),
และไม่มีการสร้าง carrier ใหม่เลย — เป็นหลักฐานพอจะพิจารณาเปิด default ในรุ่นถัดไป

---

## 1.7) SOCKS5 10 requests พร้อมกัน — mux vs no-mux (1.13.1)

ทดสอบผ่าน SOCKS5 จริง (Windows → Termux, ไฟล์ 1 MiB × 10 พร้อมกัน)

| โหมด | สำเร็จ | ข้อมูล | หมายเหตุ |
|---|---|---|---|
| `--socks5` (mux default) | **10/10** | 10.6 MB | carrier เดียว, 1 auth |
| `--socks5 --no-mux` | **3/10** | 2.3 MB | 7 ตัวถูกปฏิเสธ `busy` |

สาเหตุ: ถ้าไม่ใช้ mux ทุก connection authenticate แยก และ auth guard จำกัด
1 ครั้งต่อ key ⇒ เปิดพร้อมกันแบบเบราว์เซอร์จะโดนปฏิเสธ
⇒ default mux ไม่ได้แค่เร็วขึ้น แต่แก้ปัญหา connection หล่นตอนเปิดพร้อมกัน

---

## 2. วิธีเก็บตัวเลขสำหรับรอบถัดไป

มีสคริปต์พร้อมใช้แล้วที่ [`scripts/soak/`](../scripts/soak/README.md) —
`mux-termux.sh` (ฝั่ง server: isolated instance + HTTP target + RSS sampler)
และ `mux-windows.ps1` (ฝั่ง client: โหลดไฟล์ทุก N นาที + ตรวจ SHA-256 + CSV)

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
