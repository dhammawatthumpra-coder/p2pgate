#!/usr/bin/env node
'use strict'

const path = require('node:path')
const readline = require('node:readline/promises')
const { parseArgs } = require('node:util')
const {
  DEFAULT_CLIENT_KEY_PATH,
  expandHome,
  loadConfig,
  readConfigRaw,
  resolveConfigPath,
  saveConfig
} = require('./config-loader')
const { startServer } = require('./server')
const { startClient } = require('./client')
const { runSetupWizard } = require('./setup-wizard')
const { AuthGuard } = require('./auth-guard')
const { DeviceRegistry, validateDeviceAddOptions } = require('./device-registry')
const {
  CONTROL_VERSION,
  defaultControlSocketPath,
  readControlToken,
  sendControlCommand
} = require('./control')
const { promptHidden } = require('./auth')
const { createAuditLog } = require('./audit-log')
const {
  DEFAULT_CLIENT_CONFIG_PATH,
  createServerPasswordConfig,
  createClientPasswordConfig,
  generateConnectionPassword,
  writeQuickstartFile
} = require('./quickstart')
const { t, setLanguage } = require('./i18n')
const { runDoctor } = require('./doctor')
const {
  normalizeClientPublicKeyHex,
  assertMasterSecret,
  deriveScramVerifier,
  serializeScramVerifier
} = require('./crypto-utils')
const {
  clientKeyExists,
  generateClientKey,
  inspectClientKey,
  protectClientKey,
  unprotectClientKey
} = require('./keygen')
const { version } = require('../package.json')

const HELP_TEXT = `p2pgate v1.6 — อุโมงค์ TCP แบบ P2P สำหรับ SSH (HyperDHT)

การใช้งาน:
  p2pgate server [--config <path>]
      เริ่มเซิร์ฟเวอร์ ครั้งแรกจะสร้าง config, masterSecret
      และ connection password ให้อัตโนมัติ

  p2pgate connect [-s <masterSecret>] [-p <password>] [--port <localPort>]
      เชื่อมต่อจาก Client และสร้าง client key อัตโนมัติ

  p2pgate setup [--easy] [--mode server|client] [--config <path>]
      ตั้งค่าแบบ advanced

  p2pgate keygen [--config <path>] [--force]
      [--passphrase] [--passphrase-stdin] [--unprotect]
      สร้างหรือแสดงกุญแจประจำเครื่อง Client และพิมพ์ Public Key
      --passphrase: ตั้ง/เปลี่ยน passphrase สำหรับ client key

  p2pgate client [--config <path>] [--port <localPort>] [--pin-stdin]
      [--key-passphrase-stdin]
      เริ่มอุโมงค์แบบ advanced (ใช้ config ที่ตั้งไว้แล้ว)

  p2pgate devices list [--config <path>]
  p2pgate devices add <publicKeyHex> [--mode trusted|scram]
      [--expires 2026-12-31T23:59:59Z] [--permanent] [--comment "label"]
  p2pgate devices remove <publicKeyHex> [--config <path>]
      จัดการไฟล์ trusted_devices
      trusted ต้องระบุ --expires หรือ --permanent เท่านั้น

  p2pgate status [--config <path>] [--json]
      ดูสถานะเซิร์ฟเวอร์ที่รันอยู่ผ่าน local control socket

  p2pgate pin [--config <path>]
      ขอ Session PIN ปัจจุบันจากเซิร์ฟเวอร์ที่รันอยู่ (key-only ไม่มี PIN)

  p2pgate password reset [--config <path>]
      สร้าง connection password ใหม่และแสดงค่าใหม่

  p2pgate revoke <clientPublicKeyHex> [--config <path>]
      เพิกถอนคีย์ถาวรและตัด connection ที่เปิดอยู่ทันที
      คืนสิทธิ์ได้ด้วย p2pgate unlock <key>

  p2pgate doctor [--config <path>] [--json]
      ตรวจสุขภาพการติดตั้งและแสดงคำแนะนำ

  p2pgate unlock <clientPublicKeyHex>
  p2pgate unlock --list
  p2pgate unlock --all
      ดู/ปลดล็อก Client ที่ถูกระงับโดยไม่ต้องรีสตาร์ตเซิร์ฟเวอร์

  p2pgate help
      แสดงข้อความช่วยเหลือนี้

ภาษา:
  P2PGATE_LANG=en|th   หรือ --lang en|th
  ค่าเริ่มต้น: ตาม LANG/LC_ALL แล้ว fallback เป็น en

แหล่งข้อมูล PIN/รหัสผ่าน (เรียงตามลำดับความสำคัญ):
  1) --pin-stdin   อ่านหนึ่งบรรทัดจาก stdin
  2) P2PGATE_PIN   ตัวแปรสภาพแวดล้อม (ถูกลบออกจาก process ทันที)
  3) ถามแบบซ่อนการพิมพ์ (ค่าเริ่มต้น)

Passphrase ของ client key:
  1) --key-passphrase-stdin   อ่านหนึ่งบรรทัดจาก stdin
  2) P2PGATE_KEY_PASSPHRASE   ตัวแปรสภาพแวดล้อม (ถูกลบออกจาก process ทันที)
  3) ถามแบบซ่อนการพิมพ์ (ค่าเริ่มต้น)

ตัวอย่าง:
  p2pgate server
  p2pgate connect -s <masterSecret> -p <password>
  p2pgate connect
  p2pgate setup --easy
  p2pgate keygen --passphrase
  ssh -p 8022 localhost
  p2pgate devices list
  p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z --comment "ops-laptop"
  p2pgate status --json
  p2pgate password reset
  p2pgate doctor --json
  p2pgate unlock --list
  p2pgate unlock --all

ความปลอดภัย:
  - masterSecret และ password เป็นความลับ ห้าม commit หรือแชร์
  - หลีกเลี่ยงการใส่ password ด้วย -p ใน shell history; ใช้ prompt หรือ env
  - Session PIN มี 10 ตัวอักษร แสดงเป็น XXXXX-XXXXX และเปลี่ยนเมื่อมี
    การพยายามผิดหลายครั้ง
  - รหัสผ่านสำรองต้องยาวอย่างน้อย 12 ตัวอักษรและตัวพิมพ์เล็ก-ใหญ่มีความหมาย
  - ไม่มี flag --pin เพื่อไม่ให้รหัสผ่านไปปรากฏใน ps หรือ shell history
  - อุโมงค์ผูกกับ 127.0.0.1 เท่านั้น
`

const HELP_TEXT_EN = `p2pgate v1.6 — P2P TCP tunnel for SSH (HyperDHT)

Usage:
  p2pgate server [--config <path>]
      Start the Server. On first run, generates config, masterSecret,
      and a connection password automatically.

  p2pgate connect [-s <masterSecret>] [-p <password>] [--port <localPort>]
      Connect from a Client. Generates a client key automatically.

  p2pgate client [--config <path>] [--port <localPort>] [--pin-stdin]
  p2pgate setup [--easy] [--mode server|client] [--config <path>]
      Advanced configuration.

  p2pgate keygen [--passphrase] [--unprotect]
  p2pgate devices list|add|remove
  p2pgate status [--json]
  p2pgate pin
  p2pgate revoke <key>
  p2pgate password reset
  p2pgate doctor [--json]
  p2pgate unlock --list|<key>|--all

Common options:
  --config <path>   Config file
  --port <number>   Local port (client commands)
  -s, --secret      masterSecret (connect)
  -p, --password    connection password (connect)
  --password-stdin  read password from stdin
  --lang en|th      UI language (or P2PGATE_LANG)

Security:
  - masterSecret and password are secrets; do not commit or share them
  - prefer the hidden prompt or environment variables over -p
  - client keys can be passphrase-protected with p2pgate keygen --passphrase
  - the tunnel binds 127.0.0.1 only
`

function printHelp() {
  process.stdout.write(`${t(HELP_TEXT, HELP_TEXT_EN)}\n`)
}

function printError(err) {
  const message = err && err.message ? err.message : String(err)
  const code = err && err.code

  process.stderr.write(t(
    `\n❌ เกิดข้อผิดพลาด: ${message}\n`,
    `\n❌ Error: ${message}\n`
  ))

  switch (code) {
    case 'LANG_INVALID':
      process.stderr.write(t(
        '👉 รองรับเฉพาะ en และ th\n',
        '👉 Supported languages: en, th\n'
      ))
      break
    case 'MASTER_SECRET_REQUIRED':
      process.stderr.write(t(
        '👉 ต้องระบุ masterSecret (ใช้ -s หรือ P2PGATE_MASTER_SECRET)\n',
        '👉 masterSecret is required (use -s or P2PGATE_MASTER_SECRET)\n'
      ))
      break
    case 'PASSWORD_REQUIRED':
      process.stderr.write(t(
        '👉 ต้องระบุ password (ใช้ -p, --password-stdin หรือ P2PGATE_PASSWORD)\n',
        '👉 password is required (use -p, --password-stdin, or P2PGATE_PASSWORD)\n'
      ))
      break
    case 'PASSWORD_NOT_CONFIGURED':
      process.stderr.write(t(
        '👉 authMode=password แต่ยังไม่มี connection password กรุณารัน p2pgate password reset\n',
        '👉 authMode=password has no connection password; run p2pgate password reset\n'
      ))
      break
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
    case 'KEY_PASSPHRASE_REQUIRED':
      process.stderr.write(
        '👉 client key ถูกป้องกันด้วย passphrase\n'
      )
      process.stderr.write(
        '   ใช้ --key-passphrase-stdin หรือ P2PGATE_KEY_PASSPHRASE หรือรันใน terminal\n'
      )
      break
    case 'KEY_PASSPHRASE_INVALID':
      process.stderr.write(
        '👉 passphrase ของ client key ไม่ถูกต้อง\n'
      )
      break
    case 'KEY_PASSPHRASE_WEAK':
      process.stderr.write(
        '👉 passphrase ต้องยาวอย่างน้อย 12 ตัวอักษร\n'
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

async function readStdinLine() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  try {
    return await rl.question('')
  } finally {
    rl.close()
  }
}

async function askKeyPassphrase(question) {
  try {
    return (await promptHidden(question)).trim()
  } catch {
    const err = new Error(
      'ต้องใช้ terminal สำหรับกรอก passphrase หรือใช้ --passphrase-stdin'
    )
    err.code = 'KEY_PASSPHRASE_REQUIRED'
    throw err
  }
}

async function askNewKeyPassphrase() {
  while (true) {
    const first = await askKeyPassphrase(
      'ตั้ง passphrase สำหรับ client key (อย่างน้อย 12 ตัวอักษร): '
    )

    if (first.length < 12) {
      process.stdout.write('❌ passphrase ต้องยาวอย่างน้อย 12 ตัวอักษร\n')
      continue
    }

    const second = await askKeyPassphrase('ยืนยัน passphrase อีกครั้ง: ')
    if (first !== second) {
      process.stdout.write('❌ passphrase ทั้งสองครั้งไม่ตรงกัน\n')
      continue
    }

    return first
  }
}

async function getKeygenPassphrase(values) {
  if (values['passphrase-stdin']) {
    const passphrase = (await readStdinLine()).trim()
    if (passphrase.length < 12) {
      const err = new Error('passphrase ต้องยาวอย่างน้อย 12 ตัวอักษร')
      err.code = 'KEY_PASSPHRASE_WEAK'
      throw err
    }
    return passphrase
  }

  if (values.passphrase) return askNewKeyPassphrase()
  return null
}

async function commandKeygen(values) {
  const configPath = resolveConfigPath(values.config)
  const keyPath = await resolveKeyPath(configPath)
  const exists = clientKeyExists(keyPath)

  if (exists && values.unprotect) {
    const metadata = await inspectClientKey(keyPath)
    if (!metadata.encrypted) {
      process.stdout.write('\nℹ️  client key นี้ไม่ได้ป้องกันด้วย passphrase\n')
      return
    }

    const currentPassphrase = await askKeyPassphrase(
      'passphrase ปัจจุบันของ client key: '
    )
    const key = await unprotectClientKey(keyPath, { currentPassphrase })
    process.stdout.write('\n✅ ถอด passphrase ออกจาก client key แล้ว\n')
    printPublicKey(key.publicKey, key.path, false)
    return
  }

  if (exists && !values.force) {
    const metadata = await inspectClientKey(keyPath)

    if (values.passphrase || values['passphrase-stdin']) {
      let currentPassphrase = null
      if (metadata.encrypted) {
        currentPassphrase = await askKeyPassphrase(
          'passphrase ปัจจุบันของ client key: '
        )
      }

      const passphrase = await getKeygenPassphrase(values)
      const key = await protectClientKey(keyPath, {
        currentPassphrase,
        passphrase
      })

      process.stdout.write('\n✅ ตั้ง passphrase ให้ client key แล้ว\n')
      printPublicKey(key.publicKey, key.path, false)
      return
    }

    process.stdout.write(`\n🔑 พบ client key เดิม: ${metadata.path}\n`)
    process.stdout.write(
      `   สถานะ: ${metadata.encrypted ? 'ป้องกันด้วย passphrase' : 'ไม่มีการป้องกัน'}\n`
    )
    printPublicKey(metadata.publicKey, metadata.path, false)

    if (!metadata.encrypted) {
      process.stdout.write(
        '💡 แนะนำ: เพิ่ม passphrase ด้วย `p2pgate keygen --passphrase`\n'
      )
    }
    return
  }

  if (exists && values.force) {
    process.stdout.write(
      '⚠️  กำลังสร้างกุญแจใหม่ทับของเดิม — Server จะปฏิเสธกุญแจเดิมทันที\n'
    )
    process.stdout.write('    อย่าลืมนำ Public Key ใหม่ไปเพิ่มในเครื่อง Server\n')
  }

  const passphrase = await getKeygenPassphrase(values)
  const key = await generateClientKey(keyPath, { passphrase })
  printPublicKey(key.publicKey, key.path, true)

  if (key.encrypted) {
    process.stdout.write('🔐 client key ถูกป้องกันด้วย passphrase\n')
  }
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
  let config
  let created = null

  try {
    config = await loadConfig(configPath)
  } catch (err) {
    if (!err || err.code !== 'CONFIG_NOT_FOUND') throw err

    created = await createServerPasswordConfig()
    await saveConfig(configPath, created.config)
    config = await loadConfig(configPath)
  }

  if (config.mode !== 'server') {
    const err = new Error('config mode is client; use p2pgate connect or p2pgate client')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  process.stdout.write('\n=== p2pgate server ===\n')
  process.stdout.write(t(`ไฟล์ตั้งค่า: ${configPath}\n`, `Config: ${configPath}\n`))

  if (created) {
    if (process.stdout.isTTY) {
      process.stdout.write(t(
        '\n🔑 ตั้งค่าเริ่มต้นให้แล้ว (เก็บค่าเหล่านี้เป็นความลับ)\n',
        '\n🔑 Initial setup complete (keep these values secret)\n'
      ))
      process.stdout.write(`   masterSecret: ${created.masterSecret}\n`)
      process.stdout.write(`   password:     ${created.password}\n`)
      process.stdout.write(t(
        '   Client: p2pgate connect -s <masterSecret> -p <password>\n\n',
        '   Client: p2pgate connect -s <masterSecret> -p <password>\n\n'
      ))
    } else {
      const quickstartPath = await writeQuickstartFile({
        configPath,
        masterSecret: created.masterSecret,
        password: created.password,
        targetPort: config.targetPort
      })
      process.stdout.write(t(
        `🔑 สร้าง credential เริ่มต้นแล้ว: ${quickstartPath}\n\n`,
        `🔑 Initial credentials written to: ${quickstartPath}\n\n`
      ))
    }
  } else if (config.authMode === 'password' && process.stdout.isTTY) {
    process.stdout.write(t(
      `masterSecret: ${config.masterSecret}\n`,
      `masterSecret: ${config.masterSecret}\n`
    ))
    process.stdout.write(t(
      'password: ใช้ค่าที่สร้างตอนรันครั้งแรก หรือรัน p2pgate password reset\n\n',
      'password: use the value from the first run, or run p2pgate password reset\n\n'
    ))
  }

  const server = await startServer(config)
  const address = server.currentPublicKeyHex()

  process.stdout.write(t('\n✅ เซิร์ฟเวอร์พร้อมทำงานแล้ว\n', '\n✅ Server is ready\n'))
  process.stdout.write(t(
    `   ส่งต่อไปยัง: 127.0.0.1:${config.targetPort}\n`,
    `   Target: 127.0.0.1:${config.targetPort}\n`
  ))
  process.stdout.write(t(
    `   โหมดยืนยันตัวตน: ${server.verificationMode} (${server.authMode})\n`,
    `   Verification: ${server.verificationMode} (${server.authMode})\n`
  ))
  process.stdout.write(t(
    `   อุปกรณ์ที่ลงทะเบียน: ${server.registrySize} รายการ\n`,
    `   Registered devices: ${server.registrySize}\n`
  ))
  process.stdout.write(`   Public Key: ${address}\n\n`)
  process.stdout.write(t('กด Ctrl+C เพื่อหยุดอย่างปลอดภัย\n', 'Press Ctrl+C to stop safely\n'))

  const signal = await waitForShutdownSignal()
  process.stdout.write(t(
    `\nได้รับสัญญาณ ${signal} กำลังปิดระบบ...\n`,
    `\nReceived ${signal}; shutting down...\n`
  ))

  await server.close()
  process.stdout.write(t('ปิดระบบเรียบร้อย\n', 'Server stopped\n'))
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

  if (values['key-passphrase-stdin'] && values['pin-stdin']) {
    const err = new Error(
      'ใช้ --key-passphrase-stdin และ --pin-stdin พร้อมกันไม่ได้'
    )
    err.code = 'CONFIG_INVALID'
    throw err
  }

  let keyPassphrase
  if (values['key-passphrase-stdin']) {
    process.stdout.write('🔐 จะอ่าน passphrase ของ client key จาก stdin\n')
    keyPassphrase = (await readStdinLine()).trim()
    if (keyPassphrase === '') {
      const err = new Error('passphrase ของ client key ว่างเปล่า')
      err.code = 'KEY_PASSPHRASE_REQUIRED'
      throw err
    }
  }

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
    pinStdin: values['pin-stdin'] === true,
    keyPassphrase
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

async function openCliAudit(config) {
  const auditConfig = config && config.auditLog && typeof config.auditLog === 'object'
    ? config.auditLog
    : {}
  const audit = createAuditLog({
    enabled: auditConfig.enabled !== false,
    path: auditConfig.path,
    maxBytes: auditConfig.maxBytes,
    log: () => {}
  })
  await audit.init()
  return audit
}

async function commandConnect(values) {
  if (values['secret-stdin'] && values['password-stdin']) {
    const err = new Error(
      'ใช้ --secret-stdin และ --password-stdin พร้อมกันไม่ได้'
    )
    err.code = 'CONFIG_INVALID'
    throw err
  }

  const configPath = values.config
    ? resolveConfigPath(values.config)
    : DEFAULT_CLIENT_CONFIG_PATH

  let existing = null
  try {
    existing = await loadConfig(configPath)
    if (existing.mode !== 'client') {
      const err = new Error(
        'config is for a server; choose another --config path for the client'
      )
      err.code = 'CONFIG_INVALID'
      throw err
    }
  } catch (err) {
    if (!err || err.code !== 'CONFIG_NOT_FOUND') throw err
  }

  const envSecret = typeof process.env.P2PGATE_MASTER_SECRET === 'string'
    ? process.env.P2PGATE_MASTER_SECRET
    : null
  if (envSecret !== null) delete process.env.P2PGATE_MASTER_SECRET

  const envPassword = typeof process.env.P2PGATE_PASSWORD === 'string'
    ? process.env.P2PGATE_PASSWORD
    : null
  if (envPassword !== null) delete process.env.P2PGATE_PASSWORD

  let masterSecret = values.secret || envSecret
  if (!masterSecret && values['secret-stdin']) {
    masterSecret = (await readStdinLine()).trim()
  }
  if (!masterSecret && existing && existing.masterSecret) {
    masterSecret = existing.masterSecret
  }
  if (!masterSecret) {
    try {
      masterSecret = (await promptHidden(
        t('🔑 masterSecret: ', '🔑 masterSecret: ')
      )).trim()
    } catch {
      const err = new Error(
        'masterSecret is required; use -s or P2PGATE_MASTER_SECRET'
      )
      err.code = 'MASTER_SECRET_REQUIRED'
      throw err
    }
  }

  try {
    masterSecret = assertMasterSecret(masterSecret)
  } catch (err) {
    const wrapped = new Error(
      `masterSecret ไม่ถูกต้อง: ${err.message}`
    )
    wrapped.code = 'MASTER_SECRET_INVALID'
    throw wrapped
  }

  let password = values.password || envPassword
  if (!password && values['password-stdin']) {
    password = (await readStdinLine()).trim()
  }
  if (!password) {
    try {
      password = (await promptHidden(
        t('🔑 password: ', '🔑 password: ')
      )).trim()
    } catch {
      const err = new Error(
        'password is required; use -p, --password-stdin, or P2PGATE_PASSWORD'
      )
      err.code = 'PASSWORD_REQUIRED'
      throw err
    }
  }

  if (typeof password !== 'string' || password === '') {
    const err = new Error('password must not be empty')
    err.code = 'PASSWORD_REQUIRED'
    throw err
  }

  if (values.password) {
    process.stderr.write(t(
      '⚠️  การใส่ password บน command line อาจถูกเห็นใน shell history/ps\n',
      '⚠️  Passing the password on the command line may expose it in shell history/ps\n'
    ))
  }

  let localPort = 8022
  if (values.port !== undefined) {
    localPort = Number(values.port)
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      const err = new Error('--port ต้องเป็นตัวเลขระหว่าง 1 ถึง 65535')
      err.code = 'CONFIG_INVALID'
      throw err
    }
  } else if (existing && Number.isInteger(existing.localPort)) {
    localPort = existing.localPort
  }

  const clientKeyPath = existing && existing.clientKeyPath
    ? existing.clientKeyPath
    : DEFAULT_CLIENT_KEY_PATH

  if (!clientKeyExists(clientKeyPath)) {
    const key = await generateClientKey(clientKeyPath)
    process.stdout.write(t(
      `\n🔑 สร้าง client key ใหม่แล้ว: ${key.path}\n`,
      `\n🔑 Created a new client key: ${key.path}\n`
    ))
    process.stdout.write(t(
      `   Public Key: ${key.publicKey}\n`,
      `   Public Key: ${key.publicKey}\n`
    ))
  }

  const config = createClientPasswordConfig({
    masterSecret,
    clientKeyPath,
    localPort
  })

  if (values.port !== undefined) config.localPort = localPort
  await saveConfig(configPath, config)

  process.stdout.write(t(
    '\n=== p2pgate connect ===\n',
    '\n=== p2pgate connect ===\n'
  ))
  process.stdout.write(t(
    `ไฟล์ตั้งค่า: ${configPath}\n`,
    `Config: ${configPath}\n`
  ))

  const client = await startClient(config, {
    credential: password
  })
  const address = client.address()

  process.stdout.write(t('\n✅ อุโมงค์พร้อมใช้งานแล้ว\n', '\n✅ Tunnel is ready\n'))
  process.stdout.write(t(
    `   เปิดพอร์ตเฉพาะ: 127.0.0.1:${address.port}\n`,
    `   Local listener: 127.0.0.1:${address.port}\n`
  ))
  process.stdout.write(t(
    `   วิธีเชื่อมต่อ: ssh -p ${address.port} localhost\n\n`,
    `   Connect with: ssh -p ${address.port} localhost\n\n`
  ))
  process.stdout.write(t('กด Ctrl+C เพื่อหยุดอย่างปลอดภัย\n', 'Press Ctrl+C to stop safely\n'))

  const signal = await waitForShutdownSignal()
  process.stdout.write(t(
    `\nได้รับสัญญาณ ${signal} กำลังปิดระบบ...\n`,
    `\nReceived ${signal}; shutting down...\n`
  ))
  await client.close()
  process.stdout.write(t('ปิดระบบเรียบร้อย\n', 'Client stopped\n'))
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
    const guard = new AuthGuard({})
    await guard.init()

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
      await guard.close()
      return
    }

    for (const device of devices) {
      const source = device.source === 'config'
        ? 'config.json (allowedClientKeys)'
        : 'trusted_devices'
      const lock = guard.getStatus(device.key)
      let lockState = 'ปกติ'

      if (lock.revoked) {
        lockState = 'เพิกถอนด้วยคำสั่ง revoke'
      } else if (lock.permanent) {
        lockState = 'ระงับถาวร'
      } else if (lock.locked) {
        lockState = `ระงับอีก ${formatRemaining(lock.remainingMs)}`
      }

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
      process.stdout.write(`  Lockout: ${lockState}\n`)
      process.stdout.write(`  ล้มเหลวใน 24 ชม.: ${lock.failures} ครั้ง\n`)
    }

    process.stdout.write('\n')
    await guard.close()
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

    const audit = await openCliAudit(config)
    await audit.record('device.add', {
      source: 'cli',
      key: result.key,
      profile,
      expires: values.expires || null,
      permanent: values.permanent === true,
      replaced: result.replaced
    })
    await audit.close()
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

    const audit = await openCliAudit(config)
    await audit.record('device.remove', {
      source: 'cli',
      key: result.key,
      removed: result.removed
    })
    await audit.close()
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
  const token = await readControlToken()
  return sendControlCommand(
    defaultControlSocketPath(),
    { v: CONTROL_VERSION, token, ...request },
    { timeoutMs: 3000 }
  )
}

function isControlUnavailable(err) {
  return err && (
    err.code === 'CONTROL_UNAVAILABLE' ||
    err.code === 'CONTROL_TOKEN_MISSING' ||
    err.code === 'CONTROL_TOKEN_INVALID'
  )
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function commandStatus(values = {}) {
  const json = values.json === true
  let response

  try {
    response = await sendControl({ cmd: 'status' })
  } catch (err) {
    if (isControlUnavailable(err)) {
      if (json) {
        writeJson({
          ok: false,
          error: err.code || 'CONTROL_UNAVAILABLE',
          message: 'server is not running or the control token is unavailable'
        })
      } else {
        process.stderr.write(
          '\n⚠️  ไม่พบเซิร์ฟเวอร์ที่กำลังทำงาน (control socket ไม่พร้อมใช้งาน)\n'
        )
        process.stderr.write('   เริ่มเซิร์ฟเวอร์ด้วย: p2pgate server\n')
      }
      process.exitCode = 1
      return
    }

    throw err
  }

  if (!response || response.ok !== true) {
    if (json) {
      writeJson(response && typeof response === 'object'
        ? response
        : { ok: false, error: 'UNKNOWN' })
    } else {
      process.stderr.write(
        `\n❌ เซิร์ฟเวอร์ตอบกลับผิดพลาด: ${
          response && response.error ? response.error : 'UNKNOWN'
        }\n`
      )
    }
    process.exitCode = 1
    return
  }

  if (json) {
    writeJson({ ...response, ok: true })
    return
  }

  const activeKeys = Array.isArray(response.activeKeys) ? response.activeKeys : []
  const slots = Array.isArray(response.listeningSlots) ? response.listeningSlots : []
  const pinState = response.sessionPinAvailable
    ? `พร้อมใช้ (generation ${response.sessionGeneration})`
    : 'ไม่มี (key-only หรือยังไม่สร้าง)'

  process.stdout.write('\n=== p2pgate status ===\n')
  process.stdout.write(`โหมดยืนยันตัวตน: ${response.verificationMode}\n`)
  process.stdout.write(`โหมดยืนยันสิทธิ์: ${response.authMode || '-'}\n`)
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
    const audit = await openCliAudit(null)
    await audit.record('device.revoke', {
      source: 'cli',
      key: status.key,
      mode: 'offline'
    })
    await audit.close()
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
  const result = await runDoctor({
    configPath,
    json: values.json === true
  })
  if (result && result.exitCode) {
    process.exitCode = result.exitCode
  }
}

async function commandPassword(values, positionals) {
  if (positionals[1] !== 'reset') {
    process.stderr.write(t(
      '❌ การใช้งาน: p2pgate password reset\n',
      '❌ Usage: p2pgate password reset\n'
    ))
    process.exitCode = 1
    return
  }

  const configPath = resolveConfigPath(values.config)
  const config = await loadConfig(configPath)

  if (config.mode !== 'server' || config.authMode !== 'password') {
    process.stderr.write(t(
      '❌ คำสั่งนี้ใช้ได้เฉพาะ Server ที่ใช้ authMode=password\n',
      '❌ This command requires a Server with authMode=password\n'
    ))
    process.exitCode = 1
    return
  }

  const password = generateConnectionPassword()
  const verifier = await deriveScramVerifier(password)
  config.authPin = {
    enabled: true,
    unattended: serializeScramVerifier(verifier)
  }

  await saveConfig(configPath, config)

  process.stdout.write(t(
    `\n✅ ตั้ง password ใหม่แล้ว: ${password}\n`,
    `\n✅ New connection password: ${password}\n`
  ))
  process.stdout.write(t(
    '   ถ้า Server กำลังรันอยู่ ให้รีสตาร์ตเพื่อใช้ค่าใหม่\n\n',
    '   If the Server is running, restart it to use the new password\n\n'
  ))

  const audit = await openCliAudit(config)
  await audit.record('password.reset', { source: 'cli' })
  await audit.close()
}

async function commandUnlock(values, positionals) {
  let config = null
  try {
    config = await loadConfig(resolveConfigPath(values.config))
  } catch {
    // Unlock works without a config file; audit uses the default path.
  }

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
      const audit = await openCliAudit(config)
      await audit.record('device.unlock_all', {
        source: 'cli',
        count
      })
      await audit.close()
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
    const audit = await openCliAudit(config)
    await audit.record('device.unlock', {
      source: 'cli',
      key: keyHex,
      existed
    })
    await audit.close()

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
        port: { type: 'string' },
        secret: { type: 'string', short: 's' },
        password: { type: 'string', short: 'p' },
        'secret-stdin': { type: 'boolean' },
        'password-stdin': { type: 'boolean' },
        lang: { type: 'string' },
        easy: { type: 'boolean' },
        quick: { type: 'boolean' },
        'pin-stdin': { type: 'boolean' },
        'key-passphrase-stdin': { type: 'boolean' },
        passphrase: { type: 'boolean' },
        'passphrase-stdin': { type: 'boolean' },
        unprotect: { type: 'boolean' },
        json: { type: 'boolean' },
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

  try {
    setLanguage(values.lang)
  } catch (err) {
    process.stderr.write(`❌ ${err.message}\n`)
    process.exitCode = 1
    return
  }

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
      await runSetupWizard({
        configPath,
        easy: values.easy === true || values.quick === true,
        mode: values.mode
      })
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
    case 'connect':
      await commandConnect(values)
      return
    case 'devices':
      await commandDevices(values, positionals)
      return
    case 'status':
      await commandStatus(values)
      return
    case 'pin':
      await commandPin()
      return
    case 'revoke':
      await commandRevoke(positionals)
      return
    case 'password':
      await commandPassword(values, positionals)
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
