'use strict'

// LZ4 vs zstd on the real-link payloads. LZ4 trades ratio for speed; the question is
// whether that trade helps on a ~4 MB/s tunnel where zstd already has 36x CPU headroom.

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const lz4 = require('lz4-napi')

const MB = 1024 * 1024
const LINK_MBPS = 4.0
const SETUP_S = 2.2
const LEVEL = zlib.constants.ZSTD_c_compressionLevel
const payloadDir = path.join(__dirname, '..', 'real-link', 'payloads')

function makeEvents (bytes) {
  const actions = ['tool_call', 'tool_result', 'message', 'error', 'heartbeat']
  const parts = []
  let n = 0
  let i = 0
  while (n < bytes) {
    const ev = {
      seq: i,
      ts: new Date(1763600000000 + i * 13).toISOString(),
      session: `sess_${(i * 7919) % 100000}`,
      action: actions[i % actions.length],
      tool: ['read_file', 'search_code', 'run_command', 'sql_query'][i % 4],
      duration_ms: (i * 37) % 1500,
      ok: i % 7 !== 0,
      tokens_in: (i * 13) % 900,
      tokens_out: (i * 29) % 400,
      preview: `result for query ${i}: ${['alpha', 'bravo', 'charlie'][i % 3]} row ${(i * 17) % 1000}`
    }
    const line = JSON.stringify(ev) + '\n'
    parts.push(line)
    n += Buffer.byteLength(line)
    i += 1
  }
  return Buffer.from(parts.join('')).subarray(0, bytes)
}

function timeIt (fn, input) {
  const t0 = process.hrtime.bigint()
  const out = fn(input)
  return { out, seconds: Number(process.hrtime.bigint() - t0) / 1e9 }
}

function run (name, data) {
  const results = []

  const zstd = timeIt((b) => zlib.zstdCompressSync(b, { params: { [LEVEL]: 1 } }), data)
  const zstdBack = timeIt((b) => zlib.zstdDecompressSync(b), zstd.out)
  results.push({ name, codec: 'zstd-1', packed: zstd.out.length, c: zstd.seconds, d: zstdBack.seconds })
  if (!zstdBack.out.equals(data)) throw new Error('zstd integrity')

  for (const [label, opts] of [
    ['lz4-fast', {}],
    ['lz4-hc', { highCompression: true }],
    ['lz4-hc-9', { highCompression: true, compressionLevel: 9 }]
  ]) {
    let packed
    try {
      packed = timeIt((b) => lz4.compressFrameSync(b, opts), data)
    } catch (err) {
      results.push({ name, codec: label, error: err.message })
      continue
    }
    const back = timeIt((b) => lz4.decompressFrameSync(b), packed.out)
    if (!back.out.equals(data)) throw new Error(`${label} integrity`)
    results.push({ name, codec: label, packed: packed.out.length, c: packed.seconds, d: back.seconds })
  }

  const rawSeconds = SETUP_S + (data.length / MB) / LINK_MBPS
  console.log(`\n${name}  ${(data.length / MB).toFixed(2)} MB  raw ${rawSeconds.toFixed(2)}s`)
  for (const r of results) {
    if (r.error) { console.log(`${r.codec.padEnd(9)} ERROR ${r.error}`); continue }
    const total = SETUP_S + (r.packed / MB) / LINK_MBPS + r.c + r.d
    console.log(
      `${r.codec.padEnd(9)} ratio ${(data.length / r.packed).toFixed(2).padStart(5)}x  ` +
      `compressed ${(r.packed / MB).toFixed(2).padStart(6)} MB  ` +
      `cpu ${(r.c + r.d).toFixed(2)}s  total ${total.toFixed(2)}s  speedup ${(rawSeconds / total).toFixed(2)}x`
    )
  }
}

for (const file of ['log-64m.bin', 'text-64m.bin', 'binary-64m.bin']) {
  const full = path.join(payloadDir, file)
  if (fs.existsSync(full)) run(file, fs.readFileSync(full))
}
run('ndjson-1mb', makeEvents(1 * MB))
