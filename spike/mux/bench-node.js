'use strict'

// Node side of the spike: encode/parse benchmark with the real src/mux.js code.
// usage: node bench-node.js [iterations]

const { encodeFrame, FrameParser, TYPE } = require('../../src/mux')

const iterations = Number(process.argv[2] || 500000)
const payloadSize = Number(process.argv[3] || 64)
const payload = Buffer.allocUnsafe(payloadSize)
let seed = 0x123456789abcdef0n
for (let i = 0; i < payloadSize; i++) { seed = (seed * 6364136223846793005n + 1n) & 0xffffffffffffffffn; payload[i] = Number((seed >> 33n) & 0xffn) }

function benchEncode() {
  const start = process.hrtime.bigint()
  let bytes = 0
  for (let i = 0; i < iterations; i++) {
    bytes += encodeFrame(TYPE.DATA, 0, i & 0xffff, payload).length
  }
  const ns = Number(process.hrtime.bigint() - start)
  return { ns, bytes }
}

function benchParse() {
  const perChunk = 1024
  let produced = 0
  const parser = new FrameParser(() => { produced++ })
  const batch = Buffer.concat(
    Array.from({ length: perChunk }, (_, i) => encodeFrame(TYPE.DATA, 0, i, payload))
  )
  const rounds = Math.ceil(iterations / perChunk)

  const start = process.hrtime.bigint()
  for (let i = 0; i < rounds; i++) parser.push(batch)
  const ns = Number(process.hrtime.bigint() - start)
  return { ns, produced }
}

const enc = benchEncode()
const par = benchParse()

console.log(JSON.stringify({
  runtime: 'node',
  iterations,
  encode: { ms: enc.ns / 1e6, nsPerOp: enc.ns / iterations, bytes: enc.bytes },
  parse: { ms: par.ns / 1e6, nsPerOp: par.ns / iterations, produced: par.produced }
}, null, 1))
