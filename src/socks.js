'use strict'

/**
 * Minimal SOCKS5 server-side handshake helpers (client process side).
 *
 * Only CONNECT with IPv4 or domain address types is supported. UDP ASSOCIATE
 * and BIND are rejected. Authentication is handled by p2pgate itself, so the
 * SOCKS negotiation offers only "no authentication".
 */

const SOCKS_VERSION = 5
const REPLY = Object.freeze({
  SUCCEEDED: 0x00,
  GENERAL_FAILURE: 0x01,
  NOT_ALLOWED: 0x02,
  HOST_UNREACHABLE: 0x04,
  COMMAND_NOT_SUPPORTED: 0x07,
  ADDRESS_NOT_SUPPORTED: 0x08
})

class SocksError extends Error {
  constructor(message, replyCode = REPLY.GENERAL_FAILURE) {
    super(message)
    this.name = 'SocksError'
    this.code = 'SOCKS_FAILED'
    this.replyCode = replyCode
  }
}

function readExactly(socket, length, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null

    const cleanup = () => {
      socket.removeListener('readable', onReadable)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      if (timer) clearTimeout(timer)
    }

    const finish = (err, buffer) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(err)
      else resolve(buffer)
    }

    const onReadable = () => {
      const chunk = socket.read(length)
      if (chunk !== null) finish(null, chunk)
    }

    const onError = (err) => finish(err)
    const onClose = () => finish(new Error('SOCKS client closed the connection'))

    timer = setTimeout(() => finish(new Error('SOCKS handshake timed out')), timeoutMs)

    socket.on('readable', onReadable)
    socket.once('error', onError)
    socket.once('close', onClose)
    onReadable()
  })
}

function encodeReply(code) {
  return Buffer.from([SOCKS_VERSION, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}

function writeReply(socket, code) {
  try {
    socket.write(encodeReply(code))
  } catch {
    // The socket may already be gone.
  }
}

async function readRequest(socket) {
  const greeting = await readExactly(socket, 2)

  if (greeting[0] !== SOCKS_VERSION) {
    throw new SocksError('unsupported SOCKS version', REPLY.GENERAL_FAILURE)
  }

  const methodCount = greeting[1]
  const methods = methodCount > 0 ? await readExactly(socket, methodCount) : Buffer.alloc(0)

  if (!methods.includes(0x00)) {
    socket.write(Buffer.from([SOCKS_VERSION, 0xff]))
    throw new SocksError('client did not offer the no-auth method', REPLY.NOT_ALLOWED)
  }

  socket.write(Buffer.from([SOCKS_VERSION, 0x00]))

  const header = await readExactly(socket, 4)

  if (header[0] !== SOCKS_VERSION) {
    throw new SocksError('invalid SOCKS request version', REPLY.GENERAL_FAILURE)
  }

  const command = header[1]
  const addressType = header[3]

  if (command !== 0x01) {
    throw new SocksError('only CONNECT is supported', REPLY.COMMAND_NOT_SUPPORTED)
  }

  let host

  if (addressType === 0x01) {
    const raw = await readExactly(socket, 4)
    host = `${raw[0]}.${raw[1]}.${raw[2]}.${raw[3]}`
  } else if (addressType === 0x03) {
    const lengthByte = await readExactly(socket, 1)
    const raw = await readExactly(socket, lengthByte[0])
    host = raw.toString('utf8')
  } else {
    throw new SocksError('only IPv4 and domain addresses are supported', REPLY.ADDRESS_NOT_SUPPORTED)
  }

  const portRaw = await readExactly(socket, 2)
  const port = portRaw.readUInt16BE(0)

  if (port < 1 || host === '') {
    throw new SocksError('invalid destination', REPLY.GENERAL_FAILURE)
  }

  return { host, port }
}

module.exports = {
  REPLY,
  SocksError,
  readRequest,
  writeReply
}
