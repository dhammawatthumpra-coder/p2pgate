'use strict'

// Loopback check for the compressed mux channel: does it negotiate, round-trip
// correctly in both directions, and actually put fewer bytes on the wire?

const crypto = require('node:crypto')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { startServer } = require('../src/server')
const { startClient } = require('../src/client')
const { deriveScramVerifier, serializeScramVerifier } = require('../src/crypto-utils')
const { generateClientKey } = require('../src/keygen')
const mux = require('../src/mux')

const MB = 1024 * 1024
const SIZE = Number(process.env.SIZE_MB || 8) * MB
const CHUNK = 64 * 1024

function makeText () {
  const words = []
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  for (let i = 0; i < 2000; i += 1) {
    let w = ''
    for (let j = 0; j < 3 + (i % 9); j += 1) w += alphabet[(i * 7 + j * 13) % 26]
    words.push(w)
  }
  const parts = []
  let n = 0
  let i = 0
  while (n < SIZE) {
    const line = `${i}\t${words[i % words.length]}\t${words[(i * 31) % words.length]} ` +
      `status=ok latency=${(i * 37) % 900} bytes=${(i * 7919) % 90000}\n`
    parts.push(line)
    n += Buffer.byteLength(line)
    i += 1
  }
  return Buffer.from(parts.join('')).subarray(0, SIZE)
}

const originalSend = mux.MuxCarrier.prototype._send

async function run ({ label, serverCompress, clientCompress, algorithms }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-compress-'))

  const echo = net.createServer((s) => { s.pipe(s); s.on('error', () => {}) })
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve))
  const echoPort = echo.address().port

  const secret = crypto.randomBytes(32).toString('hex')
  const password = 'COMPRESSTEST00000000001'
  const verifier = serializeScramVerifier(await deriveScramVerifier(password))

  const base = {
    mode: 'server',
    masterSecret: secret,
    authMode: 'password',
    targetHost: '127.0.0.1',
    targetPort: echoPort,
    localPort: 0,
    clientKeyPath: path.join(dir, 'server-key.json'),
    allowedClientKeys: [],
    verificationMode: 'hybrid',
    trustedDevicesFile: path.join(dir, 'trusted_devices'),
    auditLog: { enabled: false },
    customBootstrap: [],
    authPin: { enabled: true, unattended: verifier },
    telegramAlert: { enabled: false, botToken: '', chatId: '' },
    compress: serverCompress ? { enabled: true, algorithms: algorithms || ['zstd', 'gzip'] } : false
  }

  await generateClientKey(base.clientKeyPath)

  let wireData = 0
  let dataFrames = 0
  mux.MuxCarrier.prototype._send = function (type, flags, id, payload) {
    if (type === mux.TYPE.DATA) {
      wireData += payload.length
      dataFrames += 1
    }
    return originalSend.call(this, type, flags, id, payload)
  }

  const server = await startServer(base, {
    log: () => {}, showSessionPin: false, sendStartupAlert: false, interactive: false
  })

  const clientKeyPath = path.join(dir, 'client-key.json')
  await generateClientKey(clientKeyPath)

  const client = await startClient(
    {
      ...base,
      mode: 'client',
      clientKeyPath,
      authPin: { enabled: true, unattended: null }
    },
    { log: () => {}, credential: password, mux: true, compress: clientCompress }
  )

  const payload = makeText()
  const expected = crypto.createHash('sha256').update(payload).digest('hex')

  const socket = net.createConnection({ host: '127.0.0.1', port: client.address().port })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })

  const received = []
  let receivedBytes = 0
  const started = process.hrtime.bigint()
  const done = new Promise((resolve) => {
    socket.on('data', (chunk) => {
      received.push(chunk)
      receivedBytes += chunk.length
      if (receivedBytes >= SIZE) resolve()
    })
    socket.on('error', () => resolve())
    socket.on('close', () => resolve())
  })

  let offset = 0
  while (offset < payload.length) {
    const slice = payload.subarray(offset, Math.min(offset + CHUNK, payload.length))
    offset += slice.length
    if (!socket.write(slice)) await new Promise((resolve) => socket.once('drain', resolve))
  }

  await done
  const echoed = Buffer.concat(received)
  const actual = crypto.createHash('sha256').update(echoed).digest('hex')

  socket.destroy()
  const seconds = Number(process.hrtime.bigint() - started) / 1e9
  await client.close()
  await server.close()
  echo.close()
  mux.MuxCarrier.prototype._send = originalSend

  fs.rmSync(dir, { recursive: true, force: true })

  return {
    label,
    bytesIn: SIZE,
    bytesOut: echoed.length,
    integrity: actual === expected && echoed.length === payload.length,
    wireDataMB: +(wireData / MB).toFixed(2),
    wireRatio: +(SIZE / wireData).toFixed(2),
    dataFrames,
    seconds: +seconds.toFixed(2),
    MBps: +((SIZE / MB) / seconds).toFixed(1)
  }
}

async function main () {
  const results = []

  results.push(await run({
    label: 'off (baseline)',
    serverCompress: false,
    clientCompress: false
  }))

  results.push(await run({
    label: 'zstd (auto)',
    serverCompress: true,
    clientCompress: true
  }))

  results.push(await run({
    label: 'gzip (forced)',
    serverCompress: true,
    clientCompress: true,
    algorithms: ['gzip']
  }))

  results.push(await run({
    label: 'server off, client on',
    serverCompress: false,
    clientCompress: true
  }))

  console.log(JSON.stringify(results, null, 1))
  const ok = results.every((r) => r.integrity) &&
    results[1].wireDataMB < results[0].wireDataMB * 0.75 &&
    results[3].wireDataMB > results[0].wireDataMB * 0.98

  console.log(ok ? 'COMPRESS TEST PASS' : 'COMPRESS TEST FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
