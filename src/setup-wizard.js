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
  inspectClientKey
} = require('./keygen')
const { promptHidden } = require('./auth')
const { DEFAULT_TRUSTED_DEVICES_PATH } = require('./device-registry')
const { t } = require('./i18n')
const { generateConnectionPassword } = require('./quickstart')

async function askYesNo(rl, question, defaultYes = true) {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]'

  while (true) {
    const answer = (await rl.question(`${question} ${suffix}: `)).trim().toLowerCase()

    if (answer === '') return defaultYes
    if (['y', 'yes', 'ใช่', 'ครับ', 'ค่ะ', 'ค'].includes(answer)) return true
    if (['n', 'no', 'ไม่', 'ม'].includes(answer)) return false

    console.log(t('กรุณาตอบ y (ใช่) หรือ n (ไม่)', 'Please answer y (yes) or n (no)'))
  }
}

async function askPort(rl, question, defaultValue) {
  while (true) {
    const answer = (await rl.question(`${question} [${defaultValue}]: `)).trim()
    if (answer === '') return defaultValue

    const port = Number(answer)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port

    console.log(t(
      '❌ พอร์ตต้องเป็นตัวเลขระหว่าง 1 ถึง 65535',
      '❌ Port must be an integer between 1 and 65535'
    ))
  }
}

async function askNonEmpty(rl, question) {
  while (true) {
    const answer = (await rl.question(question)).trim()
    if (answer !== '') return answer
    console.log(t('❌ ค่านี้ห้ามว่าง', '❌ This value cannot be empty'))
  }
}

async function askChoice(rl, question, allowed) {
  while (true) {
    const answer = (await rl.question(question)).trim()
    if (allowed.includes(answer)) return answer
    console.log(t(
      `กรุณาเลือก ${allowed.join(' หรือ ')}`,
      `Please choose ${allowed.join(' or ')}`
    ))
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
        t('เลือกโหมดการยืนยันตัวตน:', 'Choose a verification mode:'),
        t(
          '  1) hybrid (แนะนำ) — trusted devices ใช้ fast-path, อื่น ๆ ใช้ two-step',
          '  1) hybrid (recommended) — trusted devices use fast-path, others use two-step'
        ),
        t(
          '  2) key-only — ใช้ Public Key เท่านั้น ไม่ถาม PIN',
          '  2) key-only — public key only, no PIN prompt'
        ),
        t(
          '  3) two-step — ถาม PIN/รหัสผ่านทุกครั้ง',
          '  3) two-step — ask for PIN/password every time'
        ),
        t(`เลือก [${defaultNumber}]: `, `Select [${defaultNumber}]: `)
      ].join('\n')
    )).trim()

    const selected = answer === '' ? defaultNumber : answer

    if (selected === '1') return 'hybrid'
    if (selected === '2') return 'key-only'
    if (selected === '3') return 'two-step'

    console.log(t('กรุณาเลือก 1, 2 หรือ 3', 'Please choose 1, 2, or 3'))
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

async function runEasySetup({ rl, output, existing, configPath, requestedMode }) {
  output.write('\n=== p2pgate setup (easy) ===\n')
  output.write(t(
    'ใช้ค่าที่แนะนำโดยอัตโนมัติ: hybrid, พอร์ต 8022, ไม่ตั้ง Telegram\n\n',
    'Using recommended defaults: hybrid, port 8022, Telegram disabled\n\n'
  ))

  let mode = requestedMode
  if (mode !== 'server' && mode !== 'client') {
    const answer = await askChoice(
      rl,
      [
        t('เครื่องนี้จะทำหน้าที่อะไร?', 'What role is this machine?'),
        t('  1) Server (เครื่องที่รัน SSH server)', '  1) Server (runs the SSH server)'),
        t('  2) Client (เครื่องที่ใช้เชื่อมต่อ)', '  2) Client (connects to the Server)'),
        t('เลือก 1 หรือ 2: ', 'Select 1 or 2: ')
      ].join('\n'),
      ['1', '2']
    )
    mode = answer === '1' ? 'server' : 'client'
  }

  let masterSecret = safeExistingMasterSecret(existing)

  if (mode === 'server') {
    if (!masterSecret) {
      masterSecret = generateMasterSecret()
      output.write(t(
        'สร้าง masterSecret ใหม่ให้แล้ว\n',
        'Generated a new masterSecret\n'
      ))
    }
    output.write(t(
      '\nmasterSecret ของคุณ (เก็บเป็นความลับ):\n',
      '\nYour masterSecret (keep it secret):\n'
    ))
    output.write(`  ${masterSecret}\n`)
  } else if (!masterSecret) {
    while (!masterSecret) {
      const answer = (await rl.question(t(
        'วาง masterSecret 64 ตัวอักษรจากเครื่อง Server: ',
        'Paste the 64-character masterSecret from the Server: '
      ))).trim()

      try {
        masterSecret = assertMasterSecret(answer)
      } catch (err) {
        output.write(`❌ ${err.message}\n`)
      }
    }
  }

  const targetPort = Number.isInteger(existing && existing.targetPort)
    ? existing.targetPort
    : 8022
  const localPort = Number.isInteger(existing && existing.localPort)
    ? existing.localPort
    : 8022

  const clientKeyPath = (existing && typeof existing.clientKeyPath === 'string')
    ? existing.clientKeyPath
    : DEFAULT_CLIENT_KEY_PATH

  let clientPublicKey = null
  let clientKeyCreated = false

  if (mode === 'client') {
    if (clientKeyExists(clientKeyPath)) {
      const loaded = await inspectClientKey(clientKeyPath)
      clientPublicKey = loaded.publicKey
      output.write(t(
        `\nพบกุญแจ Client เดิม: ${loaded.path}\n`,
        `\nFound existing client key: ${loaded.path}\n`
      ))
      if (loaded.encrypted) {
        output.write(t(
          'ℹ️  กุญแจนี้ป้องกันด้วย passphrase\n',
          'ℹ️  This key is passphrase-protected\n'
        ))
      }
    } else {
      const generated = await generateClientKey(clientKeyPath)
      clientPublicKey = generated.publicKey
      clientKeyCreated = true
      output.write(t(
        `\nสร้างกุญแจ Client ใหม่: ${generated.path}\n`,
        `\nCreated a new client key: ${generated.path}\n`
      ))
    }

    output.write(t(
      '\nPublic Key ของเครื่องนี้ (นำไปเพิ่มที่ Server):\n',
      '\nThis machine\'s public key (add it on the Server):\n'
    ))
    output.write(`  ${clientPublicKey}\n`)
  }

  const allowedKeys = new Set(safeExistingKeys(existing))

  if (mode === 'server' && allowedKeys.size > 0) {
    output.write(t(
      `\nพบ Public Key เดิม ${allowedKeys.size} รายการ (ใช้เป็น trusted/fast-path ได้)\n`,
      `\nFound ${allowedKeys.size} existing public key(s) (usable for trusted fast-path)\n`
    ))
  }

  const existingModeRaw = existing && existing.verificationMode
  let verificationMode = existingModeRaw &&
    ['hybrid', 'key-only', 'two-step'].includes(String(existingModeRaw).trim().toLowerCase())
    ? String(existingModeRaw).trim().toLowerCase()
    : 'hybrid'

  if (mode === 'server' && verificationMode === 'key-only') {
    verificationMode = 'hybrid'
  }

  const trustedDevicesFile = existing &&
    typeof existing.trustedDevicesFile === 'string' &&
    existing.trustedDevicesFile.trim() !== ''
    ? existing.trustedDevicesFile
    : DEFAULT_TRUSTED_DEVICES_PATH

  const existingAuthPin = existing && existing.authPin
  let unattendedVerifier = existingAuthPin &&
    existingAuthPin.unattended &&
    typeof existingAuthPin.unattended === 'object'
    ? existingAuthPin.unattended
    : null
  let connectionPassword = null

  if (mode === 'server' && !unattendedVerifier) {
    connectionPassword = generateConnectionPassword()
    const verifier = await deriveScramVerifier(connectionPassword)
    unattendedVerifier = serializeScramVerifier(verifier)
  }

  const config = {
    mode,
    masterSecret,
    authMode: 'password',
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
      enabled: true,
      unattended: unattendedVerifier
    },
    telegramAlert: existing && existing.telegramAlert
      ? existing.telegramAlert
      : { enabled: false, botToken: '', chatId: '' }
  }

  const saved = await saveConfig(configPath, config)

  output.write(t(
    `\n✅ บันทึกการตั้งค่าแล้ว: ${configPath}\n`,
    `\n✅ Configuration saved: ${configPath}\n`
  ))
  output.write(t(
    `   โหมด: ${saved.mode}\n   นโยบายยืนยันตัวตน: ${saved.verificationMode}\n`,
    `   Mode: ${saved.mode}\n   Verification: ${saved.verificationMode}\n`
  ))

  if (connectionPassword) {
    output.write(t(
      `   password: ${connectionPassword}\n`,
      `   password: ${connectionPassword}\n`
    ))
    output.write(t(
      '   (เก็บเป็นความลับ; Client ใช้ masterSecret + password นี้)\n',
      '   (Keep it secret; clients use this masterSecret + password)\n'
    ))
  }

  if (mode === 'server') {
    output.write(t(
      '\nขั้นตอนถัดไป:\n  1) ตรวจสอบ sshd\n  2) รัน: p2pgate server\n  3) เพิ่มอุปกรณ์: p2pgate devices add <key>\n\n',
      '\nNext steps:\n  1) Verify sshd is running\n  2) Run: p2pgate server\n  3) Add devices: p2pgate devices add <key>\n\n'
    ))
  } else {
    output.write(t(
      `\nขั้นตอนถัดไป:\n  1) เพิ่ม Public Key นี้ที่ Server\n  2) รัน: p2pgate client\n  3) เชื่อมต่อ: ssh -p ${localPort} localhost\n\n`,
      `\nNext steps:\n  1) Add this public key on the Server\n  2) Run: p2pgate client\n  3) Connect: ssh -p ${localPort} localhost\n\n`
    ))
  }

  return {
    saved: true,
    configPath,
    mode,
    publicKey: clientPublicKey,
    localPort,
    targetPort,
    easy: true
  }
}

/**
 * Interactive, beginner-friendly setup wizard.
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
    output.write(t(
      'ยินดีต้อนรับ! ตัวช่วยนี้จะสร้างไฟล์ตั้งค่าให้อย่างปลอดภัย\n\n',
      'Welcome! This wizard creates a secure configuration file.\n\n'
    ))

    if (options.easy) {
      return await runEasySetup({
        rl,
        output,
        existing,
        configPath,
        requestedMode: options.mode
      })
    }

    const modeAnswer = await askChoice(
      rl,
      [
        t('เครื่องนี้จะทำหน้าที่อะไร?', 'What role is this machine?'),
        t(
          '  1) Server (เครื่องที่รัน SSH server)',
          '  1) Server (runs the SSH server)'
        ),
        t(
          '  2) Client (เครื่องที่ใช้เชื่อมต่อ)',
          '  2) Client (connects to the Server)'
        ),
        t('เลือก 1 หรือ 2: ', 'Select 1 or 2: ')
      ].join('\n'),
      ['1', '2']
    )

    const mode = modeAnswer === '1' ? 'server' : 'client'

    output.write(t(
      '\n--- กุญแจลับกลาง (masterSecret) ---\n',
      '\n--- Shared secret (masterSecret) ---\n'
    ))

    let masterSecret = safeExistingMasterSecret(existing)

    if (mode === 'server') {
      if (masterSecret) {
        const keep = await askYesNo(
          rl,
          t(
            'พบ masterSecret เดิมอยู่แล้ว ต้องการใช้ค่าเดิมต่อหรือไม่?',
            'An existing masterSecret was found. Keep it?'
          ),
          true
        )
        if (!keep) masterSecret = null
      }

      if (!masterSecret) {
        masterSecret = generateMasterSecret()
        output.write(t(
          'สร้าง masterSecret ใหม่ให้แล้ว\n',
          'Generated a new masterSecret\n'
        ))
      }

      output.write(t(
        '\nmasterSecret ของคุณ (เก็บเป็นความลับ ห้ามส่งให้คนอื่น):\n',
        '\nYour masterSecret (keep it secret):\n'
      ))
      output.write(`  ${masterSecret}\n`)
      output.write(t(
        'นำค่านี้ไปใช้ที่ Client (p2pgate connect)\n\n',
        'Use it on the Client (p2pgate connect)\n\n'
      ))
    } else {
      if (masterSecret) {
        const keep = await askYesNo(
          rl,
          t(
            'พบ masterSecret เดิมอยู่แล้ว ต้องการใช้ค่าเดิมต่อหรือไม่?',
            'An existing masterSecret was found. Keep it?'
          ),
          true
        )
        if (!keep) masterSecret = null
      }

      while (!masterSecret) {
        const answer = (await rl.question(t(
          'วาง masterSecret 64 ตัวอักษรที่ได้จากเครื่อง Server: ',
          'Paste the 64-character masterSecret from the Server: '
        ))).trim()

        try {
          masterSecret = assertMasterSecret(answer)
        } catch (err) {
          output.write(`❌ ${err.message}\n`)
          output.write(t(
            '   ตัวอย่างที่ถูกต้อง: ตัวอักษร 0-9 และ a-f จำนวน 64 ตัว\n',
            '   Expected: 64 hexadecimal characters (0-9, a-f)\n'
          ))
        }
      }
    }

    output.write(t('--- พอร์ต ---\n', '--- Ports ---\n'))

    let targetPort = Number.isInteger(existing && existing.targetPort)
      ? existing.targetPort
      : 8022

    if (mode === 'server') {
      targetPort = await askPort(
        rl,
        t(
          'พอร์ต SSH ของเครื่องนี้ (ค่าเริ่มต้น 8022 สำหรับ Termux)',
          'SSH port on this machine (default 8022 for Termux)'
        ),
        targetPort
      )
    }

    let localPort = Number.isInteger(existing && existing.localPort)
      ? existing.localPort
      : 8022

    if (mode === 'client') {
      localPort = await askPort(
        rl,
        t(
          'พอร์ตที่จะเปิดบนเครื่องนี้ (127.0.0.1) เพื่อให้ ssh ต่อเข้ามา',
          'Local port to open on 127.0.0.1 for ssh'
        ),
        localPort
      )
    }

    const clientKeyPath = (existing && typeof existing.clientKeyPath === 'string')
      ? existing.clientKeyPath
      : DEFAULT_CLIENT_KEY_PATH

    let clientPublicKey = null
    let clientKeyCreated = false

    if (mode === 'client') {
      output.write(t(
        '\n--- กุญแจประจำเครื่อง Client ---\n',
        '\n--- Client key ---\n'
      ))

      if (clientKeyExists(clientKeyPath)) {
        const loaded = await inspectClientKey(clientKeyPath)
        clientPublicKey = loaded.publicKey
        output.write(t(
          `พบกุญแจเดิม: ${loaded.path}\n`,
          `Found existing key: ${loaded.path}\n`
        ))
      } else {
        const generated = await generateClientKey(clientKeyPath)
        clientPublicKey = generated.publicKey
        clientKeyCreated = true
        output.write(t(
          `สร้างกุญแจใหม่ให้แล้ว: ${generated.path}\n`,
          `Created a new key: ${generated.path}\n`
        ))
      }

      output.write(t(
        '\nPublic Key ของเครื่องนี้ (นำไปเพิ่มที่ Server):\n',
        '\nThis machine\'s public key (add it on the Server):\n'
      ))
      output.write(`  ${clientPublicKey}\n\n`)
    }

    const allowedKeys = new Set(safeExistingKeys(existing))

    if (mode === 'server') {
      output.write(t(
        '\n--- รายชื่อเครื่อง Client ที่อนุญาต ---\n',
        '\n--- Allowed client keys ---\n'
      ))

      if (allowedKeys.size > 0) {
        output.write(t(
          `พบ Public Key เดิม ${allowedKeys.size} รายการ:\n`,
          `Found ${allowedKeys.size} existing public key(s):\n`
        ))
        for (const key of allowedKeys) output.write(`  - ${key}\n`)
        output.write('\n')
      }

      output.write(t(
        'วาง Public Key ของเครื่องลูกข่าย (64 ตัวอักษร hex) ทีละอัน แล้วกด Enter\n',
        'Paste client public keys (64 hex characters), one per line\n'
      ))

      while (true) {
        const answer = (await rl.question(t(
          'Public Key (เว้นว่างเพื่อจบ): ',
          'Public Key (leave blank to finish): '
        ))).trim()
        if (answer === '') break

        try {
          const normalized = normalizeClientPublicKeyHex(answer)
          if (allowedKeys.has(normalized)) {
            output.write(t('ℹ️  คีย์นี้มีอยู่แล้ว\n', 'ℹ️  This key already exists\n'))
          } else {
            allowedKeys.add(normalized)
            output.write(t('✅ เพิ่ม Public Key แล้ว\n', '✅ Public key added\n'))
          }
        } catch (err) {
          output.write(`❌ ${err.message}\n`)
        }
      }

      if (allowedKeys.size === 0) {
        output.write(t('\n⚠️  ยังไม่มี Public Key เลย\n', '\n⚠️  No public keys yet\n'))
        output.write(t(
          'เซิร์ฟเวอร์จะยังไม่ยอมเริ่มทำงานจนกว่าจะมีอย่างน้อย 1 คีย์\n',
          'The Server will not start until at least one key is registered\n'
        ))
        output.write(t(
          'วิธีแก้: รัน `p2pgate keygen` บนเครื่อง Client แล้วนำ Public Key มาใส่\n\n',
          'Fix: run `p2pgate keygen` on the Client and add its public key\n\n'
        ))

        const saveAnyway = await askYesNo(
          rl,
          t(
            'บันทึก config ไว้ก่อนหรือไม่? (ภายหลังแก้ไฟล์หรือรัน setup ใหม่ได้)',
            'Save the config anyway? (you can edit it or rerun setup later)'
          ),
          true
        )

        if (!saveAnyway) {
          output.write(t(
            'ยกเลิกการบันทึกแล้ว ยังไม่มีการเปลี่ยนแปลงใด ๆ\n',
            'Cancelled; nothing was changed\n'
          ))
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
      output.write(t(
        '\n⚠️  พบรูปแบบรหัสผ่านสำรองจาก v1.1 ซึ่งใช้กับ v1.5 ไม่ได้\n',
        '\n⚠️  Found a v1.1 fallback password format, which is not compatible with v1.5\n'
      ))
      output.write(t(
        '   กรุณาตั้งรหัสผ่านสำรองใหม่ (อย่างน้อย 12 ตัวอักษร)\n',
        '   Please set a new fallback password (at least 12 characters)\n'
      ))
      unattendedVerifier = null
    }

    if (mode === 'server') {
      output.write(t(
        '\n--- นโยบายการยืนยันตัวตน ---\n',
        '\n--- Verification policy ---\n'
      ))
      verificationMode = await askVerificationMode(rl, verificationMode)

      if (verificationMode === 'key-only') {
        unattendedVerifier = null
        output.write(t(
          'ℹ️  key-only: ตรวจเฉพาะ Public Key ไม่มี Session PIN และไม่ถามรหัสผ่าน\n',
          'ℹ️  key-only: public key only; no Session PIN and no password prompt\n'
        ))
        output.write(t(
          '   จัดการคีย์ด้วย: p2pgate devices list / devices add / devices remove\n',
          '   Manage keys with: p2pgate devices list / devices add / devices remove\n'
        ))
      } else {
        if (unattendedVerifier) {
          const keep = await askYesNo(
            rl,
            t(
              'คงรหัสผ่านสำรอง (Unattended Password) เดิมไว้หรือไม่?',
              'Keep the existing Unattended Password?'
            ),
            true
          )

          if (!keep) unattendedVerifier = null
        }

        if (!unattendedVerifier) {
          const enable = await askYesNo(
            rl,
            t(
              'ต้องการตั้งรหัสผ่านสำรองสำหรับเชื่อมต่อตอนไม่อยู่บ้านหรือไม่?',
              'Set a fallback password for headless access?'
            ),
            false
          )

          if (enable) {
            while (true) {
              const first = (await askHidden(t(
                'ตั้งรหัสผ่านสำรอง (อย่างน้อย 12 ตัวอักษร): ',
                'Set a fallback password (at least 12 characters): '
              ))).trim()

              if (first.length < 12) {
                output.write(t(
                  '❌ รหัสผ่านต้องยาวอย่างน้อย 12 ตัวอักษร\n',
                  '❌ Password must be at least 12 characters\n'
                ))
                continue
              }

              const second = (await askHidden(t(
                'ยืนยันรหัสผ่านสำรองอีกครั้ง: ',
                'Confirm the fallback password: '
              ))).trim()

              if (first !== second) {
                output.write(t(
                  '❌ รหัสผ่านทั้งสองครั้งไม่ตรงกัน\n',
                  '❌ The passwords do not match\n'
                ))
                continue
              }

              const verifier = await deriveScramVerifier(first)
              unattendedVerifier = serializeScramVerifier(verifier)
              output.write(t(
                '✅ ตั้งรหัสผ่านสำรองแล้ว (เก็บเฉพาะค่า SCRAM verifier)\n',
                '✅ Fallback password set (only the SCRAM verifier is stored)\n'
              ))
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

    output.write(t(
      '\n--- การแจ้งเตือน Telegram (ไม่บังคับ) ---\n',
      '\n--- Telegram alerts (optional) ---\n'
    ))

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
        t(
          'คงการแจ้งเตือน Telegram เดิมไว้หรือไม่?',
          'Keep the existing Telegram alerts?'
        ),
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
        t(
          'ต้องการแจ้งเตือนทาง Telegram เมื่อมีคนพยายามเชื่อมต่อหรือไม่?',
          'Send Telegram alerts for connection attempts?'
        ),
        false
      )

      if (enable) {
        const botToken = await askNonEmpty(
          rl,
          t('วาง Bot Token จาก @BotFather: ', 'Paste the Bot Token from @BotFather: ')
        )
        const chatId = await askNonEmpty(
          rl,
          t('วาง Chat ID ปลายทาง: ', 'Paste the destination Chat ID: ')
        )
        telegramAlert = { enabled: true, botToken, chatId }
      }
    }

    const config = {
      mode,
      masterSecret,
      authMode: 'registry',
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

    output.write(t('\n✅ บันทึกการตั้งค่าแล้ว\n', '\n✅ Configuration saved\n'))
    output.write(t(`   ไฟล์: ${configPath}\n`, `   File: ${configPath}\n`))
    output.write(t(`   โหมด: ${saved.mode}\n`, `   Mode: ${saved.mode}\n`))
    output.write(t(
      `   นโยบายยืนยันตัวตน: ${saved.verificationMode}\n`,
      `   Verification: ${saved.verificationMode}\n`
    ))
    output.write(t(
      `   ไฟล์ trusted devices: ${saved.trustedDevicesFile}\n\n`,
      `   Trusted devices file: ${saved.trustedDevicesFile}\n\n`
    ))

    if (mode === 'server') {
      output.write(t('ขั้นตอนถัดไป (เครื่อง Server):\n', 'Next steps (Server):\n'))
      output.write(t(
        '  1) ตรวจสอบว่า sshd ทำงานอยู่แล้ว\n',
        '  1) Verify that sshd is running\n'
      ))
      output.write(t(
        '  2) ปิดการล็อกอินด้วยรหัสผ่าน (ใช้กุญแจ SSH เท่านั้น)\n',
        '  2) Disable SSH password login (use keys only)\n'
      ))
      output.write(t(
        '  3) เพิ่ม/ตรวจสอบอุปกรณ์ด้วย: p2pgate devices list\n',
        '  3) List/verify devices: p2pgate devices list\n'
      ))
      output.write(t(
        '  4) เริ่มทำงานด้วยคำสั่ง: p2pgate server\n',
        '  4) Start: p2pgate server\n'
      ))
      if (saved.verificationMode !== 'key-only') {
        output.write(t(
          '     (ระบบจะแสดง Session PIN เมื่อรันใน terminal)\n',
          '     (the Session PIN is shown in an interactive terminal)\n'
        ))
      }
      output.write(t(
        '  5) ถ้าต้องการเปิดอัตโนมัติ ให้ใช้ Termux:Boot หรือ service manager ของระบบ\n\n',
        '  5) For autostart, use Termux:Boot or your OS service manager\n\n'
      ))
    } else {
      output.write(t('ขั้นตอนถัดไป (เครื่อง Client):\n', 'Next steps (Client):\n'))
      output.write(t(
        '  1) นำ Public Key นี้ไปเพิ่มใน allowedClientKeys บนเครื่อง Server:\n',
        '  1) Add this public key to the Server allowedClientKeys:\n'
      ))
      output.write(`     ${clientPublicKey}\n`)
      output.write(t(
        '  2) เริ่มอุโมงค์ด้วยคำสั่ง: p2pgate client\n',
        '  2) Start the tunnel: p2pgate client\n'
      ))
      output.write(t(
        `  3) เปิด terminal ใหม่แล้วเชื่อมต่อ: ssh -p ${localPort} localhost\n\n`,
        `  3) Open another terminal: ssh -p ${localPort} localhost\n\n`
      ))

      if (!clientKeyCreated) {
        output.write(t(
          'ℹ️  ถ้า Server ยังไม่รู้จักกุญแจนี้ ให้คัดลอก Public Key ด้านบนไปเพิ่มก่อน\n',
          'ℹ️  If the Server does not know this key yet, add the public key above first\n'
        ))
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
