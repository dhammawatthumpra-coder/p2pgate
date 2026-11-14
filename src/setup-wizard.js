'use strict'

const readline = require('node:readline/promises')
const {
  DEFAULT_CONFIG_PATH,
  DEFAULT_CLIENT_KEY_PATH,
  readConfigRaw,
  saveConfig
} = require('./config-loader')
const {
  assertMasterSecret,
  isMasterSecretValid,
  generateMasterSecret,
  normalizeClientPublicKeyHex,
  deriveScramVerifier,
  serializeScramVerifier
} = require('./crypto-utils')
const {
  clientKeyExists,
  generateClientKey,
  loadClientKey
} = require('./keygen')
const { promptHidden } = require('./auth')
const { DEFAULT_TRUSTED_DEVICES_PATH } = require('./device-registry')

async function askYesNo(rl, question, defaultYes = true) {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]'

  while (true) {
    const answer = (await rl.question(`${question} ${suffix}: `)).trim().toLowerCase()

    if (answer === '') return defaultYes
    if (['y', 'yes', 'ใช่', 'ครับ', 'ค่ะ', 'ค'].includes(answer)) return true
    if (['n', 'no', 'ไม่', 'ม'].includes(answer)) return false

    console.log('กรุณาตอบ y (ใช่) หรือ n (ไม่)')
  }
}

async function askPort(rl, question, defaultValue) {
  while (true) {
    const answer = (await rl.question(`${question} [${defaultValue}]: `)).trim()
    if (answer === '') return defaultValue

    const port = Number(answer)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port

    console.log('❌ พอร์ตต้องเป็นตัวเลขระหว่าง 1 ถึง 65535')
  }
}

async function askNonEmpty(rl, question) {
  while (true) {
    const answer = (await rl.question(question)).trim()
    if (answer !== '') return answer
    console.log('❌ ค่านี้ห้ามว่าง')
  }
}

async function askChoice(rl, question, allowed) {
  while (true) {
    const answer = (await rl.question(question)).trim()
    if (allowed.includes(answer)) return answer
    console.log(`กรุณาเลือก ${allowed.join(' หรือ ')}`)
  }
}

async function askVerificationMode(rl, currentMode) {
  const defaultNumber = currentMode === 'key-only'
    ? '2'
    : currentMode === 'two-step'
      ? '3'
      : '1'

  while (true) {
    const answer = (await rl.question(
      [
        '',
        'เลือกโหมดการยืนยันตัวตน:',
        '  1) hybrid (แนะนำ) — trusted devices ใช้ fast-path, อื่น ๆ ใช้ two-step',
        '  2) key-only — ใช้ Public Key เท่านั้น ไม่ถาม PIN',
        '  3) two-step — ถาม PIN/รหัสผ่านทุกครั้ง',
        `เลือก [${defaultNumber}]: `
      ].join('\n')
    )).trim()

    const selected = answer === '' ? defaultNumber : answer

    if (selected === '1') return 'hybrid'
    if (selected === '2') return 'key-only'
    if (selected === '3') return 'two-step'

    console.log('กรุณาเลือก 1, 2 หรือ 3')
  }
}

function safeExistingMasterSecret(raw) {
  if (!raw || typeof raw.masterSecret !== 'string') return null
  if (!isMasterSecretValid(raw.masterSecret)) return null

  try {
    return assertMasterSecret(raw.masterSecret)
  } catch {
    return null
  }
}

function safeExistingKeys(raw) {
  if (!raw || !Array.isArray(raw.allowedClientKeys)) return []

  const keys = []
  const seen = new Set()

  for (const value of raw.allowedClientKeys) {
    try {
      const normalized = normalizeClientPublicKeyHex(value)
      if (!seen.has(normalized)) {
        seen.add(normalized)
        keys.push(normalized)
      }
    } catch {
      // Ignore malformed old entries; the user can paste them again.
    }
  }

  return keys
}

/**
 * Interactive, beginner-friendly setup wizard (Thai).
 */
async function runSetupWizard(options = {}) {
  const configPath = options.configPath || DEFAULT_CONFIG_PATH
  const input = options.input || process.stdin
  const output = options.output || process.stdout

  let existing = null
  try {
    existing = await readConfigRaw(configPath)
  } catch (err) {
    if (!err || err.code !== 'CONFIG_NOT_FOUND') throw err
  }

  let rl = readline.createInterface({ input, output })

  const askHidden = async (question) => {
    // readline and raw-mode hidden input cannot consume stdin at the same
    // time, so close the interface, read the secret, then reopen it.
    rl.close()

    try {
      return await promptHidden(question, { input, output })
    } finally {
      rl = readline.createInterface({ input, output })
    }
  }

  try {
    output.write('\n=== p2pgate setup ===\n')
    output.write('ยินดีต้อนรับ! ตัวช่วยนี้จะสร้างไฟล์ตั้งค่าให้อย่างปลอดภัย\n\n')

    const modeAnswer = await askChoice(
      rl,
      [
        'เครื่องนี้จะทำหน้าที่อะไร?',
        '  1) Server (เครื่องที่เปิด SSH ไว้ เช่น Redmi 14C ใน Termux)',
        '  2) Client (เครื่องที่ใช้ ssh เข้ามา เช่น PC/Mac/โทรศัพท์)',
        'เลือก 1 หรือ 2: '
      ].join('\n'),
      ['1', '2']
    )

    const mode = modeAnswer === '1' ? 'server' : 'client'

    output.write('\n--- กุญแจลับกลาง (masterSecret) ---\n')

    let masterSecret = safeExistingMasterSecret(existing)

    if (mode === 'server') {
      if (masterSecret) {
        const keep = await askYesNo(
          rl,
          'พบ masterSecret เดิมอยู่แล้ว ต้องการใช้ค่าเดิมต่อหรือไม่?',
          true
        )
        if (!keep) masterSecret = null
      }

      if (!masterSecret) {
        masterSecret = generateMasterSecret()
        output.write('สร้าง masterSecret ใหม่ให้แล้ว\n')
      }

      output.write('\nmasterSecret ของคุณ (เก็บเป็นความลับ ห้ามส่งให้คนอื่น):\n')
      output.write(`  ${masterSecret}\n`)
      output.write('นำค่านี้ไปวางในเครื่อง Client ตอนรัน setup เท่านั้น\n\n')
    } else {
      if (masterSecret) {
        const keep = await askYesNo(
          rl,
          'พบ masterSecret เดิมอยู่แล้ว ต้องการใช้ค่าเดิมต่อหรือไม่?',
          true
        )
        if (!keep) masterSecret = null
      }

      while (!masterSecret) {
        const answer = (await rl.question(
          'วาง masterSecret 64 ตัวอักษรที่ได้จากเครื่อง Server: '
        )).trim()

        try {
          masterSecret = assertMasterSecret(answer)
        } catch (err) {
          output.write(`❌ ${err.message}\n`)
          output.write('   ตัวอย่างที่ถูกต้อง: ตัวอักษร 0-9 และ a-f จำนวน 64 ตัว\n')
        }
      }
    }

    output.write('--- พอร์ต ---\n')

    let targetPort = Number.isInteger(existing && existing.targetPort)
      ? existing.targetPort
      : 8022

    if (mode === 'server') {
      targetPort = await askPort(
        rl,
        'พอร์ต SSH ของเครื่องนี้ (Termux ใช้ 8022)',
        targetPort
      )
    }

    let localPort = Number.isInteger(existing && existing.localPort)
      ? existing.localPort
      : 8022

    if (mode === 'client') {
      localPort = await askPort(
        rl,
        'พอร์ตที่จะเปิดบนเครื่องนี้ (127.0.0.1) เพื่อให้ ssh ต่อเข้ามา',
        localPort
      )
    }

    const clientKeyPath = (existing && typeof existing.clientKeyPath === 'string')
      ? existing.clientKeyPath
      : DEFAULT_CLIENT_KEY_PATH

    let clientPublicKey = null
    let clientKeyCreated = false

    if (mode === 'client') {
      output.write('\n--- กุญแจประจำเครื่อง Client ---\n')

      if (clientKeyExists(clientKeyPath)) {
        const loaded = await loadClientKey(clientKeyPath)
        clientPublicKey = loaded.publicKey
        output.write(`พบกุญแจเดิม: ${loaded.path}\n`)
      } else {
        const generated = await generateClientKey(clientKeyPath)
        clientPublicKey = generated.publicKey
        clientKeyCreated = true
        output.write(`สร้างกุญแจใหม่ให้แล้ว: ${generated.path}\n`)
      }

      output.write('\nPublic Key ของเครื่องนี้ (นำไปเพิ่มในเครื่อง Server):\n')
      output.write(`  ${clientPublicKey}\n\n`)
    }

    const allowedKeys = new Set(safeExistingKeys(existing))

    if (mode === 'server') {
      output.write('\n--- รายชื่อเครื่อง Client ที่อนุญาต ---\n')

      if (allowedKeys.size > 0) {
        output.write(`พบ Public Key เดิม ${allowedKeys.size} รายการ:\n`)
        for (const key of allowedKeys) output.write(`  - ${key}\n`)
        output.write('\n')
      }

      output.write(
        'วาง Public Key ของเครื่องลูกข่าย (64 ตัวอักษร hex) ทีละอัน แล้วกด Enter\n'
      )

      while (true) {
        const answer = (await rl.question('Public Key (เว้นว่างเพื่อจบ): ')).trim()
        if (answer === '') break

        try {
          const normalized = normalizeClientPublicKeyHex(answer)
          if (allowedKeys.has(normalized)) {
            output.write('ℹ️  คีย์นี้มีอยู่แล้ว\n')
          } else {
            allowedKeys.add(normalized)
            output.write('✅ เพิ่ม Public Key แล้ว\n')
          }
        } catch (err) {
          output.write(`❌ ${err.message}\n`)
        }
      }

      if (allowedKeys.size === 0) {
        output.write('\n⚠️  ยังไม่มี Public Key เลย\n')
        output.write(
          'เซิร์ฟเวอร์จะยังไม่ยอมเริ่มทำงานจนกว่าจะมีอย่างน้อย 1 คีย์\n'
        )
        output.write(
          'วิธีแก้: รัน `p2pgate keygen` บนเครื่อง Client แล้วนำ Public Key มาใส่\n\n'
        )

        const saveAnyway = await askYesNo(
          rl,
          'บันทึก config ไว้ก่อนหรือไม่? (ภายหลังแก้ไฟล์หรือรัน setup ใหม่ได้)',
          true
        )

        if (!saveAnyway) {
          output.write('ยกเลิกการบันทึกแล้ว ยังไม่มีการเปลี่ยนแปลงใด ๆ\n')
          return { saved: false, configPath, mode }
        }
      }
    }

    const existingAuthPin = existing && existing.authPin
    const existingModeRaw = existing && existing.verificationMode
    let verificationMode = existingModeRaw &&
      ['hybrid', 'key-only', 'two-step'].includes(String(existingModeRaw).trim().toLowerCase())
      ? String(existingModeRaw).trim().toLowerCase()
      : (existingAuthPin && existingAuthPin.enabled === false ? 'key-only' : 'hybrid')

    let unattendedVerifier = existingAuthPin &&
      existingAuthPin.unattended &&
      typeof existingAuthPin.unattended === 'object'
      ? existingAuthPin.unattended
      : null

    if (existingAuthPin && existingAuthPin.unattendedPasswordHash !== undefined) {
      output.write(
        '\n⚠️  พบรูปแบบรหัสผ่านสำรองจาก v1.1 ซึ่งใช้กับ v1.3 ไม่ได้\n'
      )
      output.write('   กรุณาตั้งรหัสผ่านสำรองใหม่ (อย่างน้อย 12 ตัวอักษร)\n')
      unattendedVerifier = null
    }

    if (mode === 'server') {
      output.write('\n--- นโยบายการยืนยันตัวตน ---\n')
      verificationMode = await askVerificationMode(rl, verificationMode)

      if (verificationMode === 'key-only') {
        unattendedVerifier = null
        output.write(
          'ℹ️  key-only: ตรวจเฉพาะ Public Key ไม่มี Session PIN และไม่ถามรหัสผ่าน\n'
        )
        output.write(
          '   จัดการคีย์ด้วย: p2pgate devices list / devices add / devices remove\n'
        )
      } else {
        if (unattendedVerifier) {
          const keep = await askYesNo(
            rl,
            'คงรหัสผ่านสำรอง (Unattended Password) เดิมไว้หรือไม่?',
            true
          )

          if (!keep) unattendedVerifier = null
        }

        if (!unattendedVerifier) {
          const enable = await askYesNo(
            rl,
            'ต้องการตั้งรหัสผ่านสำรองสำหรับเชื่อมต่อตอนไม่อยู่บ้านหรือไม่?',
            false
          )

          if (enable) {
            while (true) {
              const first = (await askHidden(
                'ตั้งรหัสผ่านสำรอง (อย่างน้อย 12 ตัวอักษร): '
              )).trim()

              if (first.length < 12) {
                output.write('❌ รหัสผ่านต้องยาวอย่างน้อย 12 ตัวอักษร\n')
                continue
              }

              const second = (await askHidden('ยืนยันรหัสผ่านสำรองอีกครั้ง: ')).trim()

              if (first !== second) {
                output.write('❌ รหัสผ่านทั้งสองครั้งไม่ตรงกัน\n')
                continue
              }

              const verifier = await deriveScramVerifier(first)
              unattendedVerifier = serializeScramVerifier(verifier)
              output.write(
                '✅ ตั้งรหัสผ่านสำรองแล้ว (เก็บเฉพาะค่า SCRAM verifier)\n'
              )
              break
            }
          }
        }
      }
    }

    const trustedDevicesFile = existing &&
      typeof existing.trustedDevicesFile === 'string' &&
      existing.trustedDevicesFile.trim() !== ''
      ? existing.trustedDevicesFile
      : DEFAULT_TRUSTED_DEVICES_PATH

    output.write('\n--- การแจ้งเตือน Telegram (ไม่บังคับ) ---\n')

    const existingTelegram = existing && existing.telegramAlert
    let telegramAlert = { enabled: false, botToken: '', chatId: '' }

    let keepTelegram = false
    if (
      existingTelegram &&
      existingTelegram.enabled === true &&
      existingTelegram.botToken &&
      existingTelegram.chatId
    ) {
      keepTelegram = await askYesNo(
        rl,
        'คงการแจ้งเตือน Telegram เดิมไว้หรือไม่?',
        true
      )
      if (keepTelegram) {
        telegramAlert = {
          enabled: true,
          botToken: String(existingTelegram.botToken),
          chatId: String(existingTelegram.chatId)
        }
      }
    }

    if (!keepTelegram) {
      const enable = await askYesNo(
        rl,
        'ต้องการแจ้งเตือนทาง Telegram เมื่อมีคนพยายามเชื่อมต่อหรือไม่?',
        false
      )

      if (enable) {
        const botToken = await askNonEmpty(
          rl,
          'วาง Bot Token จาก @BotFather: '
        )
        const chatId = await askNonEmpty(rl, 'วาง Chat ID ปลายทาง: ')
        telegramAlert = { enabled: true, botToken, chatId }
      }
    }

    const config = {
      mode,
      masterSecret,
      targetHost: '127.0.0.1',
      targetPort,
      localPort,
      clientKeyPath,
      allowedClientKeys: [...allowedKeys],
      verificationMode,
      trustedDevicesFile,
      auditLog: existing && existing.auditLog ? existing.auditLog : undefined,
      customBootstrap: Array.isArray(existing && existing.customBootstrap)
        ? existing.customBootstrap
        : [],
      authPin: {
        enabled: verificationMode !== 'key-only',
        // Client configs never need the server's password verifier.
        unattended: mode === 'server' && verificationMode !== 'key-only'
          ? unattendedVerifier
          : null
      },
      telegramAlert
    }

    const saved = await saveConfig(configPath, config)

    output.write('\n✅ บันทึกการตั้งค่าแล้ว\n')
    output.write(`   ไฟล์: ${configPath}\n`)
    output.write(`   โหมด: ${saved.mode}\n`)
    output.write(`   นโยบายยืนยันตัวตน: ${saved.verificationMode}\n`)
    output.write(`   ไฟล์ trusted devices: ${saved.trustedDevicesFile}\n\n`)

    if (mode === 'server') {
      output.write('ขั้นตอนถัดไป (เครื่อง Server):\n')
      output.write('  1) ตรวจสอบว่า sshd ทำงานอยู่แล้ว\n')
      output.write('  2) ปิดการล็อกอินด้วยรหัสผ่าน (ใช้กุญแจ SSH เท่านั้น)\n')
      if (saved.verificationMode === 'key-only') {
        output.write('  3) เพิ่ม/ตรวจสอบอุปกรณ์ด้วย: p2pgate devices list\n')
        output.write('  4) เริ่มทำงานด้วยคำสั่ง: p2pgate server\n')
      } else {
        output.write('  3) เพิ่ม/ตรวจสอบอุปกรณ์ด้วย: p2pgate devices list\n')
        output.write('  4) เริ่มทำงานด้วยคำสั่ง: p2pgate server\n')
        output.write('     (ระบบจะแสดง Session PIN เมื่อรันใน terminal)\n')
      }
      output.write('  5) ถ้าต้องการเปิดอัตโนมัติ ให้ใช้ Termux:Boot ตามคู่มือ README\n\n')
    } else {
      output.write('ขั้นตอนถัดไป (เครื่อง Client):\n')
      output.write('  1) นำ Public Key นี้ไปเพิ่มใน allowedClientKeys บนเครื่อง Server:\n')
      output.write(`     ${clientPublicKey}\n`)
      output.write('  2) เริ่มอุโมงค์ด้วยคำสั่ง: p2pgate client\n')
      output.write(`  3) เปิด terminal ใหม่แล้วเชื่อมต่อ: ssh -p ${localPort} localhost\n\n`)

      if (!clientKeyCreated) {
        output.write(
          'ℹ️  ถ้า Server ยังไม่รู้จักกุญแจนี้ ให้คัดลอก Public Key ด้านบนไปเพิ่มก่อน\n'
        )
      }
    }

    return {
      saved: true,
      configPath,
      mode,
      publicKey: clientPublicKey,
      localPort,
      targetPort
    }
  } finally {
    rl.close()
  }
}

module.exports = {
  runSetupWizard
}
