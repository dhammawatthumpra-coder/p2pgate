'use strict'

const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_AUDIT_LOG_PATH = path.join(os.homedir(), '.p2pgate', 'audit.log')
const DEFAULT_AUDIT_MAX_BYTES = 5 * 1024 * 1024
const MAX_STRING_LENGTH = 256
const FORBIDDEN_FIELD = /pin|password|passphrase|secret|seed|verifier|token|private/i

function truncate(value) {
  if (typeof value !== 'string') return value
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}...`
    : value
}

function sanitizeFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {}

  const safe = {}

  for (const [key, value] of Object.entries(fields)) {
    if (key === 'source' || key === 'event' || key === 'ts') continue
    if (FORBIDDEN_FIELD.test(key)) continue

    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      safe[key] = value
      continue
    }

    if (typeof value === 'string') {
      safe[key] = truncate(value)
      continue
    }

    if (Array.isArray(value)) {
      safe[key] = value
        .filter((entry) => typeof entry === 'string' || typeof entry === 'number')
        .slice(0, 20)
        .map((entry) => truncate(entry))
    }
  }

  return safe
}

class AuditLog {
  constructor(options = {}) {
    this.enabled = options.enabled !== false
    this.filePath = options.filePath
      ? path.resolve(options.filePath)
      : DEFAULT_AUDIT_LOG_PATH
    this.maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes
      : DEFAULT_AUDIT_MAX_BYTES
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.queue = Promise.resolve()
    this.initialized = false
  }

  async init() {
    if (!this.enabled) return
    if (this.initialized) return

    const dir = path.dirname(this.filePath)
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      await fsp.chmod(dir, 0o700)
    } catch {
      // Windows and some filesystems do not enforce POSIX modes.
    }

    try {
      const handle = await fsp.open(this.filePath, 'a', 0o600)
      await handle.close()
      await fsp.chmod(this.filePath, 0o600)
    } catch (err) {
      this.log(`cannot prepare audit log: ${err.message}`)
    }

    await this._rotateIfNeeded()
    this.initialized = true
  }

  record(event, fields = {}) {
    if (!this.enabled) return Promise.resolve()

    const sourceFields = fields && typeof fields === 'object' && !Array.isArray(fields)
      ? fields
      : {}
    const entry = {
      ts: new Date(this.now()).toISOString(),
      event: truncate(String(event || 'unknown')),
      source: truncate(String(sourceFields.source || 'app')),
      ...sanitizeFields(sourceFields)
    }

    this.queue = this.queue
      .then(async () => {
        if (!this.initialized) await this.init()
        await this._rotateIfNeeded()
        await fsp.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, {
          mode: 0o600
        })
      })
      .catch((err) => {
        this.log(`audit log write failed: ${err.message}`)
      })

    return this.queue
  }

  async _rotateIfNeeded() {
    let stat
    try {
      stat = await fsp.stat(this.filePath)
    } catch {
      return
    }

    if (stat.size < this.maxBytes) return

    const rotated = `${this.filePath}.1`
    try {
      await fsp.rm(rotated, { force: true })
      await fsp.rename(this.filePath, rotated)
      try {
        await fsp.chmod(rotated, 0o600)
      } catch {
        // Windows and some filesystems do not enforce POSIX modes.
      }
      this.log(`audit log rotated: ${rotated}`)
    } catch (err) {
      this.log(`audit log rotation failed: ${err.message}`)
    }
  }

  async close() {
    try {
      await this.queue
    } catch {
      // Ignore.
    }
  }
}

function createAuditLog(options = {}) {
  return new AuditLog({
    enabled: options.enabled !== false,
    filePath: options.path || options.filePath || DEFAULT_AUDIT_LOG_PATH,
    maxBytes: options.maxBytes,
    log: options.log,
    now: options.now
  })
}

module.exports = {
  DEFAULT_AUDIT_LOG_PATH,
  DEFAULT_AUDIT_MAX_BYTES,
  AuditLog,
  createAuditLog,
  sanitizeFields
}
