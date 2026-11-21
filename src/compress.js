'use strict'

// Optional stream compression for mux channels (prototype, opt-in on both ends).
//
// The tunnel is byte-transparent, so compression only helps payloads that are not
// already compressed. Negotiation happens per channel in the mux OPEN exchange; the
// server answers with the algorithm it picked, and both sides wrap the channel with a
// continuous zlib stream in each direction.

const zlib = require('node:zlib')
const { Duplex } = require('node:stream')

const COMPRESS_VERSION = 1
const DEFAULT_LEVEL = 1
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024
const DEFAULT_MAX_RATIO = 1000
const DEFAULT_MIN_RATIO_BYTES = 256 * 1024
const SAMPLE_BYTES = 32 * 1024
const SAMPLE_MS = 60
const SAMPLE_MIN_RATIO = 0.9

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

  if (value === 'auto') {
    return {
      enabled: true,
      mode: 'auto',
      algorithms: allowed,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      maxRatio: DEFAULT_MAX_RATIO,
      minRatioBytes: DEFAULT_MIN_RATIO_BYTES
    }
  }

  if (value === undefined || value === null || value === false || value === 'off') {
    return {
      enabled: false,
      mode: 'off',
      algorithms: allowed,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      maxRatio: DEFAULT_MAX_RATIO,
      minRatioBytes: DEFAULT_MIN_RATIO_BYTES
    }
  }

  if (value === true) {
    return {
      enabled: true,
      mode: 'always',
      algorithms: allowed,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      maxRatio: DEFAULT_MAX_RATIO,
      minRatioBytes: DEFAULT_MIN_RATIO_BYTES
    }
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const list = normalizeAlgorithmList(value.algorithms, allowed)
    if (list.length === 0) {
      const err = new Error('compress.algorithms must contain zstd or gzip')
      err.code = 'CONFIG_INVALID'
      throw err
    }

    const mode = value.mode === 'auto' ? 'auto' : 'always'
    const maxOutputBytes = Number.isInteger(value.maxOutputBytes) && value.maxOutputBytes > 0
      ? value.maxOutputBytes
      : DEFAULT_MAX_OUTPUT_BYTES
    const maxRatio = Number.isFinite(value.maxRatio) && value.maxRatio >= 1
      ? value.maxRatio
      : DEFAULT_MAX_RATIO
    const minRatioBytes = Number.isInteger(value.minRatioBytes) && value.minRatioBytes >= 0
      ? value.minRatioBytes
      : DEFAULT_MIN_RATIO_BYTES

    return {
      enabled: value.enabled !== false,
      mode,
      algorithms: list,
      maxOutputBytes,
      maxRatio,
      minRatioBytes
    }
  }

  const err = new Error('compress must be a boolean, "auto", or an object')
  err.code = 'CONFIG_INVALID'
  throw err
}

/**
 * Counts bytes through a decompressor and aborts when the stream expands past the
 * configured limits (zip-bomb guard). The caller must report each compressed chunk
 * with countInput().
 */
function guardDecompressor(stream, limits, onLimit) {
  const maxOutputBytes = Number.isInteger(limits && limits.maxOutputBytes)
    ? limits.maxOutputBytes
    : DEFAULT_MAX_OUTPUT_BYTES
  const maxRatio = Number.isFinite(limits && limits.maxRatio)
    ? limits.maxRatio
    : DEFAULT_MAX_RATIO
  const minRatioBytes = Number.isInteger(limits && limits.minRatioBytes)
    ? limits.minRatioBytes
    : DEFAULT_MIN_RATIO_BYTES

  let input = 0
  let output = 0
  let tripped = false

  stream.on('data', (chunk) => {
    if (tripped) return
    output += chunk.length

    const overBytes = output > maxOutputBytes
    const overRatio = input >= minRatioBytes && output > input * maxRatio

    if (overBytes || overRatio) {
      tripped = true
      onLimit(overBytes ? 'COMPRESS_OUTPUT_LIMIT' : 'COMPRESS_RATIO_LIMIT')
    }
  })

  return {
    countInput(bytes) {
      input += bytes
    },
    stats() {
      return { input, output, tripped }
    }
  }
}

/**
 * Decides whether a byte sample is worth compressing. Returns true when the sample
 * shrinks by at least 10%; empty/short samples are treated as compressible because
 * interactive payloads are small and repetitive.
 */
function sampleCompressible(sample) {
  if (!Buffer.isBuffer(sample) || sample.length < 1024) return true

  try {
    const packed = supportsZstd()
      ? zlib.zstdCompressSync(sample, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 } })
      : zlib.gzipSync(sample, { level: 1 })

    return packed.length <= sample.length * SAMPLE_MIN_RATIO
  } catch {
    return true
  }
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

/**
 * Wraps a duplex byte stream (the authenticated tunnel) with a compressor on write and
 * a decompressor on read. Used for non-mux tunnels, where the whole stream is one
 * session. The wrapper is a Duplex so `pump()` can treat it like the raw stream.
 */
function createCompressedStream(stream, algorithm, limits = {}, initial = null) {
  const compressor = createCompressor(algorithm)
  const decompressor = createDecompressor(algorithm)
  let closed = false

  const wrapper = new Duplex({
    write(chunk, encoding, callback) {
      compressor.write(chunk, () => {
        if (typeof compressor.flush === 'function') compressor.flush(() => callback())
        else callback()
      })
    },
    final(callback) {
      compressor.end()
      compressor.once('end', () => {
        // End the encrypted stream as well: pump() used to end it directly, and
        // without FIN the peer would wait for its abort timer.
        if (!stream.destroyed) stream.end()
        callback()
      })
    },
    read() {
      decompressor.resume()
    },
    destroy(error, callback) {
      closed = true
      try { compressor.destroy() } catch { /* Ignore. */ }
      try { decompressor.destroy() } catch { /* Ignore. */ }
      if (!stream.destroyed) stream.destroy()
      callback(error)
    }
  })

  const guard = guardDecompressor(decompressor, limits, (code) => {
    const err = new Error(`compressed stream aborted: ${code}`)
    err.code = code
    wrapper.destroy(err)
  })

  compressor.on('data', (chunk) => {
    if (closed || stream.destroyed) return
    if (!stream.write(chunk)) compressor.pause()
  })
  stream.on('drain', () => {
    if (!closed) compressor.resume()
  })
  compressor.on('error', (err) => wrapper.destroy(err))

  if (initial && initial.length > 0) {
    guard.countInput(initial.length)
    decompressor.write(initial)
  }

  stream.on('data', (chunk) => {
    if (closed) return
    guard.countInput(chunk.length)
    decompressor.write(chunk)
  })
  decompressor.on('data', (chunk) => {
    if (!wrapper.push(chunk)) decompressor.pause()
  })
  decompressor.on('end', () => wrapper.push(null))
  decompressor.on('error', (err) => wrapper.destroy(err))
  stream.on('end', () => {
    if (!decompressor.writableEnded) decompressor.end()
  })
  stream.on('error', (err) => wrapper.destroy(err))
  stream.on('close', () => {
    if (!closed) wrapper.destroy()
  })
  wrapper.on('close', () => {
    if (!stream.destroyed) stream.destroy()
  })

  return wrapper
}

module.exports = {
  COMPRESS_VERSION,
  DEFAULT_LEVEL,
  SAMPLE_BYTES,
  SAMPLE_MS,
  supportsZstd,
  availableAlgorithms,
  normalizeAlgorithm,
  normalizeAlgorithmList,
  normalizeCompressConfig,
  pickAlgorithm,
  createCompressor,
  createDecompressor,
  writeAndFlush,
  guardDecompressor,
  sampleCompressible,
  createCompressedStream
}
