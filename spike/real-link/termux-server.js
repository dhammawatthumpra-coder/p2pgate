'use strict'

// Runs on the Termux device. Starts a TCP sink (echoing when ECHO=1) and a p2pgate
// server that exposes it, so a client on another machine can push bytes through the
// real DHT tunnel.
//
// Env: MASTER_SECRET, PASSWORD, OUT (jsonl log), ECHO (1 = echo bytes back),
//      STATS (jsonl RSS log), STATS_MS (default 60000), COMPRESS (0 = disable)
// The sink records, per connection: bytes, seconds (first byte -> close), sha256.

const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const pkgRoot = process.env.P2P_PKG || '/data/data/com.termux/files/usr/lib/node_modules/p2pgate'
const { startServer } = require(path.join(pkgRoot, 'src/server'))
const { deriveScramVerifier, serializeScramVerifier } = require(path.join(pkgRoot, 'src/crypto-utils'))
const { generateClientKey } = require(path.join(pkgRoot, 'src/keygen'))

async function main () {
  const secret = process.env.MASTER_SECRET
  const password = process.env.PASSWORD
  const out = process.env.OUT || path.join(__dirname, 'received.jsonl')
  const stats = process.env.STATS || path.join(__dirname, 'stats.jsonl')
  const statsMs = Number(process.env.STATS_MS || 60_000)
  const echo = process.env.ECHO === '1'
  if (!secret || !password) throw new Error('MASTER_SECRET and PASSWORD are required')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-link-'))

  let connIndex = 0
  const sink = net.createServer((s) => {
    const index = ++connIndex
    let bytes = 0
    let first = null
    const hash = crypto.createHash('sha256')
    s.on('error', () => {})
    s.on('data', (c) => {
      if (first === null) first = process.hrtime.bigint()
      bytes += c.length
      hash.update(c)
    })
    s.on('close', () => {
      const end = process.hrtime.bigint()
      const line = JSON.stringify({
        conn: index,
        bytes,
        seconds: first === null ? 0 : Number(end - first) / 1e9,
        sha256: hash.digest('hex')
      })
      fs.appendFileSync(out, line + '\n')
      console.log(line)
    })

    if (echo) s.pipe(s)
  })
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve))
  const sinkPort = sink.address().port

  const verifier = serializeScramVerifier(await deriveScramVerifier(password))

  const config = {
    mode: 'server',
    masterSecret: secret,
    authMode: 'password',
    targetHost: '127.0.0.1',
    targetPort: sinkPort,
    localPort: 0,
    clientKeyPath: path.join(dir, 'server-key.json'),
    allowedClientKeys: [],
    verificationMode: 'hybrid',
    trustedDevicesFile: path.join(dir, 'trusted_devices'),
    auditLog: { enabled: false },
    customBootstrap: [],
    authPin: { enabled: true, unattended: verifier },
    telegramAlert: { enabled: false, botToken: '', chatId: '' },
    compress: process.env.COMPRESS === '0'
      ? false
      : { enabled: true, algorithms: ['zstd', 'gzip'] }
  }
  await generateClientKey(config.clientKeyPath)

  const server = await startServer(config, {
    log: () => {}, showSessionPin: false, sendStartupAlert: false, interactive: false
  })

  const monitor = setInterval(() => {
    const mem = process.memoryUsage()
    const line = JSON.stringify({
      ts: Date.now(),
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      connections: connIndex
    })
    try { fs.appendFileSync(stats, line + '\n') } catch {}
  }, statsMs)
  if (typeof monitor.unref === 'function') monitor.unref()

  console.log(`READY sink=${sinkPort} pid=${process.pid} echo=${echo ? 1 : 0}`)

  const shutdown = async () => {
    clearInterval(monitor)
    try { await server.close() } catch {}
    sink.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
