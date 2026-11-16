'use strict'

const net = require('node:net')
const crypto = require('node:crypto')
const readline = require('node:readline/promises')
const HyperDHT = require('hyperdht')
const {
  assertMasterSecret,
  getSlot,
  deriveServerPublicKey,
  classifyCredential,
  deriveScramVerifier,
  buildAuthMessage,
  computeScramProof,
  computeServerSignature,
  timingSafeEqualHex,
  isHex64
} = require('./crypto-utils')
const { loadClientKey, DEFAULT_CLIENT_KEY_PATH } = require('./keygen')
const dgram = require('node:dgram')
const { encodeFrame, createDecoder, MAX_DATAGRAM } = require('./udp')
const {
  REPLY: SOCKS_REPLY,
  readRequest: readSocksRequest,
  writeReply: writeSocksReply
} = require('./socks')
const {
  AUTH_VERSION,
  AUTH_TIMEOUT_MS,
  MAX_CONTROL_BYTES,
  AUTH_STATUS,
  AuthError,
  encodeControl,
  decodeControl,
  readControlLine,
  promptHidden
} = require('./auth')

const CONNECT_TIMEOUT_MS = 12_000

function noop() {}

function nowIso() {
  return new Date().toISOString()
}

function validateLocalPort(value) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    const err = new Error('localPort must be an integer between 0 and 65535')
    err.code = 'CONFIG_INVALID'
    throw err
  }
  return value
}

function classifyOrThrow(value) {
  try {
    return classifyCredential(value)
  } catch {
    throw new AuthError(
      'ต้องเป็น PIN 10 ตัวอักษร หรือรหัสผ่านอย่างน้อย 12 ตัวอักษร',
      'CREDENTIAL_INVALID'
    )
  }
}

function isSaltHex(value) {
  return typeof value === 'string' &&
    value.length >= 32 &&
    value.length <= 128 &&
    value.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(value)
}

/**
 * Opens one encrypted HyperDHT stream to a specific server public key.
 */
function connectEncrypted(dht, publicKey, keyPair, timeoutMs, registerStream) {
  return new Promise((resolve, reject) => {
    const stream = dht.connect(publicKey, { keyPair })
    let settled = false
    let timer = null

    if (typeof registerStream === 'function') registerStream(stream)

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      stream.removeListener('open', onOpen)
      stream.removeListener('error', onError)
      stream.removeListener('close', onClose)
    }

    const fail = (err) => {
      if (settled) return
      settled = true
      cleanup()
      stream.on('error', () => {})
      if (!stream.destroyed) stream.destroy()
      reject(err)
    }

    const onOpen = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(stream)
    }

    const onError = (err) => fail(err)
    const onClose = () => fail(new Error('encrypted stream closed before it opened'))

    timer = setTimeout(() => {
      fail(new Error(`connection timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    stream.once('open', onOpen)
    stream.once('error', onError)
    stream.once('close', onClose)
  })
}

function pump(encrypted, socket, entry, onDone, log, leftover) {
  let finished = false

  const finish = (reason) => {
    if (finished) return
    finished = true

    if (reason) log(`[${nowIso()}] tunnel closed: ${reason}`)

    if (!encrypted.destroyed) encrypted.destroy()
    if (!socket.destroyed) socket.destroy()
    onDone(entry)
  }

  encrypted.on('error', (err) => finish(`p2p stream error: ${err.message}`))
  socket.on('error', (err) => finish(`local socket error: ${err.message}`))

  encrypted.on('end', () => {
    if (!socket.destroyed) socket.end()
  })

  socket.on('end', () => {
    if (!encrypted.destroyed) encrypted.end()
  })

  encrypted.on('close', () => finish())
  socket.on('close', () => finish())

  if (leftover && leftover.length > 0 && !socket.destroyed) {
    try {
      socket.write(leftover)
    } catch {
      finish('failed to write buffered tunnel data')
      return
    }
  }

  encrypted.pipe(socket)
  socket.pipe(encrypted)
}

/**
 * Starts the local client tunnel listener on 127.0.0.1:localPort.
 */
async function startClient(config, options = {}) {
  if (!config || typeof config !== 'object') {
    throw new Error('client configuration is required')
  }

  const masterSecret = assertMasterSecret(config.masterSecret)
  const localPort = validateLocalPort(
    config.localPort === undefined ? 8022 : config.localPort
  )

  const configTarget = typeof config.target === 'string' && config.target.trim() !== ''
    ? config.target.trim()
    : null
  const requestedTarget = typeof options.target === 'string' && options.target.trim() !== ''
    ? options.target.trim()
    : configTarget

  if (requestedTarget !== null && !/^[A-Za-z0-9_-]{1,32}$/.test(requestedTarget)) {
    const err = new Error('target must be 1-32 chars: A-Z a-z 0-9 _ -')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  const socksPortRaw = options.socksPort !== undefined
    ? options.socksPort
    : config.socks5Port

  const socksMode = socksPortRaw !== undefined && socksPortRaw !== null

  if (socksMode && requestedTarget !== null) {
    const err = new Error('SOCKS5 mode and a target cannot be combined')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  const socksPort = socksMode
    ? validateLocalPort(Number(socksPortRaw))
    : null

  const udpTarget = typeof options.udpTarget === 'string' && options.udpTarget.trim() !== ''
    ? options.udpTarget.trim()
    : (typeof config.udpTarget === 'string' && config.udpTarget.trim() !== ''
        ? config.udpTarget.trim()
        : null)

  if (udpTarget !== null && !/^[A-Za-z0-9_-]{1,32}$/.test(udpTarget)) {
    const err = new Error('udpTarget must be 1-32 chars: A-Z a-z 0-9 _ -')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  const udpMode = udpTarget !== null

  if (udpMode && (socksMode || requestedTarget !== null)) {
    const err = new Error('UDP mode cannot be combined with --socks5 or --target')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  const udpListenPort = udpMode
    ? validateLocalPort(
        options.udpListen !== undefined
          ? Number(options.udpListen)
          : (Number.isInteger(config.udpListen) ? config.udpListen : 5353)
      )
    : null

  const log = typeof options.log === 'function'
    ? options.log
    : (line) => console.log(line)

  const connectTimeoutMs = Number.isInteger(options.connectTimeoutMs)
    ? options.connectTimeoutMs
    : CONNECT_TIMEOUT_MS
  const authTimeoutMs = Number.isInteger(options.authTimeoutMs)
    ? options.authTimeoutMs
    : AUTH_TIMEOUT_MS
  const udpIdleTimeoutMs = Number.isInteger(options.udpIdleTimeoutMs)
    ? options.udpIdleTimeoutMs
    : 60_000
  const nowMs = typeof options.now === 'function' ? options.now : Date.now

  function writeLog(message) {
    log(`[${nowIso()}] ${message}`)
  }

  const promptOptions = {
    input: options.input || process.stdin,
    output: options.output || process.stdout
  }

  const envKeyPassphrase = typeof process.env.P2PGATE_KEY_PASSPHRASE === 'string'
    ? process.env.P2PGATE_KEY_PASSPHRASE
    : null
  if (envKeyPassphrase !== null) delete process.env.P2PGATE_KEY_PASSPHRASE

  const suppliedKeyPassphrase = typeof options.keyPassphrase === 'string'
    ? options.keyPassphrase
    : null
  let keyPassphrase = suppliedKeyPassphrase !== null
    ? suppliedKeyPassphrase
    : envKeyPassphrase

  async function loadKeyWithPassphrase() {
    let attempts = 0
    const allowRetry = suppliedKeyPassphrase === null && envKeyPassphrase === null

    while (true) {
      try {
        return await loadClientKey(
          config.clientKeyPath || DEFAULT_CLIENT_KEY_PATH,
          { passphrase: keyPassphrase }
        )
      } catch (err) {
        if (err && err.code === 'KEY_PASSPHRASE_REQUIRED') {
          if (!promptOptions.input || !promptOptions.input.isTTY) {
            throw new AuthError(
              'client key ถูกป้องกันด้วย passphrase แต่ไม่มี terminal; ใช้ --key-passphrase-stdin หรือ P2PGATE_KEY_PASSPHRASE',
              'KEY_PASSPHRASE_REQUIRED'
            )
          }

          keyPassphrase = (await promptHidden(
            '🔐 Passphrase สำหรับ client key: ',
            promptOptions
          )).trim()

          if (keyPassphrase === '') {
            throw new AuthError(
              'passphrase ว่างเปล่า',
              'KEY_PASSPHRASE_REQUIRED'
            )
          }
          continue
        }

        if (err && err.code === 'KEY_PASSPHRASE_INVALID') {
          if (!allowRetry) {
            throw new AuthError(
              'passphrase ของ client key ไม่ถูกต้อง',
              'KEY_PASSPHRASE_INVALID'
            )
          }

          attempts += 1
          if (attempts >= 3 || !promptOptions.input || !promptOptions.input.isTTY) {
            throw new AuthError(
              'passphrase ของ client key ไม่ถูกต้อง',
              'KEY_PASSPHRASE_INVALID'
            )
          }

          writeLog('passphrase ไม่ถูกต้อง ลองอีกครั้ง')
          keyPassphrase = null
          continue
        }

        throw err
      }
    }
  }

  const clientKey = await loadKeyWithPassphrase()
  const keyPair = clientKey.keyPair
  const clientPublicKeyHex = Buffer.from(keyPair.publicKey).toString('hex')

  // Read the environment credential once and remove it immediately so child
  // processes never inherit it.
  const envCredential = typeof process.env.P2PGATE_PIN === 'string'
    ? process.env.P2PGATE_PIN
    : null
  if (envCredential !== null) delete process.env.P2PGATE_PIN

  const suppliedCredential = typeof options.credential === 'string'
    ? options.credential
    : null
  const credentialProvider = typeof options.credential === 'function'
    ? options.credential
    : null
  const pinStdin = options.pinStdin === true

  // Precedence: --pin-stdin > P2PGATE_PIN > hidden prompt. If --pin-stdin is
  // selected, stdin is intentionally not read until the server asks for a
  // two-step challenge, so fast-path/key-only sessions never block on input.
  let credentialClass = null
  let credentialSource = null

  if (suppliedCredential !== null) {
    credentialClass = classifyOrThrow(suppliedCredential)
    credentialSource = 'stdin'
  } else if (envCredential !== null && !pinStdin) {
    credentialClass = classifyOrThrow(envCredential)
    credentialSource = 'env'
  } else if (pinStdin) {
    credentialSource = 'stdin'
  }

  let credentialPromise = null
  const verifierCache = new Map()

  async function readPinStdinLine() {
    const rl = readline.createInterface({
      input: promptOptions.input,
      output: promptOptions.output
    })

    try {
      return await rl.question('')
    } finally {
      rl.close()
    }
  }

  async function promptForCredential() {
    // The prompt is intentionally lazy (fast-path sessions never block), so
    // announce why it appeared now that a connection is actually waiting.
    writeLog('เซิร์ฟเวอร์ขอการยืนยันตัวตน: กรอก PIN (10 ตัว) หรือรหัสผ่าน (12 ตัวขึ้นไป)')

    while (true) {
      const value = await promptHidden(
        '🔐 PIN (10 ตัว) หรือรหัสผ่าน (12 ตัวขึ้นไป): ',
        promptOptions
      )

      if (value === '') continue

      try {
        return classifyCredential(value)
      } catch {
        writeLog('ต้องเป็น PIN 10 ตัวอักษร หรือรหัสผ่านอย่างน้อย 12 ตัวอักษร')
      }
    }
  }

  async function getCredential() {
    if (credentialClass !== null) return credentialClass

    if (credentialPromise === null) {
      credentialPromise = (async () => {
        if (credentialProvider !== null) {
          const value = await credentialProvider()
          credentialClass = classifyOrThrow(value)
          credentialSource = 'provider'
          return credentialClass
        }

        if (pinStdin && suppliedCredential === null) {
          const value = await readPinStdinLine()
          credentialClass = classifyOrThrow(value)
          credentialSource = 'stdin'
          return credentialClass
        }

        if (!promptOptions.input || !promptOptions.input.isTTY) {
          throw new AuthError(
            'เซิร์ฟเวอร์ต้องใช้ PIN/รหัสผ่าน แต่ไม่มี terminal; ใช้ --pin-stdin หรือ P2PGATE_PIN',
            'PIN_REQUIRED'
          )
        }

        credentialClass = await promptForCredential()
        credentialSource = 'prompt'
        writeLog('PIN/รหัสผ่านถูกเก็บไว้ในหน่วยความจำสำหรับ session นี้')
        return credentialClass
      })().finally(() => {
        credentialPromise = null
      })
    }

    return credentialPromise
  }

  function clearCredentialOnFailure(saltHex) {
    if (saltHex) verifierCache.delete(String(saltHex).toLowerCase())
    else verifierCache.clear()

    if (credentialSource === 'prompt') {
      credentialClass = null
    }
  }

  async function getVerifierFor(mode, saltHex) {
    const cached = verifierCache.get(saltHex)

    if (cached && cached.mode === mode) return cached.verifier

    const classified = await getCredential()
    if (classified.mode !== mode) {
      throw new AuthError(
        'ประเภทของ PIN/รหัสผ่านไม่ตรงกับเซิร์ฟเวอร์',
        'AUTH_PROTOCOL'
      )
    }

    const verifier = await deriveScramVerifier(
      classified.secret,
      Buffer.from(saltHex, 'hex')
    )
    verifierCache.set(saltHex, { mode, verifier })
    return verifier
  }

  async function sendInvalidPasswordAttempt(encrypted) {
    const clientNonce = crypto.randomBytes(32)
    const proof = crypto.randomBytes(32)

    encrypted.write(encodeControl({
      v: AUTH_VERSION,
      mode: 'pwd',
      clientNonce: clientNonce.toString('hex'),
      proof: proof.toString('hex')
    }))

    let result = null
    try {
      const response = await readControlLine(encrypted, {
        timeoutMs: authTimeoutMs,
        maxBytes: MAX_CONTROL_BYTES
      })
      result = decodeControl(response.line)
    } catch {
      result = null
    }

    const reason = result && result.error ? result.error : 'AUTH_FAILED'
    clearCredentialOnFailure(null)
    throw new AuthError(
      reason === 'LOCKED_OUT'
        ? 'ถูกปิดกั้นชั่วคราวหรือถาวร กรุณาใช้ p2pgate unlock'
        : 'เซิร์ฟเวอร์ยังไม่ได้ตั้งรหัสผ่านสำรอง กรุณาใช้ Session PIN',
      reason
    )
  }

  function declineError(status) {
    const reason = typeof status.reason === 'string' ? status.reason : 'declined'

    if (reason === 'unlisted') {
      throw new AuthError(
        'คีย์ของเครื่องนี้ไม่ได้รับอนุญาตบนเซิร์ฟเวอร์',
        'STATUS_DECLINED'
      )
    }

    if (reason === 'expired') {
      throw new AuthError(
        'สิทธิ์ของคีย์นี้หมดอายุแล้ว',
        'STATUS_DECLINED'
      )
    }

    if (reason === 'locked') {
      const minutes = Number.isFinite(status.retryAfterMs)
        ? Math.max(1, Math.ceil(status.retryAfterMs / 60_000))
        : null

      throw new AuthError(
        minutes
          ? `ถูกปิดกั้นชั่วคราว กรุณาลองใหม่ในอีกประมาณ ${minutes} นาที (Session PIN อาจถูกเปลี่ยนใหม่)`
          : 'ถูกปิดกั้นถาวร กรุณาใช้ p2pgate unlock --list / --all',
        'LOCKED_OUT'
      )
    }

    if (reason === 'interactive_unavailable') {
      throw new AuthError(
        'เซิร์ฟเวอร์ไม่สามารถยืนยันแบบ two-step ได้ในโหมด background และยังไม่ได้ตั้งรหัสผ่านสำรอง',
        'STATUS_DECLINED'
      )
    }

    if (reason === 'insecure_registry') {
      throw new AuthError(
        'ไฟล์ trusted_devices มีสิทธิ์ไม่ปลอดภัย; เซิร์ฟเวอร์ปิด fast-path',
        'STATUS_DECLINED'
      )
    }

    if (reason === 'password_unavailable') {
      throw new AuthError(
        'เซิร์ฟเวอร์ยังไม่ได้ตั้ง connection password',
        'STATUS_DECLINED'
      )
    }

    if (reason === 'busy') {
      throw new AuthError(
        'เซิร์ฟเวอร์กำลังยืนยันตัวตนรายการอื่นอยู่ กรุณาลองใหม่',
        'STATUS_DECLINED'
      )
    }

    throw new AuthError('เซิร์ฟเวอร์ปฏิเสธการเชื่อมต่อ', 'STATUS_DECLINED')
  }

  function throwResultError(result) {
    const error = typeof result.error === 'string' ? result.error : 'AUTH_FAILED'

    if (error === 'SOCKS_DENIED') {
      throw new AuthError(
        'ปลายทางนี้ไม่อยู่ใน allowlist ของเซิร์ฟเวอร์',
        'SOCKS_DENIED'
      )
    }

    if (error === 'SOCKS_DISABLED') {
      throw new AuthError(
        'เซิร์ฟเวอร์นี้ไม่ได้เปิด SOCKS (ตั้ง socks.enabled)',
        'SOCKS_DISABLED'
      )
    }

    if (error === 'TARGET_UNKNOWN') {
      throw new AuthError(
        'เซิร์ฟเวอร์ไม่มี target ชื่อนี้ (ตรวจ `targets` ใน config ฝั่ง Server)',
        'TARGET_UNKNOWN'
      )
    }

    if (error === 'TARGET_FORBIDDEN') {
      throw new AuthError(
        'target นี้ไม่อนุญาตให้ client key นี้ (ตรวจ `allow` ของ target ฝั่ง Server)',
        'TARGET_FORBIDDEN'
      )
    }

    if (error === 'LOCKED_OUT') {
      const minutes = Number.isFinite(result.retryAfterMs)
        ? Math.max(1, Math.ceil(result.retryAfterMs / 60_000))
        : null
      throw new AuthError(
        minutes
          ? `ถูกปิดกั้นชั่วคราว กรุณาลองใหม่ในอีกประมาณ ${minutes} นาที (Session PIN อาจถูกเปลี่ยนใหม่ ดูบนหน้าจอ Server)`
          : 'ถูกปิดกั้นถาวร กรุณาใช้ p2pgate unlock --list / --all',
        'LOCKED_OUT'
      )
    }

    if (error === 'PIN_ROTATED_OR_INVALID') {
      throw new AuthError(
        'PIN อาจถูกเปลี่ยนใหม่แล้ว กรุณาดู Session PIN ล่าสุดบนหน้าจอ Server หรือใช้รหัสผ่านสำรอง',
        'PIN_ROTATED_OR_INVALID'
      )
    }

    throw new AuthError(
      'PIN/รหัสผ่านไม่ถูกต้อง หรือเซิร์ฟเวอร์ยังไม่ได้ตั้งรหัสผ่านสำรอง',
      'AUTH_FAILED'
    )
  }

  function authStreamError(message, stream) {
    const gone = !stream ||
      stream.destroyed === true ||
      stream.readableEnded === true ||
      stream.writableEnded === true

    if (gone) {
      return new AuthError(
        'การเชื่อมต่อขาดระหว่างรอการยืนยันตัวตน (ลองใหม่ได้)',
        'AUTH_STREAM_CLOSED'
      )
    }

    return new AuthError(message, 'AUTH_PROTOCOL')
  }

  async function authenticateEncrypted(encrypted, authOptions = {}) {
    let statusRead

    try {
      statusRead = await readControlLine(encrypted, {
        timeoutMs: authTimeoutMs,
        maxBytes: MAX_CONTROL_BYTES
      })
    } catch {
      throw new AuthError('ไม่ได้รับสถานะจากเซิร์ฟเวอร์', 'AUTH_PROTOCOL')
    }

    let status
    try {
      status = decodeControl(statusRead.line)
    } catch {
      throw new AuthError('สถานะจากเซิร์ฟเวอร์ไม่ถูกต้อง', 'AUTH_PROTOCOL')
    }

    if (!status || status.v !== AUTH_VERSION || typeof status.status !== 'string') {
      throw new AuthError(
        'โปรโตคอลการยืนยันตัวตนไม่ตรงกัน (ต้องอัปเดตทั้งสองฝั่งเป็น v1.3)',
        'AUTH_PROTOCOL'
      )
    }

    if (status.status === AUTH_STATUS.DECLINED) {
      return declineError(status)
    }

    if (status.status === AUTH_STATUS.FASTPATH_READY) {
      return { leftover: statusRead.leftover }
    }

    if (status.status !== AUTH_STATUS.CHALLENGE_REQUIRED) {
      throw new AuthError('สถานะจากเซิร์ฟเวอร์ไม่รู้จัก', 'AUTH_PROTOCOL')
    }

    // Announce readiness before asking for input. The server replies with the
    // challenge immediately, so a human typing the password delays the proof,
    // not the READY step that the strict auth timeout guards.
    try {
      if (encrypted.destroyed) {
        throw new AuthError('stream closed', 'AUTH_STREAM_CLOSED')
      }
      encrypted.write(encodeControl({
        v: AUTH_VERSION,
        status: AUTH_STATUS.READY
      }))
    } catch (err) {
      if (err instanceof AuthError && err.code === 'AUTH_STREAM_CLOSED') throw err
      throw authStreamError('ไม่สามารถแจ้งเซิร์ฟเวอร์ว่าพร้อมยืนยันตัวตนได้', encrypted)
    }

    let challengeRead
    try {
      challengeRead = await readControlLine(encrypted, {
        timeoutMs: authTimeoutMs,
        maxBytes: MAX_CONTROL_BYTES
      })
    } catch {
      throw authStreamError('ไม่ได้รับข้อความท้าทายจากเซิร์ฟเวอร์', encrypted)
    }

    let challenge
    try {
      challenge = decodeControl(challengeRead.line)
    } catch {
      throw new AuthError('ข้อความท้าทายจากเซิร์ฟเวอร์ไม่ถูกต้อง', 'AUTH_PROTOCOL')
    }

    if (challenge && challenge.status === AUTH_STATUS.DECLINED) {
      return declineError(challenge)
    }

    if (challenge && challenge.ok === false) {
      throwResultError(challenge)
    }

    if (
      !challenge ||
      challenge.v !== AUTH_VERSION ||
      !isHex64(challenge.nonce) ||
      !isSaltHex(challenge.pinSalt) ||
      (challenge.pwdSalt !== null && !isSaltHex(challenge.pwdSalt))
    ) {
      throw new AuthError('พารามิเตอร์การยืนยันตัวตนไม่ถูกต้อง', 'AUTH_PROTOCOL')
    }

    // The challenge is already in hand and the server is waiting for the proof,
    // so a slow human answer can no longer collide with connection setup.
    const classified = await getCredential()
    const mode = classified.mode

    if (mode === 'pwd' && challenge.pwdSalt === null) {
      return sendInvalidPasswordAttempt(encrypted)
    }

    const saltHex = mode === 'pin' ? challenge.pinSalt : challenge.pwdSalt
    const serverNonceHex = challenge.nonce.toLowerCase()
    const clientNonce = crypto.randomBytes(32)
    const clientNonceHex = clientNonce.toString('hex')
    const authMessage = buildAuthMessage(
      serverNonceHex,
      clientNonceHex,
      clientPublicKeyHex
    )

    let verifier
    try {
      verifier = await getVerifierFor(mode, saltHex.toLowerCase())
    } catch (err) {
      throw new AuthError(
        `ไม่สามารถเตรียมข้อมูลยืนยันตัวตนได้: ${err.message}`,
        'AUTH_PROTOCOL'
      )
    }

    const proof = computeScramProof(verifier.clientKey, verifier.storedKey, authMessage)

    try {
      const proofMessage = {
        v: AUTH_VERSION,
        mode,
        clientNonce: clientNonceHex,
        proof: proof.toString('hex')
      }

      if (requestedTarget !== null) {
        proofMessage.target = requestedTarget
      }

      if (authOptions.socks) {
        proofMessage.socks = {
          host: authOptions.socks.host,
          port: authOptions.socks.port
        }
      }

      if (authOptions.udp) {
        proofMessage.udp = { target: authOptions.udp.target }
      }

      encrypted.write(encodeControl(proofMessage))
    } catch {
      throw new AuthError('ไม่สามารถส่งข้อมูลยืนยันตัวตนได้', 'AUTH_PROTOCOL')
    }

    let resultRead
    try {
      resultRead = await readControlLine(encrypted, {
        timeoutMs: authTimeoutMs,
        maxBytes: MAX_CONTROL_BYTES
      })
    } catch {
      const streamErr = authStreamError(
        'ไม่ได้รับผลการยืนยันตัวตนจากเซิร์ฟเวอร์',
        encrypted
      )
      if (streamErr.code !== 'AUTH_STREAM_CLOSED') clearCredentialOnFailure(saltHex)
      throw streamErr
    }

    let result
    try {
      result = decodeControl(resultRead.line)
    } catch {
      clearCredentialOnFailure(saltHex)
      throw new AuthError('ผลการยืนยันตัวตนจากเซิร์ฟเวอร์ไม่ถูกต้อง', 'AUTH_PROTOCOL')
    }

    if (!result || result.v !== AUTH_VERSION) {
      clearCredentialOnFailure(saltHex)
      throw new AuthError('ผลการยืนยันตัวตนจากเซิร์ฟเวอร์ไม่ถูกต้อง', 'AUTH_PROTOCOL')
    }

    if (result.ok !== true) {
      clearCredentialOnFailure(saltHex)
      throwResultError(result)
    }

    const expectedServerSig = computeServerSignature(verifier.serverKey, authMessage)
      .toString('hex')

    if (!timingSafeEqualHex(expectedServerSig, result.serverSig)) {
      clearCredentialOnFailure(saltHex)
      throw new AuthError(
        'การยืนยันฝั่งเซิร์ฟเวอร์ไม่ถูกต้อง — ยกเลิกการเชื่อมต่อเพื่อความปลอดภัย',
        'SERVER_SIG_INVALID'
      )
    }

    let serverTarget = null

    if (result.target && typeof result.target === 'object') {
      const name = typeof result.target.name === 'string' ? result.target.name : ''
      const port = Number(result.target.port)

      if (/^[A-Za-z0-9_-]{1,32}$/.test(name) &&
        Number.isInteger(port) && port >= 1 && port <= 65535) {
        serverTarget = { name, host: '127.0.0.1', port }
        writeLog(`TARGET ${serverTarget.name} -> ${serverTarget.host}:${serverTarget.port}`)
      }
    }

    return {
      leftover: Buffer.concat([
        statusRead.leftover,
        challengeRead.leftover,
        resultRead.leftover
      ]),
      target: serverTarget
    }
  }

  async function handleLocalSocket(socket, socksRequest = null) {
    if (closed) {
      socket.destroy()
      return
    }

    socket.setKeepAlive(true, 30_000)
    socket.setNoDelay(true)

    const entry = { socket, stream: null }
    activeConnections.add(entry)

    let aborted = false
    let pendingStream = null
    let encrypted = null

    const abortPending = () => {
      aborted = true
      if (pendingStream && !pendingStream.destroyed) pendingStream.destroy()
      if (entry.stream && !entry.stream.destroyed) entry.stream.destroy()
    }

    socket.on('error', abortPending)
    socket.on('close', abortPending)

    const baseSlot = getSlot(nowMs())
    const slots = [baseSlot, baseSlot - 1]
    const attempts = slots.map((slot) => ({ slot, retried: false }))
    let lastError = null

    while (attempts.length > 0) {
      if (aborted || closed) break

      const attempt = attempts.shift()
      const slot = attempt.slot

      let publicKey
      try {
        publicKey = deriveServerPublicKey(masterSecret, slot)
      } catch (err) {
        lastError = err
        break
      }

      try {
        encrypted = await connectEncrypted(
          dht,
          publicKey,
          keyPair,
          connectTimeoutMs,
          (stream) => {
            pendingStream = stream
          }
        )

        if (!encrypted) continue

        encrypted.on('error', noop)

        entry.stream = encrypted
        pendingStream = null

        const authResult = await authenticateEncrypted(
          encrypted,
          socksRequest ? { socks: socksRequest } : {}
        )

        writeLog(
          `TUNNEL established slot=${slot} serverKey=${publicKey.toString('hex')}` +
            `${authResult.target ? ` target=${authResult.target.name}` : ''}`
        )

        if (socksRequest) {
          writeSocksReply(socket, SOCKS_REPLY.SUCCEEDED)
        }

        pump(encrypted, socket, entry, (finishedEntry) => {
          activeConnections.delete(finishedEntry)
        }, writeLog, authResult.leftover)

        return
      } catch (err) {
        lastError = err

        if (err instanceof AuthError) {
          if (err.code === 'AUTH_STREAM_CLOSED' && !aborted && !attempt.retried) {
            writeLog(
              `auth stream closed before completion (slot=${slot}); retrying once`
            )
            if (encrypted && !encrypted.destroyed) encrypted.destroy()
            encrypted = null
            attempts.unshift({ slot, retried: true })
            continue
          }

          writeLog(`authentication failed: ${err.message}`)
          if (encrypted && !encrypted.destroyed) encrypted.destroy()
          encrypted = null
          break
        }

        writeLog(`connect to slot=${slot} failed: ${err.message}`)
      }
    }

    if (lastError && !aborted && !(lastError instanceof AuthError)) {
      writeLog(`tunnel failed after trying slots ${slots.join(', ')}: ${lastError.message}`)
    }

    if (socksRequest) {
      writeSocksReply(socket, socksReplyFor(lastError))
    }

    activeConnections.delete(entry)
    if (!socket.destroyed) socket.destroy()
  }

  function socksReplyFor(err) {
    const code = err && err.code

    if (code === 'SOCKS_DENIED' || code === 'SOCKS_DISABLED' || code === 'TARGET_FORBIDDEN') {
      return SOCKS_REPLY.NOT_ALLOWED
    }

    if (code === 'TARGET_UNKNOWN') return SOCKS_REPLY.HOST_UNREACHABLE

    return SOCKS_REPLY.GENERAL_FAILURE
  }

  async function handleSocksSocket(socket) {
    if (closed) {
      socket.destroy()
      return
    }

    socket.setNoDelay(true)

    let request
    try {
      request = await readSocksRequest(socket)
    } catch (err) {
      writeLog(`SOCKS handshake failed: ${err.message}`)
      writeSocksReply(
        socket,
        err && err.replyCode !== undefined ? err.replyCode : SOCKS_REPLY.GENERAL_FAILURE
      )
      socket.destroy()
      return
    }

    await handleLocalSocket(socket, request)
  }

  const dhtOptions = { keyPair }
  if (Array.isArray(config.customBootstrap) && config.customBootstrap.length > 0) {
    dhtOptions.bootstrap = [...config.customBootstrap]
  }
  if (options.dhtOptions && typeof options.dhtOptions === 'object') {
    Object.assign(dhtOptions, options.dhtOptions)
  }

  const dht = new HyperDHT(dhtOptions)
  dht.on('error', (err) => {
    writeLog(`DHT error: ${err.message}`)
  })

  async function runPing() {
    const requested = options.ping && Number.isInteger(options.ping.count)
      ? options.ping.count
      : 3
    const count = Math.max(1, Math.min(10, requested))
    const baseSlot = getSlot(nowMs())
    const results = []

    for (const slot of [baseSlot, baseSlot - 1]) {
      let publicKey
      try {
        publicKey = deriveServerPublicKey(masterSecret, slot)
      } catch (err) {
        results.push({ slot, ok: false, error: err.code || err.message })
        continue
      }

      const samples = []
      let lastError = null
      let targetName = null

      for (let i = 0; i < count; i += 1) {
        const startedAt = nowMs()
        let stream = null

        try {
          stream = await connectEncrypted(dht, publicKey, keyPair, connectTimeoutMs)

          if (!stream) {
            lastError = 'PEER_NOT_FOUND'
            break
          }

          stream.on('error', noop)
          const connectMs = nowMs() - startedAt
          const authStart = nowMs()
          const authResult = await authenticateEncrypted(stream)
          const authMs = nowMs() - authStart

          if (authResult.target && authResult.target.name) {
            targetName = authResult.target.name
          }

          samples.push({ connectMs, authMs })
        } catch (err) {
          lastError = err.code || err.message
          break
        } finally {
          if (stream && !stream.destroyed) stream.destroy()
        }
      }

      if (samples.length > 0) {
        results.push({
          slot,
          ok: true,
          serverKey: publicKey.toString('hex'),
          target: targetName,
          connectMs: samples.map((sample) => sample.connectMs),
          authMs: samples.map((sample) => sample.authMs),
          attempts: samples.length
        })
        break
      }

      results.push({ slot, ok: false, error: lastError || 'UNKNOWN' })
    }

    return results
  }

  if (options.ping) {
    const results = await runPing()

    try {
      await dht.destroy()
    } catch {
      // Ignore.
    }

    return {
      mode: 'ping',
      results,
      address() {
        return null
      },
      async close() {}
    }
  }

  const activeConnections = new Set()

  let closed = false
  let listening = false

  const connectionHandler = socksMode ? handleSocksSocket : handleLocalSocket

  const udpSessions = new Map()
  let udpSocket = null

  function closeUdpSession(key) {
    const session = udpSessions.get(key)
    if (!session) return

    udpSessions.delete(key)
    session.closed = true

    if (session.timer !== null) {
      clearTimeout(session.timer)
      session.timer = null
    }

    if (session.stream && !session.stream.destroyed) session.stream.destroy()
  }

  function touchUdpSession(key, session) {
    if (session.timer !== null) clearTimeout(session.timer)
    session.timer = setTimeout(() => closeUdpSession(key), udpIdleTimeoutMs)
  }

  async function openUdpStream() {
    const baseSlot = getSlot(nowMs())
    const slots = [baseSlot, baseSlot - 1]
    let lastError = null

    for (const slot of slots) {
      if (closed) break

      let publicKey
      try {
        publicKey = deriveServerPublicKey(masterSecret, slot)
      } catch (err) {
        lastError = err
        break
      }

      let encrypted = null
      try {
        encrypted = await connectEncrypted(dht, publicKey, keyPair, connectTimeoutMs)
        if (!encrypted) continue

        encrypted.on('error', noop)
        await authenticateEncrypted(encrypted, { udp: { target: udpTarget } })
        writeLog(`UDP TUNNEL established slot=${slot} target=${udpTarget}`)
        return encrypted
      } catch (err) {
        lastError = err
        if (encrypted && !encrypted.destroyed) encrypted.destroy()
      }
    }

    throw lastError || new AuthError('UDP tunnel failed', 'AUTH_FAILED')
  }

  async function forwardUdpDatagram(rinfo, payload) {
    const key = `${rinfo.address}:${rinfo.port}`
    let session = udpSessions.get(key)

    if (!session) {
      const stream = await openUdpStream()

      session = { stream, timer: null, closed: false }
      const decoder = createDecoder((message) => {
        if (session.closed) return
        touchUdpSession(key, session)

        try {
          udpSocket.send(message, rinfo.port, rinfo.address)
        } catch {
          closeUdpSession(key)
        }
      }, (err) => {
        writeLog(`UDP framing error for ${key}: ${err.message}`)
        closeUdpSession(key)
      })

      stream.on('data', (chunk) => decoder(chunk))
      stream.on('error', () => closeUdpSession(key))
      stream.on('close', () => closeUdpSession(key))

      udpSessions.set(key, session)
    }

    touchUdpSession(key, session)
    session.stream.write(encodeFrame(payload))
  }

  const server = udpMode
    ? null
    : net.createServer((socket) => {
        connectionHandler(socket).catch((err) => {
          writeLog(`unexpected local connection failure: ${err.message}`)
          socket.destroy()
        })
      })

  if (server) {
    server.on('error', (err) => {
      writeLog(`local listener error: ${err.message}`)
    })
  }

  try {
    if (udpMode) {
      udpSocket = dgram.createSocket('udp4')

      udpSocket.on('error', (err) => {
        writeLog(`UDP listener error: ${err.message}`)
      })

      udpSocket.on('message', (message, rinfo) => {
        if (closed) return

        if (message.length > MAX_DATAGRAM) {
          writeLog(`UDP datagram dropped (${message.length} bytes) from ${rinfo.address}:${rinfo.port}`)
          return
        }

        forwardUdpDatagram(rinfo, message).catch((err) => {
          writeLog(
            `UDP tunnel failed for ${rinfo.address}:${rinfo.port}: ${err.message}`
          )
        })
      })

      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err)
        udpSocket.once('error', onError)
        udpSocket.bind({ address: '127.0.0.1', port: udpListenPort }, () => {
          udpSocket.removeListener('error', onError)
          resolve()
        })
      })

      listening = true
    } else {
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err)
        server.once('error', onError)
        server.listen({ host: '127.0.0.1', port: socksMode ? socksPort : localPort }, () => {
          server.removeListener('error', onError)
          resolve()
        })
      })

      listening = true
    }
  } catch (err) {
    try {
      await dht.destroy()
    } catch {
      // Ignore.
    }
    throw err
  }

  const address = udpMode ? udpSocket.address() : server.address()

  if (udpMode) {
    writeLog(`UDP LISTENING on 127.0.0.1:${address.port} (target ${udpTarget})`)
  } else if (socksMode) {
    writeLog(`SOCKS5 listening on 127.0.0.1:${address.port}`)
  } else {
    writeLog(
      `LISTENING on 127.0.0.1:${address.port} (connect with: ssh -p ${address.port} localhost)`
    )
  }

  async function close() {
    if (closed) return
    closed = true

    let closePromise = Promise.resolve()

    if (listening) {
      if (udpMode) {
        closePromise = new Promise((resolve) => {
          try {
            udpSocket.close(() => resolve())
          } catch {
            resolve()
          }
        })
      } else {
        closePromise = new Promise((resolve) => {
          server.close(() => resolve())
        })
      }
    }

    for (const key of [...udpSessions.keys()]) {
      closeUdpSession(key)
    }

    for (const entry of activeConnections) {
      try {
        if (entry.stream) entry.stream.destroy()
      } catch {
        // Ignore.
      }
      try {
        if (!entry.socket.destroyed) entry.socket.destroy()
      } catch {
        // Ignore.
      }
    }
    activeConnections.clear()

    await closePromise

    try {
      await dht.destroy()
    } catch {
      // Ignore.
    }

    writeLog('client stopped')
  }

  return {
    dht,
    server: udpSocket || server,
    address() {
      return udpMode ? udpSocket.address() : server.address()
    },
    get mode() {
      if (udpMode) return 'udp'
      return socksMode ? 'socks' : 'tcp'
    },
    get target() {
      return requestedTarget
    },
    get activeConnections() {
      return activeConnections.size
    },
    close
  }
}

module.exports = {
  startClient
}
