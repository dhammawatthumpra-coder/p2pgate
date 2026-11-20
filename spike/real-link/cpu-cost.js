'use strict'

// CPU cost of zstd-1 compress + decompress for the exact payloads used in the
// real-link test. Prints seconds, so the end-to-end numbers can include it.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const LEVEL = zlib.constants.ZSTD_c_compressionLevel
const dir = path.join(__dirname, 'payloads')

for (const name of ['text-64m.bin', 'log-64m.bin', 'binary-64m.bin', 'text-8m.bin']) {
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) continue
  const data = fs.readFileSync(file)

  const t0 = process.hrtime.bigint()
  const packed = zlib.zstdCompressSync(data, { params: { [LEVEL]: 1 } })
  const compress = Number(process.hrtime.bigint() - t0) / 1e9

  const t1 = process.hrtime.bigint()
  const back = zlib.zstdDecompressSync(packed)
  const decompress = Number(process.hrtime.bigint() - t1) / 1e9

  const ok = back.length === data.length &&
    crypto.createHash('sha256').update(back).digest('hex') ===
    crypto.createHash('sha256').update(data).digest('hex')

  console.log(JSON.stringify({
    file: name,
    MB: +(data.length / 1024 / 1024).toFixed(1),
    ratio: +(data.length / packed.length).toFixed(2),
    compressSeconds: +compress.toFixed(2),
    decompressSeconds: +decompress.toFixed(2),
    integrity: ok
  }))
}
