'use strict'

// Does a trained zstd dictionary actually help MCP-sized JSON messages, and does the
// saved bandwidth matter once the tunnel's RTT and setup are counted?

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const LEVEL = zlib.constants.ZSTD_c_compressionLevel
const DICT_ID = zlib.constants.ZSTD_c_dictIDFlag
const MB = 1024 * 1024
const LINK_MBPS = 4.0
const RTT_MS = 80

const testDir = path.join(__dirname, 'corpus', 'test')
const messages = fs.readdirSync(testDir).sort()
  .map((name) => fs.readFileSync(path.join(testDir, name)))

const dict16 = fs.readFileSync(path.join(__dirname, 'corpus', 'dict-16k.bin'))
const dict8 = fs.readFileSync(path.join(__dirname, 'corpus', 'dict-8k.bin'))

function measure (label, opts) {
  const decompressOpts = opts.dictionary ? { dictionary: opts.dictionary } : {}

  let raw = 0
  let packed = 0
  let compressNs = 0
  let decompressNs = 0
  let ok = true

  for (const msg of messages) {
    raw += msg.length
    const t0 = process.hrtime.bigint()
    const c = zlib.zstdCompressSync(msg, opts)
    compressNs += Number(process.hrtime.bigint() - t0)

    const t1 = process.hrtime.bigint()
    const back = zlib.zstdDecompressSync(c, decompressOpts)
    decompressNs += Number(process.hrtime.bigint() - t1)

    packed += c.length
    if (!back.equals(msg)) ok = false
  }

  const perMessage = packed / messages.length
  return {
    label,
    totalBytes: packed,
    perMessageBytes: +perMessage.toFixed(1),
    ratio: +(raw / packed).toFixed(2),
    savingsVsRawPct: +((1 - packed / raw) * 100).toFixed(1),
    compressUsPerMsg: +(compressNs / messages.length / 1000).toFixed(1),
    decompressUsPerMsg: +(decompressNs / messages.length / 1000).toFixed(1),
    integrity: ok
  }
}

const rows = [
  measure('fresh', { params: { [LEVEL]: 1 } }),
  measure('dict 8k', { params: { [LEVEL]: 1 }, dictionary: dict8 }),
  measure('dict 16k', { params: { [LEVEL]: 1 }, dictionary: dict16 }),
  measure('dict 16k, no dictID', { params: { [LEVEL]: 1, [DICT_ID]: 0 }, dictionary: dict16 })
]

const raw = messages.reduce((sum, m) => sum + m.length, 0)
const count = messages.length

console.log(`test: ${count} messages, ${(raw / 1024).toFixed(0)} KB, avg ${(raw / count).toFixed(0)} B`)
console.table(rows.map((r) => ({
  variant: r.label,
  'avg bytes/msg': r.perMessageBytes,
  ratio: `${r.ratio}x`,
  saved: `${r.savingsVsRawPct}%`,
  'compress µs': r.compressUsPerMsg,
  'decompress µs': r.decompressUsPerMsg,
  ok: r.integrity
})))

const fresh = rows[0]
const dict = rows[2]

console.log('\n--- does the saved traffic matter? ---')
console.log(`per message saved vs fresh: ${(fresh.perMessageBytes - dict.perMessageBytes).toFixed(1)} B`)
console.log(`at ${LINK_MBPS} MB/s that is ${(((fresh.perMessageBytes - dict.perMessageBytes) / MB) / LINK_MBPS * 1000).toFixed(2)} ms per message`)
console.log(`one request/response RTT is ~${RTT_MS} ms, so the saving is ${(((fresh.perMessageBytes - dict.perMessageBytes) / MB) / LINK_MBPS * 1000 / RTT_MS * 100).toFixed(2)}% of one round trip`)

console.log('\n--- one continuous stream of the test corpus (how a tunnel would actually do it) ---')
const stream = Buffer.concat(messages)
for (const [label, opts] of [
  ['fresh', { params: { [LEVEL]: 1 } }],
  ['dict 16k', { params: { [LEVEL]: 1 }, dictionary: dict16 }]
]) {
  const t0 = process.hrtime.bigint()
  const c = zlib.zstdCompressSync(stream, opts)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`${label.padEnd(8)} ${(c.length / 1024).toFixed(1)} KB  ratio ${(stream.length / c.length).toFixed(2)}x  ${ms.toFixed(1)} ms  transfer ${((c.length / MB) / LINK_MBPS * 1000).toFixed(0)} ms`)
}

// 1 MB of unique NDJSON events (not a repeated corpus), i.e. an agent streaming tool
// results. This is the case where byte savings can actually matter.
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

const unique = makeEvents(1 * MB)
console.log('\n--- 1 MB of unique NDJSON events (bulk JSON case) ---')
for (const [label, opts] of [
  ['fresh', { params: { [LEVEL]: 1 } }],
  ['dict 16k', { params: { [LEVEL]: 1 }, dictionary: dict16 }]
]) {
  const t0 = process.hrtime.bigint()
  const c = zlib.zstdCompressSync(unique, opts)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`${label.padEnd(8)} ${(c.length / 1024).toFixed(1)} KB  ratio ${(unique.length / c.length).toFixed(2)}x  ${ms.toFixed(1)} ms  transfer ${((c.length / MB) / LINK_MBPS * 1000).toFixed(0)} ms`)
}
