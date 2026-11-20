'use strict'

// On a slow link, spending more CPU to save bytes can be a net win. Measures zstd level
// and brotli quality against the measured 4.0 MB/s tunnel rate.
//
// Effective time = setup + compressedBytes / linkRate + compress + decompress
// (no streaming overlap, so this is the pessimistic case).

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const LINK_MBPS = 4.0
const SETUP_S = 2.2
const MB = 1024 * 1024
const ZSTD_LEVEL = zlib.constants.ZSTD_c_compressionLevel
const BROTLI_Q = zlib.constants.BROTLI_PARAM_QUALITY

const variants = [
  { name: 'zstd-1', compress: (b) => zlib.zstdCompressSync(b, { params: { [ZSTD_LEVEL]: 1 } }), decompress: zlib.zstdDecompressSync },
  { name: 'zstd-6', compress: (b) => zlib.zstdCompressSync(b, { params: { [ZSTD_LEVEL]: 6 } }), decompress: zlib.zstdDecompressSync },
  { name: 'zstd-12', compress: (b) => zlib.zstdCompressSync(b, { params: { [ZSTD_LEVEL]: 12 } }), decompress: zlib.zstdDecompressSync },
  { name: 'brotli-4', compress: (b) => zlib.brotliCompressSync(b, { params: { [BROTLI_Q]: 4 } }), decompress: zlib.brotliDecompressSync },
  { name: 'brotli-9', compress: (b) => zlib.brotliCompressSync(b, { params: { [BROTLI_Q]: 9 } }), decompress: zlib.brotliDecompressSync }
]

// Only the log payload: the text payload is a repeated 1 MB corpus, so higher zstd
// levels find the long-range repetition and report absurd ratios (500x+) that no real
// document would produce. Logs are formulaic but not repeated, so they are usable here.
for (const file of ['log-64m.bin']) {
  const full = path.join(__dirname, 'payloads', file)
  if (!fs.existsSync(full)) continue
  const data = fs.readFileSync(full)
  const rawSeconds = SETUP_S + (data.length / MB) / LINK_MBPS

  console.log(`\n${file}  raw=${rawSeconds.toFixed(2)}s (${(data.length / MB / rawSeconds).toFixed(2)} MB/s effective)`)

  for (const v of variants) {
    const t0 = process.hrtime.bigint()
    const packed = v.compress(data)
    const compress = Number(process.hrtime.bigint() - t0) / 1e9

    const t1 = process.hrtime.bigint()
    v.decompress(packed)
    const decompress = Number(process.hrtime.bigint() - t1) / 1e9

    const total = SETUP_S + (packed.length / MB) / LINK_MBPS + compress + decompress
    console.log(
      `${v.name.padEnd(9)} ratio ${(data.length / packed.length).toFixed(2).padStart(5)}x  ` +
      `size ${(packed.length / MB).toFixed(2).padStart(6)} MB  ` +
      `cpu ${(compress + decompress).toFixed(2)}s  ` +
      `total ${total.toFixed(2)}s  speedup ${(rawSeconds / total).toFixed(2)}x`
    )
  }
}
