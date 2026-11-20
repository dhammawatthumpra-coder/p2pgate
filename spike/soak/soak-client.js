'use strict'

// 4-hour soak for the compressed mux channel over the real DHT link.
//
// Keeps one client alive, then cycles through compressible text, logs, incompressible
// binary, interactive round trips and abrupt resets. Every transfer is echoed by the
// server, so the bytes are verified end to end.
//
// Env:
//   MASTER_SECRET, PASSWORD   (required)
//   SOAK_HOURS    default 4
//   SOAK_MINUTES  overrides SOAK_HOURS (dry runs)
//   SOAK_KB       payload size per bulk case, default 256
//   SOAK_INTERVAL_SEC  pause between cycles, default 60
//   SOAK_RESTART_MIN   restart the client every N minutes, default 60 (0 = never)
//   SOAK_OUT      jsonl output path

const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { startClient } = require('D:/tunnel/p2pgate/src/client')
const { generateClientKey } = require('D:/tunnel/p2pgate/src/keygen')

const MB = 1024 * 1024
const CHUNK = 64 * 1024

const hours = Number(process.env.SOAK_HOURS || 4)
const minutes = process.env.SOAK_MINUTES ? Number(process.env.SOAK_MINUTES) : null
const durationMs = (minutes !== null ? minutes : hours * 60) * 60 * 1000
const payloadBytes = Number(process.env.SOAK_KB || 256) * 1024
const intervalMs = Number(process.env.SOAK_INTERVAL_SEC || 60) * 1000
const restartMs = Number(process.env.SOAK_RESTART_MIN || 60) * 60 * 1000
const outPath = process.env.SOAK_OUT || path.join(__dirname, 'soak.jsonl')

const secret = process.env.MASTER_SECRET
const password = process.env.PASSWORD
if (!secret || !password) throw new Error('MASTER_SECRET and PASSWORD are required')

const words = []
const alphabet = 'abcdefghijklmnopqrstuvwxyz'
for (let i = 0; i < 3000; i += 1) {
  let w = ''
  for (let j = 0; j < 3 + (i % 9); j += 1) w += alphabet[(i * 7 + j * 13) % 26]
  words.push(w)
}

function makeText (seed, bytes) {
  const parts = []
  let n = 0
  let i = seed * 1000
  while (n < bytes) {
    const line = `${i}\t${words[i % words.length]}\t${words[(i * 31) % words.length]} ` +
      `seed=${seed} status=${['ok', 'retry', 'failed'][i % 3]} latency=${(i * 37) % 900}\n`
    parts.push(line)
    n += Buffer.byteLength(line)
    i += 1
  }
  return Buffer.from(parts.join('')).subarray(0, bytes)
}

function makeLog (seed, bytes) {
  const levels = ['INFO', 'INFO', 'INFO', 'WARN', 'DEBUG', 'ERROR']
  const paths = ['/api/v1/session', '/api/v1/targets', '/health', '/metrics']
  const parts = []
  let n = 0
  let i = seed * 1000
  while (n < bytes) {
    const line = `${new Date(1763600000000 + i * 37).toISOString()} ${levels[i % 6].padEnd(5)} ` +
      `req=${i.toString(16)} seed=${seed} path=${paths[i % paths.length]} ` +
      `status=${[200, 200, 404, 500][i % 4]} ms=${(i * 7919) % 2400}\n`
    parts.push(line)
    n += Buffer.byteLength(line)
    i += 1
  }
  return Buffer.from(parts.join('')).subarray(0, bytes)
}

function makeBinary (bytes) {
  const buf = crypto.randomBytes(bytes)
  return buf
}

const sleeps = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function start () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-soak-'))
  const clientKeyPath = path.join(dir, 'client-key.json')
  await generateClientKey(clientKeyPath)

  const config = {
    mode: 'client',
    masterSecret: secret,
    authMode: 'password',
    targetHost: '127.0.0.1',
    targetPort: 1,
    localPort: 0,
    clientKeyPath,
    allowedClientKeys: [],
    verificationMode: 'hybrid',
    trustedDevicesFile: path.join(dir, 'trusted_devices'),
    auditLog: { enabled: false },
    customBootstrap: [],
    authPin: { enabled: true, unattended: null },
    telegramAlert: { enabled: false, botToken: '', chatId: '' }
  }

  const client = await startClient(config, {
    log: () => {}, credential: password, mux: true, compress: true
  })

  return {
    client,
    port: client.address().port,
    async close () {
      try { await client.close() } catch {}
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

function readExactly (socket, length, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`read timeout after ${bytes}/${length} bytes`))
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
      if (bytes >= length) {
        cleanup()
        resolve(Buffer.concat(chunks))
      }
    }
    const onError = (err) => { cleanup(); reject(err) }
    const onClose = () => {
      cleanup()
      if (bytes >= length) resolve(Buffer.concat(chunks))
      else reject(new Error(`closed after ${bytes}/${length} bytes`))
    }

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

async function bulk (port, payload, label) {
  const socket = await connect(port)
  socket.on('error', () => {})
  const expected = crypto.createHash('sha256').update(payload).digest('hex')

  let offset = 0
  const writePromise = (async () => {
    while (offset < payload.length) {
      const slice = payload.subarray(offset, Math.min(offset + CHUNK, payload.length))
      offset += slice.length
      if (!socket.write(slice)) await new Promise((resolve) => socket.once('drain', resolve))
    }
    socket.end()
  })()

  let echoed = null
  try {
    echoed = await readExactly(socket, payload.length)
  } finally {
    await writePromise.catch(() => {})
  }

  const actual = crypto.createHash('sha256').update(echoed).digest('hex')
  if (actual !== expected || echoed.length !== payload.length) {
    throw new Error(`${label} integrity mismatch (${echoed.length}/${payload.length})`)
  }

  socket.destroy()
}

async function interactive (port, rounds) {
  const socket = await connect(port)
  socket.on('error', () => {})
  const latencies = []

  for (let i = 0; i < rounds; i += 1) {
    const msg = Buffer.from(`ping-${i}-${crypto.randomBytes(4).toString('hex')}`)
    const started = process.hrtime.bigint()
    socket.write(msg)
    const echoed = await readExactly(socket, msg.length, 10_000)
    if (!echoed.equals(msg)) throw new Error('interactive echo mismatch')
    latencies.push(Number(process.hrtime.bigint() - started) / 1e6)
    await sleeps(20)
  }

  socket.destroy()
  return Math.max(...latencies)
}

async function abrupt (port) {
  const socket = await connect(port)
  socket.write(Buffer.alloc(8 * 1024, 0x41))
  await sleeps(30)
  socket.destroy()
}

function append (record) {
  fs.appendFileSync(outPath, JSON.stringify(record) + '\n')
}

async function main () {
  const startedAt = Date.now()
  let env = await start()
  let restartAt = startedAt + restartMs

  let cycle = 0
  let failures = 0
  let consecutiveFailures = 0
  let restarts = 0
  let bytesIn = 0

  console.log(`SOAK START duration=${(durationMs / 3600000).toFixed(2)}h ` +
    `payload=${payloadBytes / 1024}KB interval=${intervalMs / 1000}s`)

  while (Date.now() - startedAt < durationMs) {
    if (restartMs > 0 && Date.now() >= restartAt) {
      await env.close()
      env = await start()
      restartAt = Date.now() + restartMs
      restarts += 1
      console.log(`client restarted (${restarts})`)
    }

    cycle += 1
    const kind = ['text', 'log', 'binary', 'interactive', 'reset'][cycle % 5]
    const started = process.hrtime.bigint()
    let ok = true
    let error = null
    let detail = null

    try {
      if (kind === 'text') {
        const payload = makeText(cycle, payloadBytes)
        bytesIn += payload.length
        await bulk(env.port, payload, kind)
      } else if (kind === 'log') {
        const payload = makeLog(cycle, payloadBytes)
        bytesIn += payload.length
        await bulk(env.port, payload, kind)
      } else if (kind === 'binary') {
        const payload = makeBinary(payloadBytes)
        bytesIn += payload.length
        await bulk(env.port, payload, kind)
      } else if (kind === 'interactive') {
        detail = { maxLatencyMs: +(await interactive(env.port, 50)).toFixed(1) }
      } else {
        await abrupt(env.port)
      }
    } catch (err) {
      ok = false
      error = err.code || err.message
      failures += 1
      consecutiveFailures += 1

      if (consecutiveFailures >= 3) {
        try { await env.close() } catch {}
        env = await start()
        consecutiveFailures = 0
        restarts += 1
        console.log('client restarted after repeated failures')
      }
    }

    if (ok) consecutiveFailures = 0

    const cycleMs = Number(process.hrtime.bigint() - started) / 1e6
    const record = {
      ts: Date.now(),
      cycle,
      kind,
      ok,
      ms: +cycleMs.toFixed(0),
      bytes: bytesIn,
      rss: process.memoryUsage().rss,
      ...(detail || {}),
      ...(error ? { error } : {})
    }
    append(record)
    if (cycle % 10 === 0) console.log(JSON.stringify(record))

    const remaining = durationMs - (Date.now() - startedAt)
    if (remaining <= 0) break
    const pause = Math.max(0, intervalMs - cycleMs)
    await sleeps(Math.min(pause, remaining))
  }

  await env.close()

  const record = {
    ts: Date.now(),
    kind: 'summary',
    cycles: cycle,
    failures,
    restarts,
    bytesIn,
    minutes: +((Date.now() - startedAt) / 60000).toFixed(1)
  }
  append(record)
  console.log(JSON.stringify(record))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  try { append({ ts: Date.now(), kind: 'fatal', error: err.code || err.message }) } catch {}
  process.exit(1)
})
