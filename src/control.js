'use strict'

const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const CONTROL_VERSION = 2
const MAX_CONTROL_BYTES = 4096
const MAX_CONTROL_RESPONSE_BYTES = 65_536
const CONTROL_TIMEOUT_MS = 5000
const TOKEN_HEX = /^[0-9a-f]{64}$/i

function defaultControlSocketPath() {
  if (process.platform === 'win32') {
    const hash = crypto
      .createHash('sha256')
      .update(os.homedir())
      .digest('hex')
      .slice(0, 12)
    return `\\\\.\\pipe\\p2pgate-control-${hash}`
  }

  return path.join(os.homedir(), '.p2pgate', 'control.sock')
}

function defaultControlTokenPath() {
  return path.join(os.homedir(), '.p2pgate', 'control.token')
}

function tokenDigest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest()
}

function verifyControlToken(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false
  return crypto.timingSafeEqual(tokenDigest(received), tokenDigest(expected))
}

async function createControlToken(filePath = defaultControlTokenPath()) {
  const absolutePath = path.resolve(filePath)
  const token = crypto.randomBytes(32).toString('hex')
  const dir = path.dirname(absolutePath)

  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await fsp.chmod(dir, 0o700)
  } catch {
    // Windows and some filesystems do not enforce POSIX modes.
  }

  await fsp.writeFile(absolutePath, `${token}\n`, { mode: 0o600 })
  try {
    await fsp.chmod(absolutePath, 0o600)
  } catch {
    // See above.
  }

  return { token, path: absolutePath }
}

async function readControlToken(filePath = defaultControlTokenPath()) {
  const absolutePath = path.resolve(filePath)
  let raw

  try {
    raw = await fsp.readFile(absolutePath, 'utf8')
  } catch (err) {
    const missing = new Error(
      `control token not found: ${absolutePath}`
    )
    missing.code = 'CONTROL_TOKEN_MISSING'
    missing.cause = err
    throw missing
  }

  const token = raw.trim()
  if (!TOKEN_HEX.test(token)) {
    const invalid = new Error(
      `control token is malformed: ${absolutePath}`
    )
    invalid.code = 'CONTROL_TOKEN_INVALID'
    throw invalid
  }

  return token
}

async function removeControlToken(filePath) {
  if (!filePath) return
  try {
    await fsp.rm(path.resolve(filePath), { force: true })
  } catch {
    // Ignore.
  }
}

function writeResponse(socket, response) {
  try {
    socket.end(`${JSON.stringify(response)}\n`)
  } catch {
    try {
      socket.destroy()
    } catch {
      // Ignore.
    }
  }
}

function isPosix() {
  return process.platform !== 'win32'
}

async function verifySocketPermissions(socketPath) {
  if (!isPosix()) return

  const stat = await fsp.lstat(socketPath)
  let reason = null

  if (!stat.isSocket()) {
    reason = 'not-a-socket'
  } else if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    reason = 'wrong-owner'
  } else if ((stat.mode & 0o077) !== 0) {
    reason = 'group-or-other-permissions'
  }

  if (reason) {
    const err = new Error(
      `control socket has unsafe permissions or ownership (${reason}): ${socketPath}`
    )
    err.code = 'CONTROL_INSECURE'
    throw err
  }
}

function probeSocket(socketPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath })
    let settled = false

    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        // Ignore.
      }
      resolve(value)
    }

    const timer = setTimeout(() => finish(false), timeoutMs)

    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function prepareSocketPath(socketPath, log) {
  if (!isPosix()) return

  await fsp.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 })
  try {
    await fsp.chmod(path.dirname(socketPath), 0o700)
  } catch {
    // Windows and some filesystems do not enforce POSIX modes.
  }

  try {
    await fsp.lstat(socketPath)
  } catch (err) {
    if (err && err.code === 'ENOENT') return
    throw err
  }

  const live = await probeSocket(socketPath)

  if (live) {
    const err = new Error(
      `another p2pgate server is already using ${socketPath}`
    )
    err.code = 'CONTROL_IN_USE'
    throw err
  }

  try {
    await fsp.rm(socketPath, { force: true })
    log(`removed stale control socket: ${socketPath}`)
  } catch (err) {
    log(`could not remove stale control socket: ${err.message}`)
  }
}

async function startControlServer(options = {}) {
  const socketPath = options.socketPath || defaultControlSocketPath()
  const handler = options.handler
  const log = typeof options.log === 'function' ? options.log : () => {}
  const token = options.token

  if (typeof handler !== 'function') {
    throw new Error('control server handler is required')
  }

  if (typeof token !== 'string' || !TOKEN_HEX.test(token)) {
    throw new Error('control server token is required')
  }

  await prepareSocketPath(socketPath, log)

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0)
    let settled = false
    let timer = null

    const finish = (response) => {
      if (settled) return
      settled = true

      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }

      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)

      writeResponse(socket, response)
    }

    const fail = (error, message) => finish({ ok: false, error, message })

    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      buffer = Buffer.concat([buffer, bytes])

      if (buffer.length > MAX_CONTROL_BYTES) {
        fail('REQUEST_TOO_LARGE', 'control request exceeds 4096 bytes')
        return
      }

      const newline = buffer.indexOf(0x0a)
      if (newline === -1) return

      const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '')

      let request
      try {
        request = JSON.parse(line)
      } catch {
        fail('INVALID_REQUEST', 'control request is not valid JSON')
        return
      }

      if (!request || request.v !== CONTROL_VERSION) {
        fail('UNSUPPORTED_VERSION', 'unsupported control protocol version')
        return
      }

      if (!verifyControlToken(request.token, token)) {
        fail('UNAUTHORIZED', 'invalid control token')
        return
      }

      Promise.resolve()
        .then(() => handler(request))
        .then((response) => {
          finish(response && typeof response === 'object'
            ? response
            : { ok: false, error: 'INVALID_RESPONSE', message: 'handler returned no response' })
        })
        .catch((err) => {
          fail('CONTROL_ERROR', err && err.message ? err.message : String(err))
        })
    }

    const onError = () => {
      if (!settled) {
        settled = true
        if (timer !== null) clearTimeout(timer)
      }
      try {
        socket.destroy()
      } catch {
        // Ignore.
      }
    }

    const onClose = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    timer = setTimeout(() => {
      fail('TIMEOUT', 'control request timed out')
    }, CONTROL_TIMEOUT_MS)

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })

  server.on('error', (err) => {
    log(`control server error: ${err.message}`)
  })

  const previousUmask = isPosix() ? process.umask(0o177) : null

  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err)
      server.once('error', onError)
      server.listen(socketPath, () => {
        server.removeListener('error', onError)
        resolve()
      })
    })
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') err.code = 'CONTROL_IN_USE'
    throw err
  } finally {
    if (previousUmask !== null) process.umask(previousUmask)
  }

  if (isPosix()) {
    try {
      await fsp.chmod(socketPath, 0o600)
    } catch {
      // Ignore.
    }
  }

  try {
    await verifySocketPermissions(socketPath)
  } catch (err) {
    await new Promise((resolve) => {
      server.close(() => resolve())
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections()
      }
    })
    if (isPosix()) {
      try {
        await fsp.rm(socketPath, { force: true })
      } catch {
        // Ignore.
      }
    }
    throw err
  }

  log(`CONTROL socket listening: ${socketPath}`)

  async function close() {
    await new Promise((resolve) => {
      server.close(() => resolve())

      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections()
      }
    })

    if (isPosix()) {
      try {
        await fsp.rm(socketPath, { force: true })
      } catch {
        // Ignore.
      }
    }
  }

  return {
    server,
    socketPath,
    close
  }
}

function sendControlCommand(socketPath, request, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs)
    ? options.timeoutMs
    : 2000
  const payload = options.token && request && request.token === undefined
    ? { ...request, token: options.token }
    : request

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath })
    let buffer = Buffer.alloc(0)
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }

    const finish = (err, response) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        socket.destroy()
      } catch {
        // Ignore.
      }

      if (err) reject(err)
      else resolve(response)
    }

    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      buffer = Buffer.concat([buffer, bytes])

      if (buffer.length > MAX_CONTROL_RESPONSE_BYTES) {
        const err = new Error('control response is too large')
        err.code = 'CONTROL_PROTOCOL'
        finish(err)
        return
      }

      const newline = buffer.indexOf(0x0a)
      if (newline === -1) return

      const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '')

      let response
      try {
        response = JSON.parse(line)
      } catch {
        const err = new Error('control response is not valid JSON')
        err.code = 'CONTROL_PROTOCOL'
        finish(err)
        return
      }

      finish(null, response)
    }

    const onError = (err) => {
      const unavailable = new Error(err && err.message ? err.message : 'control socket unavailable')
      unavailable.code = 'CONTROL_UNAVAILABLE'
      unavailable.cause = err
      finish(unavailable)
    }

    const onClose = () => {
      if (!settled) {
        const err = new Error('control socket closed before a response')
        err.code = 'CONTROL_UNAVAILABLE'
        finish(err)
      }
    }

    timer = setTimeout(() => {
      const err = new Error('control request timed out')
      err.code = 'CONTROL_UNAVAILABLE'
      finish(err)
    }, timeoutMs)

    socket.once('connect', () => {
      try {
        socket.write(`${JSON.stringify(payload)}\n`)
      } catch (err) {
        finish(err)
      }
    })

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

module.exports = {
  CONTROL_VERSION,
  MAX_CONTROL_BYTES,
  MAX_CONTROL_RESPONSE_BYTES,
  defaultControlSocketPath,
  defaultControlTokenPath,
  createControlToken,
  readControlToken,
  removeControlToken,
  verifyControlToken,
  verifySocketPermissions,
  startControlServer,
  sendControlCommand
}
