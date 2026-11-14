'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const HyperDHT = require('hyperdht')

const DEFAULT_DIR = path.join(os.homedir(), '.p2pgate')
const DEFAULT_CLIENT_KEY_PATH = path.join(DEFAULT_DIR, 'client-key.json')
const HEX_64 = /^[0-9a-f]{64}$/
const HEX_32 = /^[0-9a-f]{32}$/
const HEX_24 = /^[0-9a-f]{24}$/
const SCRYPT_PARAMS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  keylen: 32,
  maxmem: 64 * 1024 * 1024
})
const MIN_PASSPHRASE_LENGTH = 12

function keyError(message, code = 'CLIENT_KEY_INVALID') {
  const err = new Error(message)
  err.code = code
  return err
}

function expandHome(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new TypeError('path must be a non-empty string')
  }

  const value = input.trim()
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }

  return value
}

function resolveKeyPath(keyPath = DEFAULT_CLIENT_KEY_PATH) {
  return path.resolve(expandHome(keyPath))
}

async function ensureSecureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await fsp.chmod(dir, 0o700)
  } catch {
    // Windows and some filesystems do not enforce POSIX modes.
  }
}

async function writeKeyFile(keyPath, record) {
  const absolutePath = resolveKeyPath(keyPath)
  await ensureSecureDir(path.dirname(absolutePath))

  const payload = `${JSON.stringify(record, null, 2)}\n`
  await fsp.writeFile(absolutePath, payload, { mode: 0o600 })
  try {
    await fsp.chmod(absolutePath, 0o600)
  } catch {
    // See above.
  }

  return absolutePath
}

async function readKeyRecord(keyPath) {
  const absolutePath = resolveKeyPath(keyPath)

  let raw
  try {
    raw = await fsp.readFile(absolutePath, 'utf8')
    // The seed is a private key, so keep the file private even if it was
    // copied from somewhere with looser permissions.
    try {
      await fsp.chmod(absolutePath, 0o600)
    } catch {
      // Windows and some filesystems do not enforce POSIX modes.
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw keyError(
        `client key file not found: ${absolutePath}. Run \`p2pgate keygen\` to create one.`,
        'CLIENT_KEY_NOT_FOUND'
      )
    }
    throw err
  }

  let record
  try {
    record = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    throw keyError(`client key file is not valid JSON: ${absolutePath}`, 'CLIENT_KEY_INVALID')
  }

  return { record, path: absolutePath }
}

function validateKeyRecord(record, keyPath) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw keyError(`client key file is malformed: ${keyPath}`, 'CLIENT_KEY_INVALID')
  }

  const publicKey = typeof record.publicKey === 'string'
    ? record.publicKey.trim().toLowerCase()
    : ''

  if (!HEX_64.test(publicKey)) {
    throw keyError(
      `client key file must contain a 64-character hex "publicKey": ${keyPath}`,
      'CLIENT_KEY_INVALID'
    )
  }

  if (record.encrypted === true) {
    const kdfParams = record.kdfParams
    const saltHex = kdfParams && typeof kdfParams.saltHex === 'string'
      ? kdfParams.saltHex.trim().toLowerCase()
      : ''
    const ivHex = typeof record.ivHex === 'string'
      ? record.ivHex.trim().toLowerCase()
      : ''
    const tagHex = typeof record.tagHex === 'string'
      ? record.tagHex.trim().toLowerCase()
      : ''
    const ciphertextHex = typeof record.ciphertextHex === 'string'
      ? record.ciphertextHex.trim().toLowerCase()
      : ''

    if (
      record.version !== 2 ||
      record.kdf !== 'scrypt' ||
      record.cipher !== 'aes-256-gcm' ||
      !kdfParams ||
      !HEX_32.test(saltHex) ||
      !HEX_24.test(ivHex) ||
      !HEX_32.test(tagHex) ||
      !HEX_64.test(ciphertextHex)
    ) {
      throw keyError(
        `encrypted client key file is malformed: ${keyPath}`,
        'CLIENT_KEY_INVALID'
      )
    }

    return {
      encrypted: true,
      publicKey,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
      saltHex,
      ivHex,
      tagHex,
      ciphertextHex,
      kdfParams
    }
  }

  const seed = typeof record.seed === 'string' ? record.seed.trim().toLowerCase() : ''
  if (!HEX_64.test(seed)) {
    throw keyError(
      `client key file must contain 64-character hex "seed" and "publicKey": ${keyPath}`,
      'CLIENT_KEY_INVALID'
    )
  }

  return {
    encrypted: false,
    seed,
    publicKey,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null
  }
}

function scryptAsync(passphrase, salt, params = SCRYPT_PARAMS) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(passphrase, 'utf8'),
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem },
      (err, key) => {
        if (err) reject(err)
        else resolve(key)
      }
    )
  })
}

async function encryptRecord({ seedHex, publicKey, createdAt, passphrase }) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw keyError(
      `client key passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
      'KEY_PASSPHRASE_WEAK'
    )
  }

  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = await scryptAsync(passphrase, salt)

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(seedHex, 'hex')),
    cipher.final()
  ])
  const tag = cipher.getAuthTag()

  return {
    version: 2,
    encrypted: true,
    publicKey,
    createdAt,
    kdf: 'scrypt',
    kdfParams: {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      keylen: SCRYPT_PARAMS.keylen,
      saltHex: salt.toString('hex')
    },
    cipher: 'aes-256-gcm',
    ivHex: iv.toString('hex'),
    tagHex: tag.toString('hex'),
    ciphertextHex: ciphertext.toString('hex')
  }
}

async function decryptRecord(validated, passphrase) {
  if (typeof passphrase !== 'string' || passphrase === '') {
    throw keyError(
      'client key passphrase is required',
      'KEY_PASSPHRASE_REQUIRED'
    )
  }

  const salt = Buffer.from(validated.saltHex, 'hex')
  const params = {
    N: validated.kdfParams.N,
    r: validated.kdfParams.r,
    p: validated.kdfParams.p,
    keylen: validated.kdfParams.keylen,
    maxmem: SCRYPT_PARAMS.maxmem
  }

  try {
    const key = await scryptAsync(passphrase, salt, params)
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(validated.ivHex, 'hex')
    )
    decipher.setAuthTag(Buffer.from(validated.tagHex, 'hex'))
    const seed = Buffer.concat([
      decipher.update(Buffer.from(validated.ciphertextHex, 'hex')),
      decipher.final()
    ])

    if (seed.length !== 32) {
      throw new Error('invalid seed length')
    }

    return seed.toString('hex')
  } catch {
    throw keyError(
      'client key passphrase is incorrect or the key file is damaged',
      'KEY_PASSPHRASE_INVALID'
    )
  }
}

function keyPairFromSeed(seedHex) {
  return HyperDHT.keyPair(Buffer.from(seedHex, 'hex'))
}

async function loadClientKey(keyPath = DEFAULT_CLIENT_KEY_PATH, options = {}) {
  const { record, path: absolutePath } = await readKeyRecord(keyPath)
  const validated = validateKeyRecord(record, absolutePath)

  let seedHex
  if (validated.encrypted) {
    seedHex = await decryptRecord(validated, options.passphrase)
  } else {
    seedHex = validated.seed
  }

  const keyPair = keyPairFromSeed(seedHex)
  const derivedPublicKey = Buffer.from(keyPair.publicKey).toString('hex')

  if (derivedPublicKey !== validated.publicKey) {
    throw keyError(
      `client key file is inconsistent (public key does not match seed): ${absolutePath}. Delete it and run \`p2pgate keygen\` again, then update the server whitelist.`,
      'CLIENT_KEY_MISMATCH'
    )
  }

  return {
    keyPair,
    seedHex,
    publicKey: validated.publicKey,
    createdAt: validated.createdAt,
    encrypted: validated.encrypted,
    path: absolutePath
  }
}

async function inspectClientKey(keyPath = DEFAULT_CLIENT_KEY_PATH) {
  const { record, path: absolutePath } = await readKeyRecord(keyPath)
  const validated = validateKeyRecord(record, absolutePath)

  return {
    exists: true,
    encrypted: validated.encrypted,
    publicKey: validated.publicKey,
    createdAt: validated.createdAt,
    path: absolutePath
  }
}

async function generateClientKey(keyPath = DEFAULT_CLIENT_KEY_PATH, options = {}) {
  const absolutePath = resolveKeyPath(keyPath)
  const seed = crypto.randomBytes(32)
  const keyPair = keyPairFromSeed(seed.toString('hex'))
  const publicKey = Buffer.from(keyPair.publicKey).toString('hex')
  const createdAt = new Date().toISOString()

  const record = options.passphrase
    ? await encryptRecord({
      seedHex: seed.toString('hex'),
      publicKey,
      createdAt,
      passphrase: options.passphrase
    })
    : {
      seed: seed.toString('hex'),
      publicKey,
      createdAt
    }

  await writeKeyFile(absolutePath, record)

  return {
    keyPair,
    seedHex: seed.toString('hex'),
    publicKey,
    createdAt,
    encrypted: Boolean(options.passphrase),
    path: absolutePath
  }
}

async function protectClientKey(keyPath = DEFAULT_CLIENT_KEY_PATH, options = {}) {
  const { record, path: absolutePath } = await readKeyRecord(keyPath)
  const validated = validateKeyRecord(record, absolutePath)

  let seedHex
  if (validated.encrypted) {
    seedHex = await decryptRecord(validated, options.currentPassphrase)
  } else {
    seedHex = validated.seed
  }

  const keyPair = keyPairFromSeed(seedHex)
  const publicKey = Buffer.from(keyPair.publicKey).toString('hex')

  if (publicKey !== validated.publicKey) {
    throw keyError(
      `client key file is inconsistent (public key does not match seed): ${absolutePath}`,
      'CLIENT_KEY_MISMATCH'
    )
  }

  const encrypted = await encryptRecord({
    seedHex,
    publicKey,
    createdAt: validated.createdAt || new Date().toISOString(),
    passphrase: options.passphrase
  })

  await writeKeyFile(absolutePath, encrypted)

  return {
    keyPair,
    publicKey,
    encrypted: true,
    path: absolutePath
  }
}

async function unprotectClientKey(keyPath = DEFAULT_CLIENT_KEY_PATH, options = {}) {
  const { record, path: absolutePath } = await readKeyRecord(keyPath)
  const validated = validateKeyRecord(record, absolutePath)

  if (!validated.encrypted) {
    return {
      publicKey: validated.publicKey,
      encrypted: false,
      path: absolutePath
    }
  }

  const seedHex = await decryptRecord(validated, options.currentPassphrase)
  const keyPair = keyPairFromSeed(seedHex)
  const publicKey = Buffer.from(keyPair.publicKey).toString('hex')

  if (publicKey !== validated.publicKey) {
    throw keyError(
      `client key file is inconsistent (public key does not match seed): ${absolutePath}`,
      'CLIENT_KEY_MISMATCH'
    )
  }

  await writeKeyFile(absolutePath, {
    seed: seedHex,
    publicKey,
    createdAt: validated.createdAt || new Date().toISOString()
  })

  return { keyPair, publicKey, encrypted: false, path: absolutePath }
}

function clientKeyExists(keyPath = DEFAULT_CLIENT_KEY_PATH) {
  try {
    return fs.existsSync(resolveKeyPath(keyPath))
  } catch {
    return false
  }
}

module.exports = {
  DEFAULT_CLIENT_KEY_PATH,
  MIN_PASSPHRASE_LENGTH,
  SCRYPT_PARAMS,
  loadClientKey,
  inspectClientKey,
  generateClientKey,
  protectClientKey,
  unprotectClientKey,
  clientKeyExists
}
