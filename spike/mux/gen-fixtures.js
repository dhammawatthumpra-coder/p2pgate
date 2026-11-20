'use strict'

// Generates parity fixtures for the Rust spike from the real JS implementation.
// usage: node gen-fixtures.js > fixtures/mux-cases.jsonl

const crypto = require('node:crypto')
const {
  encodeFrame,
  FrameParser,
  TYPE,
  MAX_FRAME,
  HEADER_BYTES
} = require('../../src/mux')

const cases = []

function addEncode(type, flags, channelId, payload) {
  cases.push({
    kind: 'encode',
    type,
    flags,
    channelId,
    payload: Buffer.from(payload || []).toString('hex')
  })
}

// every frame type, including the p2path control type
for (const type of Object.values(TYPE)) {
  addEncode(type, 0, 1, Buffer.from('hello'))
}
addEncode(TYPE.DATA, 0, 7, Buffer.alloc(0))
addEncode(TYPE.DATA, 0, 0xffffffff, crypto.randomBytes(16))
addEncode(TYPE.DATA, 3, 42, crypto.randomBytes(MAX_FRAME))
addEncode(TYPE.DATA, 0, 1, crypto.randomBytes(MAX_FRAME - 1))

for (let i = 0; i < 50; i++) {
  addEncode(TYPE.DATA, i % 4, 1 + (i % 128), crypto.randomBytes(i * 37 % 1024))
}

// parse cases: frames, concatenations, and every split point
function encoded(type, flags, id, payload) {
  return encodeFrame(type, flags, id, payload).toString('hex')
}

const samples = [
  encoded(TYPE.DATA, 0, 1, Buffer.from('abc')),
  encoded(TYPE.DATA, 0, 2, crypto.randomBytes(MAX_FRAME)),
  encoded(TYPE.WINDOW, 0, 9, crypto.randomBytes(4)),
  encoded(TYPE.CLOSE, 0, 3, Buffer.alloc(0))
]

function addParse(chunks) {
  cases.push({ kind: 'parse', chunks: chunks.map((c) => c.toString('hex')) })
}

// whole frames, one chunk each
for (const sample of samples) addParse([Buffer.from(sample, 'hex')])

// one byte at a time (header split across chunks)
for (const sample of samples) {
  const buf = Buffer.from(sample, 'hex')
  addParse(Array.from({ length: buf.length }, (_, i) => buf.subarray(i, i + 1)))
}

// several frames in one chunk, and every two-way split
const all = Buffer.concat(samples.map((s) => Buffer.from(s, 'hex')))
addParse([all])
for (let i = 1; i < all.length; i += Math.max(1, Math.floor(all.length / 40))) {
  addParse([all.subarray(0, i), all.subarray(i)])
}

// trailing partial header must not produce a frame
addParse([all, Buffer.from([1, 2, 3])])
addParse([Buffer.alloc(0)])
addParse([])

// reference parser output for each parse case (computed by the JS code)
for (const item of cases) {
  if (item.kind !== 'parse') continue
  const frames = []
  let error = false
  const parser = new FrameParser(
    (frame) => frames.push({
      type: frame.type,
      flags: frame.flags,
      channelId: frame.channelId,
      payload: frame.payload.toString('hex')
    }),
    () => { error = true }
  )
  for (const hex of item.chunks) parser.push(Buffer.from(hex, 'hex'))
  item.expected = { frames, error }
}

process.stdout.write(cases.map((c) => JSON.stringify(c)).join('\n') + '\n')
