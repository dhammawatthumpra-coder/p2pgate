'use strict'

// Optional stream compression for mux channels (prototype, opt-in on both ends).
//
// The tunnel is byte-transparent, so compression only helps payloads that are not
// already compressed. Negotiation happens per channel in the mux OPEN exchange; the
// server answers with the algorithm it picked, and both sides wrap the channel with a
// continuous zlib stream in each direction.

const zlib = require('node:zlib')

const COMPRESS_VERSION = 1
const DEFAULT_LEVEL = 1

function supportsZstd() {
  return typeof zlib.zstdCompressSync === 'function' &&
    typeof zlib.createZstdCompress === 'function' &&
    typeof zlib.createZstdDecompress === 'function'
}

function availableAlgorithms() {
  return supportsZstd() ? ['zstd', 'gzip'] : ['gzip']
}

function normalizeAlgorithm(name) {
  const value = String(name || '').toLowerCase()

  if (value === 'zstd' && supportsZstd()) return 'zstd'
  if (value === 'gzip' || value === 'deflate' || value === 'gz') return 'gzip'

  return null
}

function normalizeAlgorithmList(list, fallback) {
  const source = Array.isArray(list) ? list : fallback
  const out = []

  for (const item of source) {
    const algorithm = normalizeAlgorithm(item)
    if (algorithm && !out.includes(algorithm)) out.push(algorithm)
  }

  return out
}

function normalizeCompressConfig(value, algorithms = availableAlgorithms()) {
  const allowed = normalizeAlgorithmList(algorithms, availableAlgorithms())

  if (value === undefined || value === null || value === false) {
    return { enabled: false, algorithms: allowed }
  }

  if (value === true) {
    return { enabled: true, algorithms: allowed }
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const list = normalizeAlgorithmList(value.algorithms, allowed)
    if (list.length === 0) {
      const err = new Error('compress.algorithms must contain zstd or gzip')
      err.code = 'CONFIG_INVALID'
      throw err
    }

    return { enabled: value.enabled !== false, algorithms: list }
  }

  const err = new Error('compress must be a boolean or an object')
  err.code = 'CONFIG_INVALID'
  throw err
}

function pickAlgorithm(requested, allowed) {
  const list = Array.isArray(requested) ? requested : [requested]
  const allow = Array.isArray(allowed) && allowed.length > 0
    ? allowed
    : availableAlgorithms()

  for (const name of list) {
    const algorithm = normalizeAlgorithm(name)
    if (algorithm && allow.includes(algorithm)) return algorithm
  }

  return null
}

function createCompressor(algorithm, options = {}) {
  const level = Number.isInteger(options.level) ? options.level : DEFAULT_LEVEL

  if (algorithm === 'zstd') {
    if (!supportsZstd()) {
      const err = new Error('zstd is not available in this Node.js build')
      err.code = 'COMPRESS_UNAVAILABLE'
      throw err
    }

    return zlib.createZstdCompress({
      chunkSize: options.chunkSize || 16 * 1024,
      params: { [zlib.constants.ZSTD_c_compressionLevel]: level }
    })
  }

  if (algorithm === 'gzip') {
    return zlib.createGzip({ level })
  }

  const err = new Error(`unsupported compression algorithm ${algorithm}`)
  err.code = 'COMPRESS_UNSUPPORTED'
  throw err
}

function createDecompressor(algorithm) {
  if (algorithm === 'zstd') {
    if (!supportsZstd()) {
      const err = new Error('zstd is not available in this Node.js build')
      err.code = 'COMPRESS_UNAVAILABLE'
      throw err
    }

    return zlib.createZstdDecompress()
  }

  if (algorithm === 'gzip') {
    return zlib.createGunzip()
  }

  const err = new Error(`unsupported compression algorithm ${algorithm}`)
  err.code = 'COMPRESS_UNSUPPORTED'
  throw err
}

// Flush after every write so interactive channels (SSH keystrokes) are not delayed by
// the compressor's internal buffering. Cost measured at ~2% ratio on 16 KB chunks.
function writeAndFlush(compressor, chunk) {
  const ready = compressor.write(chunk)

  if (typeof compressor.flush === 'function') {
    compressor.flush()
  }

  return ready
}

module.exports = {
  COMPRESS_VERSION,
  DEFAULT_LEVEL,
  supportsZstd,
  availableAlgorithms,
  normalizeAlgorithm,
  normalizeAlgorithmList,
  normalizeCompressConfig,
  pickAlgorithm,
  createCompressor,
  createDecompressor,
  writeAndFlush
}
