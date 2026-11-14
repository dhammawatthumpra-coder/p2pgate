'use strict'

const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_STATE_PATH = path.join(os.homedir(), '.p2pgate', 'lockout-state.json')
const WINDOW_MS = 24 * 60 * 60 * 1000
const LOCK_STALE_MS = 10_000
const LOCK_TIMEOUT_MS = 2_000

const LOCKOUT_LEVELS = Object.freeze([
  { failures: 3, lockoutMs: 15 * 60 * 1000, label: '15m' },
  { failures: 6, lockoutMs: 6 * 60 * 60 * 1000, label: '6h' },
  { failures: 10, permanent: true, label: 'permanent' }
])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null

  const failureTimes = Array.isArray(record.failureTimes)
    ? record.failureTimes.filter((time) => Number.isFinite(time))
    : []

  return {
    failureTimes,
    suspended: record.suspended === true,
    suspendedUntil: Number.isFinite(record.suspendedUntil) ? record.suspendedUntil : 0,
    level: [0, 3, 6, 10].includes(record.level) ? record.level : 0,
    lastFailureAt: Number.isFinite(record.lastFailureAt) ? record.lastFailureAt : 0,
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    revoked: record.revoked === true,
    reason: typeof record.reason === 'string' ? record.reason : ''
  }
}

class AuthGuard {
  constructor(options = {}) {
    this.statePath = options.statePath || DEFAULT_STATE_PATH
    this.lockPath = `${this.statePath}.lock`
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.failDelayMs = Array.isArray(options.failDelayMs) &&
      options.failDelayMs.length === 2 &&
      Number.isInteger(options.failDelayMs[0]) &&
      Number.isInteger(options.failDelayMs[1])
      ? [Math.min(...options.failDelayMs), Math.max(...options.failDelayMs)]
      : [2500, 3500]
    this.maxConcurrent = Number.isInteger(options.maxConcurrent)
      ? options.maxConcurrent
      : 3
    this.windowMs = Number.isInteger(options.windowMs) ? options.windowMs : WINDOW_MS
    this.log = typeof options.log === 'function' ? options.log : () => {}

    this.state = { version: 1, clients: {} }
    this.loadedMtimeMs = 0
    this.activeKeys = new Set()
    this.activeTotal = 0
    this.pinGeneration = 0
    this._pinRefreshChain = Promise.resolve()
    this.closed = false
  }

  async init() {
    await fsp.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 })
    try {
      await fsp.chmod(path.dirname(this.statePath), 0o700)
    } catch {
      // Windows and some filesystems do not enforce POSIX modes.
    }

    await this.refreshStateIfChanged()
  }

  async close() {
    this.closed = true
    try {
      await this._pinRefreshChain
    } catch {
      // Ignore.
    }
  }

  async refreshStateIfChanged() {
    let stat

    try {
      stat = await fsp.stat(this.statePath)
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        this.state = { version: 1, clients: {} }
        this.loadedMtimeMs = 0
        return false
      }
      throw err
    }

    if (stat.mtimeMs === this.loadedMtimeMs) return false

    let raw
    try {
      raw = await fsp.readFile(this.statePath, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        this.state = { version: 1, clients: {} }
        this.loadedMtimeMs = 0
        return false
      }
      throw err
    }

    let parsed
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    } catch {
      this.log(`lockout state is not valid JSON: ${this.statePath}`)
      this.loadedMtimeMs = stat.mtimeMs
      return false
    }

    const clients = {}

    if (parsed && typeof parsed === 'object' && parsed.clients &&
      typeof parsed.clients === 'object' && !Array.isArray(parsed.clients)) {
      for (const [key, record] of Object.entries(parsed.clients)) {
        if (!isHex64(key)) continue
        const normalized = normalizeRecord(record)
        if (normalized) clients[key.toLowerCase()] = normalized
      }
    }

    this.state = { version: 1, clients }
    this.loadedMtimeMs = stat.mtimeMs
    return true
  }

  async _acquireLock() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS

    while (Date.now() < deadline) {
      try {
        const handle = await fsp.open(this.lockPath, 'wx', 0o600)
        const token = crypto.randomBytes(8).toString('hex')

        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() }))
        } catch (err) {
          try {
            await handle.close()
          } catch {
            // Ignore.
          }
          try {
            await fsp.rm(this.lockPath, { force: true })
          } catch {
            // Ignore.
          }
          throw err
        }

        return { handle, token }
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err

        try {
          const stat = await fsp.stat(this.lockPath)
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            await fsp.rm(this.lockPath, { force: true })
            continue
          }
        } catch {
          // The lock may have disappeared; retry.
        }

        await sleep(10)
      }
    }

    throw new Error('timed out acquiring lockout state lock')
  }

  async _releaseLock(lock) {
    try {
      await lock.handle.close()
    } catch {
      // Ignore.
    }

    try {
      const raw = await fsp.readFile(this.lockPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && parsed.token === lock.token) {
        await fsp.rm(this.lockPath, { force: true })
      }
    } catch {
      // The lock was already gone or another process replaced it.
    }
  }

  async _writeState() {
    const tempPath = `${this.statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    const payload = `${JSON.stringify(this.state, null, 2)}\n`

    try {
      await fsp.writeFile(tempPath, payload, { mode: 0o600 })
      try {
        await fsp.chmod(tempPath, 0o600)
      } catch {
        // Windows and some filesystems do not enforce POSIX modes.
      }
      await fsp.rename(tempPath, this.statePath)
      try {
        await fsp.chmod(this.statePath, 0o600)
      } catch {
        // See above.
      }
      const stat = await fsp.stat(this.statePath)
      this.loadedMtimeMs = stat.mtimeMs
    } finally {
      try {
        await fsp.rm(tempPath, { force: true })
      } catch {
        // Ignore.
      }
    }
  }

  async _withLock(fn) {
    const lock = await this._acquireLock()

    try {
      await this.refreshStateIfChanged()
      const result = await fn()
      await this._writeState()
      return result
    } finally {
      await this._releaseLock(lock)
    }
  }

  _pruneFailures(record, now) {
    if (!record) return []
    record.failureTimes = record.failureTimes.filter(
      (time) => time > now - this.windowMs && time <= now
    )
    return record.failureTimes
  }

  _crossedLevel(previousCount, count) {
    for (let i = LOCKOUT_LEVELS.length - 1; i >= 0; i--) {
      const level = LOCKOUT_LEVELS[i]
      if (previousCount < level.failures && count >= level.failures) return level
    }
    return null
  }

  getStatus(keyHex) {
    const key = String(keyHex).toLowerCase()
    const record = this.state.clients[key]

    if (!record) {
      return {
        key,
        failures: 0,
        locked: false,
        permanent: false,
        suspendedUntil: 0,
        remainingMs: 0,
        level: 0,
        lastFailureAt: 0,
        revoked: false,
        reason: ''
      }
    }

    const now = this.now()
    const failures = this._pruneFailures(record, now).length
    const permanent = record.suspended === true
    const locked = permanent || record.suspendedUntil > now

    return {
      key,
      failures,
      locked,
      permanent,
      suspendedUntil: record.suspendedUntil,
      remainingMs: permanent
        ? null
        : Math.max(0, record.suspendedUntil - now),
      level: record.level,
      lastFailureAt: record.lastFailureAt,
      revoked: record.revoked === true,
      reason: record.reason || ''
    }
  }

  isSuspended(keyHex) {
    return this.getStatus(keyHex).locked
  }

  async listStatuses() {
    await this.refreshStateIfChanged()

    const statuses = []
    for (const key of Object.keys(this.state.clients)) {
      const status = this.getStatus(key)
      if (status.failures > 0 || status.locked) statuses.push(status)
    }

    return statuses.sort((a, b) => a.key.localeCompare(b.key))
  }

  async acquire(remoteHex) {
    await this.refreshStateIfChanged()

    const status = this.getStatus(remoteHex)
    if (status.locked) {
      return {
        ok: false,
        error: 'LOCKED_OUT',
        retryAfterMs: status.remainingMs,
        permanent: status.permanent
      }
    }

    if (this.activeKeys.has(remoteHex) || this.activeTotal >= this.maxConcurrent) {
      return { ok: false, error: 'AUTH_FAILED', busy: true }
    }

    this.activeKeys.add(remoteHex)
    this.activeTotal += 1
    let released = false

    return {
      ok: true,
      release: () => {
        if (released) return
        released = true
        this.activeKeys.delete(remoteHex)
        this.activeTotal = Math.max(0, this.activeTotal - 1)
      }
    }
  }

  async recordFailure(remoteHex) {
    const result = await this._withLock(async () => {
      const now = this.now()
      const record = this.state.clients[remoteHex] ||
        { failureTimes: [], suspended: false, suspendedUntil: 0, level: 0 }

      const previousCount = this._pruneFailures(record, now).length
      record.failureTimes.push(now)
      const count = record.failureTimes.length
      const crossed = this._crossedLevel(previousCount, count)

      if (crossed) {
        record.level = crossed.failures

        if (crossed.permanent) {
          record.suspended = true
          record.suspendedUntil = 0
        } else {
          record.suspended = false
          record.suspendedUntil = now + crossed.lockoutMs
        }
      }

      record.lastFailureAt = now
      record.updatedAt = now
      this.state.clients[remoteHex] = record

      const status = this.getStatus(remoteHex)

      return {
        failures: count,
        locked: status.locked,
        permanent: status.permanent,
        retryAfterMs: status.remainingMs,
        newlySuspended: Boolean(crossed),
        notification: crossed ? crossed.label : null,
        refreshPin: Boolean(crossed && (crossed.failures === 3 || crossed.failures === 6))
      }
    })

    return result
  }

  async recordSuccess(remoteHex) {
    return this._withLock(async () => {
      const status = this.getStatus(remoteHex)
      if (status.locked) return false
      delete this.state.clients[remoteHex]
      return true
    })
  }

  async revoke(keyHex, reason = 'manual') {
    const key = String(keyHex).toLowerCase()

    return this._withLock(async () => {
      const now = this.now()
      const record = this.state.clients[key] || {
        failureTimes: [],
        suspended: false,
        suspendedUntil: 0,
        level: 0
      }

      record.suspended = true
      record.suspendedUntil = 0
      record.revoked = true
      record.reason = reason
      record.updatedAt = now
      this.state.clients[key] = record

      return this.getStatus(key)
    })
  }

  async unlock(keyHex) {
    const key = String(keyHex).toLowerCase()

    return this._withLock(async () => {
      const existed = Boolean(this.state.clients[key])
      delete this.state.clients[key]
      return existed
    })
  }

  async unlockAll() {
    return this._withLock(async () => {
      const count = Object.keys(this.state.clients).length
      this.state.clients = {}
      return count
    })
  }

  async refreshPin(fn, expectedGeneration) {
    const run = this._pinRefreshChain.then(async () => {
      if (
        Number.isInteger(expectedGeneration) &&
        this.pinGeneration !== expectedGeneration
      ) {
        return { refreshed: false, generation: this.pinGeneration }
      }

      const nextGeneration = this.pinGeneration + 1
      await fn(nextGeneration)
      this.pinGeneration = nextGeneration
      return { refreshed: true, generation: nextGeneration }
    })

    this._pinRefreshChain = run.catch(() => {})
    return run
  }

  async delayFailure() {
    const [minimum, maximum] = this.failDelayMs
    const delayMs = crypto.randomInt(minimum, maximum + 1)
    await sleep(delayMs)
    return delayMs
  }
}

module.exports = {
  AuthGuard
}
