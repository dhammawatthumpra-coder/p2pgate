# p2pgate — Handoff

อัปเดตล่าสุด: 2026-11-15
สถานะ: **v1.6.3 prepared** (messaging patch; npm ยังเป็น 1.6.2 จนกว่าจะ publish)
เจ้าของโปรเจกต์: dhammawatthumpra-coder

เอกสารนี้เขียนไว้ให้เปิด session ใหม่แล้วทำงานต่อได้ทันทีโดยไม่ต้องไล่ประวัติแชท

---

## 0. วิธีเริ่ม session ใหม่

วางข้อความนี้ใน session ใหม่:

```text
โปรเจกต์: D:\tunnel\p2pgate (p2pgate v1.6.3)
อ่าน docs/HANDOFF.md ก่อน แล้วสรุปสถานะปัจจุบันและรอคำสั่ง
```

จากนั้นสั่งงานได้เลย เช่น "ทำ soak test", "เพิ่ม multi-port", "ตรวจ repo ก่อนออก v1.7.0"

---

## 1. โปรเจกต์คืออะไร

P2P TCP tunnel สำหรับเข้าถึง SSH บนเครื่องที่อยู่หลัง CGNAT/ไฟร์วอลล์ โดยไม่ต้องเปิด
inbound port ทำงานบน HyperDHT (Noise) พร้อม SCRAM mutual auth

- **Node.js** ≥ 20 (ทดสอบบน Node 24)
- **dependency ภายนอกตัวเดียว:** `hyperdht` 6.36.0 — ห้ามเพิ่มถ้าไม่จำเป็นจริง ๆ
- ทำงานบน Termux/Android, Linux, macOS, Windows
- License: Apache-2.0
- ไม่ rewrite เป็น Go (ตัดสินใจแล้ว)

ลิงก์:

| รายการ | URL |
|---|---|
| Repo | https://github.com/dhammawatthumpra-coder/p2pgate |
| npm | https://www.npmjs.com/package/p2pgate |
| Release | https://github.com/dhammawatthumpra-coder/p2pgate/releases/tag/v1.6.3 |

---

## 2. สถานะปัจจุบัน

| รายการ | ค่า |
|---|---|
| Version | `1.6.3` (messaging patch, พร้อม publish) |
| npm `latest` | `1.6.2` — ยังไม่อัปเดตจนกว่า `npm publish` |
| Git branch | `main` |
| Commit | `__COMMIT__` |
| Tag | `v1.6.3` |
| GitHub Release | `v1.6.2` = Latest; `v1.6.3` ยังไม่สร้าง |
| Working tree | clean |
| Tests | `npm test` → **37 checks PASSED** (Windows + Termux) |
| src | 16 ไฟล์, `src/self-test.js` ~1,331 บรรทัด |

ตรวจสถานะเร็ว ๆ:

```powershell
cd D:\tunnel\p2pgate
git status --short
git log --oneline --decorate -3
npm test
npm view p2pgate version
```

---

## 3. v1.6.0 / v1.6.1 ทำอะไรไปแล้ว

### v1.6.3 (patch)

- ข้อความเริ่มของ `p2pgate client` บอกชัดว่า PIN/รหัสผ่านจะถูกถามเมื่อมี connection
- เพิ่ม log ก่อน prompt ว่าเซิร์ฟเวอร์ขอการยืนยันตัวตน
- lazy prompt คงเดิม (trusted/fast-path ไม่ถูกถาม)

### v1.6.2 (patch)

- ปรับข้อความ prompt เป็น `🔐 PIN (10 ตัว) หรือรหัสผ่าน (12 ตัวขึ้นไป):`
- ปรับข้อความแจ้ง credential ผิดรูปแบบให้เป็นกลาง (เลิกใช้คำว่า "รหัสผ่านสำรอง")
- ไม่กระทบ protocol/config/พฤติกรรม

### v1.6.1 (patch)

- client ส่ง `READY` ทันทีหลังได้ `CHALLENGE_REQUIRED` แล้วจึงถาม PIN/password
  → พิมพ์ช้าไม่ทำให้ stream ตายก่อนตอบ
- server รอ proof ด้วย `max(authTimeoutMs, preAuthTimeoutMs)`
- client retry slot เดิม 1 ครั้งเมื่อ stream ปิดกลาง handshake
- log `AUTH TIMEOUT ... stage=ready|proof`, ข้อความ `การเชื่อมต่อขาดระหว่างรอการยืนยันตัวตน (ลองใหม่ได้)`
- proof timeout ไม่ถูกนับเป็น auth failure (ไม่เพิ่ม lockout)
- `startClient({ credential })` รับฟังก์ชัน async ได้

### Zero-setup server

```sh
p2pgate server
```

ครั้งแรกจะ:

- สร้าง `~/.p2pgate/config.json`
- generate `masterSecret` (64 hex)
- generate connection password (24 ตัว Base32)
- เก็บเฉพาะ SCRAM verifier ใน `authPin.unattended`
- เริ่มทำงานทันที

ถ้าไม่ใช่ TTY (headless) จะเขียน `~/.p2pgate/quickstart.txt` สิทธิ์ `0600` แทนการพิมพ์

### Zero-setup client

```sh
p2pgate connect
p2pgate connect -s <masterSecret> -p <password>
```

- สร้าง `~/.p2pgate/client-key.json` อัตโนมัติ
- สร้าง `~/.p2pgate/client.json`
- เปิด listener `127.0.0.1:8022`
- เตือนเมื่อใช้ `-p` (shell history / process list)
- รองรับ `--password-stdin`, `--secret-stdin`, `P2PGATE_PASSWORD`, `P2PGATE_MASTER_SECRET`

### อื่น ๆ

- `authMode: password|registry`
- `p2pgate password reset`
- `p2pgate setup --easy`
- i18n: `P2PGATE_LANG=en|th`, `--lang`
- `p2pgate status` แสดง `โหมดยืนยันสิทธิ์`

---

## 4. ไฟล์สำคัญ

| ไฟล์ | หน้าที่ |
|---|---|
| `src/cli.js` | entry point, arg parsing, `server` auto-init, `connect`, `password reset`, `--lang`, help |
| `src/quickstart.js` | สร้าง config/password/quickstart credentials |
| `src/config-loader.js` | normalize `authMode` (default = password ถ้าไม่มี keys), validation |
| `src/server.js` | DHT listener, auth flow, `authMode=password` (รับ unregistered key), fastpath |
| `src/client.js` | client auth flow, log `TUNNEL established slot=... serverKey=...` |
| `src/auth.js` | SCRAM primitives ฝั่ง protocol |
| `src/crypto-utils.js` | HKDF, slot derivation, SCRAM verifier, `SESSION_PIN_ALPHABET` |
| `src/auth-guard.js` | lockout, revocation, PIN generation |
| `src/device-registry.js` | `allowedClientKeys` + `trusted_devices`, `fastpathAllowed` |
| `src/audit-log.js` | JSONL audit + forbidden-field filter + rotation |
| `src/control.js` | local control socket (`status`, `pin`, `revoke`, `unlock`) |
| `src/doctor.js` | health checks (รองรับ password mode) |
| `src/keygen.js` | client key + passphrase protection |
| `src/setup-wizard.js` | advanced setup + `--easy` + i18n |
| `src/i18n.js` | `P2PGATE_LANG` / `--lang` / `t(th, en)` |
| `src/self-test.js` | 37 checks รวม password mode, slow credential, stream-close retry |

Docs: `docs/specs/phase7-v1.6.0.md` (spec), `docs/releases/v1.6.1.md` (patch notes),
`docs/releases/v1.6.0.md` (release notes),
`TESTING.md` (คู่มือทดสอบภาษาไทย), `README.md` / `README.th.md`

---

## 5. คำสั่งที่ใช้บ่อย

```powershell
# dev
npm test                 # check + 37 self-test checks
npm run check            # syntax check ทุกไฟล์
npm run self-test

# ใช้งาน
p2pgate server
p2pgate connect
p2pgate connect -s <secret> -p <password> --port 8022
ssh -p 8022 localhost

# จัดการ
p2pgate devices list
p2pgate devices add <key> --mode trusted --expires 2026-12-31T23:59:59Z --comment "my-pc"
p2pgate devices remove <key>
p2pgate password reset
p2pgate status --json
p2pgate doctor --json
p2pgate revoke <key>
p2pgate unlock --list
```

---

## 6. Invariants — ห้ามทำพัง

1. **Password ไม่ถูกส่งเป็น plaintext** ผ่าน network/DHT — ส่งเฉพาะ SCRAM proof
   และเก็บเฉพาะ verifier (`saltHex`, `storedKeyHex`, `serverKeyHex`)
2. **`serverKey` ใน client log คือ DHT public key** ของ slot (`TUNNEL established
   slot=498525 serverKey=...`) ไม่ใช่ `masterSecret` และไม่ใช่ SCRAM `serverKeyHex`
   ผู้ใช้ใช้ค่านี้ยืนยันว่า "ต่อถูกเครื่อง" — **ตกลงกันแล้วว่าไม่ต้องเปลี่ยนชื่อ log**
   ค่านี้เปลี่ยนทุกชั่วโมงตาม slot
3. **config เก่าไม่ถูกสลับโหมด**: ถ้าไม่มี `authMode` และมี `allowedClientKeys`
   → ถือเป็น `registry` (รักษาพฤติกรรม v1.5)
4. **`authMode=password` + `verificationMode=key-only` = config error** (ห้ามรวมกัน)
5. **registry ว่างเริ่มได้เฉพาะ password mode**; registry mode ยังต้องมี key
6. **`trusted_devices` ต้องสิทธิ์ 0600** ไม่งั้น `permissionsOk=false` → fastpath ปิด
7. **tunnel bind `127.0.0.1` เท่านั้น**
8. **audit log ต้อง drop** ฟิลด์ `pin|password|passphrase|secret|seed|verifier|
   storedKey|serverKey|token|privateKey|key`
9. **ไม่เพิ่ม dependency ภายนอก** นอกจาก `hyperdht`
10. **`p2pgate server` ต้องรันก่อน** `p2pgate connect` (ไม่ใช่บั๊ก)

---

## 7. Config ที่ควรรู้

```json
{
  "mode": "server",
  "masterSecret": "<64 hex>",
  "authMode": "password",
  "verificationMode": "hybrid",
  "targetPort": 8022,
  "localPort": 8022,
  "allowedClientKeys": [],
  "trustedDevicesFile": "~/.p2pgate/trusted_devices",
  "authPin": {
    "enabled": true,
    "unattended": { "saltHex": "...", "storedKeyHex": "...", "serverKeyHex": "..." }
  },
  "auditLog": { "enabled": true, "path": "...", "maxBytes": 5242880 }
}
```

| ค่า | ความหมาย |
|---|---|
| `authMode: password` | รับ client key ที่ไม่รู้จักได้ถ้า password ถูก (default ของ zero-setup) |
| `authMode: registry` | ต้องอยู่ใน `allowedClientKeys`/`trusted_devices` |
| `verificationMode: hybrid` | trusted → fastpath, อื่น ๆ → challenge |
| `verificationMode: key-only` | เฉพาะ key, ไม่มี PIN |
| `verificationMode: two-step` | challenge ทุกครั้ง |

---

## 8. ข้อจำกัด / ยังไม่ได้ทดสอบ

| เรื่อง | สถานะ |
|---|---|
| GitHub Actions | **ปิด** เพราะบัญชีติด billing lock — ใช้ `npm test` local |
| Soak test 24 ชม. | ยังไม่ทำ |
| Multi-client พร้อมกัน | ยังไม่ stress |
| Wi-Fi ↔ 4G switching | ยังไม่ทดสอบ |
| NAT บางรูปแบบ | ยังไม่ครอบคลุม |
| Multi-port / multi-target | ไม่มี (1 instance = 1 target port) |
| UDP | ไม่รองรับ |
| TUN / subnet routing | ไม่รองรับ (Termux ทำไม่ได้ถ้าไม่ root) |
| i18n legacy commands | แปลไม่ครบ (setup/server/connect/help แปลแล้ว) |

---

## 9. งานถัดไปที่เป็นไปได้

เรียงตามความคุ้ม:

1. **Soak + multi-client** — รัน 24 ชม., หลาย client พร้อมกัน, เก็บ log
2. **Network switching** — ปิด/เปิด Wi-Fi, สลับ 4G, ดูว่า reconnect เองได้
3. **เปิด CI** — แก้ billing หรือย้ายไป CI อื่น (workflow มีอยู่แต่ disable)
4. **v1.7.0 `targets` (multi-port)** — `targets: { ssh: 22, web: 443 }`
   และ `connect --target web`
5. **แปล legacy CLI/doctor ให้ครบ en/th**
6. **เตรียม core สำหรับ p2phub** — `p2pgate enroll`, `p2pgate agent`,
   client config `serverPublicKey`, `connect --name` (ดูข้อ 10)

---

## 10. ความสัมพันธ์กับ `p2phub` (โปรเจกต์แยก)

มีโปรเจกต์ใหม่แยกออกไปแล้ว:

- Path: `D:\tunnel\p2phub` (git repo แยก, commit initial scaffold แล้ว)
- Spec: `D:\tunnel\p2phub\docs\spec.md`
- npm name: `p2phub` (ยังว่างบน npm ณ 2026-11-15)
- แนวคิด: optional control plane — inventory, directory, policy, enrollment,
  secret custody (ไม่ proxy data, hub คุยผ่าน DHT เอง)

สิ่งที่ **p2phub ต้องรอจาก core** (ทำเมื่อเริ่ม v1.7):

| ของที่ต้องเพิ่มใน p2pgate | ใช้ทำอะไร |
|---|---|
| `p2pgate enroll --hub --token` | ลงทะเบียนเครื่องกับ hub |
| `p2pgate agent --interval` | heartbeat จาก `status --json` |
| client config `serverPublicKey` | ต่อได้โดยไม่ต้องถือ `masterSecret` |
| `p2pgate connect --name` | resolve ชื่อผ่าน hub |
| `targets` | ให้ route enforcement ต่อพอร์ตได้ |

**อย่าเริ่มแก้อะไรใน p2pgate เพื่อ p2phub จนกว่าจะเริ่ม v1.7 อย่างเป็นทางการ**

---

## 11. Release checklist (รุ่นถัดไป)

```powershell
cd D:\tunnel\p2pgate

# 1. ตรวจ
npm test
git status --short

# 2. เลขรุ่น + docs
npm version 1.7.0 --no-git-tag-version --ignore-scripts
# แก้ CHANGELOG.md, README.md, README.th.md, docs/releases/v1.7.0.md,
# docs/specs/phaseX-v1.7.0.md, TESTING.md (จำนวน checks)

# 3. commit + tag + push
git add -A
git commit -m "feat(release): v1.7.0 <summary>"
git tag -a v1.7.0 -m "p2pgate v1.7.0"
git push origin main
git push origin v1.7.0

# 4. npm (ต้องมี OTP จากเจ้าของบัญชี)
npm publish

# 5. GitHub Release
gh release create v1.7.0 --draft --title "p2pgate v1.7.0" --notes-file docs/releases/v1.7.0.md
gh release edit v1.7.0 --draft=false --latest --notes-file docs/releases/v1.7.0.md

# 6. ตรวจ
npm view p2pgate version
npx --yes p2pgate@1.7.0 --version
```

หลัง publish ต้องทดสอบบน Termux ด้วย (ติดตั้งจริง + `npm test` ใน
`npm root -g/p2pgate`)

---

## 12. สภาพแวดล้อมที่ใช้ทดสอบ

**Windows (เครื่องหลัก)**

```text
D:\tunnel\p2pgate
Node v24.15.0
npm 11.17.0
client config: C:\Users\csuti\.p2pgate\client.json
```

**Termux (Redmi 14C)**

```text
ssh: watthumpra@100.76.100.90 -p 8022   (ผ่าน Tailscale)
key: %USERPROFILE%\.ssh\id_ed25519
known_hosts: $env:TEMP\p2pgate_known_hosts
node 24, p2pgate 1.6.1 ติดตั้งแบบ global
```

คำสั่งตรวจ Termux:

```powershell
ssh -p 8022 -o BatchMode=yes -o StrictHostKeyChecking=no `
  -o UserKnownHostsFile="$env:TEMP\p2pgate_known_hosts" `
  -i "$env:USERPROFILE\.ssh\id_ed25519" `
  watthumpra@100.76.100.90 'p2pgate --version; p2pgate status'
```

---

## 13. Gotchas ที่เคยเจอ

| อาการ | สาเหตุ/วิธีแก้ |
|---|---|
| `PEER_NOT_FOUND` | `p2pgate server` ไม่ได้รัน / secret ไม่ตรง / เวลาเครื่องต่างกัน > 1 ชม. / UDP ถูกบล็อก |
| `authentication failed: ไม่ได้รับข้อความท้าทาย...` แล้วรอบถัดไปต่อได้ | stream ตายระหว่างพิมพ์ (server restart หรือเกิน 120 วิ) — v1.6.1 retry ให้เองและ log `auth stream closed ... retrying once` |
| `ssh: Connection closed by 127.0.0.1` | tunnel ต่อ Server ไม่ได้ (มักเป็นข้อบน) |
| client ค้างโดยไม่ถาม password | ใช้ `p2pgate client` (advanced) ซึ่งไม่บังคับ credential — ต้องมี `-p` หรือ prompt ถ้าใช้ `connect` |
| trusted ไม่ fastpath | ยังไม่ `devices add --mode trusted`, หมดอายุ, หรือไฟล์สิทธิ์ไม่ใช่ 0600 |
| `-p` เตือนทุกครั้ง | ตั้งใจ — ใช้ prompt/`--password-stdin`/`P2PGATE_PASSWORD` แทน |
| headless server หา password ไม่เจอ | ดู `~/.p2pgate/quickstart.txt` (0600) แล้วลบหลังคัดลอก |
| Windows ไม่เตือนสิทธิ์ไฟล์ | Windows ไม่ตรวจ POSIX perms (พฤติกรรมที่รู้อยู่) |
| npm page แสดง README อังกฤษ | `readmeFilename` ใน metadata เป็น `README.th.md` แต่หน้าเว็บแสดง EN — ไม่ต้องแก้ |

---

## 14. สไตล์การทำงานที่ผู้ใช้ต้องการ

- ตอบเป็นภาษาไทย, ศัพท์เทคนิคเป็นอังกฤษได้
- ต้องการคำตอบที่ตรวจสอบได้จริง ไม่เดา — ทดสอบจริงก่อนบอกว่าเสร็จ
- dependency ภายนอกต้องน้อยที่สุด (ตอนนี้มี `hyperdht` ตัวเดียว)
- ไม่ rewrite เป็นภาษาใหม่
- ชอบทดสอบบนอุปกรณ์จริง (Termux) ไม่ใช่แค่ mock
- งาน release ต้องอัปเดต docs/CHANGELOG/release notes ให้ครบ
- ก่อน publish npm ต้องขอ OTP จากผู้ใช้

---

## 15. Checklist ก่อนเริ่มงานใน session ใหม่

```powershell
cd D:\tunnel\p2pgate
git status --short          # ต้องรู้ว่ามีไฟล์ค้างไหม
git log --oneline -3
npm test                    # ต้องได้ 37 checks (หรือมากกว่า)
npm view p2pgate version    # ต้องเป็น 1.6.1
```

ถ้าทุกอย่างตรงกับเอกสารนี้ แปลว่า handoff ครบ — เริ่มงานต่อได้เลย
