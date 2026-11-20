'use strict'

// Codec cost in isolation: compress and decompress only, no tunnel.
// The tunnel leg in the printed table is MODELED (compressed size / measured raw
// rate), so it is an upper bound — spike/compression-spike.js is the real end-to-end
// measurement and gives 1.6-2.7x, not the 6x this model suggests.
//
// text-like data is synthetic but deliberately high-entropy (random tokens and
// random dictionary words) so the ratios stay in the range real text/documents give,
// instead of the 15-30x a tiny repeated word list would produce.

const crypto = require('node:crypto')
const zlib = require('node:zlib')

const MB = 1024 * 1024
const SIZE = 16 * MB
const LEVEL = zlib.constants.ZSTD_c_compressionLevel

function makeText () {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  const words = []
  for (let i = 0; i < 800; i++) {
    let w = ''
    const len = 4 + (i % 5)
    for (let j = 0; j < len; j++) w += alphabet[(i * 7 + j * 13) % 26]
    words.push(w)
  }
  const parts = []
  let n = 0
  while (n < SIZE) {
    const line = `${n}\t${words[n % words.length]}\t${words[(n * 31) % words.length]}\t` +
      `${crypto.randomBytes(3).toString('base64')}\tvalue=${(n * 2654435761) % 100000}\n`
    parts.push(line)
    n += Buffer.byteLength(line)
  }
  return Buffer.from(parts.join('')).subarray(0, SIZE)
}

const algos = [
  { name: 'gzip-1', compress: (b) => zlib.gzipSync(b, { level: 1 }), decompress: zlib.gunzipSync },
  { name: 'zstd-1', compress: (b) => zlib.zstdCompressSync(b, { params: { [LEVEL]: 1 } }), decompress: zlib.zstdDecompressSync },
  { name: 'zstd-3', compress: (b) => zlib.zstdCompressSync(b, { params: { [LEVEL]: 3 } }), decompress: zlib.zstdDecompressSync },
  { name: 'brotli-1', compress: (b) => zlib.brotliCompressSync(b, { params: { 1: 1 } }), decompress: zlib.brotliDecompressSync },
  { name: 'brotli-4', compress: (b) => zlib.brotliCompressSync(b, { params: { 1: 4 } }), decompress: zlib.brotliDecompressSync }
]

function measure (data, algo, tunnelMBps) {
  const t0 = process.hrtime.bigint()
  const packed = algo.compress(data)
  const compressSeconds = Number(process.hrtime.bigint() - t0) / 1e9

  const t1 = process.hrtime.bigint()
  const unpacked = algo.decompress(packed)
  const decompressSeconds = Number(process.hrtime.bigint() - t1) / 1e9

  const integrity = crypto.createHash('sha256').update(unpacked).digest('hex') ===
    crypto.createHash('sha256').update(data).digest('hex')

  const tunnelSeconds = (packed.length / MB) / tunnelMBps
  const total = compressSeconds + tunnelSeconds + decompressSeconds
  const effectiveMBps = (SIZE / MB) / total

  return {
    algo: algo.name,
    ratio: +(data.length / packed.length).toFixed(2),
    compress: +compressSeconds.toFixed(2),
    decompress: +decompressSeconds.toFixed(2),
    tunnel: +tunnelSeconds.toFixed(2),
    effectiveMBps: +effectiveMBps.toFixed(1),
    speedup: +(effectiveMBps / tunnelMBps).toFixed(2),
    integrity
  }
}

// raw tunnel rates measured with the same 16 MiB payload (spike/compression-spike.js)
const cases = [
  { name: 'text', data: makeText(), rawTunnelMBps: 5.2 },
  { name: 'random', data: crypto.randomBytes(SIZE), rawTunnelMBps: 6.2 }
]

const out = []
for (const item of cases) {
  for (const algo of algos) {
    try {
      out.push({ case: item.name, rawTunnelMBps: item.rawTunnelMBps, ...measure(item.data, algo, item.rawTunnelMBps) })
    } catch (err) {
      out.push({ case: item.name, algo: algo.name, error: err.message })
    }
  }
}

for (const row of out) {
  if (row.error) {
    console.log(`${row.case.padEnd(7)} ${row.algo.padEnd(9)} ERROR ${row.error}`)
    continue
  }
  console.log(
    `${row.case.padEnd(7)} ${row.algo.padEnd(9)} ratio ${String(row.ratio).padStart(5)}x  ` +
    `comp ${row.compress}s  tunnel ${row.tunnel}s  decomp ${row.decompress}s  ` +
    `effective ${String(row.effectiveMBps).padStart(5)} MB/s  speedup ${row.speedup}x  ${row.integrity ? 'ok' : 'BAD'}`
  )
}
