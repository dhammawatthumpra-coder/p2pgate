'use strict'

// Edge cases for the compressed mux channel: tiny payloads, half-close ordering,
// interactive latency, incompressible data and zero-byte connections.

const crypto = require('node:crypto')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { startServer } = require('../src/server')
const { startClient } = require('../src/client')
const { deriveScramVerifier, serializeScramVerifier } = require('../src/crypto-utils')
const { generateClientKey } = require('../src/keygen')

async function setup () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-compress-edge-'))

  let targetBytes = 0
  let targetConns = 0
  let targetCloses = 0

  const echo = net.createServer((s) => {
    targetConns += 1
    s.on('data', (chunk) => { targetBytes += chunk.length })
    s.on('close', () => { targetCloses += 1 })
    s.on('error', () => {})
    s.pipe(s)
  })
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve))

  const secret = crypto.randomBytes(32).toString('hex')
  const password = 'COMPRESSEDGETEST0000001'
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
    compress: { enabled: true, algorithms: ['zstd', 'gzip'] }
  }

  await generateClientKey(base.clientKeyPath)

  const server = await startServer(base, {
    log: () => {}, showSessionPin: false, sendStartupAlert: false, interactive: false
  })

  const clientKeyPath = path.join(dir, 'client-key.json')
  await generateClientKey(clientKeyPath)

  const client = await startClient(
    { ...base, mode: 'client', clientKeyPath, authPin: { enabled: true, unattended: null } },
    { log: () => {}, credential: password, mux: true, compress: true }
  )

  return {
    port: client.address().port,
    stats () {
      return { targetBytes, targetConns, targetCloses }
    },
    async close () {
      await client.close()
      await server.close()
      echo.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

function connect (port) {
  const socket = net.createConnection({ host: '127.0.0.1', port })
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function collect (socket, expected, options = {}) {
  return new Promise((resolve) => {
    const chunks = []
    let bytes = 0
    let firstAt = null

    const done = () => resolve({
      data: Buffer.concat(chunks),
      bytes,
      latencyMs: firstAt === null ? null : Number(process.hrtime.bigint() - firstAt) / 1e6
    })

    socket.on('data', (chunk) => {
      if (firstAt === null) firstAt = process.hrtime.bigint()
      chunks.push(chunk)
      bytes += chunk.length
      if (expected !== null && bytes >= expected) done()
    })
    socket.on('close', done)
    socket.on('error', done)

    if (options.endAfterWrite) socket.end()
  })
}

const results = []

function record (name, ok, detail) {
  results.push({ name, ok, ...detail })
}

async function main () {
  const env = await setup()

  try {
    // 1 byte
    {
      const socket = await connect(env.port)
      const wait = collect(socket, 1)
      socket.write(Buffer.from([0x41]))
      socket.end()
      const got = await wait
      record('1 byte + half-close', got.bytes === 1 && got.data[0] === 0x41, {
        bytes: got.bytes
      })
      socket.destroy()
    }

    // tiny JSON round trip with end
    {
      const msg = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 7, result: 'ok' }))
      const socket = await connect(env.port)
      const wait = collect(socket, msg.length)
      socket.write(msg)
      socket.end()
      const got = await wait
      record('small JSON + half-close', got.data.equals(msg), { bytes: got.bytes })
      socket.destroy()
    }

    // interactive: 10 writes 30 ms apart, echo must come back each time
    {
      const socket = await connect(env.port)
      const received = []
      let bytes = 0
      socket.on('data', (chunk) => { received.push(chunk); bytes += chunk.length })

      const latencies = []
      for (let i = 0; i < 10; i += 1) {
        const payload = Buffer.from(`ping-${i}`)
        const before = bytes
        const started = process.hrtime.bigint()
        socket.write(payload)
        while (bytes < before + payload.length) {
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
        latencies.push(Number(process.hrtime.bigint() - started) / 1e6)
        await new Promise((resolve) => setTimeout(resolve, 30))
      }

      const text = Buffer.concat(received).toString()
      const ok = text === Array.from({ length: 10 }, (_, i) => `ping-${i}`).join('')
      record('interactive round trips', ok, {
        maxLatencyMs: +Math.max(...latencies).toFixed(1)
      })
      socket.destroy()
    }

    // 4 MiB of random (incompressible) data
    {
      const payload = crypto.randomBytes(4 * 1024 * 1024)
      const expected = crypto.createHash('sha256').update(payload).digest('hex')
      const socket = await connect(env.port)
      const wait = collect(socket, payload.length)
      let offset = 0
      const CHUNK = 64 * 1024
      while (offset < payload.length) {
        const slice = payload.subarray(offset, Math.min(offset + CHUNK, payload.length))
        offset += slice.length
        if (!socket.write(slice)) await new Promise((resolve) => socket.once('drain', resolve))
      }
      socket.end()
      const got = await wait
      const actual = crypto.createHash('sha256').update(got.data).digest('hex')
      record('4 MiB random + half-close', actual === expected && got.bytes === payload.length, {
        bytes: got.bytes,
        target: env.stats()
      })
      socket.destroy()
    }

    // zero-byte connection
    {
      const socket = await connect(env.port)
      const closed = await new Promise((resolve) => {
        socket.once('close', () => resolve(true))
        socket.end()
        setTimeout(() => resolve(false), 1_000)
      })
      record('zero-byte connection', closed, { closed })
      socket.destroy()
    }
  } finally {
    await env.close()
  }

  console.log(JSON.stringify(results, null, 1))
  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? 'EDGE TEST PASS' : `EDGE TEST FAIL (${failed.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
