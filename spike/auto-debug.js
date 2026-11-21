'use strict'

const crypto = require('node:crypto')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { startServer } = require('../src/server')
const { startClient } = require('../src/client')
const { deriveScramVerifier, serializeScramVerifier } = require('../src/crypto-utils')
const { generateClientKey } = require('../src/keygen')

async function main () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-auto-'))
  const echo = net.createServer((s) => { s.on('error', () => {}); s.pipe(s) })
  await new Promise((r) => echo.listen(0, '127.0.0.1', r))

  const secret = crypto.randomBytes(32).toString('hex')
  const password = 'AUTOTEST00000000000001'
  const verifier = serializeScramVerifier(await deriveScramVerifier(password))

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
    trustedDevicesFile: path.join(dir, 'trusted_devices'),
    auditLog: { enabled: false },
    customBootstrap: [],
    authPin: { enabled: true, unattended: verifier },
    telegramAlert: { enabled: false, botToken: '', chatId: '' },
    compress: { enabled: true, algorithms: ['zstd'] }
  }
  await generateClientKey(base.clientKeyPath)

  const server = await startServer(base, {
    log: () => {}, showSessionPin: false, sendStartupAlert: false, interactive: false
  })

  const clientKeyPath = path.join(dir, 'client-key.json')
  await generateClientKey(clientKeyPath)

  const client = await startClient(
    { ...base, mode: 'client', clientKeyPath, authPin: { enabled: true, unattended: null } },
    { log: (m) => console.error('[client]', m), credential: password, mux: true, compress: 'auto' }
  )

  for (const [label, payload] of [
    ['random', crypto.randomBytes(64 * 1024)],
    ['text', Buffer.from('hello compressible line\n'.repeat(4096))]
  ]) {
    const socket = net.createConnection({ host: '127.0.0.1', port: client.address().port })
    await new Promise((r) => socket.once('connect', r))
    let received = 0
    socket.on('data', (c) => { received += c.length })
    socket.on('error', (e) => console.error('[socket]', e.code || e.message))

    const t0 = Date.now()
    socket.write(payload)
    while (received < payload.length && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 20))
    }
    console.log(label, 'wanted', payload.length, 'got', received)
    socket.destroy()
    await new Promise((r) => setTimeout(r, 300))
  }

  await client.close()
  await server.close()
  echo.close()
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
