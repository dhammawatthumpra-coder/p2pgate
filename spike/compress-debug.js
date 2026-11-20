'use strict'

// Debug: capture the compressed bytes the client receives and compare online vs
// offline decompression. Isolates "server sent a truncated stream" from "client
// dropped the tail".

const crypto = require('node:crypto')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const zlib = require('node:zlib')
const { startServer } = require('../src/server')
const { startClient } = require('../src/client')
const { deriveScramVerifier, serializeScramVerifier } = require('../src/crypto-utils')
const { generateClientKey } = require('../src/keygen')
const { MuxChannel } = require('../src/mux')

const SIZE = 4 * 1024 * 1024

async function main () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-cdbg-'))

  let targetBytes = 0
  const echo = net.createServer((s) => {
    s.on('data', (c) => { targetBytes += c.length })
    s.on('error', () => {})
    s.pipe(s)
  })
  await new Promise((r) => echo.listen(0, '127.0.0.1', r))

  const secret = crypto.randomBytes(32).toString('hex')
  const password = 'COMPRESSDBG00000000001'
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
    log: (m) => console.error('[server]', m),
    showSessionPin: false, sendStartupAlert: false, interactive: false
  })

  const clientKeyPath = path.join(dir, 'client-key.json')
  await generateClientKey(clientKeyPath)

  const inbound = []
  const originalOnData = MuxChannel.prototype._onData
  MuxChannel.prototype._onData = function (payload) {
    inbound.push(Buffer.from(payload))
    return originalOnData.call(this, payload)
  }

  const client = await startClient(
    { ...base, mode: 'client', clientKeyPath, authPin: { enabled: true, unattended: null } },
    { log: (m) => console.error('[client]', m), credential: password, mux: true, compress: true }
  )

  const payload = crypto.randomBytes(SIZE)
  const socket = net.createConnection({ host: '127.0.0.1', port: client.address().port })
  await new Promise((r) => socket.once('connect', r))

  let received = 0
  socket.on('data', (c) => { received += c.length })

  let offset = 0
  while (offset < payload.length) {
    const chunk = payload.subarray(offset, Math.min(offset + 65536, payload.length))
    offset += chunk.length
    if (!socket.write(chunk)) await new Promise((r) => socket.once('drain', r))
  }
  socket.end()

  await new Promise((r) => { socket.once('close', r); setTimeout(r, 5000) })

  const compressed = Buffer.concat(inbound)
  let offline = -1
  try {
    offline = zlib.zstdDecompressSync(compressed).length
  } catch (err) {
    console.error('offline decompress failed:', err.message)
  }

  const streamed = await new Promise((resolve) => {
    const dec = zlib.createZstdDecompress()
    let out = 0
    dec.on('data', (c) => { out += c.length })
    dec.on('end', () => resolve({ out, ended: true }))
    dec.on('error', (err) => resolve({ out, ended: false, error: err.message }))
    for (const chunk of inbound) dec.write(chunk)
    dec.end()
    setTimeout(() => resolve({ out, ended: false, error: 'timeout' }), 5000)
  })

  console.log(JSON.stringify({
    targetBytes,
    compressedWireBytes: compressed.length,
    onlineReceived: received,
    offlineDecompressed: offline,
    streamedDecompressed: streamed
  }, null, 1))

  MuxChannel.prototype._onData = originalOnData
  await client.close()
  await server.close()
  echo.close()
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
