'use strict'

// Downloads /big.bin through the local p2pgate listener and verifies it.
// usage: node fetch-verify.js <port> <sha256> <bytes> [timeoutMs]
// prints one JSON line, exits 0 on success

const http = require('node:http')
const crypto = require('node:crypto')

const port = Number(process.argv[2] || 18082)
const expectedSha = String(process.argv[3] || '').toLowerCase()
const expectedBytes = Number(process.argv[4] || 0)
const timeoutMs = Number(process.argv[5] || 120_000)

const started = Date.now()
let bytes = 0
const hash = crypto.createHash('sha256')
let settled = false

const finish = (result, code) => {
  if (settled) return
  settled = true
  console.log(JSON.stringify(result))
  process.exit(code)
}

const timer = setTimeout(() => {
  finish({ ok: false, error: 'timeout', bytes, ms: Date.now() - started }, 2)
}, timeoutMs)

const req = http.get({ host: '127.0.0.1', port, path: '/big.bin' }, (res) => {
  if (res.statusCode !== 200) {
    res.resume()
    finish({ ok: false, error: `status ${res.statusCode}`, bytes: 0, ms: Date.now() - started }, 1)
    return
  }

  res.on('data', (chunk) => {
    bytes += chunk.length
    hash.update(chunk)
  })

  res.on('end', () => {
    clearTimeout(timer)
    const actual = hash.digest('hex')
    const ok = actual === expectedSha && bytes === expectedBytes
    finish({
      ok,
      bytes,
      ms: Date.now() - started,
      sha256: actual,
      error: ok ? null : 'integrity'
    }, ok ? 0 : 1)
  })

  res.on('error', (err) => {
    clearTimeout(timer)
    finish({ ok: false, error: err.code || err.message, bytes, ms: Date.now() - started }, 1)
  })
})

req.on('error', (err) => {
  clearTimeout(timer)
  finish({ ok: false, error: err.code || err.message, bytes, ms: Date.now() - started }, 1)
})
