# Changelog

รูปแบบอ้างอิง [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
และใช้ [Semantic Versioning](https://semver.org/)

## [Unreleased]

- รอผลทดสอบ long-running และการสลับเครือข่าย

## [1.8.3] - 2026-11-15

### Added

- `p2pgate master show [--reveal] [--json]` — แสดง fingerprint หรือค่าเต็มของ masterSecret
- `p2pgate master reset [--yes] [--dry-run] [--json]` — หมุน masterSecret
  พร้อมสำรอง config เดิม (`config.json.bak-<timestamp>` โหมด 0600)
- audit event `master.reset` (เก็บเฉพาะ fingerprint ไม่เก็บค่า secret)
- self-test: หมุน masterSecret แล้ว backup ถูกสร้างและ field อื่นยังอยู่

### Changed

- help เป็น v1.8 และเพิ่มหัวข้อ master commands
- README/README.th เพิ่มหัวข้อ 9.4 การหมุน masterSecret

## [1.8.2] - 2026-11-15

### Fixed

- `saveConfig()` เขียน `targets.<name>.allow: null` และ `socks.allow: []`
  ลงไฟล์ แต่ loader ไม่ยอมรับค่าที่ตัวเองเขียน → เปิด config เดิมไม่ได้
  (`targets.default.allow must be a non-empty array...`)
- รับ `allow: null` เป็น "ไม่จำกัด" และยอมให้ `socks.allow: []` เมื่อ `socks.enabled: false`
- config โหมด client ไม่เก็บ `targets`/`defaultTarget`/`socks` อีกต่อไป
  (client ไม่ได้ใช้ — เดิมทำให้ไฟล์ client พังหลัง save)
- เพิ่ม self-test กันการถอยหลัง: config ต้องผ่าน save → load round-trip

## [1.8.1] - 2026-11-15

### Fixed

- README/README.th: โครงสร้างโปรเจกต์ (`## 21) Project structure`) แสดงไฟล์ไม่ครบ
  และข้ามรุ่น — อัปเดตให้ตรงกับ repo จริง
  - release notes ครบ `v1.4.0` → `v1.8.1`
  - specs เพิ่ม `phase8-targets.md`, `phase9-socks5.md`
  - `docs/HANDOFF.md`, `docs/SERVICE.md`
  - `scripts/systemd`, `scripts/termux/service`, `scripts/windows`
  - `src/allowlist.js`, `src/socks.js`

## [1.8.0] - 2026-11-15

### Added

- SOCKS5 gateway ฝั่ง client: `p2pgate connect --socks5 <port>`
- `socks` config ฝั่ง Server พร้อม allowlist แบบ IPv4/CIDR + port
- Server resolve hostname เองและตรวจ **ทุก IP** ที่ resolve ได้กับ allowlist
- Client เก็บ `socks5Port` ไว้ใช้รอบถัดไป
- log `SOCKS ALLOW` / `SOCKS DENIED` และ `target=socks` ใน `AUTH OK`/`FORWARD`

### Security

- SOCKS ปิดโดยค่าเริ่มต้น และต้องมี allow อย่างน้อย 1 รายการ
- ปฏิเสธ `UDP ASSOCIATE`, `BIND`, และปลายทาง IPv6 (v1.8)
- ส่ง SOCKS success หลัง auth สำเร็จเท่านั้น → ปลายทางที่ถูกปฏิเสธไม่ดูเป็น open proxy
- ใช้ `--socks5` ร่วมกับ `--target` ไม่ได้

### Changed

- README/README.th เปลี่ยนหัวเป็น v1.8 พร้อมส่วน SOCKS5
- เพิ่ม `src/socks.js`, `src/allowlist.js` ใน `npm run check`

## [1.7.0] - 2026-11-15

### Added

- `targets` config: Server expose หลาย service พร้อมกัน
  `{ "web": { "host": "127.0.0.1", "port": 8080 } }`
- `defaultTarget` สำหรับ client รุ่นเก่าที่ไม่ส่ง target
- `p2pgate connect --target <name>` / `p2pgate client --target <name>`
- per-target `allow` list (คีย์ client หรือ `"*"`)
- Client log `TARGET <name> -> 127.0.0.1:<port>` และ `target=` ใน `TUNNEL established`
- `status --json` เพิ่ม `targets` และ `defaultTarget`

### Changed

- Server banner แสดงรายการ targets + default target
- `server --port` override ค่า default target เฉพาะรอบ
- `FORWARD` log ระบุ `target=<name>`

### Security

- Client ส่งได้เฉพาะ **ชื่อ target** — ไม่มีทางส่ง `host:port` ดิบ (กัน SSRF)
- target ต้องเป็น `127.0.0.1` เท่านั้น
- target ที่ไม่รู้จัก/ไม่อยู่ใน allowlist ถูกปฏิเสธโดยไม่แตะ service ปลายทาง
  และไม่นับเป็น auth failure (ไม่เพิ่ม lockout)

## [1.6.4] - 2026-11-15

### Added

- `p2pgate server --port <targetPort>` และ `--target-port <targetPort>`
  สำหรับ override พอร์ตปลายทางเฉพาะรอบที่รัน (ไม่บันทึกลง config)
- Error code `PORT_INVALID` พร้อมข้อความแยกจาก config error

### Changed

- Help แสดงรูปแบบ `p2pgate server [--config <path>] [--port <targetPort>]`
- README/README.th เพิ่มแถวคำสั่ง `server --port`
- Roadmap: `targets` (multi-port) อยู่ในแผน v1.7.0

## [1.6.3] - 2026-11-15

### Changed

- ข้อความตอนเริ่ม `p2pgate client` ชัดขึ้นว่า PIN/รหัสผ่านจะถูกถาม
  **เมื่อมี connection เข้ามา** ไม่ใช่ตอนเริ่มโปรแกรม
- เพิ่ม log ก่อนขึ้น prompt: `เซิร์ฟเวอร์ขอการยืนยันตัวตน: กรอก PIN (10 ตัว) หรือรหัสผ่าน (12 ตัวขึ้นไป)`
  เพื่อให้รู้ว่าทำไม prompt โผล่มาหลัง `ssh`
- ข้อความโหมด `--pin-stdin` ระบุว่าเป็นการอ่านเมื่อถูกขอ ไม่ใช่ตอนเริ่ม

### Note

พฤติกรรม lazy prompt คงเดิมโดยตั้งใจ — trusted/fast-path ต้องไม่ถูกถามอะไรเลย

## [1.6.2] - 2026-11-15

### Changed

- ปรับข้อความ prompt ของ client ให้ตรงกับทุกโหมด:
  `🔐 PIN (10 ตัว) หรือรหัสผ่าน (12 ตัวขึ้นไป):`
  (เดิมใช้คำว่า "รหัสผ่านสำรอง" ซึ่งทำให้สับสนใน password mode)
- ปรับข้อความแจ้งเมื่อ credential ผิดรูปแบบให้เป็นกลาง:
  `ต้องเป็น PIN 10 ตัวอักษร หรือรหัสผ่านอย่างน้อย 12 ตัวอักษร`
- Help และ error message เลิกใช้คำว่า "รหัสผ่านสำรอง" เมื่อหมายถึงรหัสผ่านที่ใช้จริง

## [1.6.1] - 2026-11-15

### Fixed

- Client ส่ง `READY` ทันทีหลังได้ `CHALLENGE_REQUIRED` แล้วจึงถาม PIN/password
  ทำให้การพิมพ์ช้าไม่ชนกับ timeout ของ transport อีก
- Server รอ proof ด้วย `max(authTimeoutMs, preAuthTimeoutMs)` เพราะผู้ใช้ต้องพิมพ์
  รหัสหลังได้รับ challenge
- ถ้า stream ปิดระหว่างยืนยันตัวตน Client จะ retry slot เดิมหนึ่งครั้งอัตโนมัติ
  และรายงานว่า `การเชื่อมต่อขาดระหว่างรอการยืนยันตัวตน (ลองใหม่ได้)`
  แทน `authentication failed`
- Server log `AUTH TIMEOUT ... stage=ready|proof` เพื่อวินิจฉัยสาเหตุ
- Timeout ตอนรอ proof ไม่ถูกนับเป็น auth failure (ไม่ทำให้ lockout เพิ่มขึ้น)

### Added

- `startClient({ credential })` รองรับฟังก์ชัน async ที่คืนค่า credential
  (ใช้กับ embedding และ self-test)
- Self-test เพิ่ม 2 เคส: พิมพ์รหัสช้า และ retry เมื่อ stream ปิดกลาง handshake

## [1.6.0] - 2026-11-15

### Added

- Zero-setup `p2pgate server`: สร้าง config, masterSecret และ connection password อัตโนมัติ
- `p2pgate connect` พร้อม `-s/-p` สำหรับเชื่อมต่อแบบบรรทัดเดียว
- `authMode: password|registry` (password เป็นค่าเริ่มต้นของ zero-setup)
- `p2pgate password reset`
- `P2PGATE_LANG=en|th` และ `--lang`
- `quickstart.txt` สำหรับ headless first run (สิทธิ์ `0600`)

### Changed

- `p2pgate setup` เป็น advanced configuration
- Client สร้าง key และ config อัตโนมัติผ่าน `connect`
- `p2pgate server` เริ่มได้แม้ registry ว่างใน password mode
- README/README.th อัปเดต zero-setup flow

### Security

- Connection password 24 ตัวอักษร เก็บเฉพาะ SCRAM verifier
- เตือนเมื่อใช้ `-p` บน command line
- Existing registry configs ไม่ถูกสลับเป็น password mode อัตโนมัติ

## [1.5.0] - 2026-11-15

### Added

- Audit log แบบ JSONL (`~/.p2pgate/audit.log`) พร้อม rotation
- Client key ที่ป้องกันด้วย passphrase (scrypt + AES-256-GCM)
- `p2pgate status --json` และ `p2pgate doctor --json`
- Control token ต่อเซิร์ฟเวอร์ (`~/.p2pgate/control.token`)
- POSIX control socket owner/permission check
- แสดง lockout/revocation state ใน `p2pgate devices list`
- Tests สำหรับ audit, encrypted key, control token, doctor JSON

### Changed

- Control protocol เป็น version `2` และทุก request ต้องมี token
- `config.json` รองรับ `auditLog`
- `doctor` ตรวจ audit log และสถานะ encryption ของ client key
- README/TESTING/docs อัปเดต v1.5

### Security

- Audit log กรอง PIN/password/passphrase/seed/verifier/token
- Control token เปรียบเทียบด้วย SHA-256 + `timingSafeEqual`
- Windows ใช้ token เสริม named-pipe DACL (Node core ตั้ง DACL เองไม่ได้)
- Client key passphrase ไม่รับผ่าน command-line argument

## [1.4.1] - 2026-11-14

### Changed

- README: เพิ่มคำสั่งติดตั้ง `npm install -g p2pgate`, badges และลิงก์ npm
- ปรับเอกสาร release/install ให้ตรงกับแพ็กเกจที่เผยแพร่แล้ว

## [1.4.0] - 2026-11-14

### Added

- Local control socket สำหรับเซิร์ฟเวอร์ที่กำลังรันอยู่
  - POSIX: `~/.p2pgate/control.sock` โหมด `0600`
  - Windows: named pipe
  - newline-delimited JSON, version `1`, request สูงสุด 4096 bytes
- คำสั่ง `p2pgate status`, `p2pgate pin`, `p2pgate revoke <key>`
- `p2pgate doctor` ตรวจสุขภาพการติดตั้งเป็นภาษาไทยด้วย ✅ / ⚠️ / ❌
- `AuthGuard.revoke()` สำหรับเพิกถอนคีย์ถาวรและตัด active tunnel
- บังคับ `--expires` หรือ `--permanent` เมื่อเพิ่ม trusted device ผ่าน CLI
- `TESTING.md` คู่มือ manual acceptance test
- English README (`README.md`) และ Thai translation (`README.th.md`)
- npm package `p2pgate@1.4.0`
- Self-test เพิ่ม coverage สำหรับ control plane, revoke/unlock, doctor
  และ trusted expiry

### Changed

- Server แสดงจำนวนอุปกรณ์จาก registry แทนจำนวนคีย์ใน config
- `server.close()` ปิดและลบ control socket
- `npm run check` ตรวจ `src/control.js` และ `src/doctor.js`
- README อัปเดต v1.4 และเพิ่มหัวข้อ control plane / doctor
- แก้ self-test ให้ทำงานได้ทั้ง terminal แบบ interactive และ non-interactive
- จัดระเบียบ spec ไว้ใน `docs/specs/` และแปลง Phase 4 จาก `.docx` เป็น Markdown
- แก้ `bin` path และคำอธิบายแพ็กเกจให้พร้อมสำหรับ npm

### Security

- PIN ถูกอ่านจากหน่วยความจำและส่งผ่าน local socket เท่านั้น
- `revoke` ปิด stream ที่ใช้งานอยู่ทันทีและบันทึกการระงับถาวร
- control socket ถูกสร้างด้วย umask `0177` และ `chmod 0600` บน POSIX
- `doctor` ไม่พิมพ์ master secret, PIN หรือ verifier

## [1.3.0]

### Added

- `verificationMode`: `hybrid`, `key-only`, `two-step`
- Dual-source device registry: `allowedClientKeys` + `trusted_devices`
- `trusted` / `scram` profiles, `expires=`, labels และ comments
- POSIX permission check และ live reload ของ `trusted_devices`
- Status frames v3: `DECLINED`, `FASTPATH_READY`, `CHALLENGE_REQUIRED`, `READY`
- Client deferred input: อ่าน PIN เฉพาะเมื่อต้อง two-step
- CLI: `devices list`, `devices add`, `devices remove`
- Setup wizard เลือก verification mode

### Changed

- Client เชื่อมต่อก่อนแล้วรอสถานะจาก Server
- `--pin-stdin` ไม่บล็อก fast-path/key-only
- README และ self-test อัปเดตสำหรับ v1.3

## [1.2.0]

### Added

- Mutual SCRAM verification พร้อม server signature
- Session PIN 10 ตัวอักษร Base32
- Async `crypto.scrypt` และ SCRAM verifier storage
- Progressive lockout: 3/15 นาที, 6/6 ชั่วโมง, 10/ถาวร
- `p2pgate unlock` แบบ live
- Serialized PIN refresh

### Changed

- แทนที่ HMAC challenge-response แบบเดิมด้วย SCRAM
- README และ self-test อัปเดตสำหรับ v1.2

## [1.1.0]

### Added

- Session PIN และ Unattended Password
- Challenge-response ก่อน pipe ไปยัง target
- Telegram alerts สำหรับความพยายามเชื่อมต่อที่ไม่ได้รับอนุญาต
- Lockout 3 ครั้ง / 15 นาที
- Hidden input และ `P2PGATE_PIN`

## [1.0.0]

### Added

- อุโมงค์ TCP แบบ P2P ผ่าน HyperDHT
- Hourly rolling server keys จาก `masterSecret`
- Protocol-level `allowedClientKeys` firewall
- Localhost-only binding
- CLI และ interactive setup wizard
- Termux:Boot script
- Self-test ชุดแรก
