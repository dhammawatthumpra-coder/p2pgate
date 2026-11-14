'use strict'

const crypto = require('node:crypto')
const HyperDHT = require('hyperdht')

const SLOT_MS = 3_600_000
const HKDF_SALT = Buffer.from('p2pgate-v1-rolling-slot', 'utf8')
const HEX_64 = /^[0-9a-f]{64}$/

function masterSecretError(message) {
  const err = new Error(message)
  err.code = 'MASTER_SECRET_INVALID'
  return err
}

function clientKeyError(message) {
  const err = new Error(message)
  err.code = 'CLIENT_KEY_INVALID'
  return err
}

/**
 * Validates and normalizes a master secret.
 * A valid secret is exactly 32 random bytes encoded as 64 hex characters.
 * Placeholder, short, malformed, and obviously weak values are rejected.
 */
function assertMasterSecret(value) {
  if (typeof value !== 'string') {
    throw masterSecretError('masterSecret must be a string of 64 hexadecimal characters')
  }

  const normalized = value.trim().toLowerCase()

  if (!HEX_64.test(normalized)) {
    throw masterSecretError(
      'masterSecret must be exactly 64 hexadecimal characters (32 random bytes)'
    )
  }

  const bytes = Buffer.from(normalized, 'hex')
  const distinctBytes = new Set(bytes).size

  if (distinctBytes < 8) {
    throw masterSecretError(
      'masterSecret looks weak (too many repeated bytes). Generate a random secret with `p2pgate setup`'
    )
  }

  return normalized
}

function isMasterSecretValid(value) {
  try {
    assertMasterSecret(value)
    return true
  } catch {
    return false
  }
}

function generateMasterSecret() {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * UTC hour slot used for the rolling discovery key.
 */
function getSlot(timestampMs = Date.now()) {
  if (!Number.isFinite(timestampMs)) {
    throw new TypeError('timestampMs must be a finite number')
  }
  return Math.floor(timestampMs / SLOT_MS)
}

/**
 * Derives the deterministic 32-byte seed for a given hour slot.
 *
 * Node.js caveat: crypto.hkdfSync() returns an ArrayBuffer, so we always
 * convert it explicitly through Buffer.from() before using it.
 */
function deriveSlotSeed(masterSecret, slot) {
  const normalized = assertMasterSecret(masterSecret)

  if (!Number.isSafeInteger(slot)) {
    throw new TypeError('slot must be a safe integer')
  }

  const ikm = Buffer.from(normalized, 'hex')
  const raw = crypto.hkdfSync(
    'sha256',
    ikm,
    HKDF_SALT,
    Buffer.from(`slot:${slot}`, 'utf8'),
    32
  )

  return Buffer.from(raw)
}

/**
 * Returns the HyperDHT keypair used by the server for a given slot.
 */
function deriveSlotKeyPair(masterSecret, slot) {
  return HyperDHT.keyPair(deriveSlotSeed(masterSecret, slot))
}

function deriveServerPublicKey(masterSecret, slot) {
  const keyPair = deriveSlotKeyPair(masterSecret, slot)
  return Buffer.from(keyPair.publicKey)
}

function deriveServerPublicKeyHex(masterSecret, slot) {
  return deriveServerPublicKey(masterSecret, slot).toString('hex')
}

/**
 * Strictly converts a public key buffer (or Uint8Array) to lowercase hex.
 */
function publicKeyToHex(publicKey) {
  if (!Buffer.isBuffer(publicKey) && !(publicKey instanceof Uint8Array)) {
    throw clientKeyError('public key must be a Buffer or Uint8Array')
  }

  const buffer = Buffer.from(publicKey)
  if (buffer.length !== 32) {
    throw clientKeyError('public key must be exactly 32 bytes')
  }

  return buffer.toString('hex')
}

/**
 * Normalizes a client public key from configuration (64 hex characters).
 */
function normalizeClientPublicKeyHex(value) {
  if (typeof value !== 'string') {
    throw clientKeyError('client public key must be a 64-character hexadecimal string')
  }

  const normalized = value.trim().toLowerCase()
  if (!HEX_64.test(normalized)) {
    throw clientKeyError(
      'client public key must be exactly 64 hexadecimal characters (32 bytes)'
    )
  }

  return normalized
}

const SESSION_PIN_LENGTH = 10
const SESSION_PIN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const SCRAM_SCRYPT = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
})

function authCredentialError(message, code = 'CREDENTIAL_INVALID') {
  const err = new Error(message)
  err.code = code
  return err
}

function generateSessionPin() {
  let pin = ''

  for (let i = 0; i < SESSION_PIN_LENGTH; i++) {
    pin += SESSION_PIN_ALPHABET[crypto.randomInt(0, SESSION_PIN_ALPHABET.length)]
  }

  return pin
}

function formatSessionPin(pin) {
  if (typeof pin !== 'string' || pin.length !== SESSION_PIN_LENGTH) return pin
  return `${pin.slice(0, 5)}-${pin.slice(5)}`
}

/**
 * v1.2 credential classification:
 *   - >= 12 chars -> unattended password, case-sensitive and not stripped
 *   - 10 chars -> session PIN, uppercased
 *   - 5+5 chars with one hyphen -> session PIN, hyphen removed and uppercased
 *
 * The >= 12 check MUST happen first so a password containing hyphens is never
 * misclassified as a 10-character PIN.
 */
function classifyCredential(input) {
  if (typeof input !== 'string') {
    throw authCredentialError('credential must be a string')
  }

  const trimmed = input.trim()

  if (trimmed.length >= 12) {
    return { mode: 'pwd', secret: trimmed }
  }

  if (trimmed.length === 10) {
    return { mode: 'pin', secret: trimmed.toUpperCase() }
  }

  if (trimmed.length === 11 && /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(trimmed)) {
    return { mode: 'pin', secret: trimmed.replace('-', '').toUpperCase() }
  }

  throw authCredentialError(
    'credential must be a 10-character PIN or a password of at least 12 characters'
  )
}

function hmacSha256(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest()
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest()
}

function xorBuffers(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) {
    throw authCredentialError('SCRAM buffers must be equal-length Buffers')
  }

  const output = Buffer.alloc(left.length)
  for (let i = 0; i < left.length; i++) output[i] = left[i] ^ right[i]
  return output
}

function timingSafeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false

  try {
    return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  } catch {
    return false
  }
}

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function scryptAsync(password, salt, keylen = 32) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      keylen,
      SCRAM_SCRYPT,
      (err, derivedKey) => {
        if (err) reject(err)
        else resolve(derivedKey)
      }
    )
  })
}

/**
 * Derives SCRAM keys. The salt is scoped exclusively to p2pgate SCRAM
 * verification and must never be reused for any other purpose.
 */
async function deriveScramVerifier(secret, salt = crypto.randomBytes(16)) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw authCredentialError('credential must be a non-empty string')
  }

  if (!Buffer.isBuffer(salt) || salt.length < 16 || salt.length > 64) {
    throw authCredentialError('SCRAM salt must be a Buffer of 16-64 bytes')
  }

  const saltedPassword = await scryptAsync(secret, salt, 32)
  const clientKey = hmacSha256(saltedPassword, Buffer.from('p2pgate-client', 'utf8'))
  const storedKey = sha256(clientKey)
  const serverKey = hmacSha256(saltedPassword, Buffer.from('p2pgate-server', 'utf8'))

  return {
    salt,
    saltHex: salt.toString('hex'),
    clientKey,
    storedKey,
    serverKey,
    storedKeyHex: storedKey.toString('hex'),
    serverKeyHex: serverKey.toString('hex')
  }
}

function serializeScramVerifier(verifier) {
  return {
    saltHex: verifier.saltHex,
    storedKeyHex: verifier.storedKeyHex,
    serverKeyHex: verifier.serverKeyHex
  }
}

function parseScramVerifier(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw authCredentialError('SCRAM verifier must be an object', 'AUTH_VERIFIER_INVALID')
  }

  const { saltHex, storedKeyHex, serverKeyHex } = value

  if (
    typeof saltHex !== 'string' ||
    saltHex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(saltHex)
  ) {
    throw authCredentialError('SCRAM saltHex is invalid', 'AUTH_VERIFIER_INVALID')
  }

  const salt = Buffer.from(saltHex, 'hex')
  if (salt.length < 16 || salt.length > 64) {
    throw authCredentialError('SCRAM salt must be 16-64 bytes', 'AUTH_VERIFIER_INVALID')
  }

  if (!isHex64(storedKeyHex) || !isHex64(serverKeyHex)) {
    throw authCredentialError('SCRAM keys must be 32-byte hex strings', 'AUTH_VERIFIER_INVALID')
  }

  return {
    salt,
    saltHex: salt.toString('hex'),
    storedKey: Buffer.from(storedKeyHex, 'hex'),
    storedKeyHex: storedKeyHex.toLowerCase(),
    serverKey: Buffer.from(serverKeyHex, 'hex'),
    serverKeyHex: serverKeyHex.toLowerCase()
  }
}

function buildAuthMessage(serverNonceHex, clientNonceHex, clientPublicKeyHex) {
  return `${serverNonceHex}:${clientNonceHex}:${clientPublicKeyHex}`
}

function computeScramProof(clientKey, storedKey, authMessage) {
  const clientSignature = hmacSha256(storedKey, Buffer.from(authMessage, 'utf8'))
  return xorBuffers(clientKey, clientSignature)
}

function recoverScramClientKey(proof, storedKey, authMessage) {
  const clientSignature = hmacSha256(storedKey, Buffer.from(authMessage, 'utf8'))
  return xorBuffers(proof, clientSignature)
}

function computeServerSignature(serverKey, authMessage) {
  return hmacSha256(serverKey, Buffer.from(authMessage, 'utf8'))
}

function verifyScramProof(proof, storedKey, authMessage) {
  if (!Buffer.isBuffer(proof) || proof.length !== 32) return false
  if (!Buffer.isBuffer(storedKey) || storedKey.length !== 32) return false

  try {
    const candidateClientKey = recoverScramClientKey(proof, storedKey, authMessage)
    const candidateStoredKey = sha256(candidateClientKey)
    return crypto.timingSafeEqual(candidateStoredKey, storedKey)
  } catch {
    return false
  }
}

module.exports = {
  SLOT_MS,
  HKDF_SALT,
  SESSION_PIN_LENGTH,
  SESSION_PIN_ALPHABET,
  assertMasterSecret,
  isMasterSecretValid,
  generateMasterSecret,
  getSlot,
  deriveSlotSeed,
  deriveSlotKeyPair,
  deriveServerPublicKey,
  deriveServerPublicKeyHex,
  publicKeyToHex,
  normalizeClientPublicKeyHex,
  generateSessionPin,
  formatSessionPin,
  classifyCredential,
  timingSafeEqualHex,
  isHex64,
  deriveScramVerifier,
  serializeScramVerifier,
  parseScramVerifier,
  buildAuthMessage,
  computeScramProof,
  computeServerSignature,
  verifyScramProof
}
