# p2pgate (v1.4)

[English](README.md) | **ไทย**

อุโมงค์ TCP แบบ P2P ขนาดเล็ก สำหรับเข้าถึง SSH บนมือถือที่อยู่หลัง CGNAT/ไฟร์วอลล์
โดยไม่ต้องเปิดพอร์ตออกสู่อินเทอร์เน็ต พร้อม **Mutual SCRAM**, **Verification Policy Modes**,
**Dual-Source Device Registry** และ **Local Control Plane**

ออกแบบสำหรับ **Redmi 14C (Android 14, Termux)** แต่ใช้ได้กับ Windows, macOS, Linux
และ Android เครื่องอื่นที่มี Node.js 20 ขึ้นไป

> เวอร์ชัน 1.4 เพิ่ม local control socket (`status`, `pin`, `revoke`),
> คำสั่ง `doctor` และบังคับวันหมดอายุสำหรับ trusted devices
> **ต้องอัปเดตทั้ง Server และ Client เป็น v1.4** เพื่อใช้คำสั่งใหม่ครบชุด
> (โปรโตคอล tunnel/auth ยังเข้ากันได้กับ v1.3)
>
> คู่มือทดสอบก่อนใช้งานจริง: [`TESTING.md`](TESTING.md)

---

## p2pgate ทำอะไร

```text
[PC / Mac / มือถือ]
ssh -p 8022 localhost
        │
        ▼
  p2pgate client  ──── HyperDHT (UDP + เข้ารหัส + hole punching) ────►  p2pgate server
  (ผูก 127.0.0.1 เท่านั้น)                                              (Termux บนมือถือ)
                                                                              │
                                                                              │ 1) registry/policy
                                                                              │ 2) fast-path หรือ SCRAM
                                                                              │ 3) ตรวจ serverSig
                                                                              ▼
                                                                       127.0.0.1:8022
                                                                           sshd
```

- ไม่เปิดพอร์ต SSH สู่อินเทอร์เน็ต
- Client เปิดเฉพาะ `127.0.0.1`
- Server ตรวจ Public Key จาก **สองแหล่ง**: `config.json` และ `trusted_devices`
- **hybrid:** อุปกรณ์ `trusted` ใช้ fast-path, อุปกรณ์อื่นใช้ two-step
- **key-only:** ใช้ Public Key เท่านั้น ไม่ถาม PIN
- **two-step:** ถาม PIN/รหัสผ่านทุกครั้ง แม้อุปกรณ์จะถูกทำเครื่องหมาย trusted
- Client เชื่อมต่อก่อน แล้วจึงถาม PIN เฉพาะเมื่อ Server ต้องใช้ two-step
- Control socket ภายในเครื่องสำหรับ `status`, `pin`, `revoke` โดยไม่ต้องรีสตาร์ต
- `p2pgate doctor` ตรวจสุขภาพการติดตั้งและแนะนำวิธีแก้เป็นภาษาไทย
- trusted devices ต้องมีวันหมดอายุหรือระบุ `--permanent` อย่างชัดเจน
- Lockout แบบก้าวหน้า 3/15 นาที, 6/6 ชั่วโมง, 10/ถาวร
- ปลดล็อกได้ทันทีด้วย `p2pgate unlock`
- ใช้ dependency ภายนอกเพียงตัวเดียว: `hyperdht`

---

## 1) Verification Modes

ตั้งค่าใน `config.json`:

```json
"verificationMode": "hybrid"
```

| โหมด | ค่าเริ่มต้น | พฤติกรรม |
|---|---|---|
| `hybrid` | ใช่ | อุปกรณ์ `trusted` ใช้ fast-path; อุปกรณ์ `scram` ใช้ two-step |
| `key-only` | ไม่ | ตรวจเฉพาะ Public Key; ไม่มี Session PIN และไม่ถาม PIN |
| `two-step` | ไม่ | ต้องยืนยันทั้ง Public Key และ PIN/รหัสผ่านทุกครั้ง |

### hybrid

- อุปกรณ์ที่ลงทะเบียนใน `trusted_devices` ด้วย `trusted` และยังไม่หมดอายุ
  จะเริ่ม session ได้ทันทีหลังตรวจ Public Key
- อุปกรณ์ที่มาจาก `config.json` หรือโปรไฟล์ `scram` ต้องยืนยันแบบ two-step
- ถ้า Server รันแบบไม่มี terminal และไม่มี Unattended Password
  อุปกรณ์ที่ต้อง two-step จะถูกปฏิเสธ
  แต่ trusted devices ยังใช้ fast-path ได้

### key-only

- เหมาะกับ automated workflow หรือ Server ที่รันเบื้องหลัง
- ทุกคีย์ที่ลงทะเบียนและยังไม่หมดอายุใช้ fast-path
- **ไม่สร้าง Session PIN** และไม่ถาม PIN
- ต้องป้องกันไฟล์กุญแจ Client เป็นพิเศษ เพราะไม่มี PIN เป็นด่านที่สอง

### two-step

- ต้องยืนยันทั้ง Public Key และ PIN/รหัสผ่านทุกครั้ง
- โปรไฟล์ `trusted` ใน `trusted_devices` จะไม่ถูกใช้เป็น fast-path
- เหมาะกับเครื่องที่ต้องการความเข้มงวดสูงสุด

> ค่าเริ่มต้นของ config v1.2 ที่ไม่มี `verificationMode` คือ `hybrid`
> ถ้า config เดิมมี `authPin.enabled: false` จะถูกตีความเป็น `key-only`

---

## 2) Dual-Source Device Registry

Server รวมรายการอุปกรณ์จาก:

1. `allowedClientKeys` ใน `config.json` (โปรไฟล์ `scram` โดยปริยาย)
2. ไฟล์ `trusted_devices` (ค่าเริ่มต้น `~/.p2pgate/trusted_devices`)

กำหนด path ได้ใน `config.json`:

```json
"trustedDevicesFile": "~/.p2pgate/trusted_devices"
```

### รูปแบบไฟล์

```text
# บรรทัดว่างและบรรทัดที่เริ่มด้วย # จะถูกข้าม
trusted <64-char-hex-public-key> primary-workstation
trusted,expires=2026-12-31T23:59:59Z <64-char-hex-public-key> contractor-laptop
scram <64-char-hex-public-key> shared-terminal
<64-char-hex-public-key> legacy-default-two-step-client
```

- บรรทัดที่ไม่มี option = โปรไฟล์ `scram`
- `trusted` = fast-path ภายใต้ `hybrid` (และทุกคีย์ภายใต้ `key-only`)
- `scram` = two-step
- `expires=` ต้องเป็น ISO-8601 และมี timezone เช่น `...Z`
- ป้ายชื่อ (label) เป็นข้อความที่เหลือบนบรรทัด

### Precedence

- คีย์ที่มีเฉพาะใน `config.json` → โปรไฟล์ `scram`
- คีย์ที่มีเฉพาะใน `trusted_devices` → ใช้โปรไฟล์/วันหมดอายุที่ระบุ
- คีย์ที่มีทั้งสองที่และรายการในไฟล์ยัง active → `trusted_devices` ชนะ
- คีย์ที่มีในไฟล์แต่ **หมดอายุ** → ถูกปฏิเสธ แม้จะยังอยู่ใน `config.json`

### สิทธิ์ไฟล์ (POSIX)

ก่อนใช้ fast-path ระบบตรวจว่าไฟล์ `trusted_devices`:

- เป็นไฟล์ปกติ ไม่ใช่ symlink
- เจ้าของคือผู้ใช้ปัจจุบัน
- ไม่มีสิทธิ์สำหรับ group/other (`chmod 600` หรือเข้มกว่า)

ถ้าสิทธิ์ไม่ปลอดภัย:

- `hybrid`: รายการ `trusted` จะไม่ใช้ fast-path (ต้อง two-step)
- `key-only`: รายการที่มาจากไฟล์จะถูกปฏิเสธ
- `two-step`: ยังต้อง two-step ตามปกติ

### Live Reload

Server ติดตาม `mtimeMs` ของ `trusted_devices`
และโหลดใหม่เมื่อไฟล์เปลี่ยน โดยไม่ต้องรีสตาร์ต
แนะนำให้แก้ผ่าน `p2pgate devices add/remove` ซึ่งเขียนแบบ atomic

---

## 3) การเชื่อมต่อแบบใหม่ (Deferred Input)

Client จะ **เชื่อมต่อก่อน** แล้วรอสถานะจาก Server:

| สถานะ | ความหมาย | การทำงานของ Client |
|---|---|---|
| `FASTPATH_READY` | อุปกรณ์ใช้ fast-path | ไม่ถาม PIN, เริ่มส่งข้อมูลทันที |
| `CHALLENGE_REQUIRED` | ต้องยืนยัน two-step | อ่าน PIN/รหัสผ่าน แล้วทำ SCRAM |
| `DECLINED` | ไม่ได้รับอนุญาต/หมดอายุ/ถูกระงับ | แสดงเหตุผลและปิด connection |

- Client ไม่ถาม PIN ก่อนเชื่อมต่ออีกต่อไป
- ถ้าเป็น fast-path หรือ key-only จะไม่มีการถาม PIN เลย
- `--pin-stdin` จะอ่าน stdin **เฉพาะเมื่อถูกถาม** (ไม่บล็อก fast-path)
- `P2PGATE_PIN` ถูกลบออกจาก process ทันทีหลังอ่านตอนเริ่ม Client

หลังได้สถานะ `CHALLENGE_REQUIRED` Client จะส่ง `READY`
แล้ว Server จึงส่ง SCRAM challenge และเริ่มจับเวลา 10 วินาที

---

## 4) Session PIN และ Unattended Password

### Session PIN

- 10 ตัวอักษร Base32: `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`
- แสดงเป็น `XXXXX-XXXXX` ในกรอบ ASCII บน console แบบ interactive
- เก็บในหน่วยความจำเท่านั้น ไม่เขียนลง config/log/ไฟล์
- เปลี่ยนใหม่เมื่อมีผู้ใส่ผิดครบ 3 หรือ 6 ครั้ง (salt ใหม่ทุกครั้ง)
- **key-only ไม่สร้าง Session PIN**
- Server ที่รันแบบ headless จะไม่แสดง PIN
  ให้ใช้ fast-path, key-only หรือ Unattended Password

### Unattended Password

- ยาวอย่างน้อย 12 ตัวอักษร
- ตัวพิมพ์เล็ก-ใหญ่มีความหมาย
- ใช้ได้ใน `hybrid`/`two-step` แม้ Server ไม่มี terminal
- เก็บเฉพาะ SCRAM verifier (`saltHex`, `storedKeyHex`, `serverKeyHex`)
- ตั้งค่าผ่าน `p2pgate setup`

```json
"authPin": {
  "enabled": true,
  "unattended": {
    "saltHex": "...",
    "storedKeyHex": "...",
    "serverKeyHex": "..."
  }
}
```

ถ้าไม่มีจะเป็น `"unattended": null`

---

## 5) การกรอก Credential ฝั่ง Client

ลำดับความสำคัญ:

1. `--pin-stdin` — อ่านหนึ่งบรรทัดจาก stdin เมื่อ Server ต้องใช้ two-step
2. `P2PGATE_PIN` — environment variable (ลบออกจาก process ทันที)
3. Hidden prompt — ค่าเริ่มต้น

> p2pgate ไม่มี flag `--pin`> เพื่อไม่ให้รหัสผ่านปรากฏใน `ps` หรือ shell history
>
> หลีกเลี่ยง `P2PGATE_PIN=... p2pgate client` แบบ inline
> ใช้ hidden prompt หรือ `--pin-stdin` จากไฟล์ที่ปลอดภัย

ตัวอย่างบน Termux/Linux:

```sh
install -m 600 /dev/null ~/.p2pgate/pin.txt
nano ~/.p2pgate/pin.txt
p2pgate client --pin-stdin < ~/.p2pgate/pin.txt
```

บน Windows PowerShell:

```powershell
Get-Content .\pin.txt | p2pgate client --pin-stdin
```

ตัวอย่าง environment variable:

```sh
export P2PGATE_PIN='...'
p2pgate client
unset P2PGATE_PIN
```

---

## 6) Progressive Lockout และ `unlock`

นับตาม Public Key ภายใน 24 ชั่วโมง:

| ผิด | ผล |
|---|---|
| 3 ครั้ง | ระงับ 15 นาที + เปลี่ยน Session PIN |
| 6 ครั้ง | ระงับ 6 ชั่วโมง + เปลี่ยน Session PIN |
| 10 ครั้ง | ระงับถาวร |

- invalid response ถูกหน่วง 2.5–3.5 วินาที
- จำกัด concurrent verification 1 ต่อคีย์ และ 3 ทั้งระบบ
- สถานะเก็บที่ `~/.p2pgate/lockout-state.json` สิทธิ์ `0600`
- ใช้ lockfile + atomic rename + mtime reload
- `p2pgate unlock` มีผลกับ Server ที่รันอยู่ทันที

```sh
p2pgate unlock --list
p2pgate unlock <clientPublicKeyHex>
p2pgate unlock --all
```

---

## 7) CLI สำหรับจัดการอุปกรณ์

```sh
p2pgate devices list
p2pgate devices add <publicKeyHex> --mode trusted \
  --expires 2026-12-31T23:59:59Z --comment "contractor"
p2pgate devices add <publicKeyHex> --mode trusted --permanent
p2pgate devices add <publicKeyHex> --mode scram --comment "shared-terminal"
p2pgate devices remove <publicKeyHex>
```

- `list` แสดงคีย์ทั้งหมดที่ merge แล้ว: แหล่งที่มา, โปรไฟล์, วันหมดอายุ, ป้ายชื่อ
- `add`/`remove` เขียน `trusted_devices` แบบ atomic
- `--mode` ค่าเริ่มต้นคือ `scram`; ใช้ `--mode trusted` สำหรับ fast-path
- `--expires` ต้องเป็น ISO-8601 พร้อม timezone
- **`--mode trusted` ต้องระบุ `--expires` หรือ `--permanent` เท่านั้น**
  - ถ้าไม่ระบุ ระบบจะปฏิเสธและอธิบายเป็นภาษาไทย
  - ถ้าระบุทั้งสองอย่าง ระบบจะปฏิเสธ
  - `--permanent` ใช้ได้เฉพาะกับ trusted
- ระบบจะเตือนว่า trusted device ข้ามการถาม PIN
- `remove` จะเตือนถ้าคีย์นั้นยังอยู่ใน `allowedClientKeys` ของ `config.json`
- ใช้ `--config <path>` เพื่อระบุ config

ตัวอย่างผลลัพธ์ `devices list`:

```text
- aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  แหล่งที่มา: config.json (allowedClientKeys)
  โปรไฟล์: scram
  หมดอายุ: -
  ป้ายชื่อ: -
  สถานะ: ใช้งาน
  Fast-path: ไม่ใช่
```

---

## 8) Local Control Plane (`status` / `pin` / `revoke`)

Server v1.4 เปิด **local control socket** สำหรับจัดการเซิร์ฟเวอร์ที่กำลังรันอยู่
โดยไม่ต้องรีสตาร์ตและไม่ต้องเปิดพอร์ต TCP เพิ่ม

### ตำแหน่ง socket

| ระบบ | ตำแหน่ง |
|---|---|
| Linux / macOS / Termux | `~/.p2pgate/control.sock` (สิทธิ์ `0600`, โฟลเดอร์ `0700`) |
| Windows | named pipe `\\.\pipe\p2pgate-control-<hash>` |

- ใช้ได้เฉพาะผู้ใช้เดียวกันบนเครื่องเดียวกัน
- socket ถูกลบเมื่อเซิร์ฟเวอร์ปิดอย่างถูกต้อง
- ถ้า socket ค้างจาก process ที่ตายไปแล้ว ระบบจะ probe ก่อนและลบทิ้ง
- ถ้ามีเซิร์ฟเวอร์อื่นใช้ socket อยู่ จะเริ่มไม่ได้และแจ้ง `CONTROL_IN_USE`

### คำสั่ง

```sh
p2pgate status
p2pgate pin
p2pgate revoke <clientPublicKeyHex>
```

#### `p2pgate status`

แสดงข้อมูลที่ไม่มี secrets:

- โหมดยืนยันตัวตน
- สถานะว่ามี Session PIN หรือไม่ (ไม่แสดง PIN)
- slot ปัจจุบันและ slots ที่เปิดอยู่
- จำนวนอุปกรณ์ลงทะเบียน
- จำนวน connection และคีย์ที่เชื่อมต่อ
- จำนวนที่ถูกบล็อกสะสม
- uptime, ไฟล์ trusted_devices, control socket path

#### `p2pgate pin`

ขอ Session PIN ปัจจุบันจากหน่วยความจำของเซิร์ฟเวอร์ผ่าน control socket:

```text
=== Session PIN ปัจจุบัน ===
   ABCDE-FGHJK
   generation: 1
```

- PIN ไม่ถูกเขียนลงดิสก์หรือ log
- โหมด `key-only` จะตอบ `NO_SESSION_PIN`
- ถ้าเซิร์ฟเวอร์ไม่ได้รันอยู่ จะแจ้งให้เริ่ม `p2pgate server`

#### `p2pgate revoke <key>`

- เพิกถอนคีย์แบบถาวร (`reason: manual`)
- ตัด connection ที่เปิดอยู่ของคีย์นั้นทันที
- การเชื่อมต่อครั้งถัดไปจะถูกปฏิเสธ
- ถ้าเซิร์ฟเวอร์ไม่ได้รันอยู่ คำสั่งจะบันทึกการเพิกถอนลง lockout state โดยตรง
  และมีผลเมื่อเซิร์ฟเวอร์เริ่มทำงาน/อ่าน state ใหม่

คืนสิทธิ์ด้วย:

```sh
p2pgate unlock <clientPublicKeyHex>
```

> `revoke` เป็นการตัดที่ระดับ p2pgate
> SSH session ที่ถูก pipe ผ่านอุโมงค์จะถูกปิดตาม stream
> แต่ควรตรวจสอบฝั่ง sshd เพิ่มเติมหากต้องการตัด session ระดับ OS

---

## 9) `p2pgate doctor`

คำสั่งตรวจสุขภาพแบบอ่านอย่างเดียว (read-only) แสดงผลภาษาไทยด้วย
`✅` / `⚠️` / `❌`

```sh
p2pgate doctor
p2pgate doctor --config /path/to/config.json
```

ตรวจสอบ:

1. เวอร์ชัน Node.js (ต้อง >= 20)
2. ไฟล์ config อ่านและ validate ได้
3. `verificationMode` และฟิลด์ที่เกี่ยวข้อง
4. สิทธิ์ไฟล์ config, client key, trusted_devices, lockout state
   - บน Windows จะแจ้งว่าไม่ได้ตรวจ POSIX permission
5. Device registry: จำนวนอุปกรณ์, อุปกรณ์หมดอายุ,
   trusted ที่ไม่มีวันหมดอายุ, สิทธิ์ไฟล์, registry ว่าง
6. ปลายทาง: Server ตรวจว่า `127.0.0.1:<targetPort>` มี sshd ฟังอยู่หรือไม่
   Client ตรวจว่าพอร์ตท้องถิ่นว่างหรือไม่
7. Control plane: ถ้าเซิร์ฟเวอร์รันอยู่จะ query `status`
8. Lockout state: จำนวนที่ถูกระงับ/เพิกถอน
9. คำเตือนเรื่องการมองเห็น Session PIN ในโหมดไม่มี terminal
10. กุญแจ Client ฝั่ง Client ว่ามีและถูกต้องหรือไม่

- exit code `0` เมื่อไม่มี `❌`
- exit code `1` เมื่อมีปัญหาวิกฤต
- ไม่พิมพ์ `masterSecret`, seed, verifier หรือ PIN

---

## 10) สิ่งที่ต้องมี

- มือถือ Android + Termux + Termux:Boot (F-Droid)
- Node.js 20 ขึ้นไป
- OpenSSH ฝั่ง Server และ `ssh` ฝั่ง Client
- อินเทอร์เน็ตที่อนุญาต UDP ขาออก

---

## 11) ติดตั้งบน Redmi 14C (Termux)

```sh
pkg update && pkg upgrade -y
pkg install nodejs openssh nano procps -y
node -v
```

คัดลอกโปรเจกต์ไปที่ `~/p2pgate` แล้ว:

```sh
cd ~/p2pgate
npm install --ignore-scripts --no-audit --no-fund
npm link --ignore-scripts
npm run check
npm run self-test
```

ถ้า native prebuild ใช้ไม่ได้:

```sh
pkg install python build-essential -y
npm install --no-audit --no-fund
```

---

## 12) ตั้งค่า SSH ให้ปลอดภัย

```sh
passwd
sshd
```

สร้าง SSH key บน Client:

```sh
ssh-keygen -t ed25519
```

นำ `id_ed25519.pub` ไปใส่ใน Termux:

```sh
mkdir -p ~/.ssh
nano ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

ปิด PasswordAuthentication:

```sh
nano $PREFIX/etc/ssh/sshd_config
```

```text
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
```

```sh
pkill sshd
sshd
ssh -p 8022 localhost
```

---

## 13) ตั้งค่า Server

```sh
cd ~/p2pgate
p2pgate setup
```

เลือก `1) Server` และเลือกโหมด:

```text
1) hybrid (แนะนำ)
2) key-only
3) two-step
```

- `hybrid`: trusted devices ใช้ fast-path, อุปกรณ์อื่น two-step
- `key-only`: ไม่ถาม PIN (จะไม่ถามรหัสผ่านสำรอง)
- `two-step`: ถาม PIN/รหัสผ่านทุกครั้ง

จากนั้น:

1. วาง Public Key ของ Client
2. ตั้ง Unattended Password (ยกเว้น key-only)
3. บันทึก config
4. เพิ่ม trusted devices ถ้าต้องการ:
   ```sh
   p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z --comment "laptop"
   ```
5. เริ่ม Server:
   ```sh
   p2pgate server
   ```

ถ้ารันใน terminal และโหมดเป็น hybrid/two-step จะเห็น Session PIN ในกรอบ
ถ้ารันแบบ headless จะไม่เห็น PIN; ใช้ trusted fast-path หรือ Unattended Password

---

## 14) ตั้งค่า Client

```sh
cd p2pgate
npm install --ignore-scripts --no-audit --no-fund
npm link --ignore-scripts
p2pgate setup
```

เลือก `2) Client` วาง `masterSecret` และกำหนดพอร์ต

นำ Public Key ไปเพิ่มที่ Server:

```sh
p2pgate setup
```

หรือเพิ่มเป็น trusted device:

```sh
p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z --comment "my-pc"
```

เริ่มอุโมงค์:

```sh
p2pgate client
```

- ถ้า Server ส่ง `FASTPATH_READY` จะไม่ถาม PIN
- ถ้า Server ส่ง `CHALLENGE_REQUIRED` จะถาม PIN/รหัสผ่านในหน้าต่าง Client
- ถ้า Server ส่ง `DECLINED` จะแสดงเหตุผลและปิด

จากนั้นเปิด terminal ใหม่:

```sh
ssh -p 8022 localhost
```

---

## 15) ใช้งานประจำวัน

```sh
# Server
cd ~/p2pgate
p2pgate server

# Client
cd p2pgate
p2pgate client
ssh -p 8022 localhost
```

- trusted devices ภายใต้ hybrid ไม่ต้องกรอก PIN
- อุปกรณ์ scram ต้องกรอก PIN/รหัสผ่าน
- key-only ไม่ถาม PIN
- two-step ถามทุกครั้ง
- ถ้า PIN ถูกเปลี่ยนหรือถูกระงับ Client จะแจ้งเป็นภาษาไทย

---

## 16) Termux:Boot

```sh
mkdir -p ~/.termux/boot
cp ~/p2pgate/scripts/termux-boot.sh ~/.termux/boot/start-p2pgate.sh
chmod +x ~/.termux/boot/start-p2pgate.sh
```

- ตั้ง Battery ของ Termux เป็น Unrestricted
- เปิด Termux:Boot อย่างน้อยหนึ่งครั้ง
- รีสตาร์ตเครื่อง

โหมดที่เหมาะกับ headless:

- `key-only` — ไม่ต้องใช้ PIN
- `hybrid` + trusted devices — อุปกรณ์เหล่านั้นใช้ fast-path
- `hybrid`/`two-step` + Unattended Password — ใช้รหัสผ่านสำรอง

Session PIN ไม่ถูกเขียนลงไฟล์หรือ log ในทุกกรณี

log:

```sh
tail -f ~/.p2pgate/server.log
```

---

## 17) Telegram (ไม่บังคับ)

1. สร้างบอทกับ `@BotFather`
2. เอา Bot Token
3. ส่งข้อความหาบอทหนึ่งครั้ง
4. เอา Chat ID จาก `getUpdates`

ระบบจะแจ้งเมื่อ:

- มีคีย์ที่ไม่รู้จักพยายามเชื่อมต่อ (จำกัด 1 ครั้ง/60 วินาที/คีย์)
- ใส่ผิด 3 ครั้ง → ระงับ 15 นาที + เปลี่ยน PIN
- ใส่ผิด 6 ครั้ง → ระงับ 6 ชั่วโมง + เปลี่ยน PIN
- ใส่ผิด 10 ครั้ง → ระงับถาวร

ข้อความจะไม่มี PIN หรือรหัสผ่าน

---

## 18) ความปลอดภัย

- **`masterSecret`** ใช้สร้างคีย์ Server รายชั่วโมง
- **`allowedClientKeys` + `trusted_devices`** เป็น registry
- **`hybrid`** ให้ fast-path เฉพาะ trusted devices
- **`key-only`** ไม่มี PIN — ต้องปกป้อง Client key และ registry เป็นพิเศษ
- **`two-step`** เข้มที่สุด
- **Session PIN** อยู่ใน RAM เท่านั้น
- **Unattended Password** เก็บเฉพาะ SCRAM verifier
- **SCRAM mutual** ตรวจทั้ง Client proof และ Server signature
- **ไม่มี `--pin`** และ `P2PGATE_PIN` ถูกลบออกจาก process
- **`trusted_devices`** ต้องเป็นเจ้าของโดยผู้ใช้และ `chmod 600`
  หากสิทธิ์ไม่ปลอดภัย fast-path จะถูกปิด
- **Progressive lockout** 3/15m, 6/6h, 10/permanent
- **Control socket** เป็น local-only (`0600` หรือ named pipe ของผู้ใช้)
  - PIN ถูกอ่านจาก RAM และส่งผ่าน socket เท่านั้น
  - revoke ตัด connection ที่เปิดอยู่และบันทึกการระงับถาวร
  - ไม่มี TCP listener สำหรับ control plane
- **trusted device** ข้าม PIN จึงต้องมีวันหมดอายุหรือ `--permanent` อย่างชัดเจน
- **พอร์ตภายใน** ผูกกับ `127.0.0.1`
- **ไฟล์ config/กุญแจ/lockout/trusted_devices** สิทธิ์ `0600`
- **doctor** ไม่พิมพ์ secrets และไม่แก้ไขไฟล์

> p2pgate ไม่ได้แทนที่ SSH security ทั้งหมด
> แต่ช่วยให้เข้าถึง SSH ได้โดยไม่ต้องเปิดพอร์ตสู่สาธารณะ

---

## 19) คำสั่งทั้งหมด

| คำสั่ง | ความหมาย |
|---|---|
| `p2pgate setup` | ตั้งค่าและเลือก verificationMode |
| `p2pgate keygen` | สร้าง/แสดงกุญแจ Client |
| `p2pgate server` | เริ่ม Server |
| `p2pgate client` | เริ่ม Client และขอ credential เฉพาะเมื่อต้อง two-step |
| `p2pgate client --pin-stdin` | อ่าน credential จาก stdin เมื่อถูกถาม |
| `p2pgate devices list` | แสดง registry ที่ merge แล้ว |
| `p2pgate devices add <key> --mode trusted --expires ...` | เพิ่ม trusted device ชั่วคราว |
| `p2pgate devices add <key> --mode trusted --permanent` | เพิ่ม trusted device ถาวร (ต้องยืนยันเจตนา) |
| `p2pgate devices add <key> --mode scram` | เพิ่มอุปกรณ์ที่ต้อง two-step |
| `p2pgate devices remove <key>` | ลบออกจาก trusted_devices |
| `p2pgate status` | ดูสถานะเซิร์ฟเวอร์ผ่าน control socket |
| `p2pgate pin` | ขอ Session PIN จากเซิร์ฟเวอร์ที่รันอยู่ |
| `p2pgate revoke <key>` | เพิกถอนคีย์และตัด connection ที่เปิดอยู่ |
| `p2pgate doctor` | ตรวจสุขภาพการติดตั้งและแนะนำวิธีแก้ |
| `p2pgate unlock --list` | ดูสถานะ lockout/revoke |
| `p2pgate unlock <key>` | ปลดล็อกเฉพาะคีย์ |
| `p2pgate unlock --all` | ปลดล็อกทั้งหมด |
| `p2pgate help` | แสดงข้อความช่วยเหลือ |
| `npm run check` | ตรวจ syntax |
| `npm run self-test` | ทดสอบทุกโหมด, registry, control, doctor, lockout, rotation |
| `npm test` | รัน `check` + `self-test` |

ไฟล์เริ่มต้น:

- config: `~/.p2pgate/config.json`
- กุญแจ Client: `~/.p2pgate/client-key.json`
- trusted devices: `~/.p2pgate/trusted_devices`
- lockout state: `~/.p2pgate/lockout-state.json`
- control socket: `~/.p2pgate/control.sock` (Windows: named pipe)

---

## 20) แก้ปัญหา

### ขึ้น `STATUS_DECLINED`

- `unlisted`: คีย์ไม่อยู่ใน registry -> `p2pgate devices list`
- `expired`: หมดอายุ -> แก้ `--expires` หรือเพิ่มใหม่
- `insecure_registry`: ไฟล์ trusted_devices สิทธิ์ไม่ปลอดภัย -> `chmod 600`
- `interactive_unavailable`: Server headless ไม่มี terminal และไม่มี Unattended Password
  -> ใช้ trusted fast-path, key-only หรือตั้ง Unattended Password
- `busy`: มีการยืนยันตัวตนอื่นทำงานอยู่ -> ลองใหม่

### `p2pgate status` / `pin` ใช้ไม่ได้

- ต้องมีเซิร์ฟเวอร์ที่รันอยู่และเป็นผู้ใช้เดียวกัน
- ตรวจว่า `~/.p2pgate/control.sock` มีอยู่ (Windows ใช้ named pipe)
- ถ้าเซิร์ฟเวอร์เพิ่ง crash แล้ว socket ค้าง ให้เริ่มเซิร์ฟเวอร์ใหม่
  ระบบจะ probe และลบ socket ที่ไม่มีเจ้าของให้
- ถ้าขึ้น `CONTROL_IN_USE` แสดงว่ามีเซิร์ฟเวอร์อื่นใช้ socket อยู่
  ให้ปิดตัวเก่าก่อน

### `revoke` แล้วยังเชื่อมต่อได้

- ตรวจว่าใช้ `p2pgate revoke <key>` กับเซิร์ฟเวอร์ที่กำลังรันอยู่
- ถ้าเซิร์ฟเวอร์ไม่ได้รัน คำสั่งจะบันทึกเฉพาะ state
  และมีผลเมื่อเซิร์ฟเวอร์อ่าน state ใหม่
- ตรวจด้วย `p2pgate unlock --list` ว่าสถานะเป็น
  "เพิกถอนด้วยคำสั่ง revoke"
- คืนสิทธิ์ด้วย `p2pgate unlock <key>`

### `devices add --mode trusted` ถูกปฏิเสธ

ต้องระบุอย่างใดอย่างหนึ่ง:

```sh
p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z
p2pgate devices add <key> --mode trusted --permanent
```

ถ้าใช้ `--permanent` ควรตรวจสอบรายการเป็นระยะด้วย `p2pgate devices list`

### `doctor` ขึ้น ❌

อ่านคำแนะนำใต้บรรทัดนั้น เช่น สิทธิ์ไฟล์ไม่ปลอดภัย, registry ว่าง,
ไม่พบกุญแจ Client หรือ config ไม่ถูกต้อง
แก้แล้วรัน `p2pgate doctor` ซ้ำ
คำเตือน `⚠️` ไม่ทำให้ exit code เป็น 1

### trusted device ไม่ใช้ fast-path

- ตรวจ `verificationMode` ว่าเป็น `hybrid` หรือ `key-only`
- ตรวจว่าไฟล์เป็น `chmod 600` และเจ้าของถูกต้อง
- ตรวจว่าไฟล์ไม่หมดอายุ
- ตรวจว่า `config.json` ไม่ได้ override (ไฟล์ควรชนะ)
- ตรวจว่า Server โหลดไฟล์ใหม่แล้ว (`devices list` / mtime)

### key-only ไม่ถาม PIN

นี่คือพฤติกรรมปกติของ `key-only`
ถ้าต้องการ PIN ให้ใช้ `hybrid` หรือ `two-step`

### two-step ถาม PIN ทุกครั้ง

นี่คือพฤติกรรมปกติ
แม้อุปกรณ์จะอยู่ใน `trusted_devices` ก็จะไม่ใช้ fast-path ในโหมดนี้

### Client ไม่ถาม PIN

- ถ้า Server ส่ง `FASTPATH_READY` หรือเป็น `key-only` จะไม่ถาม
- ถ้าต้องการให้ถาม ใช้ `hybrid` + โปรไฟล์ `scram` หรือ `two-step`

### `PIN_REQUIRED`

Client ต้อง two-step แต่ไม่มี terminal / ไม่มี `--pin-stdin` / ไม่มี `P2PGATE_PIN`

### `PIN_ROTATED_OR_INVALID`

- PIN อาจถูกเปลี่ยนเพราะมีผู้ใส่ผิด 3/6 ครั้ง หรือ Server รีสตาร์ต
- ดู PIN ล่าสุดบนหน้าจอ Server หรือใช้ Unattended Password

### `LOCKED_OUT`

```sh
p2pgate unlock --list
p2pgate unlock <clientPublicKeyHex>
p2pgate unlock --all
```

### `AUTH_CONFIG_UPGRADE_REQUIRED`

พบ config รูปแบบ v1.1 กรุณารัน:

```sh
p2pgate setup
```

### v1.2 config ยังใช้งานได้ไหม

ได้ — ถ้าไม่มี `verificationMode` จะถือเป็น `hybrid`
และถ้า `authPin.enabled: false` จะถือเป็น `key-only`

### `PEER_NOT_FOUND`

- ตรวจ Server ทำงาน
- ตรวจ `masterSecret` ตรงกัน
- ตรวจ registry/public key
- ตรวจ UDP เครือข่าย
- Client ลองชั่วโมงก่อนหน้าให้อัตโนมัติ

### `EADDRINUSE`

```sh
p2pgate client --port 8023
ssh -p 8023 localhost
```

### SSH `Permission denied (publickey)`

- ตรวจ `~/.ssh/authorized_keys` และสิทธิ์
- ตรวจ `PasswordAuthentication no` และรีสตาร์ต sshd

---

## 21) โครงสร้างโปรเจกต์

```text
p2pgate/
├── .github/
│   └── workflows/
│       └── ci.yml
├── .editorconfig
├── .gitattributes
├── .gitignore
├── .npmrc
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
├── LICENSE
├── NOTICE
├── README.md
├── README.th.md
├── TESTING.md
├── config.example.json
├── docs/
│   ├── README.md
│   ├── releases/
│   │   └── v1.4.0.md
│   └── specs/
│       ├── phase2-v1.1.md
│       ├── phase3-v1.2.md
│       ├── phase4-v1.3.0.md
│       ├── phase5-v1.4.0.md
│       └── project-spec.md
├── package.json
├── package-lock.json
├── scripts/
│   └── termux-boot.sh
└── src/
    ├── cli.js
    ├── auth.js
    ├── auth-guard.js
    ├── device-registry.js
    ├── control.js
    ├── doctor.js
    ├── config-loader.js
    ├── crypto-utils.js
    ├── keygen.js
    ├── setup-wizard.js
    ├── server.js
    ├── client.js
    └── self-test.js
```

### การพัฒนาและ CI

- คู่มือทดสอบก่อนใช้งานจริง: [`TESTING.md`](TESTING.md)
- ประวัติเวอร์ชัน: [`CHANGELOG.md`](CHANGELOG.md)
- แนวทางมีส่วนร่วม: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- นโยบายความปลอดภัย: [`SECURITY.md`](SECURITY.md)
- workflow `.github/workflows/ci.yml` รัน `npm ci --ignore-scripts`,
  `npm run check` และ `npm run self-test` บน Ubuntu (Node 20/22/24),
  Windows (24) และ macOS (24) เมื่อ GitHub Actions ของบัญชีพร้อมใช้งาน
- รันชุดเดียวกันในเครื่องก่อน push:

```sh
npm test
```

---

## 22) หมายเหตุทางเทคนิค

- **Registry merge:** config keys = scram; file entries override; expired file entry denies
- **POSIX check:** symlink/owner/group-other permissions before fast-path
- **Live reload:** `mtimeMs` + atomic rename
- **Status frames v3:** `DECLINED`, `FASTPATH_READY`, `CHALLENGE_REQUIRED`, `READY`
- **Client READY:** Client ส่งหลังได้ credential เพื่อไม่ให้เวลาพิมพ์ถูกนับใน 10 วินาที
- **Control protocol:** newline-delimited JSON, version `1`, max 4096 bytes, timeout 5 วินาที
- **Control commands:** `status`, `pin`, `revoke`
  - `status` ไม่คืน PIN
  - `pin` อ่านจาก memory เท่านั้น
  - `revoke` ใช้ `AuthGuard.revoke(key, 'manual')` แล้วปิด active streams
- **Control socket:** POSIX `0600`, Windows named pipe, stale-socket probe ก่อนลบ
- **doctor:** read-only, exit 1 เมื่อมี `❌`, ไม่พิมพ์ secrets
- **Trusted expiry:** CLI บังคับ `--expires` หรือ `--permanent`; ไฟล์เดิมยังใช้ได้
- **SCRAM:** ยังใช้ challenge/response แบบ mutual และตรวจ `serverSig`
- **Session PIN:** 10 ตัวอักษร Base32, salt ใหม่ทุกครั้งที่สร้าง/เปลี่ยน
- **Async scrypt:** `crypto.scrypt` (N=16384, r=8, p=1)
- **Lockout:** 24-hour failure window, lockfile, atomic rename, mtime reload
- **Concurrency:** 1 ต่อคีย์, 3 ทั้งระบบ
- **Invalid delay:** 2.5–3.5 วินาที (self-test ใช้ค่าสั้น)
- **No `P2PGATE_TEST_*` env hooks**
- **Self-test:** ใช้ `HyperDHT.bootstrapper` และ injected clock/delay

---

## 23) License

p2pgate ใช้ **Apache License 2.0**

- [`LICENSE`](LICENSE)
- [`NOTICE`](NOTICE)

Copyright 2026 dhammawatthumpra-coder

