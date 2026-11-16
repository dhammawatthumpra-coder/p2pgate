# p2pgate v1.6 — คู่มือทดสอบก่อนใช้งานจริง

เอกสารนี้เป็น **manual acceptance test** สำหรับตรวจสอบว่า p2pgate v1.11.2
ทำงานได้จริงบนเครื่องและเครือข่ายของคุณ ไม่ใช่แค่ผ่าน self-test

> ⚠️ ควรทดสอบในเครื่อง/บัญชีผู้ใช้ทดสอบก่อน
> โดยเฉพาะ `revoke`, `unlock` และการทดสอบ lockout
> เพราะคำสั่งเหล่านี้เปลี่ยนสถานะถาวรของคีย์

---

## 0) หลักการและขอบเขต

การทดสอบแบ่งเป็น 9 ระดับ:

| ระดับ | สิ่งที่พิสูจน์ | ใช้เวลาประมาณ |
|---|---|---|
| L0 | Syntax และ automated self-test | 2 นาที |
| L1 | อุโมงค์จริงบนเครื่องเดียว/LAN | 10 นาที |
| L2 | Termux + เครือข่ายมือถือ | 30 นาที |
| L3 | Verification modes และ registry | 20 นาที |
| L4 | Control plane (`status` / `pin` / `revoke`) | 15 นาที |
| L5 | `doctor` และกรณีผิดปกติ | 15 นาที |
| L6 | Lockout และ `unlock` | 15 นาที |
| L7 | Restart / boot / secret leakage | 20 นาที |
| L8 | Long-running และการสลับเครือข่าย | 1 คืนขึ้นไป |

**เกณฑ์ผ่านขั้นต่ำก่อนใช้จริง:** ผ่าน L0–L4 และ L7
ส่วน L5–L6 และ L8 แนะนำอย่างยิ่งก่อนใช้กับเครื่องจริงระยะยาว

---

## 0.1) การอยู่ร่วมกับ Tailscale + sshd บน Termux

สรุป: **ไม่ชนกันโดยปกติ** เพราะ `p2pgate server` ไม่ได้เปิด TCP port ฝั่งเซิร์ฟเวอร์
แต่มีจุดที่ต้องระวัง 3 จุด

| องค์ประกอบ | พอร์ต/ช่องทาง | ชนกับ p2pgate? |
|---|---|---|
| OpenSSH sshd (Termux) | TCP 8022 | ไม่ชนกับ Server; **ชนกับ Client** ถ้า Client อยู่เครื่องเดียวกันและใช้ `localPort` 8022 |
| Tailscale | UDP 41641 + interface `tailscale0` | ไม่ชน เพราะ HyperDHT ใช้ UDP คนละ socket |
| tailscaled socket | `/var/run/tailscale/tailscaled.sock` | ไม่ชนกับ `~/.p2pgate/control.sock` |
| Tailscale SSH | TCP 22 บน tailnet | ไม่ชนกับ OpenSSH 8022 เว้นแต่ตั้ง `tailscale serve` ทับพอร์ต 8022 |
| Tailscale exit node | route ทั้งหมดผ่าน exit node | ไม่ชน แต่ **hole punching อาจล้มเหลวหรือช้า** |

### จุดที่ต้องระวัง

1. **Client กับ sshd อยู่เครื่องเดียวกัน**
   - `p2pgate client` ค่าเริ่มต้นผูก `127.0.0.1:8022`
   - ถ้า sshd ใช้ 8022 อยู่แล้ว จะได้ `EADDRINUSE`
   - แก้โดยใช้พอร์ตอื่น:
     ```sh
     p2pgate client --port 8023
     ssh -p 8023 localhost
     ```

2. **Server ต้องชี้ไป sshd ที่ฟังอยู่จริง**
   - ค่าเริ่มต้น `targetPort: 8022` เหมาะกับ Termux
   - ถ้า sshd เปลี่ยนพอร์ตหรือ bind เฉพาะ Tailscale IP
     ให้แก้ `targetPort` หรือตรวจ `ss -ltnp | grep sshd`
   - p2pgate ต่อผ่าน `127.0.0.1` ดังนั้น sshd ต้องฟังบน loopback ด้วย

3. **อย่าใช้ config/state จริง أثناءทดสอบ**
   - `p2pgate setup` เขียนทับ `~/.p2pgate/config.json`
   - `devices add/remove` แก้ `trusted_devices`
   - `revoke/unlock` แก้ `lockout-state.json`
   - แนะนำใช้ HOME แยกสำหรับการทดสอบ (ดูด้านล่าง)

### วิธีทดสอบแบบไม่แตะ setup จริง

บน Termux/Linux/macOS:

```sh
export P2PGATE_TEST_HOME="$TMPDIR/p2pgate-test"
mkdir -p "$P2PGATE_TEST_HOME"

HOME="$P2PGATE_TEST_HOME" p2pgate setup
HOME="$P2PGATE_TEST_HOME" p2pgate server
```

อีก terminal หนึ่ง (Client):

```sh
HOME="$P2PGATE_TEST_HOME" p2pgate client --port 8023
ssh -p 8023 localhost
```

- control socket, config, trusted_devices และ lockout state
  จะอยู่ใต้ `$P2PGATE_TEST_HOME` ทั้งหมด
- คำสั่ง `ssh` ยังใช้ home จริงตามปกติ
- เมื่อทดสอบเสร็จ ลบโฟลเดอร์ทดสอบได้

ถ้าเลี่ยง HOME แยกไม่ได้ ให้ backup ก่อน:

```sh
cp -a ~/.p2pgate ~/.p2pgate.backup-$(date +%Y%m%d-%H%M%S)
```

### Tailscale ที่ควรปิดระหว่างทดสอบรอบแรก

- ปิด **exit node** ชั่วคราว
- ปิด **Tailscale Serve/Funnel** ที่อาจใช้พอร์ตทับ sshd
- ถ้าใช้ Android VPN รวมทราฟฟิกทั้งหมด ให้ทดสอบทั้งเปิดและปิด Tailscale
  เพื่อแยกปัญหา hole punching ออกจากปัญหา VPN routing

> `npm run self-test` ไม่แตะ sshd, Tailscale, พอร์ต 8022 หรือ `~/.p2pgate` จริง
> เพราะใช้ temp directory, พอร์ต 0 และ echo server ชั่วคราว

---

## 1) สิ่งที่ต้องเตรียม

- Node.js **20 ขึ้นไป** ทั้ง Server และ Client
- OpenSSH ฝั่ง Server (sshd ทำงานและใช้ public key login)
- `ssh` ฝั่ง Client
- อินเทอร์เน็ตที่อนุญาต UDP ขาออก
- เครื่องทดสอบ 2 เครื่อง (หรือ 1 เครื่องสำหรับ L1)
- สำหรับ L2: มือถือ Android + Termux

ตรวจเวอร์ชัน:

```sh
node -v
npm -v
```

---

## 2) L0 — Syntax และ Automated Test

### 2.1 ติดตั้งแบบไม่รัน script

```sh
npm ci --ignore-scripts --no-audit --no-fund
```

### 2.2 ตรวจ syntax

```sh
npm run check
```

**ผลที่ต้องเห็น:** ไม่มี error และจบด้วย exit code `0`

### 2.3 รัน self-test

```sh
npm run self-test
```

**ผลที่ต้องเห็น:**

- มีบรรทัด `✅` ครบทุกหัวข้อ
- มี `SELF-TEST PASSED`
- ไม่มี `FAILED` หรือ stack trace

จำนวน check ที่ควรมากกว่าหรือเท่ากับ v1.11: **54 checks**

### 2.4 ตรวจ metadata

```sh
node -e "const p=require('./package.json'); console.log(p.version, p.dependencies)"
```

**ผลที่ต้องเห็น:**

- `1.4.0`
- dependency มีเพียง `hyperdht`

---

## 3) L1 — อุโมงค์จริงบนเครื่องเดียวหรือ LAN

เป้าหมาย: พิสูจน์ว่า `ssh` ผ่านอุโมงค์ได้จริง ไม่ใช่แค่ handshake ผ่าน

### 3.1 เตรียม sshd ฝั่ง Server

ตรวจว่ามี sshd ฟังอยู่:

```sh
# Linux / Termux
ss -ltnp | grep 8022
```

```powershell
# Windows
Get-NetTCPConnection -LocalPort 8022 -State Listen
```

ถ้ายังไม่มี ให้เริ่ม sshd และทดสอบ `ssh -p 8022 localhost` ก่อน
เพื่อแยกปัญหา SSH ออกจากปัญหา p2pgate

### 3.2 ตั้งค่า Server

```sh
p2pgate setup
```

เลือก:

- `Server`
- โหมด `hybrid` (แนะนำสำหรับการทดสอบแรก)
- ใส่ Public Key ของ Client
- ตั้ง Unattended Password หรือใช้ Session PIN

### 3.3 ตั้งค่า Client

บนอีกเครื่อง:

```sh
p2pgate setup
```

เลือก `Client`, ใส่ `masterSecret` เดียวกัน, ตั้ง `localPort` (เช่น `8022`)

นำ Public Key ของ Client ไปเพิ่มที่ Server (ถ้ายังไม่ได้ทำ)

### 3.4 เริ่ม Server

```sh
p2pgate server
```

**ผลที่ต้องเห็น:**

- `✅ เซิร์ฟเวอร์พร้อมทำงานแล้ว`
- `โหมดยืนยันตัวตน: hybrid`
- `อุปกรณ์ที่ลงทะเบียน: N รายการ` (ต้องไม่ใช่ 0)
- `Public Key รอบนี้: ...`
- ถ้ารันใน terminal แบบ interactive และไม่ใช่ key-only จะเห็น Session PIN

### 3.5 เริ่ม Client

```sh
p2pgate client
```

> ถ้า Client อยู่เครื่องเดียวกับ sshd ที่ใช้พอร์ต 8022
> ให้เปลี่ยนเป็น `p2pgate client --port 8023` และใช้ `ssh -p 8023 localhost`
> (ดูหัวข้อ 0.1 เรื่อง Tailscale + sshd)

**ผลที่ต้องเห็น:**

- `✅ อุโมงค์พร้อมใช้งานแล้ว`
- `เปิดพอร์ตเฉพาะ: 127.0.0.1:<port>`
- ไม่มี prompt PIN ถ้าเป็น fast-path
- มี prompt PIN ถ้าเป็น two-step

### 3.6 ทดสอบ SSH ผ่านอุโมงค์

เปิด terminal ใหม่:

```sh
ssh -p 8022 localhost
```

**ผลที่ต้องเห็น:** เข้า SSH ได้ และคำสั่ง `whoami`, `pwd` ทำงาน

### 3.7 ทดสอบข้อมูลจำนวนมาก

```sh
# บน Client หลัง ssh เข้าไปแล้ว
dd if=/dev/zero bs=1M count=20 | wc -c
```

หรือคัดลอกไฟล์ 10–20 MB ผ่าน `scp -P 8022`

**ผลที่ต้องเห็น:** ข้อมูลครบ ไม่ค้าง ไม่ตัดกลางทาง

---

## 4) L2 — Termux + เครือข่ายมือถือ

เป้าหมาย: พิสูจน์ hole punching / UDP ผ่าน CGNAT และการทำงานบนมือถือจริง

### 4.1 เตรียม Termux

```sh
pkg update && pkg upgrade -y
pkg install nodejs openssh nano procps -y
```

### 4.2 ตั้งค่า

ทำตาม L1 แต่ Server อยู่บน Termux และ Client อยู่อีกเครือข่าย
(เช่น มือถือใช้ 4G, PC ใช้ Wi-Fi บ้าน)

### 4.3 ทดสอบ

- เริ่ม `p2pgate server` บน Termux
- เริ่ม `p2pgate client` บน PC
- `ssh -p 8022 localhost` จาก PC
- ปล่อย connection ค้างไว้ 5–10 นาที แล้วพิมพ์คำสั่งอีกครั้ง

**ผลที่ต้องเห็น:** connection ยังทำงาน ไม่หลุดเพราะมือถือพักหน้าจอ

### 4.4 เช็กปัญหาเฉพาะ Termux

- ปิด battery optimization ของ Termux
- เปิด Termux wake lock (แจ้งเตือนถาวร)
- ตรวจว่า operator ไม่บล็อก UDP

ถ้าเชื่อมต่อไม่ได้ ให้ดู `PEER_NOT_FOUND` ใน README ก่อน

---

## 5) L3 — Verification Modes และ Registry

ทดสอบทีละโหมด โดยแก้ `verificationMode` ใน config แล้วรีสตาร์ต Server

### 5.1 hybrid + trusted fast-path

```sh
p2pgate devices add <clientPublicKeyHex> --mode trusted \
  --expires 2027-12-31T23:59:59Z --comment "test-laptop"
p2pgate devices list
```

เริ่ม Client ใหม่โดยไม่ใส่ PIN

**ผลที่ต้องเห็น:**

- `devices list` แสดงโปรไฟล์ `trusted`, วันหมดอายุ และ `Fast-path: ใช่`
- Client ใช้ `FASTPATH_READY` และไม่ถาม PIN
- SSH ใช้งานได้

### 5.2 trusted หมดอายุ

```sh
p2pgate devices add <clientPublicKeyHex> --mode trusted \
  --expires 2020-01-01T00:00:00Z --comment "expired-test"
```

**ผลที่ต้องเห็น:** Client ถูกปฏิเสธด้วยเหตุผล `expired`
และไม่มีการเปิด connection ไปยัง sshd

### 5.3 two-step

ตั้ง `"verificationMode": "two-step"` แล้วรีสตาร์ต Server

**ผลที่ต้องเห็น:**

- Client ได้ `CHALLENGE_REQUIRED`
- มี prompt PIN/รหัสผ่าน
- PIN ผิดถูกหน่วงและไม่เปิด sshd
- PIN ถูกต้องผ่าน

### 5.4 key-only

ตั้ง `"verificationMode": "key-only"` แล้วรีสตาร์ต Server

**ผลที่ต้องเห็น:**

- Server แสดง `โหมดยืนยันตัวตน: key-only`
- ไม่มี Session PIN
- Client ไม่ถาม PIN
- `p2pgate pin` ตอบว่าโหมดนี้ไม่มี Session PIN

### 5.5 Live reload

1. ขณะ Server รันอยู่ เพิ่ม trusted device ใหม่
2. รอ 1–2 วินาที
3. เชื่อมต่อด้วยคีย์นั้น

**ผลที่ต้องเห็น:** ใช้ fast-path ได้โดยไม่ต้องรีสตาร์ต Server

### 5.6 Trusted expiry enforcement

```sh
p2pgate devices add <key> --mode trusted
```

**ผลที่ต้องเห็น:** ถูกปฏิเสธและแจ้งว่าต้องมี `--expires` หรือ `--permanent`

```sh
p2pgate devices add <key> --mode trusted --permanent
```

**ผลที่ต้องเห็น:** สำเร็จ พร้อมคำเตือนเรื่องข้าม PIN

---

## 6) L4 — Control Plane

### 6.1 `status`

ขณะ Server รันอยู่:

```sh
p2pgate status
```

**ผลที่ต้องเห็น:**

- `=== p2pgate status ===`
- โหมดยืนยันตัวตนตรงกับ config
- จำนวนอุปกรณ์มากกว่า 0
- จำนวน connection และ slots แสดงถูกต้อง
- ไม่มี PIN ใน output

### 6.2 `pin`

```sh
p2pgate pin
```

**ผลที่ต้องเห็น:**

- แสดง PIN รูปแบบ `XXXXX-XXXXX`
- ตรงกับ PIN บนหน้าจอ Server (ถ้ามี)
- ไม่มีการเขียน PIN ลงไฟล์

ทดสอบในโหมด key-only: ต้องได้ข้อความว่าไม่มี Session PIN

### 6.3 `revoke` ขณะมี session เปิดอยู่

1. เปิด SSH ผ่านอุโมงค์ค้างไว้
2. รัน:

```sh
p2pgate revoke <clientPublicKeyHex>
```

**ผลที่ต้องเห็น:**

- คำสั่งสำเร็จและรายงานจำนวน connection ที่ปิด
- SSH session ถูกตัดทันที
- `p2pgate unlock --list` แสดงสถานะ "เพิกถอนด้วยคำสั่ง revoke"
- เชื่อมต่อใหม่ถูกปฏิเสธ

### 6.4 `unlock`

```sh
p2pgate unlock <clientPublicKeyHex>
```

**ผลที่ต้องเห็น:** เชื่อมต่อใหม่ได้ตามปกติ

### 6.5 `revoke` ขณะ Server ไม่ได้รัน

1. หยุด Server
2. รัน `p2pgate revoke <key>`

**ผลที่ต้องเห็น:**

- คำสั่งบันทึกการเพิกถอนและแจ้งว่า Server ไม่ได้รัน
- เมื่อเริ่ม Server ใหม่ คีย์นั้นยังถูกปฏิเสธ
- `unlock` คืนสิทธิ์ได้

### 6.6 สิทธิ์ของ control socket (POSIX)

```sh
ls -l ~/.p2pgate/control.sock
stat -c '%a' ~/.p2pgate/control.sock
```

**ผลที่ต้องเห็น:** โหมด `600` และเจ้าของเป็นผู้ใช้ปัจจุบัน

บน Windows ให้ตรวจว่ามี named pipe และเข้าถึงได้เฉพาะผู้ใช้เดียวกัน

### 6.7 `CONTROL_IN_USE`

พยายามเริ่ม Server สองตัวที่ใช้ home เดียวกัน

**ผลที่ต้องเห็น:** ตัวที่สองเริ่มไม่ได้และแจ้ง `CONTROL_IN_USE`
(หรือข้อความว่า control socket ถูกใช้อยู่)

---

## 7) L5 — `doctor` และกรณีผิดปกติ

### 7.1 กรณีปกติ

```sh
p2pgate doctor
```

**ผลที่ต้องเห็น:**

- มี ✅ หลายรายการ
- ไม่มี masterSecret, PIN หรือ verifier ใน output
- exit code `0` ถ้าไม่มี ❌

### 7.2 trusted_devices สิทธิ์หลวม (POSIX)

```sh
chmod 644 ~/.p2pgate/trusted_devices
p2pgate doctor
```

**ผลที่ต้องเห็น:** แจ้งเตือน/ผิดพลาดเรื่องสิทธิ์ และแนะนำ `chmod 600`

จากนั้นคืนสิทธิ์:

```sh
chmod 600 ~/.p2pgate/trusted_devices
```

### 7.3 sshd ไม่ทำงาน

หยุด sshd แล้วรัน `p2pgate doctor`

**ผลที่ต้องเห็น:** ⚠️ ว่าไม่พบบริการที่พอร์ตปลายทาง

### 7.4 Registry ว่าง

ใช้ config ที่ไม่มีทั้ง `allowedClientKeys` และ trusted devices

**ผลที่ต้องเห็น:** ❌ ไม่มีอุปกรณ์ลงทะเบียน และแนะนำ 방법เพิ่ม

### 7.5 ไม่มี client key (โหมด Client)

ย้าย `client-key.json` ออกชั่วคราวแล้วรัน `p2pgate doctor`

**ผลที่ต้องเห็น:** ❌ ไม่พบกุญแจ Client และแนะนำ `p2pgate keygen`

### 7.6 Windows

**ผลที่ต้องเห็น:** ⚠️ ว่าไม่ได้ตรวจ POSIX permission
และควรตรวจ ACL เองด้วย `icacls`

---

## 8) L6 — Lockout และ `unlock`

> ใช้คีย์ทดสอบแยกต่างหาก อย่าใช้คีย์ที่ต้องใช้งานจริง
> เพราะอาจถูกระงับถาวรระหว่างทดสอบ

1. เปิด Server โหมด hybrid/two-step
2. ใช้ Client คีย์ทดสอบ
3. ใส่ PIN ผิด 3 ครั้ง

**ผลที่ต้องเห็น:**

- ถูกหน่วงก่อนตอบ error
- คีย์ถูกระงับ 15 นาที
- Session PIN ถูกเปลี่ยน generation
- `p2pgate unlock --list` แสดงสถานะ

ทำซ้ำเพื่อทดสอบ 6 ครั้ง (ระงับ 6 ชั่วโมง) และ 10 ครั้ง (ถาวร)
แล้วทดสอบ:

```sh
p2pgate unlock <key>
```

**ผลที่ต้องเห็น:** เชื่อมต่อได้อีกครั้งโดยไม่ต้องรีสตาร์ต Server

---

## 9) L7 — Restart / Boot / Secret Leakage

### 9.1 Restart Server

หยุดและเริ่ม Server ใหม่

**ผลที่ต้องเห็น:**

- คีย์ที่ถูก revoke ยังถูกปฏิเสธ
- คีย์ที่ unlock แล้วเชื่อมต่อได้
- trusted devices ยังอยู่
- ไม่มี Session PIN เก่าหลงเหลือในไฟล์

### 9.2 Autostart

- Termux: ใช้ `scripts/termux-boot.sh`
- Linux: systemd
- macOS: launchd
- Windows: Task Scheduler

**ผลที่ต้องเห็น:** Server เริ่มเองหลัง reboot และ log ถูกเขียนตามที่กำหนด

### 9.3 ตรวจ PIN ไม่หลุดลงดิสก์

เก็บค่า PIN จาก `p2pgate pin` ไว้ แล้วค้นหาในไฟล์ที่เกี่ยวข้อง:

```sh
grep -R "<PIN>" ~/.p2pgate 2>/dev/null
```

**ผลที่ต้องเห็น:** ไม่พบ PIN ใน config, log, lockout state หรือ trusted devices

ตรวจ process list ว่าไม่มี `--pin`:

```sh
ps aux | grep p2pgate
```

**ผลที่ต้องเห็น:** ไม่มีรหัสผ่านใน arguments

### 9.4 ตรวจพอร์ตที่เปิด

```sh
ss -ltnp | grep -E '8022|p2pgate'
```

**ผลที่ต้องเห็น:** Client ฟังเฉพาะ `127.0.0.1` ไม่ใช่ `0.0.0.0`

Windows:

```powershell
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -eq 8022 }
```

---

## 10) L8 — Long-running และการสลับเครือข่าย

### 10.1 ทิ้ง Server ไว้ 24 ชั่วโมง

ตรวจเป็นระยะ:

- ยังเชื่อมต่อใหม่ได้
- memory ไม่โตผิดปกติ
- log ไม่มี error ซ้ำ ๆ
- rotation รายชั่วโมงไม่ตัด session ที่ใช้งานอยู่

### 10.2 สลับ Wi-Fi ↔ 4G

ขณะ SSH session เปิดอยู่ ให้สลับเครือข่ายของ Client

**ผลที่ต้องเห็น:** session อาจหลุด (ปกติของ TCP) แต่เชื่อมต่อใหม่ได้
และไม่มี state ค้างที่ Server

### 10.3 หลาย Client พร้อมกัน

เชื่อมต่อ 2–3 เครื่องพร้อมกัน

**ผลที่ต้องเห็น:**

- แต่ละเครื่องใช้คีย์ของตัวเอง
- ไม่มีคีย์ใดได้สิทธิ์ของอีกคีย์
- `p2pgate status` แสดงจำนวน connection ถูกต้อง

---

## 10.4) L9 — v1.6 Security & Automation

### Client key passphrase

```sh
p2pgate keygen --passphrase
p2pgate keygen              # ต้องแสดงว่าป้องกันด้วย passphrase
p2pgate client              # ต้องถาม passphrase
```

ทดสอบแบบไม่ interactive:

```sh
p2pgate client --key-passphrase-stdin < key-passphrase.txt
```

- passphrase ผิดต้องถูกปฏิเสธ
- key แบบ plaintext เดิมต้องยังใช้ได้

### JSON output

```sh
p2pgate status --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.ok,j.verificationMode)})"
p2pgate doctor --json   # ต้อง parse ได้และ exit code ตรงกับ critical checks
```

### Audit log

```sh
grep -E 'auth\.(success|failure|declined)|control\.revoke' ~/.p2pgate/audit.log
```

- ต้องไม่มี PIN, password, passphrase, seed, masterSecret หรือ control token
- ไฟล์ต้องเป็น `0600`
- เมื่อเกิน `maxBytes` ต้องมี `audit.log.1`

### Control token

- `~/.p2pgate/control.token` ต้องเป็น `0600`
- ถ้าแก้ token ให้ผิด `status` ต้องได้ `UNAUTHORIZED`
- บน POSIX control socket ต้องเป็น `0600`

### Devices list

```sh
p2pgate devices list
```

- ต้องเห็น `Lockout:` และจำนวนครั้งที่ล้มเหลว

---

## 11) Known Limitations ของ v1.11.2

สิ่งเหล่านี้ **ยังไม่มี** และไม่ควรถือว่าเป็นบั๊ก:

- Master secret rotation
- Windows ACL/DACL enforcement (ใช้ control token เสริม)
- Audit log เป็น local และไม่ได้ทำ tamper-evident logging
- Multi-target หรือ per-key target policy
- Multi-tenant หรือ remote control plane
- การตัด SSH session ระดับ OS (revoke ตัดที่ stream ของ p2pgate)
- Long-running, multi-client stress และ NAT บางรูปแบบยังรอทดสอบ

---

## 12) บันทึกผลการทดสอบ

คัดลอกตารางนี้ไปใช้บันทึกผล:

```text
p2pgate v1.11.2 — Test Record
วันที่:
เครื่อง Server:
เครื่อง Client:
เครือข่าย:

[ ] L0 npm ci + check + self-test (54 checks)
[ ] L0 `p2pgate ping --count 2`
[ ] L0 `p2pgate status --watch` (traffic)
[ ] L0 UDP: `p2pgate udp --target <name>`
[ ] L0 `config validate` / `config show`
[ ] L0 `socks.perClient` override
[ ] L0 `master show` / `master reset --dry-run`
[ ] L0 multi-target (`--target web`)
[ ] L0 SOCKS5 allow/deny (`--socks5`)
[ ] L0 zero-setup server + connect
[ ] L0 connect -s -p
[ ] L0 password reset
[ ] L0 P2PGATE_LANG=en/th
[ ] L1 SSH ผ่านอุโมงค์ (LAN)
[ ] L1 ถ่ายโอนข้อมูล 10–20 MB
[ ] L2 Termux + 4G
[ ] L3 hybrid + trusted fast-path
[ ] L3 trusted expired
[ ] L3 two-step + PIN
[ ] L3 key-only
[ ] L3 live reload
[ ] L3 trusted expiry enforcement
[ ] L4 status
[ ] L4 status --json
[ ] L4 pin
[ ] L4 revoke + unlock
[ ] L4 revoke offline
[ ] L4 control socket permission
[ ] L4 control token / UNAUTHORIZED
[ ] L4 CONTROL_IN_USE
[ ] L5 doctor ปกติ
[ ] L5 doctor --json
[ ] L5 doctor กรณีผิดปกติ
[ ] L6 lockout 3/6/10
[ ] L7 restart
[ ] L7 autostart
[ ] L7 ไม่มี PIN ในไฟล์/process
[ ] L7 พอร์ตผูก 127.0.0.1
[ ] L8 long-running 24 ชม.
[ ] L8 สลับเครือข่าย
[ ] L8 หลาย Client
[ ] L9 client key passphrase
[ ] L9 audit log และไม่มี secrets
[ ] L9 devices list แสดง lockout

ปัญหาที่พบ:
1.
2.
3.

สรุป: ผ่าน / ไม่ผ่าน
ผู้ทดสอบ:
```

---

## 13) ถ้าพบปัญหา ควรเก็บอะไรบ้าง

- เวอร์ชัน: `p2pgate --version` และ `node -v`
- ระบบ: Termux/Linux/macOS/Windows และเวอร์ชัน
- โหมด: `hybrid` / `key-only` / `two-step`
- คำสั่งที่ใช้ (ลบ PIN/secret ออก)
- ข้อความ error ทั้งหมด
- ผล `p2pgate doctor`
- ผล `p2pgate status` (ถ้า Server ยังรัน)
- `p2pgate devices list`
- log ของ Server (ถ้ามี)

**อย่าแนบ:** `masterSecret`, PIN, รหัสผ่าน, ไฟล์ `client-key.json`
หรือ verifier จาก `config.json`
