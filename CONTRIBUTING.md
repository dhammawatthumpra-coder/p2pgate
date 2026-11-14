# Contributing

ขอบคุณที่สนใจพัฒนา p2pgate โปรเจกต์นี้เน้นความเรียบง่าย
ความปลอดภัย และ dependency ภายนอกเพียงตัวเดียว (`hyperdht`)

## สิ่งที่ต้องมี

- Node.js 20 ขึ้นไป
- npm
- ระบบปฏิบัติการ: Linux, macOS, Windows หรือ Termux (Android)

## เริ่มต้น

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run self-test
```

ก่อนส่ง PR ต้องผ่านทั้ง `npm run check` และ `npm run self-test`

สำหรับการทดสอบกับ SSH จริงและเครือข่าย 4G ดู [`TESTING.md`](TESTING.md)

## หลักการเขียนโค้ด

1. **Zero external dependency**
   - ใช้ built-in modules ของ Node เท่านั้น
   - ห้ามเพิ่ม dependency ใหม่โดยไม่มีการอภิปรายและเหตุผลชัดเจน
2. **CommonJS**
   - ใช้ `require()` และ `module.exports`
   - ไม่ใช้ ESM ในรอบนี้
3. **ไม่แตะ protocol เดิมโดยไม่จำเป็น**
   - การเปลี่ยน handshake ต้องมี versioning และ backward compatibility
4. **ความปลอดภัยมาก่อนความสะดวก**
   - ห้าม log PIN, รหัสผ่าน, master secret, verifier หรือ private key
   - ไฟล์ที่อาจมี secret ต้องมีสิทธิ์ `0600`
   - control plane ต้องเป็น local-only
5. **ข้อความสำหรับผู้ใช้เป็นภาษาไทย**
   - ข้อความ CLI, error และ README ใช้ภาษาไทย
   - code identifier และ protocol field ใช้ภาษาอังกฤษ
6. **การทดสอบ**
   - เพิ่ม self-test เมื่อเพิ่มพฤติกรรมใหม่
   - รักษา test เดิมไม่ให้พัง

## รูปแบบ Commit

แนะนำ Conventional Commits:

```text
feat(control): add pin command
fix(auth): reject expired trusted devices
docs(readme): update v1.4 setup steps
test(control): cover revoke and unlock
```

## ก่อนเปิด Pull Request

- [ ] `npm ci --ignore-scripts --no-audit --no-fund`
- [ ] `npm run check`
- [ ] `npm run self-test`
- [ ] ไม่มี `config.json`, `client-key.json`, `trusted_devices`,
      `lockout-state.json`, log หรือไฟล์ที่มี secret ถูก commit
- [ ] อัปเดต README/CHANGELOG เมื่อเปลี่ยนพฤติกรรมที่ผู้ใช้เห็น
- [ ] เพิ่มหรือปรับ self-test
- [ ] อธิบายผลกระทบด้านความปลอดภัย (ถ้ามี)

## การรายงานช่องโหว่

อย่าเปิด public issue สำหรับช่องโหว่ที่ยังไม่ถูกแก้ไข
ดู [`SECURITY.md`](SECURITY.md)

## สิทธิ์การใช้งาน

การมีส่วนร่วมในโปรเจกต์นี้ถือว่ายอมรับเงื่อนไขสิทธิ์การใช้งาน
ของ repository นี้ (หากยังไม่มีไฟล์ `LICENSE` กรุณาสอบถามผู้ดูแลก่อนนำไปใช้ต่อ)
