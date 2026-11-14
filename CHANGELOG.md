# Changelog

รูปแบบอ้างอิง [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
และใช้ [Semantic Versioning](https://semver.org/)

## [Unreleased]

- รอผลทดสอบ long-running และการสลับเครือข่าย
- แก้ self-test ให้ทำงานได้ทั้ง terminal แบบ interactive และ non-interactive

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
- Self-test เพิ่ม coverage สำหรับ control plane, revoke/unlock, doctor
  และ trusted expiry

### Changed

- Server แสดงจำนวนอุปกรณ์จาก registry แทนจำนวนคีย์ใน config
- `server.close()` ปิดและลบ control socket
- `npm run check` ตรวจ `src/control.js` และ `src/doctor.js`
- README อัปเดต v1.4 และเพิ่มหัวข้อ control plane / doctor

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
