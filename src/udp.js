'use strict'

/**
 * UDP-over-stream framing.
 *
 * hyperdht exposes streams only, so datagrams are carried as:
 *   [length: uint16 big-endian][payload]
 *
 * Datagrams larger than MAX_DATAGRAM are refused instead of fragmented, which
 * keeps behaviour predictable on links with a small MTU.
 */

const MAX_DATAGRAM = 1200
const MAX_FRAME = MAX_DATAGRAM + 2

function encodeFrame(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)

  if (body.length === 0) {
    const err = new Error('empty datagrams are not forwarded')
    err.code = 'UDP_EMPTY'
    throw err
  }

  if (body.length > MAX_DATAGRAM) {
    const err = new Error(`datagram exceeds ${MAX_DATAGRAM} bytes`)
    err.code = 'UDP_TOO_LARGE'
    throw err
  }

  const frame = Buffer.allocUnsafe(2 + body.length)
  frame.writeUInt16BE(body.length, 0)
  body.copy(frame, 2)
  return frame
}

/**
 * Returns a stateful decoder. Feed chunks from the stream; it calls
 * onDatagram(buffer) for each complete frame.
 */
function createDecoder(onDatagram, onError) {
  let pending = Buffer.alloc(0)

  return function push(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])

    while (pending.length >= 2) {
      const length = pending.readUInt16BE(0)

      if (length === 0 || length > MAX_DATAGRAM) {
        onError(new Error(`invalid datagram length ${length}`))
        return
      }

      if (pending.length < 2 + length) return

      // Copy so the caller can keep the buffer after the next push().
      const payload = Buffer.from(pending.subarray(2, 2 + length))
      pending = pending.subarray(2 + length)
      onDatagram(payload)
    }
  }
}

module.exports = {
  MAX_DATAGRAM,
  MAX_FRAME,
  encodeFrame,
  createDecoder
}
