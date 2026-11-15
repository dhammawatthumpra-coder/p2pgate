# Running p2pgate as a service

คู่มือรัน `p2pgate server` / `p2pgate client` เป็น service (daemon) บน Termux,
Linux และ Windows

> อ่านหัวข้อ 1 ก่อนติดตั้ง — service เปลี่ยนวิธีป้องกันตัวบางอย่าง

---

## 1. สิ่งที่เปลี่ยนเมื่อรันเป็น service

### 1.1 Session PIN ใช้ไม่ได้

Session PIN สร้างได้เฉพาะเมื่อมี TTY และเก็บใน RAM เท่านั้น  
เมื่อรันเป็น service (ไม่มี terminal) จะไม่มี PIN

ผลต่อแต่ละโหมด:

| `verificationMode` | headless / service | หมายเหตุ |
|---|---|---|
| `key-only` | ✅ ทำงานเต็มที่ | key คือปัจจัยเดียว — **แนะนำสำหรับ service** |
| `hybrid` + trusted device | ✅ fastpath | ปกติ |
| `hybrid` + key ที่ไม่ trusted | ❌ `interactive_unavailable` | ไม่มี PIN ให้ถาม |
| `two-step` | ❌ `interactive_unavailable` | ถ้าไม่มี password fallback |
| `two-step` + unattended password | ✅ แต่ลดเหลือ password เดียว | อ่อนลงthan ปกติ |

`authMode: password` ยังใช้ได้ใน service เพราะถาม connection password จาก client
ไม่ต้องมี PIN ฝั่ง server

### 1.2 สิ่งที่ **ไม่** เปลี่ยน

- ไม่มี inbound port (ยัง outbound DHT)
- password ไม่ถูกส่ง plaintext (SCRAM proof)
- เก็บเฉพาะ SCRAM verifier, ไม่เก็บ password
- `serverKey` ยังใช้ยืนยันเครื่องได้
- tunnel bind `127.0.0.1`
- lockout / revoke / audit ทำงานเหมือนเดิม
- `p2pgate server` จัดการ SIGTERM/SIGINT แบบ graceful

---

## 2. เลือกโหมดที่ปลอดภัยสำหรับ service

### แบบที่แนะนำ (key-only)

```json
{
  "authMode": "registry",
  "verificationMode": "key-only"
}
```

- trusted device ที่ยัง active → เข้าได้ทันที
- key อื่น → ปฏิเสธ
- ไม่มี PIN ไม่มี password ค้างให้รั่ว
- revoke ได้ทันทีด้วย `p2pgate revoke <key>`

### แบบที่มี password เป็น fallback

```json
{
  "authMode": "password",
  "verificationMode": "hybrid"
}
```

- trusted → fastpath
- key อื่น → ต้องใส่ connection password
- สะดวก แต่ static secret กลายเป็นปัจจัยที่สองแทน PIN

### แบบที่ **ไม่ควร** ใช้กับ service

```json
{ "verificationMode": "two-step" }
```

เพราะสองปัจจัยจริง ๆ ต้องมี PIN ซึ่งแสดงไม่ได้ใน headless

---

## 3. Checklist ก่อนเปิด service

```text
[ ] ตั้ง verificationMode เป็น key-only หรือมี password fallback
[ ] trusted device ใช้ --expires ไม่ใช่ --permanent (สำหรับเครื่องพกพา)
[ ] ~/.p2pgate/config.json สิทธิ์ 0600
[ ] ~/.p2pgate/trusted_devices สิทธิ์ 0600
[ ] log directory 0700 + มี rotation
[ ] ไม่มี password/secret ใน unit file หรือ command line
[ ] รันด้วย user เฉพาะ (Linux) ไม่ใช่ root
[ ] ทดสอบ revoke แล้ว session ที่เปิดอยู่ถูกตัดจริง
[ ] ทดสอบ p2pgate status จาก service ที่รันอยู่
[ ] รู้จักวิธีดู log และ restart
```

---

## 4. Termux

### 4.1 แบบที่แนะนำ: termux-services (runit)

ติดตั้ง:

```sh
pkg install termux-services
```

คัดลอก service:

```sh
mkdir -p "$PREFIX/var/service/p2pgate/log"
cp scripts/termux/service/p2pgate/run     "$PREFIX/var/service/p2pgate/run"
cp scripts/termux/service/p2pgate/log/run "$PREFIX/var/service/p2pgate/log/run"
chmod +x "$PREFIX/var/service/p2pgate/run" "$PREFIX/var/service/p2pgate/log/run"
```

เปิดใช้งาน:

```sh
sv-enable p2pgate
sv up p2pgate
sv status p2pgate
```

คำสั่งที่ใช้บ่อย:

```sh
sv restart p2pgate
sv down p2pgate
tail -f "$LOGDIR/p2pgate/current"     # ถ้าใช้ log/run
```

> `termux-wake-lock` จะถูกเรียกใน `run` — เพิ่มการใช้แบตเตอรี่ แต่กัน Android
> kill process

### 4.2 แบบเดิม: Termux:Boot

ยังใช้ `scripts/termux-boot.sh` ได้ (มี restart loop + log rotation)
แต่ไม่มี process supervision เท่า termux-services

```sh
mkdir -p ~/.termux/boot
cp scripts/termux-boot.sh ~/.termux/boot/start-p2pgate.sh
chmod +x ~/.termux/boot/start-p2pgate.sh
```

### 4.3 ข้อควรรู้บน Android

- Android อาจ kill process แม้มี wake-lock → ใช้ termux-services เพื่อ restart
- อย่ารัน service บนเครื่องที่จะ reboot บ่อยโดยไม่มี Termux:Boot
- แบตเตอรี่/ความร้อนเพิ่มขึ้นเมื่อรันตลอด

---

## 5. Linux (systemd)

### 5.1 เตรียม user และ config

```sh
sudo useradd --system --home /home/p2pgate --create-home p2pgate
sudo -u p2pgate p2pgate server      # รันครั้งแรกเพื่อสร้าง config (Ctrl+C หลังสร้างเสร็จ)
sudo chmod 600 /home/p2pgate/.p2pgate/config.json
```

### 5.2 Server

```sh
sudo cp scripts/systemd/p2pgate-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now p2pgate-server
systemctl status p2pgate-server
journalctl -u p2pgate-server -f
```

แก้ `User=` และ path ใน unit ให้ตรงกับเครื่องจริง (ตรวจ `which p2pgate`)

### 5.3 Client

```sh
sudo cp scripts/systemd/p2pgate-client.service /etc/systemd/system/
sudo systemctl enable --now p2pgate-client
```

> client service จะใช้ได้เฉพาะเมื่อ server ไม่ challenge — คือ fastpath/key-only  
> ถ้า server ขอ PIN/password จะไม่มี TTY ให้กรอก

### 5.4 Health check

```sh
sudo -u p2pgate p2pgate status
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8022   # ต้องไม่ใช่ 000
```

---

## 6. Windows

### 6.1 Task Scheduler (มากับ Windows)

```powershell
# ติดตั้ง (รันที่ logon ของผู้ใช้ปัจจุบัน)
powershell -ExecutionPolicy Bypass -File scripts\windows\install-task.ps1

# ดูสถานะ
Get-ScheduledTask -TaskName p2pgate
Get-ScheduledTaskInfo -TaskName p2pgate

# ถอน
powershell -ExecutionPolicy Bypass -File scripts\windows\install-task.ps1 -Uninstall
```

ตัวเลือก:

| พารามิเตอร์ | ความหมาย |
|---|---|
| `-Mode server\|client` | เลือกคำสั่ง (ค่าเริ่มต้น `server`) |
| `-ConfigPath <path>` | ระบุ config (ค่าเริ่มต้น `%USERPROFILE%\.p2pgate\config.json`) |
| `-AtStartup` | เริ่มตอน boot (ต้องรันด้วยสิทธิ์ admin และระบุ `-User`/`-Password`) |
| `-LogPath <path>` | ไฟล์ log (ค่าเริ่มต้น `%USERPROFILE%\.p2pgate\service.log`) |

> ถ้าใช้ `-AtStartup` ให้ใช้ **absolute path** ใน config ทุกจุด  
> เพราะบัญชี service อาจมี `%USERPROFILE%` คนละอัน

### 6.2 NSSM (ถ้าต้องการ service จริง)

```powershell
nssm install p2pgate "C:\Program Files\nodejs\node.exe" "C:\path\to\p2pgate\src\cli.js server"
nssm set p2pgate AppDirectory C:\path\to\p2pgate
nssm set p2pgate AppStdout C:\Users\csuti\.p2pgate\service.log
nssm set p2pgate AppStderr C:\Users\csuti\.p2pgate\service.log
nssm set p2pgate Start SERVICE_AUTO_START
nssm start p2pgate
```

---

## 7. Log และการหมุนไฟล์

| Platform | ตำแหน่ง log | Rotation |
|---|---|---|
| Termux (runit) | `$LOGDIR/p2pgate/current` | svlogd |
| Termux (boot script) | `~/.p2pgate/server.log` | สคริปต์ตัดที่ 1 MiB |
| systemd | journald | `journalctl --vacuum-size` |
| Windows (task/nssm) | `~/.p2pgate/service.log` | ต้องจัดการเอง (หรือใช้ NSSM rotation) |

audit log แยกอยู่ที่ `~/.p2pgate/audit.log` (JSONL) และหมุนเองตาม `auditLog.maxBytes`

---

## 8. Upgrade

```sh
# Linux / Termux
npm install -g p2pgate@<version>
sv restart p2pgate            # Termux
sudo systemctl restart p2pgate-server   # Linux
p2pgate --version
p2pgate status
```

```powershell
# Windows
npm install -g p2pgate@<version>
Restart-ScheduledTask -TaskName p2pgate
p2pgate --version
```

หมายเหตุ: process ที่รันอยู่จะใช้โค้ดเก่าใน memory จนกว่าจะ restart

---

## 9. Revoke / rotate ระหว่างที่ service รันอยู่

ไม่ต้อง restart:

```sh
p2pgate revoke <clientKey>
p2pgate unlock --list
p2pgate devices add <key> --mode trusted --expires 2027-01-01T00:00:00Z
```

คำสั่งเหล่านี้คุยกับ control socket ของ service ที่รันอยู่

`p2pgate password reset` ต้อง restart service เพื่อใช้ค่าใหม่

---

## 10. Troubleshooting

| อาการ | สาเหตุ | แก้ |
|---|---|---|
| client ถูกปฏิเสธ `interactive_unavailable` | server ไม่มี TTY และไม่มี PIN/password fallback | ใช้ `key-only`, trusted device, หรือ password mode |
| service start แล้วออกทันที | config ไม่ถูกต้อง/ไม่มีสิทธิ์อ่าน | ดู log, รันด้วยมือก่อน |
| `ALLOWED_KEYS_EMPTY` | registry mode แต่ไม่มี key | เพิ่ม trusted device หรือใช้ password mode |
| `P2PGATE_LANG` ไม่ทำงาน | ไม่ได้ตั้งใน unit | เพิ่ม `Environment=P2PGATE_LANG=th` |
| `p2pgate status` ไม่ได้ | control socket อยู่คนละ user/home | รันด้วย user เดียวกับ service |
| Android kill แม้มี служба | Doze/แบตเตอรี่ | termux-services + wake-lock + ปิด optimization |
| Windows task ไม่รัน | ตั้งเป็น `-AtLogOn` แต่ไม่มีคน login | ใช้ `-AtStartup` + credentials หรือ NSSM |
| ต่อได้แต่ช้า | DHT bootstrap ช้า | ตรวจ UDP outbound / NTP |

---

## 11. ตัวอย่าง config สำหรับ service

`~/.p2pgate/config.json` (server, key-only):

```json
{
  "mode": "server",
  "masterSecret": "<64 hex>",
  "authMode": "registry",
  "verificationMode": "key-only",
  "targetHost": "127.0.0.1",
  "targetPort": 8022,
  "localPort": 8022,
  "clientKeyPath": "~/.p2pgate/client-key.json",
  "allowedClientKeys": [],
  "trustedDevicesFile": "~/.p2pgate/trusted_devices",
  "auditLog": { "enabled": true, "path": "~/.p2pgate/audit.log", "maxBytes": 5242880 },
  "customBootstrap": [],
  "authPin": { "enabled": false, "unattended": null },
  "telegramAlert": { "enabled": false, "botToken": "", "chatId": "" }
}
```

เพิ่มเครื่องที่ไว้ใจ:

```sh
p2pgate devices add <clientPublicKey> --mode trusted --expires 2027-12-31T23:59:59Z --comment "laptop"
```
