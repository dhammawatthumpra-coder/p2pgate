'use strict'

// Generates three payloads of the same size:
//   text   - synthetic documentation-like text
//   log    - realistic application log lines
//   binary - random bytes (stands in for jpg/mp4/zip, i.e. already compressed)
// and writes zstd-1 versions next to them.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const SIZE = Number(process.env.SIZE_MB || 16) * 1024 * 1024
const OUT = path.join(__dirname, 'payloads')
const ZSTD_LEVEL = zlib.constants.ZSTD_c_compressionLevel

fs.mkdirSync(OUT, { recursive: true })

function fill (makeLine) {
  const parts = []
  let n = 0
  let i = 0
  while (n < SIZE) {
    const line = makeLine(i++)
    parts.push(line)
    n += Buffer.byteLength(line)
  }
  return Buffer.from(parts.join('')).subarray(0, SIZE)
}

// Real English/code text: concatenate the project's own source and docs. This is the
// honest stand-in for "text files people actually transfer" (~3-4x with zstd).
function makeText () {
  const root = 'D:/tunnel/p2pgate'
  const files = [
    'README.md', 'README.th.md', 'CHANGELOG.md', 'TESTING.md', 'CONTRIBUTING.md',
    'src/mux.js', 'src/server.js', 'src/client.js', 'src/cli.js', 'src/auth.js',
    'src/config-loader.js', 'src/socks.js', 'src/control.js', 'src/crypto-utils.js',
    'docs/SOAK.md', 'docs/HANDOFF.md', 'docs/PRODUCT-HANDOFF.md'
  ]
  const chunks = []
  for (const rel of files) {
    try { chunks.push(fs.readFileSync(path.join(root, rel))) } catch {}
  }
  const corpus = Buffer.concat(chunks)
  if (corpus.length === 0) throw new Error('text corpus is empty')
  const out = Buffer.allocUnsafe(SIZE)
  for (let offset = 0; offset < SIZE; offset += corpus.length) {
    corpus.copy(out, offset, 0, Math.min(corpus.length, SIZE - offset))
  }
  return out
}

const binary = crypto.randomBytes(SIZE)

const alphabet = 'abcdefghijklmnopqrstuvwxyz'
const words = []
for (let i = 0; i < 1200; i++) {
  let w = ''
  for (let j = 0; j < 3 + (i % 8); j++) w += alphabet[(i * 7 + j * 13) % 26]
  words.push(w)
}

const levels = ['INFO', 'INFO', 'INFO', 'WARN', 'DEBUG', 'ERROR']
const paths = ['/api/v1/session', '/api/v1/targets', '/health', '/api/v1/stream', '/metrics', '/api/v1/auth']
const agents = ['Mozilla/5.0 (Linux; Android 14)', 'curl/8.5.0', 'p2pgate/1.13.5', 'okhttp/4.12.0']

const log = fill((i) => {
  const ts = new Date(1763600000000 + i * 37).toISOString()
  const ms = 3 + ((i * 2654435761) % 2400)
  return `${ts} ${levels[i % levels.length].padEnd(5)} req=${i.toString(16).padStart(8, '0')} ` +
    `user=${words[(i * 11) % words.length]} path=${paths[i % paths.length]} ` +
    `status=${[200, 200, 200, 404, 500, 304][i % 6]} bytes=${100 + ((i * 7919) % 90000)} ` +
    `duration_ms=${ms} ua="${agents[i % agents.length]}"\n`
})

const items = [
  { name: 'text', data: makeText() },
  { name: 'log', data: log },
  { name: 'binary', data: binary }
]

for (const item of items) {
  const rawPath = path.join(OUT, `${item.name}-${SIZE / 1024 / 1024}m.bin`)
  fs.writeFileSync(rawPath, item.data)

  const compressed = zlib.zstdCompressSync(item.data, { params: { [ZSTD_LEVEL]: 1 } })
  const zstPath = rawPath.replace(/\.bin$/, '.zst')
  fs.writeFileSync(zstPath, compressed)

  console.log(JSON.stringify({
    name: item.name,
    bytes: item.data.length,
    sha256: crypto.createHash('sha256').update(item.data).digest('hex'),
    zstdBytes: compressed.length,
    zstdSha256: crypto.createHash('sha256').update(compressed).digest('hex'),
    ratio: +(item.data.length / compressed.length).toFixed(2)
  }))
}
