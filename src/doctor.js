'use strict'

const fsp = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const { loadConfig } = require('./config-loader')
const { DeviceRegistry } = require('./device-registry')
const { clientKeyExists, loadClientKey } = require('./keygen')
const {
  CONTROL_VERSION,
  defaultControlSocketPath,
  sendControlCommand
} = require('./control')

const DEFAULT_LOCKOUT_STATE_PATH = path.join(
  os.homedir(),
  '.p2pgate',
  'lockout-state.json'
)
const MIN_NODE_MAJOR = 20
const TCP_PROBE_TIMEOUT_MS = 1500
const CONTROL_PROBE_TIMEOUT_MS = 1000

function createReporter(output) {
  const lines = []

  function write(level, title, detail) {
    const icon = level === 'ok' ? '✅' : level === 'warn' ? '⚠️' : '❌'
    const line = `${icon} ${title}`
    lines.push(line)
    if (detail) lines.push(`   ${detail.replace(/\n/g, '\n   ')}`)
    output.write(`${line}\n`)
    if (detail) output.write(`   ${detail.replace(/\n/g, '\n   ')}\n`)
  }

  return { write, lines }
}

async function checkPermissions({ filePath, label, required, report }) {
  let stat

  try {
    stat = await fsp.lstat(filePath)
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      if (required) {
        report.write('error', `ไม่พบไฟล์ ${label}`, `path: ${filePath}`)
        return false
      }

      report.write('warn', `ยังไม่มีไฟล์ ${label}`, `path: ${filePath}`)
      return true
    }

    report.write('error', `ตรวจสอบไฟล์ ${label} ไม่ได้`, err.message)
    return false
  }

  if (process.platform === 'win32') {
    report.write(
      'ok',
      `ไฟล์ ${label} มีอยู่ (Windows ไม่ตรวจ POSIX permission)`,
      `path: ${filePath}`
    )
    return true
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    report.write('error', `ไฟล์ ${label} ไม่ใช่ไฟล์ปกติ`, `path: ${filePath}`)
    return false
  }

  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    report.write('error', `ไฟล์ ${label} ไม่ได้เป็นเจ้าของโดยผู้ใช้ปัจจุบัน`, `path: ${filePath}`)
    return false
  }

  if ((stat.mode & 0o077) !== 0) {
    report.write(
      'error',
      `สิทธิ์ไฟล์ ${label} ไม่ปลอดภัย`,
      `path: ${filePath}\nแก้ไขด้วย: chmod 600 ${filePath}`
    )
    return false
  }

  report.write('ok', `สิทธิ์ไฟล์ ${label} ปลอดภัย`, `path: ${filePath}`)
  return true
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        // Ignore.
      }
      resolve(result)
    }

    const timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT' }), TCP_PROBE_TIMEOUT_MS)

    socket.once('connect', () => finish({ ok: true }))
    socket.once('error', (err) => finish({ ok: false, code: err.code || 'ERROR' }))
  })
}

function probeLocalPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        server.close()
      } catch {
        // Ignore.
      }
      resolve(result)
    }

    server.once('error', (err) => finish({ ok: false, code: err.code || 'ERROR' }))
    server.listen(port, '127.0.0.1', () => finish({ ok: true }))
  })
}

async function readLockoutSummary(filePath) {
  let raw

  try {
    raw = await fsp.readFile(filePath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { exists: false, clients: 0, suspended: 0, revoked: 0 }
    }
    return { exists: false, error: err.message }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { exists: true, error: `อ่าน JSON ไม่ได้: ${err.message}` }
  }

  const clients = parsed && parsed.clients && typeof parsed.clients === 'object'
    ? Object.values(parsed.clients)
    : []

  let suspended = 0
  let revoked = 0
  const now = Date.now()

  for (const record of clients) {
    if (!record || typeof record !== 'object') continue
    if (record.revoked === true) revoked += 1
    else if (
      record.suspended === true ||
      (Number.isFinite(record.suspendedUntil) && record.suspendedUntil > now)
    ) {
      suspended += 1
    }
  }

  return { exists: true, clients: clients.length, suspended, revoked }
}

/**
 * Read-only diagnostic checks. Writes Thai lines to `options.output`
 * (process.stdout by default) and returns { exitCode, lines }.
 */
async function runDoctor(options = {}) {
  const output = options.output || process.stdout
  const report = createReporter(output)
  const configPath = options.configPath

  output.write('\n=== p2pgate doctor ===\n')
  output.write(`เวลา: ${new Date().toISOString()}\n\n`)

  // 1. Node.js version
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (Number.isInteger(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR) {
    report.write('ok', `Node.js ${process.versions.node} อยู่ในเกณฑ์ (>= ${MIN_NODE_MAJOR})`)
  } else {
    report.write(
      'error',
      `Node.js ${process.versions.node} เก่าเกินไป`,
      `ต้องใช้ Node.js ${MIN_NODE_MAJOR} ขึ้นไป`
    )
  }

  // 2. Config
  let config = null

  try {
    config = await loadConfig(configPath)
    report.write('ok', 'โหลดไฟล์ตั้งค่าได้', `path: ${configPath}`)
  } catch (err) {
    if (err && err.code === 'CONFIG_NOT_FOUND') {
      report.write(
        'error',
        'ไม่พบไฟล์ตั้งค่า',
        `path: ${configPath}\nแก้ไขด้วย: p2pgate setup`
      )
    } else {
      report.write('error', 'ไฟล์ตั้งค่าไม่ถูกต้อง', err.message)
    }
  }

  if (!config) {
    output.write('\n❌ doctor พบปัญหาที่ต้องแก้ไขก่อน\n\n')
    return { exitCode: 1, lines: report.lines }
  }

  // 3. Verification mode
  report.write(
    'ok',
    `โหมดยืนยันตัวตน: ${config.verificationMode}`,
    config.mode === 'server'
      ? config.verificationMode === 'key-only'
        ? 'key-only ไม่ใช้ Session PIN และไม่ถามรหัสผ่าน'
        : 'ใช้ Public Key ร่วมกับ PIN/รหัสผ่านตามนโยบาย'
      : 'ฝั่ง Client จะเชื่อมต่อก่อนและรอสถานะจากเซิร์ฟเวอร์'
  )

  // 4. File permissions
  if (process.platform === 'win32') {
    report.write(
      'warn',
      'Windows: ไม่ได้ตรวจ POSIX permissions',
      'ตรวจสอบ ACL ของไฟล์ config/กุญแจด้วยตนเอง'
    )
  }

  let allPermissionsOk = true
  allPermissionsOk = await checkPermissions({
    filePath: configPath,
    label: 'config',
    required: true,
    report
  }) && allPermissionsOk

  if (config.mode === 'client' || clientKeyExists(config.clientKeyPath)) {
    allPermissionsOk = await checkPermissions({
      filePath: config.clientKeyPath,
      label: 'client key',
      required: config.mode === 'client',
      report
    }) && allPermissionsOk
  }

  if (config.mode === 'server') {
    allPermissionsOk = await checkPermissions({
      filePath: config.trustedDevicesFile,
      label: 'trusted_devices',
      required: false,
      report
    }) && allPermissionsOk

    allPermissionsOk = await checkPermissions({
      filePath: DEFAULT_LOCKOUT_STATE_PATH,
      label: 'lockout state',
      required: false,
      report
    }) && allPermissionsOk
  }

  if (allPermissionsOk) {
    report.write('ok', 'ไฟล์สำคัญมีสิทธิ์อยู่ในระดับที่ตรวจสอบได้')
  }

  // 5. Device registry
  let devices = []

  if (config.mode === 'server') {
    const registry = new DeviceRegistry({
      configKeys: config.allowedClientKeys,
      filePath: config.trustedDevicesFile,
      verificationMode: config.verificationMode
    })

    try {
      await registry.init()
      devices = await registry.listDevices()

      if (devices.length === 0) {
        report.write(
          'error',
          'ไม่มีอุปกรณ์ลงทะเบียน',
          'เพิ่มด้วย: p2pgate devices add <publicKeyHex> --mode scram'
        )
      } else {
        report.write('ok', `อุปกรณ์ลงทะเบียน: ${devices.length} รายการ`)
      }

      if (!registry.permissionsOk) {
        report.write(
          config.verificationMode === 'key-only' ? 'error' : 'warn',
          'ไฟล์ trusted_devices มีสิทธิ์ไม่ปลอดภัย',
          `สาเหตุ: ${registry.permissionsError || 'unknown'}\nแก้ไขด้วย: chmod 600 ${config.trustedDevicesFile}`
        )
      }

      const expired = devices.filter((device) => !device.active)
      if (expired.length > 0) {
        report.write(
          'warn',
          `มีอุปกรณ์หมดอายุ ${expired.length} รายการ`,
          expired.map((device) => `${device.key} (${device.label || 'ไม่มีป้ายชื่อ'})`).join('\n')
        )
      }

      const permanentTrusted = devices.filter(
        (device) => device.profile === 'trusted' && device.active && !device.expiresAtIso
      )

      if (permanentTrusted.length > 0) {
        report.write(
          'warn',
          `trusted device ที่ไม่มีวันหมดอายุ ${permanentTrusted.length} รายการ`,
          `${permanentTrusted.map((device) => device.key).join('\n')}\nควรกำหนดวันหมดอายุด้วย --expires หรือตรวจสอบเป็นระยะ`
        )
      }

      const fastpath = devices.filter((device) => device.fastpathAllowed)
      if (config.verificationMode === 'hybrid' && fastpath.length === 0) {
        report.write(
          'warn',
          'hybrid ไม่มี trusted device ที่ใช้ fast-path ได้',
          'ทุกอุปกรณ์จะต้องยืนยันแบบ two-step'
        )
      }
    } catch (err) {
      report.write('error', 'ตรวจสอบ registry ไม่ได้', err.message)
    }
  }

  // 6. Target / local port
  if (config.mode === 'server') {
    const target = await probeTcp(config.targetHost, config.targetPort)

    if (target.ok) {
      report.write(
        'ok',
        `พบบริการที่ ${config.targetHost}:${config.targetPort} (คาดว่า sshd)`
      )
    } else if (target.code === 'ECONNREFUSED') {
      report.write(
        'warn',
        `ไม่พบบริการที่ ${config.targetHost}:${config.targetPort}`,
        'ตรวจสอบว่า sshd ทำงานอยู่: sshd\nหรือแก้ targetPort ใน config'
      )
    } else {
      report.write(
        'warn',
        `ตรวจสอบ ${config.targetHost}:${config.targetPort} ไม่ได้`,
        `รหัส: ${target.code}`
      )
    }
  } else {
    const local = await probeLocalPortAvailable(config.localPort)

    if (local.ok) {
      report.write('ok', `พอร์ตท้องถิ่น ${config.localPort} ว่าง`)
    } else if (local.code === 'EADDRINUSE') {
      report.write(
        'warn',
        `พอร์ตท้องถิ่น ${config.localPort} ถูกใช้งานอยู่`,
        'อาจเป็น p2pgate client ที่รันอยู่ หรือใช้ --port เพื่อเปลี่ยน'
      )
    } else {
      report.write('warn', `ตรวจสอบพอร์ต ${config.localPort} ไม่ได้`, `รหัส: ${local.code}`)
    }
  }

  // 7. Live control plane
  const controlSocketPath = defaultControlSocketPath()

  try {
    const status = await sendControlCommand(
      controlSocketPath,
      { v: CONTROL_VERSION, cmd: 'status' },
      { timeoutMs: CONTROL_PROBE_TIMEOUT_MS }
    )

    if (status && status.ok) {
      report.write(
        'ok',
        'เซิร์ฟเวอร์กำลังทำงานและตอบสนอง control socket',
        `โหมด: ${status.verificationMode}; connection: ${status.activeConnections}; slot: ${status.currentSlot}`
      )
    } else {
      report.write('warn', 'control socket ตอบกลับผิดพลาด', status && status.error ? status.error : 'unknown')
    }
  } catch (err) {
    report.write(
      'warn',
      'ไม่พบเซิร์ฟเวอร์ที่กำลังทำงาน',
      `control socket: ${controlSocketPath}\nเริ่มด้วย: p2pgate server`
    )
  }

  // 8. Lockout state
  if (config.mode === 'server') {
    const lockout = await readLockoutSummary(DEFAULT_LOCKOUT_STATE_PATH)

    if (!lockout.exists) {
      report.write(
        lockout.error ? 'warn' : 'ok',
        lockout.error ? 'อ่านสถานะ lockout ไม่ได้' : 'ยังไม่มีสถานะ lockout',
        lockout.error || ''
      )
    } else {
      report.write(
        'ok',
        `สถานะ lockout: ${lockout.clients} รายการ`,
        `ระงับชั่วคราว/ถาวร: ${lockout.suspended}; เพิกถอนด้วย revoke: ${lockout.revoked}`
      )
    }
  }

  // 9. Session PIN visibility
  if (config.mode === 'server' && config.verificationMode !== 'key-only') {
    const hasFallback = Boolean(config.authPin && config.authPin.unattended)
    const hasFastpath = devices.some((device) => device.fastpathAllowed)

    if (process.stdout.isTTY) {
      report.write('ok', 'Session PIN จะแสดงบนหน้าจอเมื่อรันใน terminal')
    } else if (hasFallback) {
      report.write(
        'ok',
        'รันแบบไม่มี terminal แต่มี Unattended Password สำหรับ two-step'
      )
    } else if (hasFastpath) {
      report.write(
        'ok',
        'รันแบบไม่มี terminal; trusted device ใช้ fast-path ได้'
      )
    } else {
      report.write(
        'warn',
        'รันแบบไม่มี terminal และไม่มีทางยืนยันตัวตนสำรอง',
        [
          'Session PIN จะมองไม่เห็น และ two-step จะถูกปฏิเสธ',
          'แก้ไข: ใช้ trusted device, เปลี่ยนเป็น key-only หรือตั้ง Unattended Password'
        ].join('\n')
      )
    }
  }

  // 10. Client key
  if (config.mode === 'client') {
    if (!clientKeyExists(config.clientKeyPath)) {
      report.write(
        'error',
        'ไม่พบกุญแจ Client',
        `path: ${config.clientKeyPath}\nแก้ไขด้วย: p2pgate keygen`
      )
    } else {
      try {
        const key = await loadClientKey(config.clientKeyPath)
        report.write('ok', 'กุญแจ Client ถูกต้อง', `public key: ${key.publicKey}`)
      } catch (err) {
        report.write('error', 'กุญแจ Client ไม่ถูกต้อง', err.message)
      }
    }
  }

  const criticalCount = report.lines.filter((line) => line.startsWith('❌')).length
  const warnCount = report.lines.filter((line) => line.startsWith('⚠️')).length

  if (criticalCount === 0) {
    output.write(`\n✅ doctor ตรวจสอบเสร็จสิ้น (คำเตือน ${warnCount} รายการ)\n\n`)
    return { exitCode: 0, lines: report.lines }
  }

  output.write(
    `\n❌ doctor พบปัญหา ${criticalCount} รายการที่ต้องแก้ไข (คำเตือน ${warnCount} รายการ)\n\n`
  )
  return { exitCode: 1, lines: report.lines }
}

module.exports = {
  runDoctor,
  DEFAULT_LOCKOUT_STATE_PATH
}
