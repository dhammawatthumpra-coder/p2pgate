# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 1.8.x | ✅ |
| 1.7.x | ⚠️ อัปเกรดเป็น 1.8.x |
| 1.6.x | ⚠️ อัปเกรดเป็น 1.8.x |
| 1.5.x | ⚠️ อัปเกรดเป็น 1.8.x |
| ต่ำกว่า 1.5 | ❌ |

## การรายงานช่องโหว่

**กรุณาอย่าเปิด public issue สำหรับช่องโหว่ที่ยังไม่ถูกแก้ไข**

ช่องทางที่แนะนำ:

1. เปิด **private security advisory** ใน GitHub repository นี้
2. ระบุ:
   - เวอร์ชันและระบบปฏิบัติการ
   - ผลกระทบที่คาดว่าจะเกิด
   - ขั้นตอนทำซ้ำ (ถ้ามี)
   - หลักฐาน/log ที่ตัดข้อมูลลับออกแล้ว
3. อย่าส่ง:
   - `masterSecret`
   - PIN หรือรหัสผ่านจริง
   - `client-key.json`
   - SCRAM verifier จาก `config.json`
   - ข้อมูลส่วนตัวของผู้อื่น

ทีมผู้ดูแลจะพยายามตอบกลับภายใน 7 วัน และจะแจ้งความคืบหน้าเมื่อมี
การยืนยันหรือแก้ไข

## ขอบเขตที่สนใจเป็นพิเศษ

- การข้ามการยืนยันตัวตน (authentication bypass)
- การหลุดของ PIN หรือ secret ผ่าน log, ไฟล์, process list หรือ control socket
- ช่องทางที่ทำให้ trusted device หรือ key-only ถูกใช้เกินสิทธิ์
- ปัญหา path traversal หรือ symlink ใน `trusted_devices`
- การหลุดของ tunnel ไปยังปลายทางที่ไม่ใช่ `127.0.0.1`
- ช่องโหว่ใน control socket หรือ named pipe
- การโจมตีแบบ replay หรือ downgrade ต่อ handshake
- ช่องโหว่ใน dependency `hyperdht`

## Known Limitations

สิ่งเหล่านี้ทราบอยู่แล้วและไม่ถือเป็นช่องโหว่ใหม่:

- `key-only` ไม่มี PIN เป็นด่านที่สอง — ความปลอดภัยขึ้นกับ client key
- `trusted` device ข้ามการถาม PIN ตามการออกแบบ
- `authMode: password` รับ client key ที่ไม่รู้จักได้หาก password ถูก
  จึงอ่อนกว่า `registry`; ใช้ password ยาวและพิจารณา trusted device
- Windows ไม่ได้ตรวจ POSIX permission/ACL ของไฟล์ config และ trusted devices
  และ Node core ไม่ได้ตั้ง custom DACL ให้ named pipe; ใช้ control token เสริม
- audit log เป็นไฟล์ local และไม่ได้ทำ tamper-evident logging
- `revoke` ตัดที่ระดับ stream ของ p2pgate
  ไม่ได้สั่งปิด SSH session ระดับ OS โดยตรง
- client key แบบเข้ารหัสยังเปิดเผย `publicKey` และ metadata ในไฟล์
- SOCKS5 รองรับเฉพาะ TCP + IPv4 (v1.8) และต้องเปิด allowlist เอง

## Incident response (สงสัยว่า secret รั่ว)

ทำตามลำดับนี้บนเครื่อง Server:

```sh
# 1) ตัดสิทธิ์คีย์ที่น่าสงสัยทันที (ตัด session ที่เปิดอยู่ด้วย)
p2pgate revoke <clientKey>

# 2) เปลี่ยน connection password (มีผลหลังรีสตาร์ต)
p2pgate password reset

# 3) หมุน DHT identity และไม่เก็บค่าเก่าบนดิสก์
p2pgate master reset --yes --no-backup

# 4) รีสตาร์ต Server
#    Ctrl+C แล้ว p2pgate server

# 5) อัปเดต Client ทุกเครื่อง
#    p2pgate connect -s <masterSecret ใหม่> -p <password ใหม่>
```

หลังยืนยันว่าใช้งานได้:

```sh
p2pgate devices list        # ตรวจว่ามีแต่เครื่องที่ไว้ใจ
p2pgate status
rm -f ~/.p2pgate/quickstart.txt
rm -f ~/.p2pgate/config.json.bak-*   # ถ้ามีจากการหมุนครั้งก่อน
```

หลักการ:

- `master reset` เปลี่ยน identity แต่ **ไม่** ตัดสิทธิ์คีย์และไม่เปลี่ยน password
- `password reset` เปลี่ยนปัจจัยที่ใช้ยืนยัน แต่ไม่เปลี่ยน identity
- เคสเครื่องถูกยึด (อ่าน config ได้) ต้องทำทั้งสามอย่าง: revoke + password + master
- เก็บ audit log ไว้ตรวจย้อนหลัง (`master.reset` ถูกบันทึกพร้อม fingerprint)

## Safe Harbor

การทดสอบที่ทำบนเครื่องของคุณเองหรือเครื่องที่ได้รับอนุญาตเท่านั้น
จะได้รับการพิจารณาในเชิงบวก หากเป็นการรายงานช่องโหว่โดยสุจริต
และไม่เปิดเผยข้อมูลของผู้อื่น
