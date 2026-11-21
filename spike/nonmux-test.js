'use strict'

// Non-mux compression: challenge sessions (proof field) and fast-path sessions
// (control line inside the peek window).

const crypto = require('node:crypto')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { startServer } = require('../src/server')
const { startClient } = require('../src/client')
const { deriveScramVerifier, serializeScramVerifier } = require('../src/crypto-utils')
const { generateClientKey, loadClientKey } = require('../src/keygen')
const { DeviceRegistry } = require('../src/device-registry')

const MB = 1024 * 1024

function readExactly (socket, length, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`read timeout ${bytes}/${length}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    const onData = (chunk) => {
      chunks.push(chunk)
      bytes += chunk.length
      if (bytes >= length) { cleanup(); resolve(Buffer.concat(chunks)) }
    }
    const onError = (err) => { cleanup(); reject(err) }
    const onClose = () => {
      cleanup()
      if (bytes >= length) resolve(Buffer.concat(chunks))
      else reject(new Error(`closed ${bytes}/${length}`))
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

async function runCase ({ label, serverCompress, clientCompress, fastpath, target }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-nonmux-'))

  const echo = net.createServer((s) => { s.on('error', () => {}); s.pipe(s) })
  await new Promise((r) => echo.listen(0, '127.0.0.1', r))

  const secret = crypto.randomBytes(32).toString('hex')
  const password = 'NONMUXTEST000000000001'
  const verifier = serializeScramVerifier(await deriveScramVerifier(password))
  const devicesPath = path.join(dir, 'trusted_devices')

  const clientKeyPath = path.join(dir, 'client-key.json')
  await generateClientKey(clientKeyPath)
  const clientKey = await loadClientKey(clientKeyPath)

  if (fastpath) {
    const registry = new DeviceRegistry({
      configKeys: [],
      filePath: devicesPath,
      verificationMode: 'hybrid',
      posixCheck: async () => ({ ok: true })
    })
    await registry.init()
    await registry.addDevice({
      key: clientKey.publicKey,
      profile: 'trusted',
      label: 'nonmux-test'
    })
  }

  const base = {
    mode: 'server',
    masterSecret: secret,
    authMode: 'password',
    targetHost: '127.0.0.1',
    targetPort: echo.address().port,
    localPort: 0,
    clientKeyPath: path.join(dir, 'server-key.json'),
    allowedClientKeys: [],
    verificationMode: 'hybrid',
    trustedDevicesFile: devicesPath,
    auditLog: { enabled: false },
    customBootstrap: [],
    authPin: { enabled: true, unattended: verifier },
    telegramAlert: { enabled: false, botToken: '', chatId: '' },
    compress: serverCompress ? { enabled: true, algorithms: ['zstd', 'gzip'] } : false
  }
  await generateClientKey(base.clientKeyPath)

  const logs = []
  const server = await startServer(base, {
    log: (m) => logs.push(`[server] ${m}`),
    showSessionPin: false,
    sendStartupAlert: false,
    interactive: false
  })

  const clientLogs = []
  const client = await startClient(
    { ...base, mode: 'client', clientKeyPath, authPin: { enabled: true, unattended: null } },
    {
      log: (m) => clientLogs.push(`[client] ${m}`),
      credential: fastpath ? undefined : password,
      mux: false,
      target: target || undefined,
      compress: clientCompress
    }
  )

  const payload = Buffer.from('compressible non-mux line\n'.repeat(16384))
  const socket = net.createConnection({ host: '127.0.0.1', port: client.address().port })
  await new Promise((r) => socket.once('connect', r))
  let received = 0
  socket.on('data', (chunk) => { received += chunk.length })
  socket.write(payload)

  const started = Date.now()
  while (received < payload.length && Date.now() - started < 15_000) {
    await new Promise((r) => setTimeout(r, 20))
  }

  const ok = received === payload.length
  const compressLog = clientLogs.some((l) => l.includes('COMPRESS ')) ||
    logs.some((l) => l.includes('COMPRESS '))

  socket.destroy()
  await client.close()
  await server.close()
  echo.close()
  fs.rmSync(dir, { recursive: true, force: true })

  const row = {
    label,
    ok,
    received,
    compress: compressLog,
    fastpath: logs.some((l) => l.includes('FASTPATH')),
    auth: logs.some((l) => l.includes('AUTH OK'))
  }
  console.log(JSON.stringify(row))
  return row
}

async function main () {
  const rows = []
  rows.push(await runCase({ label: 'challenge + compress', serverCompress: true, clientCompress: true }))
  rows.push(await runCase({ label: 'challenge, server off', serverCompress: false, clientCompress: true }))
  rows.push(await runCase({ label: 'fastpath + compress', serverCompress: true, clientCompress: true, fastpath: true }))
  rows.push(await runCase({ label: 'fastpath + target + compress', serverCompress: true, clientCompress: true, fastpath: true, target: 'default' }))

  const pass = rows.every((r) => r.ok) &&
    rows[0].compress === true &&
    rows[1].compress === false &&
    rows[2].compress === true &&
    rows[2].fastpath === true &&
    rows[3].compress === true

  console.log(pass ? 'NONMUX TEST PASS' : 'NONMUX TEST FAIL')
  process.exit(pass ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
