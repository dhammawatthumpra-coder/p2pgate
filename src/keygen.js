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

function validateKeyRecord(record, keyPath) {
  if (!record || typeof record !== 'object') {
    throw keyError(`client key file is malformed: ${keyPath}`, 'CLIENT_KEY_INVALID')
  }

  const seed = typeof record.seed === 'string' ? record.seed.trim().toLowerCase() : ''
  const publicKey = typeof record.publicKey === 'string'
    ? record.publicKey.trim().toLowerCase()
    : ''

  if (!HEX_64.test(seed) || !HEX_64.test(publicKey)) {
    throw keyError(
      `client key file must contain 64-character hex "seed" and "publicKey": ${keyPath}`,
      'CLIENT_KEY_INVALID'
    )
  }

  return { seed, publicKey }
}

async function loadClientKey(keyPath = DEFAULT_CLIENT_KEY_PATH) {
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

  const { seed, publicKey } = validateKeyRecord(record, absolutePath)
  const keyPair = HyperDHT.keyPair(Buffer.from(seed, 'hex'))
  const derivedPublicKey = Buffer.from(keyPair.publicKey).toString('hex')

  if (derivedPublicKey !== publicKey) {
    throw keyError(
      `client key file is inconsistent (public key does not match seed): ${absolutePath}. Delete it and run \`p2pgate keygen\` again, then update the server whitelist.`,
      'CLIENT_KEY_MISMATCH'
    )
  }

  return {
    keyPair,
    seedHex: seed,
    publicKey,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
    path: absolutePath
  }
}

async function generateClientKey(keyPath = DEFAULT_CLIENT_KEY_PATH) {
  const absolutePath = resolveKeyPath(keyPath)
  const seed = crypto.randomBytes(32)
  const keyPair = HyperDHT.keyPair(seed)

  const record = {
    seed: seed.toString('hex'),
    publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
    createdAt: new Date().toISOString()
  }

  await writeKeyFile(absolutePath, record)

  return {
    keyPair,
    seedHex: record.seed,
    publicKey: record.publicKey,
    createdAt: record.createdAt,
    path: absolutePath
  }
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
  loadClientKey,
  generateClientKey,
  clientKeyExists
}
