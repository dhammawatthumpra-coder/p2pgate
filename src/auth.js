'use strict'

const readline = require('node:readline')

const AUTH_VERSION = 3
const AUTH_TIMEOUT_MS = 10_000
const MAX_CONTROL_BYTES = 4096
const AUTH_STATUS = Object.freeze({
  DECLINED: 'DECLINED',
  FASTPATH_READY: 'FASTPATH_READY',
  CHALLENGE_REQUIRED: 'CHALLENGE_REQUIRED',
  READY: 'READY'
})

const keypressReady = new WeakSet()

class AuthError extends Error {
  constructor(message, code = 'AUTH_ERROR') {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

function encodeControl(message) {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
}

function decodeControl(line) {
  let parsed

  try {
    parsed = JSON.parse(line)
  } catch {
    throw new AuthError('auth message is not valid JSON', 'AUTH_PROTOCOL')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuthError('auth message must be an object', 'AUTH_PROTOCOL')
  }

  return parsed
}

/**
 * Reads one newline-delimited control message and preserves any bytes that
 * arrived after the newline so they can be forwarded as raw tunnel data.
 */
function readControlLine(stream, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs)
    ? options.timeoutMs
    : AUTH_TIMEOUT_MS
  const maxBytes = Number.isInteger(options.maxBytes)
    ? options.maxBytes
    : MAX_CONTROL_BYTES

  return new Promise((resolve, reject) => {
    if (stream.destroyed) {
      reject(new AuthError('stream is already destroyed', 'AUTH_STREAM_CLOSED'))
      return
    }

    let buffer = Buffer.alloc(0)
    let timer = null
    let settled = false

    const finish = (err, value) => {
      if (settled) return
      settled = true

      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }

      stream.removeListener('data', onData)
      stream.removeListener('error', onError)
      stream.removeListener('close', onClose)
      stream.removeListener('end', onEnd)

      // Keep the stream paused until the caller attaches the real pipe. This
      // prevents raw tunnel bytes from being dropped between auth and piping.
      try {
        stream.pause()
      } catch {
        // Ignore.
      }

      if (err) reject(err)
      else resolve(value)
    }

    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      buffer = Buffer.concat([buffer, bytes])

      if (buffer.length > maxBytes) {
        finish(new AuthError('auth message is too large', 'AUTH_MESSAGE_TOO_LARGE'))
        return
      }

      const newline = buffer.indexOf(0x0a)
      if (newline === -1) return

      const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '')
      const leftover = buffer.subarray(newline + 1)

      finish(null, { line, leftover })
    }

    const onError = (err) => finish(err)
    const onClose = () => finish(new AuthError('auth stream closed', 'AUTH_STREAM_CLOSED'))
    const onEnd = () => finish(new AuthError('auth stream ended', 'AUTH_STREAM_CLOSED'))

    timer = setTimeout(() => {
      finish(new AuthError(`auth message timed out after ${timeoutMs}ms`, 'AUTH_TIMEOUT'))
    }, timeoutMs)

    stream.on('data', onData)
    stream.once('error', onError)
    stream.once('close', onClose)
    stream.once('end', onEnd)
  })
}

/**
 * Reads a secret without echoing it to the terminal. Requires a TTY; for
 * non-interactive use, pass --pin-stdin or P2PGATE_PIN instead.
 */
function promptHidden(question, options = {}) {
  const input = options.input || process.stdin
  const output = options.output || process.stdout
  const maxLength = Number.isInteger(options.maxLength) ? options.maxLength : 256

  if (!input || !input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(
      new AuthError(
        'cannot read a hidden credential from non-interactive input; use --pin-stdin or P2PGATE_PIN',
        'PIN_REQUIRED'
      )
    )
  }

  return new Promise((resolve, reject) => {
    let value = ''
    let settled = false

    if (!keypressReady.has(input)) {
      readline.emitKeypressEvents(input)
      keypressReady.add(input)
    }

    const cleanup = () => {
      input.removeListener('keypress', onKeypress)
      try {
        input.setRawMode(false)
      } catch {
        // Ignore.
      }
      try {
        input.pause()
      } catch {
        // Ignore.
      }
    }

    const finish = (err) => {
      if (settled) return
      settled = true
      cleanup()
      output.write('\n')

      if (err) reject(err)
      else resolve(value)
    }

    const onKeypress = (str, key) => {
      if (key && key.ctrl && (key.name === 'c' || key.name === 'd')) {
        finish(new AuthError('credential entry cancelled', 'AUTH_ABORTED'))
        return
      }

      if (key && (key.name === 'return' || key.name === 'enter')) {
        finish(null)
        return
      }

      if (key && (key.name === 'backspace' || key.name === 'delete')) {
        if (value.length > 0) {
          value = value.slice(0, -1)
          output.write('\b \b')
        }
        return
      }

      if (str && (!key || (!key.ctrl && !key.meta)) && str >= ' ' && str !== '\x7f') {
        for (const char of str) {
          if (value.length >= maxLength) break
          value += char
          output.write('*')
        }
      }
    }

    output.write(question)
    input.on('keypress', onKeypress)

    try {
      input.setRawMode(true)
    } catch {
      finish(new AuthError('cannot enable hidden input mode', 'PIN_REQUIRED'))
      return
    }

    input.resume()
  })
}

module.exports = {
  AUTH_VERSION,
  AUTH_TIMEOUT_MS,
  MAX_CONTROL_BYTES,
  AUTH_STATUS,
  AuthError,
  encodeControl,
  decodeControl,
  readControlLine,
  promptHidden
}
