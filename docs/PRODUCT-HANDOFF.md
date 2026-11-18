# p2pgate — Product Handoff (for a new agent)

เอกสารนี้เขียนให้ **เอเจนตัวใหม่** อ่านแล้วเข้าใจผลิตภัณฑ์ได้ใน 15 นาที
โดยไม่ต้องไล่ประวัติแชท และใช้เป็นจุดตั้งต้นสำหรับ "คิด product ใหม่" บนฐานของ p2pgate

- อัปเดตล่าสุด: 2026-11-18
- เวอร์ชัน: **1.13.2** (npm `latest` + GitHub Release)
- เจ้าของ: dhammawatthumpra-coder
- เอกสารเทคนิคคู่กัน: [`HANDOFF.md`](HANDOFF.md) (สถานะ/invariants/รีลีส) และ [`SOAK.md`](SOAK.md) (ผลทดสอบระยะยาว)

---

## 1) ผลิตภัณฑ์คืออะไร (และไม่ใช่อะไร)

**คือ:** อุโมงค์ TCP/UDP แบบ P2P สำหรับเข้าถึง service บน loopback (หลัก ๆ คือ SSH)
ของเครื่องที่อยู่หลัง CGNAT/ไฟร์วอลล์ โดยไม่ต้องเปิด inbound port
ทำงานบน HyperDHT (UDP + เข้ารหัส + hole punching) พร้อม SCRAM mutual auth

**ไม่ใช่:**
- ไม่ใช่ VPN / ไม่มี IP layer (ไม่มี TUN, ไม่มี subnet routing, ไม่มี MagicDNS)
- ไม่ได้ให้ "เครื่องทุกเครื่องอยู่ใน LAN เดียวกัน" — เข้าถึงเป็นราย service/พอร์ต
- ไม่มี public ingress (ไม่มี edge แบบ ngrok) และไม่มี coordination server ที่ต้องมีตลอด

จุดขายที่ defences ได้จริง: **ไม่มี public endpoint + ไม่ต้องมี control server + dependency เดียว + รันบน Termux ได้**

---

## 2) สถานะปัจจุบัน

| รายการ | ค่า |
|---|---|
| Version | 1.13.2 |
| npm | `p2pgate@1.13.2` (ผ่าน validation แล้ว) |
| Tests | `npm test` → **82 checks** (รวม fast-path matrix) (Windows + Termux) |
| Dependency | `hyperdht@6.36.0` เท่านั้น (transitive 58 แพ็กเกจ) |
| Node | ≥ 20 (ทดสอบ Node 24) |
| Platforms | Termux/Android, Linux, macOS, Windows |
| Socket.dev | 84 (Supply Chain) / Vulnerability 100 / Quality 100 / Maintenance 96 / License 100 |
| CI | **ปิด** — GitHub Actions ติด billing lock |
| License | Apache-2.0 |

---

## 3) ความสามารถที่มีจริง (และความสุกของมัน)

| ความสามารถ | สถานะ | หมายเหตุ |
|---|---|---|
| Zero-setup server/client | แข็ง | `p2pgate server` สร้าง config/password เอง |
| SCRAM mutual auth + password mode | แข็ง | เก็บเฉพาะ verifier, ไม่ส่ง password |
| Trusted devices (fast path) + expiry | แข็ง | ต้องมี `--expires` หรือ `--permanent` |
| Multi-target (`targets` + `--target`) | แข็ง | client ส่งได้แค่ชื่อ target |
| SOCKS5 gateway + IP/CIDR allowlist | แข็ง | TCP CONNECT, IPv4 เท่านั้น |
| UDP forwarding (`udpTargets`) | ใช้งานได้ | cap 1200 B, session ต่อ endpoint, idle 60 s |
| mux (`--mux`) | แข็ง (soak 4 ชม. × 2) | 128 channels/carrier; fast path ใช้ได้ตั้งแต่ 1.13.0 |
| mux default สำหรับ `--socks5` | แข็ง | 1.13.1; `--no-mux` ถอยกลับได้ |
| Control plane (status/pin/revoke) | แข็ง | local socket + per-server token |
| Audit log (JSONL) | แข็ง | ไม่บันทึก secret |
| doctor / config validate | แข็ง | ใช้ใน automated check ได้ |
| ping / traffic counters / status --watch | แข็ง | ping วัด connect+auth จริง |

---

## 4) สถาปัตยกรรมย่อ (อ่านโค้ดที่ไหน)

```
client (127.0.0.1 listener)
  └─ HyperDHT stream (slot ต่อชั่วโมง จาก masterSecret)
       └─ auth: DECLINED | FASTPATH_READY(+mux) | CHALLENGE_REQUIRED → SCRAM
            └─ mux carrier (ถ้าเปิด) หรือ stream ต่อ connection
                 └─ server: target ที่ประกาศไว้ (127.0.0.1 เท่านั้น) / SOCKS / UDP
```

| ไฟล์ | บทบาท |
|---|---|
| `src/server.js` | DHT listener, auth, fastpath+peek, mux session, forward, UDP, caps |
| `src/client.js` | listener, auth client, mux carrier, SOCKS, UDP, pump |
| `src/auth.js` | control line, `readControlLine`, `peekControlLine` |
| `src/mux.js` | framing, `MuxCarrier`, `MuxChannel`, flow control |
| `src/config-loader.js` | normalize config (รวม `mux`, `muxPeekMs`) |
| `src/cli.js` | ทุกคำสั่ง, help, i18n |
| `src/self-test.js` | 82 checks (เป็น regression suite จริง) |
| `scripts/soak/` | ชุดทดสอบระยะยาว (termux/windows/runner/watchdog/report) |

---

## 5) Invariants — ห้ามทำพังถ้าจะต่อยอด

1. password ไม่ถูกส่ง plaintext (SCRAM proof เท่านั้น; เก็บแค่ verifier)
2. tunnel bind `127.0.0.1` เท่านั้น
3. client ส่งได้เฉพาะ **ชื่อ target** หรือ SOCKS destination — ไม่มี `host:port` ดิบ
4. SOCKS ตรวจ **ทุก IP ที่ resolve ได้** กับ allowlist (กัน rebinding)
5. `authMode=password` + `verificationMode=key-only` = config error
6. `trusted_devices` ต้อง 0600 ไม่งั้น fast path ปิด
7. audit log ต้อง drop ฟิลด์ `pin|password|passphrase|secret|seed|verifier|storedKey|serverKey|token|privateKey|key`
8. dependency ภายนอกต้องน้อยที่สุด (ปัจจุบัน 1) — เพิ่มต้องมีการตัดสินใจและจดเหตุผล
9. **ห้ามปิด connection ด้วย `destroy()` ก่อน flush** — ต้อง `end()`/FIN (เคสจริง: ไฟล์ขาดท้าย)
10. **ทุกทิศทางต้องมี backpressure** (pause/resume + `drain`)
11. **fast-path peek ต้อง forward `raw`** (ทุกไบต์ที่อ่าน) เมื่อไม่ใช่ mux upgrade — เคยทำ SSH พังใน 1.13.0/1.13.1
12. `docs:check` ผูกกับ `npm test` — README/CHANGELOG/release notes ต้องตรง version

---

## 6) หลักฐานที่มี (ใช้ได้ในเอกสารขาย/ตัดสินใจ)

**Soak (ดู `SOAK.md` §1.5–1.7)**
- password mode, 4 ชม.: 79/79 ผ่าน, carrier เดียว, RSS นิ่ง
- trusted device (fast path), 4 ชม.: 80/80 ผ่าน, `fastpath=1`, RSS ลดลง
- โอนไฟล์: 8/32 MiB upload+echo, 16 MiB download, 8 channels พร้อมกัน × 4 MiB — SHA-256 ตรง
- outage จริง (Windows network flapping 47 นาที): client ฟื้นเองด้วยการสร้าง carrier ใหม่

**SOCKS5 10 requests พร้อมกัน (1 MiB each)**
- mux default: **10/10 สำเร็จ**
- `--no-mux`: **3/10** (7 โดน `busy` เพราะ auth guard 1 ครั้ง/key)

**ข้อจำกัดที่ยังไม่มีข้อมูล:** multi-client พร้อมกัน, Wi-Fi↔4G switching, soak 24 ชม.

---

## 7) กลุ่มผู้ใช้ที่เหมาะ / ไม่เหมาะ (ตรงไปตรงมา)

**เหมาะ**
- คนที่ต้องการ SSH เข้าเครื่องตัวเอง (มือถือ/PC ที่บ้าน) โดยไม่เปิด port
- คนที่รันบน Termux/Android และไม่อยากจ่าย cloud
- คนที่อยากได้ tunnel ที่ไม่ต้องพึ่ง third-party edge

**ไม่เหมาะ (ตอนนี้)**
- ทีมที่ต้องการ SSO/audit ระดับองค์กร (ยังไม่มี identity plane)
- คนที่ต้องการ "เครื่องทุกเครื่องเหมือนอยู่ LAN เดียวกัน" (ต้อง TUN — คนละโปรเจกต์)
- ผู้ใช้ทั่วไปที่คาดหวัง UX แบบแอปเดียวจบ (ยังเป็น CLI)

---

## 8) ทิศทาง product ที่เป็นไปได้ (พร้อมการประเมิน)

> อย่าเพิ่งเลือก — เอกสารนี้ให้ทางเลือกและต้นทุน ไม่ได้ฟันธง

### A. Managed fleet (control plane) — "p2phub"
เพิ่ม enroll / directory (ชื่อ → public key) / policy / audit รวมศูนย์ โดย **data ยังเป็น p2pgate ต่อเครื่อง**
- ต้นทุน: 1–2 สัปดาห์ (MVP), hub เป็น 1 service + SQLite
- ได้: "ดูแล 20 เครื่องจากที่เดียว"
- เสี่ยง: hub ถูก compromise = ยึด fleet ได้; ต้องออกแบบ revocation ให้ชัด
- ต้องเปลี่ยน: auth model (hub-issued signed ticket) — กระทบ invariant ข้อ 1–2 เดิม
- มีสเปกพักไว้แล้วที่ `D:\tunnel\p2phub\docs\spec.md`

### B. Any-to-any service mesh — "Teleport-lite"
ทุกเครื่องมี agent, dial service ของกันได้ตามสิทธิ์จาก hub (ยังเป็น service-based ไม่มี IP)
- ต้นทุน: 3–6 สัปดาห์ + งาน policy/revocation
- ได้ประโยชน์สูงสุดเทียบแรง และใกล้ use case "ทีมเข้าถึง service ทุกเครื่อง"
- ต้องแก้: identity ต่อเครื่อง, NAT symmetric (ต้องมี relay บางกรณี), revocation window

### C. IP mesh / TUN — "Tailscale ย่อ"
- **ไม่แนะนำให้ต่อยอดใน p2pgate**: ต้อง TUN/userspace stack, ปลดข้อจำกัด Termux/no-root
  และเพิ่มพื้นผิว bug (routing loop, DNS leak, MTU) คนละระดับ
- ถ้าจะทำ ควรเป็นโปรเจกต์ใหม่ และต้องมี CI + fuzzing + security review ก่อน

### D. อื่น ๆ ที่ยังไม่ได้ประเมินลึก
- Bastion สำหรับทีมเล็ก (SSH + audit + policy, ขายเป็น self-host)
- Device/IoT gateway (เครื่องหลัง CGNAT จำนวนมาก, อัปเดต/รีโมต)
- p2pgate เป็น library/embedded (ให้ผลิตภัณฑ์อื่นฝัง tunnel ไปใช้)

---

## 9) คำถามที่ต้องตอบก่อนเริ่ม product ใหม่

1. เป้าหมายคือ "เข้าถึง service" หรือ "เครื่องอยู่ใน LAN เดียวกัน"? (ข้อหลัง = TUN = คนละเกม)
2. ผู้ใช้คือตัวเอง / ทีมเล็ก / ลูกค้า? (กำหนดว่าต้องมี SSO/audit แค่ไหน)
3. ยอมให้ hub เป็นจุดศูนย์กลางหรือไม่ และ hub ล่มแล้วต้องใช้ต่อได้ไหม?
4. ต้องเข้าอุปกรณ์ที่ลง agent ไม่ได้ (router/printer) ไหม? (ถ้าใช่ ต้อง TUN/subnet)
5. รับ relay ที่เห็น metadata ได้ไหม?
6. จะรักษา invariant "ไม่มี hub ก็ใช้ได้" ไว้หรือไม่?

---

## 10) ข้อควรระวังด้านความปลอดภัย/ปฏิบัติการ

- **hub = จุดยึด fleet**: ถ้าทำ control plane ต้องมี signed capability + TTL สั้น + pin hub key
- ความลับในเครื่อง: `~/.p2pgate/config.json` มี masterSecret; `hosts.json` มี secret ด้วย
- publish npm ต้องมี OTP ของเจ้าของบัญชี — เอเจนไม่ควรพยายาม publish เอง
- CI ปิดอยู่ (billing lock) ⇒ ทุกการเปลี่ยนแปลงต้องพึ่ง `npm test` local + ทดสอบอุปกรณ์จริง
- ห้าม commit/push secret หรือไฟล์ `.env` ใด ๆ

---

## 11) คำสั่งที่ใช้บ่อย

```powershell
cd D:\tunnel\p2pgate
npm test                       # 82 checks + docs check
git log --oneline -5
npm view p2pgate version
gh release list --limit 3
```

```sh
# Termux (เครื่องทดสอบจริง)
ssh -p 8022 <user>@<host>
p2pgate --version
pgrep -af "p2pgate server"
tail -n 20 ~/p2pgate-server.log
```

รีลีส: ดู §11 ใน `HANDOFF.md` (มี `docs:check` + OTP + GitHub Release)

---

## 12) สิ่งที่ "ห้าม" สำหรับเอเจนตัวใหม่

1. อย่าเพิ่ม dependency โดยไม่มีการตัดสินใจและบันทึกเหตุผล
2. อย่าเปลี่ยน default ในทางที่ทำให้ผู้ใช้เดิมพังโดยไม่มี flag ถอยกลับ
3. อย่าลบ/แก้ invariant ใน §5 เพื่อให้ฟีเจอร์ใหม่ผ่านง่ายขึ้น
4. อย่าประกาศว่า "เสร็จ" ก่อน `npm test` ผ่านและทดสอบบนอุปกรณ์จริง (Windows ↔ Termux)
5. อย่าใช้ screenshot/ตัวเลขจากหน่วยความจำ — ต้องรันเก็บใหม่
6. อย่าแตะ `~/.p2pgate` ของผู้ใช้ (ใช้ HOME/config แยกเมื่อทดสอบ)

---

## 13) ไฟล์อ้างอิงสำคัญ

- [`HANDOFF.md`](HANDOFF.md) — สถานะ, invariants, ประวัติรุ่น, รีลีสเช็กลิสต์
- [`SOAK.md`](SOAK.md) — ผลทดสอบระยะยาว + วิธีเก็บตัวเลขรอบใหม่
- [`specs/phase15-fastpath-mux.md`](specs/phase15-fastpath-mux.md) — ตัวอย่างสเปกที่ดี (capability + peek + compatibility matrix)
- [`releases/v1.13.2.md`](releases/v1.13.2.md) — ตัวอย่างการเขียน incident/hotfix note
- `D:\tunnel\p2phub\docs\spec.md` — สเปก control plane ที่พักไว้ (ยังไม่เริ่ม)
