#!/usr/bin/env node
'use strict'

const path = require('node:path')
const { parseArgs } = require('node:util')
const {
  DEFAULT_CLIENT_KEY_PATH,
  expandHome,
  loadConfig,
  readConfigRaw,
  resolveConfigPath
} = require('./config-loader')
const { startServer } = require('./server')
const { startClient } = require('./client')
const { runSetupWizard } = require('./setup-wizard')
const { AuthGuard } = require('./auth-guard')
const { DeviceRegistry, validateDeviceAddOptions } = require('./device-registry')
const {
  CONTROL_VERSION,
  defaultControlSocketPath,
  sendControlCommand
} = require('./control')
const { runDoctor } = require('./doctor')
const {
  normalizeClientPublicKeyHex
} = require('./crypto-utils')
const {
  clientKeyExists,
  generateClientKey,
  loadClientKey
} = require('./keygen')
const { version } = require('../package.json')

const HELP_TEXT = `p2pgate v1.4 — อุโมงค์ TCP แบบ P2P สำหรับ Termux (Zero-Trust + SCRAM)

การใช้งาน:
  p2pgate setup [--config <path>]
      ตั้งค่าครั้งแรกแบบถาม-ตอบ (แนะนำ)

  p2pgate keygen [--config <path>] [--force]
      สร้างหรือแสดงกุญแจประจำเครื่อง Client และพิมพ์ Public Key

  p2pgate server [--config <path>]
      เริ่มเซิร์ฟเวอร์และแสดง Session PIN 10 ตัวอักษรบนหน้าจอ

  p2pgate client [--config <path>] [--port <localPort>] [--pin-stdin]
      เริ่มอุโมงค์และยืนยันตัวตนด้วย PIN หรือรหัสผ่านสำรอง
      Client จะเชื่อมต่อก่อน และถาม PIN เฉพาะเมื่อเซิร์ฟเวอร์ต้องใช้ two-step
      ถ้าไม่ระบุ --pin-stdin จะถามแบบซ่อนการพิมพ์

  p2pgate devices list [--config <path>]
  p2pgate devices add <publicKeyHex> [--mode trusted|scram]
      [--expires 2026-12-31T23:59:59Z] [--permanent] [--comment "label"]
  p2pgate devices remove <publicKeyHex> [--config <path>]
      จัดการไฟล์ trusted_devices
      trusted ต้องระบุ --expires หรือ --permanent เท่านั้น

  p2pgate status [--config <path>]
      ดูสถานะเซิร์ฟเวอร์ที่รันอยู่ผ่าน local control socket

  p2pgate pin [--config <path>]
      ขอ Session PIN ปัจจุบันจากเซิร์ฟเวอร์ที่รันอยู่ (key-only ไม่มี PIN)

  p2pgate revoke <clientPublicKeyHex> [--config <path>]
      เพิกถอนคีย์ถาวรและตัด connection ที่เปิดอยู่ทันที
      คืนสิทธิ์ได้ด้วย p2pgate unlock <key>

  p2pgate doctor [--config <path>]
      ตรวจสุขภาพการติดตั้งและแสดงคำแนะนำเป็นภาษาไทย

  p2pgate unlock <clientPublicKeyHex>
  p2pgate unlock --list
  p2pgate unlock --all
      ดู/ปลดล็อก Client ที่ถูกระงับโดยไม่ต้องรีสตาร์ตเซิร์ฟเวอร์

  p2pgate help
      แสดงข้อความช่วยเหลือนี้

แหล่งข้อมูล PIN/รหัสผ่าน (เรียงตามลำดับความสำคัญ):
  1) --pin-stdin   อ่านหนึ่งบรรทัดจาก stdin
  2) P2PGATE_PIN   ตัวแปรสภาพแวดล้อม (ถูกลบออกจาก process ทันที)
  3) ถามแบบซ่อนการพิมพ์ (ค่าเริ่มต้น)

ตัวอย่าง:
  p2pgate setup
  p2pgate keygen
  p2pgate server
  p2pgate client
  p2pgate client --pin-stdin < pin.txt
  ssh -p 8022 localhost
  p2pgate devices list
  p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z --comment "ops-laptop"
  p2pgate status
  p2pgate pin
  p2pgate revoke <key>
  p2pgate doctor
  p2pgate unlock --list
  p2pgate unlock --all

ความปลอดภัย:
  - Session PIN มี 10 ตัวอักษร แสดงเป็น XXXXX-XXXXX และเปลี่ยนเมื่อมี
    การพยายามผิดหลายครั้ง
  - รหัสผ่านสำรองต้องยาวอย่างน้อย 12 ตัวอักษรและตัวพิมพ์เล็ก-ใหญ่มีความหมาย
  - ไม่มี flag --pin เพื่อไม่ให้รหัสผ่านไปปรากฏใน ps หรือ shell history
  - หลีกเลี่ยงคำสั่ง P2PGATE_PIN=... แบบ inline เพราะ shell อาจบันทึกประวัติ
    ใช้การถามแบบซ่อนหรือ --pin-stdin จากไฟล์ที่ปลอดภัยดีกว่า
  - อุโมงค์ผูกกับ 127.0.0.1 เท่านั้น
`

function printHelp() {
  process.stdout.write(`${HELP_TEXT}\n`)
}

function printError(err) {
  const message = err && err.message ? err.message : String(err)
  const code = err && err.code

  process.stderr.write(`\n❌ เกิดข้อผิดพลาด: ${message}\n`)

  switch (code) {
    case 'CONFIG_NOT_FOUND':
      process.stderr.write('👉 ยังไม่มีไฟล์ตั้งค่า กรุณารัน: p2pgate setup\n')
      break
    case 'CONFIG_INVALID_JSON':
      process.stderr.write('👉 ไฟล์ config เสียหาย กรุณาแก้ไขหรือรัน setup ใหม่\n')
      break
    case 'CONFIG_INVALID':
      process.stderr.write(
        '👉 ค่าใน config ไม่ถูกต้อง กรุณาตรวจสอบหรือรัน p2pgate setup ใหม่\n'
      )
      break
    case 'AUTH_CONFIG_UPGRADE_REQUIRED':
      process.stderr.write(
        '👉 พบรูปแบบ authPin จาก v1.1 กรุณารัน p2pgate setup เพื่ออัปเดตเป็น v1.2\n'
      )
      break
    case 'MASTER_SECRET_INVALID':
      process.stderr.write(
        '👉 masterSecret ต้องเป็นตัวอักษร hex 0-9/a-f จำนวน 64 ตัว และต้องสุ่มจริง\n'
      )
      break
    case 'ALLOWED_KEYS_EMPTY':
      process.stderr.write(
        '👉 ยังไม่มีอุปกรณ์ลงทะเบียนใน allowedClientKeys หรือ trusted_devices\n'
      )
      process.stderr.write('   เพิ่มได้ด้วย: p2pgate devices add <key> --mode trusted\n')
      break
    case 'CLIENT_KEY_NOT_FOUND':
      process.stderr.write('👉 ยังไม่มีกุญแจ Client กรุณารัน: p2pgate keygen\n')
      break
    case 'CLIENT_KEY_MISMATCH':
      process.stderr.write(
        '👉 ไฟล์กุญแจ Client ไม่สอดคล้องกัน กรุณาสร้างใหม่ด้วย: p2pgate keygen --force\n'
      )
      break
    case 'AUTH_VERIFIER_INVALID':
      process.stderr.write(
        '👉 ค่า SCRAM verifier ใน config ไม่ถูกต้อง กรุณารัน p2pgate setup ใหม่\n'
      )
      break
    case 'PIN_REQUIRED':
      process.stderr.write(
        '👉 ต้องระบุ PIN/รหัสผ่านเมื่อไม่ได้รันใน terminal แบบ interactive\n'
      )
      process.stderr.write('   ใช้: p2pgate client --pin-stdin หรือตั้งค่า P2PGATE_PIN\n')
      break
    case 'CREDENTIAL_INVALID':
      process.stderr.write(
        '👉 PIN ต้องมี 10 ตัวอักษร หรือรหัสผ่านสำรองต้องยาวอย่างน้อย 12 ตัวอักษร\n'
      )
      process.stderr.write('   PIN อาจอยู่ในรูป XXXXX-XXXXX\n')
      break
    case 'AUTH_ABORTED':
      process.stderr.write('👉 ยกเลิกการใส่ PIN แล้ว\n')
      break
    case 'AUTH_PASSWORD_WEAK':
      process.stderr.write('👉 รหัสผ่านสำรองต้องยาวอย่างน้อย 12 ตัวอักษร\n')
      break
    case 'AUTH_HASH_INVALID':
      process.stderr.write(
        '👉 ค่า verifier รหัสผ่านสำรองใน config ไม่ถูกต้อง กรุณารัน p2pgate setup ใหม่\n'
      )
      break
    case 'EADDRINUSE':
      process.stderr.write(
        '👉 พอร์ตนี้ถูกใช้งานอยู่ กรุณาปิดโปรแกรมที่ใช้พอร์ตนั้น หรือเลือกพอร์ตอื่นด้วย --port\n'
      )
      break
    case 'EACCES':
      process.stderr.write('👉 ไม่มีสิทธิ์เข้าถึงพอร์ตหรือไฟล์ที่กำหนด\n')
      break
    default:
      break
  }
}

async function resolveKeyPath(configPath) {
  try {
    const raw = await readConfigRaw(configPath)
    if (raw && typeof raw.clientKeyPath === 'string' && raw.clientKeyPath.trim() !== '') {
      return path.resolve(expandHome(raw.clientKeyPath))
    }
  } catch (err) {
    if (!err || err.code !== 'CONFIG_NOT_FOUND') throw err
  }

  return DEFAULT_CLIENT_KEY_PATH
}

function printPublicKey(publicKey, keyPath, isNew) {
  process.stdout.write(`\n🔑 ${isNew ? 'สร้างกุญแจ Client ใหม่แล้ว' : 'กุญแจ Client พร้อมใช้งาน'}\n`)
  process.stdout.write(`   ไฟล์: ${keyPath}\n`)
  process.stdout.write('\nPublic Key (64 ตัวอักษร):\n')
  process.stdout.write(`  ${publicKey}\n\n`)
  process.stdout.write('นำ Public Key นี้ไปเพิ่มใน allowedClientKeys ของเครื่อง Server\n')
  process.stdout.write('แล้วรีสตาร์ตเซิร์ฟเวอร์ (หรือรัน setup บน Server อีกครั้ง)\n')
}

async function commandKeygen(values) {
  const configPath = resolveConfigPath(values.config)
  const keyPath = await resolveKeyPath(configPath)

  if (clientKeyExists(keyPath) && !values.force) {
    const key = await loadClientKey(keyPath)
    printPublicKey(key.publicKey, key.path, false)
    return
  }

  if (clientKeyExists(keyPath) && values.force) {
    process.stdout.write(
      '⚠️  กำลังสร้างกุญแจใหม่ทับของเดิม — Server จะปฏิเสธกุญแจเดิมทันที\n'
    )
    process.stdout.write('    อย่าลืมนำ Public Key ใหม่ไปเพิ่มในเครื่อง Server\n')
  }

  const key = await generateClientKey(keyPath)
  printPublicKey(key.publicKey, key.path, true)
}

async function waitForShutdownSignal() {
  return new Promise((resolve) => {
    const signals = ['SIGINT', 'SIGTERM']

    const handler = (signal) => {
      for (const name of signals) process.removeListener(name, handler)
      resolve(signal)
    }

    for (const name of signals) process.once(name, handler)
  })
}

async function commandServer(values) {
  const configPath = resolveConfigPath(values.config)
  const config = await loadConfig(configPath)

  process.stdout.write('\n=== p2pgate server ===\n')
  process.stdout.write(`ไฟล์ตั้งค่า: ${configPath}\n`)

  const server = await startServer(config)
  const address = server.currentPublicKeyHex()

  process.stdout.write('\n✅ เซิร์ฟเวอร์พร้อมทำงานแล้ว\n')
  process.stdout.write(`   ส่งต่อไปยัง: 127.0.0.1:${config.targetPort}\n`)
  process.stdout.write(`   โหมดยืนยันตัวตน: ${server.verificationMode}\n`)
  process.stdout.write(`   อุปกรณ์ที่ลงทะเบียน: ${server.registrySize} รายการ\n`)
  process.stdout.write(`   Public Key รอบนี้: ${address}\n\n`)
  process.stdout.write('กด Ctrl+C เพื่อหยุดอย่างปลอดภัย\n')

  const signal = await waitForShutdownSignal()
  process.stdout.write(`\nได้รับสัญญาณ ${signal} กำลังปิดระบบ...\n`)

  await server.close()
  process.stdout.write('ปิดระบบเรียบร้อย\n')
}

async function commandClient(values) {
  const configPath = resolveConfigPath(values.config)
  const config = await loadConfig(configPath)

  if (values.port !== undefined) {
    const port = Number(values.port)

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      const err = new Error('--port ต้องเป็นตัวเลขระหว่าง 1 ถึง 65535')
      err.code = 'CONFIG_INVALID'
      throw err
    }

    config.localPort = port
  }

  process.stdout.write('\n=== p2pgate client ===\n')
  process.stdout.write(`ไฟล์ตั้งค่า: ${configPath}\n`)

  if (values['pin-stdin']) {
    process.stdout.write(
      '🔐 จะอ่าน PIN/รหัสผ่านจาก stdin เฉพาะเมื่อเซิร์ฟเวอร์ต้องใช้ two-step\n'
    )
  } else if (!process.env.P2PGATE_PIN) {
    process.stdout.write(
      '🔐 จะถาม PIN เฉพาะเมื่อเซิร์ฟเวอร์ต้องใช้ two-step (trusted/key-only ไม่ถาม)\n'
    )
  }

  const client = await startClient(config, {
    pinStdin: values['pin-stdin'] === true
  })
  const address = client.address()

  process.stdout.write('\n✅ อุโมงค์พร้อมใช้งานแล้ว\n')
  process.stdout.write(`   เปิดพอร์ตเฉพาะ: 127.0.0.1:${address.port}\n`)
  process.stdout.write(`   วิธีเชื่อมต่อ: ssh -p ${address.port} localhost\n\n`)
  process.stdout.write('กด Ctrl+C เพื่อหยุดอย่างปลอดภัย\n')

  const signal = await waitForShutdownSignal()
  process.stdout.write(`\nได้รับสัญญาณ ${signal} กำลังปิดอุโมงค์...\n`)

  await client.close()
  process.stdout.write('ปิดอุโมงค์เรียบร้อย\n')
}

async function commandDevices(values, positionals) {
  const configPath = resolveConfigPath(values.config)
  const config = await loadConfig(configPath)
  const registry = new DeviceRegistry({
    configKeys: config.allowedClientKeys,
    filePath: config.trustedDevicesFile,
    verificationMode: config.verificationMode,
    now: Date.now
  })

  await registry.init()
  const subcommand = positionals[1]

  if (subcommand === 'list') {
    const devices = await registry.listDevices()

    process.stdout.write('\n=== p2pgate devices ===\n')
    process.stdout.write(`โหมดยืนยันตัวตน: ${config.verificationMode}\n`)
    process.stdout.write(`ไฟล์ trusted_devices: ${config.trustedDevicesFile}\n`)

    if (!registry.permissionsOk) {
      process.stdout.write(
        `⚠️  ไฟล์ trusted_devices มีสิทธิ์ไม่ปลอดภัย (${registry.permissionsError}); fast-path ถูกปิด\n`
      )
    }

    if (devices.length === 0) {
      process.stdout.write('\nไม่มีอุปกรณ์ที่ลงทะเบียน\n')
      return
    }

    for (const device of devices) {
      const source = device.source === 'config'
        ? 'config.json (allowedClientKeys)'
        : 'trusted_devices'

      process.stdout.write(`\n- ${device.key}\n`)
      process.stdout.write(`  แหล่งที่มา: ${source}\n`)
      if (device.source === 'trusted_devices' && device.alsoInConfig) {
        process.stdout.write('  หมายเหตุ: trusted_devices override config.json\n')
      }
      process.stdout.write(`  โปรไฟล์: ${device.profile}\n`)
      process.stdout.write(`  หมดอายุ: ${device.expiresAtIso || '-'}\n`)
      process.stdout.write(`  ป้ายชื่อ: ${device.label || '-'}\n`)
      process.stdout.write(`  สถานะ: ${device.active ? 'ใช้งาน' : 'หมดอายุ'}\n`)
      process.stdout.write(`  Fast-path: ${device.fastpathAllowed ? 'ใช่' : 'ไม่ใช่'}\n`)
    }

    process.stdout.write('\n')
    return
  }

  if (subcommand === 'add') {
    const keyArg = positionals[2]

    if (!keyArg) {
      process.stderr.write('❌ กรุณาระบุ Public Key ที่ต้องการเพิ่ม\n')
      process.exitCode = 1
      return
    }

    let keyHex
    try {
      keyHex = normalizeClientPublicKeyHex(keyArg)
    } catch (err) {
      process.stderr.write(`❌ Public Key ไม่ถูกต้อง: ${err.message}\n`)
      process.exitCode = 1
      return
    }

    const profile = values.mode === undefined
      ? 'scram'
      : String(values.mode).toLowerCase()

    if (profile !== 'trusted' && profile !== 'scram') {
      process.stderr.write('❌ --mode ต้องเป็น trusted หรือ scram\n')
      process.exitCode = 1
      return
    }

    const validation = validateDeviceAddOptions({
      profile,
      expires: values.expires,
      permanent: values.permanent === true
    })

    if (!validation.ok) {
      process.stderr.write(`❌ ${validation.error}\n`)
      if (profile === 'trusted') {
        process.stderr.write(
          '   ระบุ --expires 2026-12-31T23:59:59Z หรือ --permanent หากจำเป็นจริง ๆ\n'
        )
      }
      process.exitCode = 1
      return
    }

    let result
    try {
      result = await registry.addDevice({
        key: keyHex,
        profile,
        expires: values.expires,
        label: values.comment || ''
      })
    } catch (err) {
      process.stderr.write(`❌ ไม่สามารถบันทึกอุปกรณ์ได้: ${err.message}\n`)
      process.exitCode = 1
      return
    }

    process.stdout.write(`\n✅ บันทึกอุปกรณ์แล้ว: ${result.key}\n`)
    process.stdout.write(`   ไฟล์: ${result.filePath}\n`)
    process.stdout.write(`   โปรไฟล์: ${profile}\n`)

    if (profile === 'trusted') {
      process.stdout.write(
        '   ⚠️  trusted device ข้ามการถาม PIN — ควรตั้งวันหมดอายุและปกป้องกุญแจ Client\n'
      )
      if (values.permanent) {
        process.stdout.write(
          '   ⚠️  ตั้งเป็นถาวรตามคำสั่ง --permanent — โปรดตรวจสอบเป็นระยะด้วย p2pgate devices list\n'
        )
      }
    }

    if (result.replaced) {
      process.stdout.write('   ℹ️  แทนที่รายการเดิมของคีย์นี้ใน trusted_devices\n')
    }
    if (result.alsoInConfig) {
      process.stdout.write(
        '   ℹ️  คีย์นี้อยู่ใน config.json ด้วย; trusted_devices จะมีผลเหนือกว่า\n'
      )
    }
    return
  }

  if (subcommand === 'remove') {
    const keyArg = positionals[2]

    if (!keyArg) {
      process.stderr.write('❌ กรุณาระบุ Public Key ที่ต้องการลบ\n')
      process.exitCode = 1
      return
    }

    let keyHex
    try {
      keyHex = normalizeClientPublicKeyHex(keyArg)
    } catch (err) {
      process.stderr.write(`❌ Public Key ไม่ถูกต้อง: ${err.message}\n`)
      process.exitCode = 1
      return
    }

    let result
    try {
      result = await registry.removeDevice(keyHex)
    } catch (err) {
      process.stderr.write(`❌ ไม่สามารถลบอุปกรณ์ได้: ${err.message}\n`)
      process.exitCode = 1
      return
    }

    if (result.removed) {
      process.stdout.write(`\n✅ ลบออกจาก trusted_devices แล้ว: ${result.key}\n`)
    } else {
      process.stdout.write(`\nℹ️  ไม่พบคีย์นี้ใน trusted_devices: ${result.key}\n`)
    }

    if (result.alsoInConfig) {
      process.stdout.write(
        '   ⚠️  คีย์นี้ยังอยู่ใน allowedClientKeys ของ config.json (โปรไฟล์ scram)\n'
      )
    }
    return
  }

  process.stderr.write(
    '❌ การใช้งาน: p2pgate devices list | devices add <key> | devices remove <key>\n'
  )
  process.exitCode = 1
}

function formatRemaining(ms) {
  if (ms === null) return 'ถาวร'
  if (!Number.isFinite(ms) || ms <= 0) return 'หมดแล้ว'

  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes} นาที`

  const hours = Math.ceil(minutes / 60)
  return `${hours} ชั่วโมง`
}

function formatUptime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const parts = []

  if (days > 0) parts.push(`${days} วัน`)
  if (hours > 0) parts.push(`${hours} ชม.`)
  if (minutes > 0) parts.push(`${minutes} น.`)
  if (parts.length === 0) parts.push(`${seconds} วินาที`)

  return parts.join(' ')
}

async function sendControl(request) {
  return sendControlCommand(
    defaultControlSocketPath(),
    { v: CONTROL_VERSION, ...request },
    { timeoutMs: 3000 }
  )
}

function isControlUnavailable(err) {
  return err && err.code === 'CONTROL_UNAVAILABLE'
}

async function commandStatus() {
  let response

  try {
    response = await sendControl({ cmd: 'status' })
  } catch (err) {
    if (isControlUnavailable(err)) {
      process.stderr.write(
        '\n⚠️  ไม่พบเซิร์ฟเวอร์ที่กำลังทำงาน (control socket ไม่พร้อมใช้งาน)\n'
      )
      process.stderr.write('   เริ่มเซิร์ฟเวอร์ด้วย: p2pgate server\n')
      process.exitCode = 1
      return
    }

    throw err
  }

  if (!response || response.ok !== true) {
    process.stderr.write(
      `\n❌ เซิร์ฟเวอร์ตอบกลับผิดพลาด: ${
        response && response.error ? response.error : 'UNKNOWN'
      }\n`
    )
    process.exitCode = 1
    return
  }

  const activeKeys = Array.isArray(response.activeKeys) ? response.activeKeys : []
  const slots = Array.isArray(response.listeningSlots) ? response.listeningSlots : []
  const pinState = response.sessionPinAvailable
    ? `พร้อมใช้ (generation ${response.sessionGeneration})`
    : 'ไม่มี (key-only หรือยังไม่สร้าง)'

  process.stdout.write('\n=== p2pgate status ===\n')
  process.stdout.write(`โหมดยืนยันตัวตน: ${response.verificationMode}\n`)
  process.stdout.write(`Session PIN: ${pinState}\n`)
  process.stdout.write(`Slot ปัจจุบัน: ${response.currentSlot}\n`)
  process.stdout.write(
    `Slots ที่เปิดอยู่: ${slots.length > 0 ? slots.join(', ') : '-'}\n`
  )
  process.stdout.write(`อุปกรณ์ที่ลงทะเบียน: ${response.registrySize}\n`)
  process.stdout.write(`Connection ที่ใช้งาน: ${response.activeConnections}\n`)
  process.stdout.write(
    `คีย์ที่เชื่อมต่อ: ${activeKeys.length > 0 ? activeKeys.join(', ') : '-'}\n`
  )
  process.stdout.write(`ถูกบล็อกสะสม: ${response.blockedCount}\n`)
  process.stdout.write(`ทำงานมา: ${formatUptime(response.uptimeMs)}\n`)
  process.stdout.write(`Terminal แบบ interactive: ${response.interactive ? 'ใช่' : 'ไม่ใช่'}\n`)
  process.stdout.write(`ไฟล์ trusted_devices: ${response.trustedDevicesFile}\n`)
  process.stdout.write(`Control socket: ${response.controlSocketPath}\n\n`)
}

async function commandPin() {
  let response

  try {
    response = await sendControl({ cmd: 'pin' })
  } catch (err) {
    if (isControlUnavailable(err)) {
      process.stderr.write(
        '\n⚠️  ไม่พบเซิร์ฟเวอร์ที่กำลังทำงาน จึงอ่าน Session PIN ไม่ได้\n'
      )
      process.stderr.write('   เริ่มเซิร์ฟเวอร์ด้วย: p2pgate server\n')
      process.exitCode = 1
      return
    }

    throw err
  }

  if (!response || response.ok !== true) {
    if (response && response.error === 'NO_SESSION_PIN') {
      process.stdout.write(
        '\nℹ️  โหมดนี้ไม่มี Session PIN (key-only ใช้ Public Key เท่านั้น)\n'
      )
      return
    }

    process.stderr.write(
      `\n❌ ไม่สามารถอ่าน Session PIN ได้: ${
        response && response.error ? response.error : 'UNKNOWN'
      }\n`
    )
    process.exitCode = 1
    return
  }

  process.stdout.write('\n=== Session PIN ปัจจุบัน ===\n')
  process.stdout.write(`   ${response.formatted}\n`)
  process.stdout.write(`   generation: ${response.generation}\n`)
  process.stdout.write(
    '   ℹ️  PIN ถูกอ่านจากหน่วยความจำผ่าน control socket และไม่ถูกเขียนลงดิสก์\n\n'
  )
}

async function commandRevoke(positionals) {
  const keyArg = positionals[1]

  if (!keyArg) {
    process.stderr.write('❌ กรุณาระบุ Public Key ที่ต้องการเพิกถอน\n')
    process.exitCode = 1
    return
  }

  let keyHex
  try {
    keyHex = normalizeClientPublicKeyHex(keyArg)
  } catch (err) {
    process.stderr.write(`❌ Public Key ไม่ถูกต้อง: ${err.message}\n`)
    process.exitCode = 1
    return
  }

  try {
    const response = await sendControl({ cmd: 'revoke', key: keyHex })

    if (!response || response.ok !== true) {
      process.stderr.write(
        `\n❌ เพิกถอนไม่สำเร็จ: ${
          response && response.error ? response.error : 'UNKNOWN'
        }\n`
      )
      process.exitCode = 1
      return
    }

    process.stdout.write(`\n✅ เพิกถอนคีย์แล้ว: ${response.key}\n`)
    process.stdout.write(`   ปิด connection ที่เปิดอยู่: ${response.closed}\n`)
    process.stdout.write(
      '   ℹ️  การเชื่อมต่อครั้งถัดไปจะถูกปฏิเสธจนกว่าจะรัน p2pgate unlock <key>\n\n'
    )
    return
  } catch (err) {
    if (!isControlUnavailable(err)) throw err
  }

  const guard = new AuthGuard({})
  await guard.init()

  try {
    const status = await guard.revoke(keyHex, 'manual')
    process.stdout.write(
      `\n✅ บันทึกการเพิกถอนแล้ว (เซิร์ฟเวอร์ไม่ได้ทำงานอยู่): ${status.key}\n`
    )
    process.stdout.write(
      '   ℹ️  การเชื่อมต่อครั้งถัดไปจะถูกปฏิเสธทันทีที่เซิร์ฟเวอร์อ่าน state นี้\n'
    )
    process.stdout.write(
      '   คืนสิทธิ์ได้ด้วย: p2pgate unlock <key>\n\n'
    )
  } finally {
    await guard.close()
  }
}

async function commandDoctor(values) {
  const configPath = resolveConfigPath(values.config)
  const result = await runDoctor({ configPath })
  if (result && result.exitCode) {
    process.exitCode = result.exitCode
  }
}

async function commandUnlock(values, positionals) {
  const guard = new AuthGuard({})
  await guard.init()

  try {
    if (values.list) {
      const statuses = await guard.listStatuses()

      if (statuses.length === 0) {
        process.stdout.write('\nไม่มีรายการที่ถูกระงับหรือมีประวัติล้มเหลว\n')
        return
      }

      process.stdout.write('\nรายการ Client ที่มีประวัติ/ถูกระงับ:\n')
      for (const status of statuses) {
        const state = status.revoked
          ? 'เพิกถอนด้วยคำสั่ง revoke (คืนสิทธิ์ด้วย p2pgate unlock)'
          : status.permanent
            ? 'ระงับถาวร'
            : status.locked
              ? `ระงับอีก ${formatRemaining(status.remainingMs)}`
              : 'ปกติ'

        process.stdout.write(`\n- ${status.key}\n`)
        process.stdout.write(`  สถานะ: ${state}\n`)
        process.stdout.write(`  ล้มเหลวใน 24 ชม.: ${status.failures} ครั้ง\n`)
        process.stdout.write(`  ระดับ: ${status.level === 0 ? '-' : status.level}\n`)
      }
      process.stdout.write('\n')
      return
    }

    if (values.all) {
      const count = await guard.unlockAll()
      process.stdout.write(`\n✅ ปลดล็อกทั้งหมดแล้ว (${count} รายการ)\n`)
      return
    }

    const keyArg = positionals[1]

    if (!keyArg) {
      process.stderr.write(
        '❌ กรุณาระบุ Public Key หรือใช้ --list / --all\n'
      )
      process.exitCode = 1
      return
    }

    let keyHex
    try {
      keyHex = normalizeClientPublicKeyHex(keyArg)
    } catch (err) {
      process.stderr.write(`❌ Public Key ไม่ถูกต้อง: ${err.message}\n`)
      process.exitCode = 1
      return
    }

    const existed = await guard.unlock(keyHex)
    if (existed) {
      process.stdout.write(`\n✅ ปลดล็อกแล้ว: ${keyHex}\n`)
    } else {
      process.stdout.write(`\nℹ️  ไม่พบข้อมูลของคีย์นี้: ${keyHex}\n`)
    }
  } finally {
    await guard.close()
  }
}

async function main(argv) {
  let parsed

  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c' },
        port: { type: 'string', short: 'p' },
        'pin-stdin': { type: 'boolean' },
        mode: { type: 'string' },
        expires: { type: 'string' },
        permanent: { type: 'boolean' },
        comment: { type: 'string' },
        all: { type: 'boolean' },
        list: { type: 'boolean' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' }
      }
    })
  } catch (err) {
    process.stderr.write(`❌ ${err.message}\n\n`)
    printHelp()
    process.exitCode = 1
    return
  }

  const { values, positionals } = parsed
  const command = positionals[0] || 'help'

  if (values.version) {
    process.stdout.write(`p2pgate ${version}\n`)
    return
  }

  if (values.help || command === 'help') {
    printHelp()
    return
  }

  switch (command) {
    case 'setup': {
      const configPath = resolveConfigPath(values.config)
      await runSetupWizard({ configPath })
      return
    }
    case 'keygen':
      await commandKeygen(values)
      return
    case 'server':
      await commandServer(values)
      return
    case 'client':
      await commandClient(values)
      return
    case 'devices':
      await commandDevices(values, positionals)
      return
    case 'status':
      await commandStatus()
      return
    case 'pin':
      await commandPin()
      return
    case 'revoke':
      await commandRevoke(positionals)
      return
    case 'doctor':
      await commandDoctor(values)
      return
    case 'unlock':
      await commandUnlock(values, positionals)
      return
    default:
      process.stderr.write(`❌ ไม่รู้จักคำสั่ง: ${command}\n\n`)
      printHelp()
      process.exitCode = 1
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    if (err && (err.name === 'AbortError' || err.code === 'AUTH_ABORTED')) {
      process.stderr.write('\nยกเลิกแล้ว\n')
      process.exitCode = 130
      return
    }

    if (err && err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      process.stderr.write(`❌ ${err.message}\n\n`)
      printHelp()
      process.exitCode = 1
      return
    }

    printError(err)
    process.exitCode = 1
  })
}

module.exports = { main }
