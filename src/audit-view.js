'use strict'

const fsp = require('node:fs/promises')

const DEFAULT_TAIL_BYTES = 256 * 1024

/**
 * Reads the last part of an audit JSONL file and returns parsed events,
 * newest last. Designed for small screens: no full-file load.
 */
async function readAuditEvents(filePath, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : null
  const failuresOnly = options.failuresOnly === true
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : DEFAULT_TAIL_BYTES

  let handle

  try {
    handle = await fsp.open(filePath, 'r')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return []
    }
    throw err
  }

  try {
    const stat = await handle.stat()
    const size = stat.size
    const start = Math.max(0, size - maxBytes)
    const length = size - start

    if (length <= 0) return []

    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)

    const lines = buffer.toString('utf8').split(/\r?\n/)
    const events = []
    const cutoff = sinceMs === null ? null : Date.now() - sinceMs

    for (const line of lines) {
      const text = line.trim()
      if (text === '') continue

      let event
      try {
        event = JSON.parse(text)
      } catch {
        continue
      }

      if (!event || typeof event !== 'object') continue

      if (failuresOnly) {
        const name = String(event.event || '')
        if (!/failure|declined|revoked|locked|timeout/.test(name)) continue
      }

      if (cutoff !== null) {
        const stamp = Date.parse(event.ts || event.t || '')
        if (!Number.isFinite(stamp) || stamp < cutoff) continue
      }

      events.push(event)
    }

    return events.slice(-limit)
  } finally {
    await handle.close().catch(() => {})
  }
}

module.exports = {
  DEFAULT_TAIL_BYTES,
  readAuditEvents
}
