'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
  assertMasterSecret,
  normalizeClientPublicKeyHex,
  parseScramVerifier
} = require('./crypto-utils')
const {
  DEFAULT_TRUSTED_DEVICES_PATH,
  normalizeVerificationMode
} = require('./device-registry')

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.p2pgate')
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, 'config.json')
const DEFAULT_CLIENT_KEY_PATH = path.join(DEFAULT_CONFIG_DIR, 'client-key.json')

const TARGET_HOST = '127.0.0.1'
const VALID_MODES = new Set(['server', 'client'])

class ConfigError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
  }
}

function expandHome(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ConfigError('path must be a non-empty string', 'CONFIG_INVALID')
  }

  const value = input.trim()
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }

  return value
}

function defaultConfig() {
  return {
    mode: 'server',
    masterSecret: '',
    targetHost: TARGET_HOST,
    targetPort: 8022,
    localPort: 8022,
    clientKeyPath: DEFAULT_CLIENT_KEY_PATH,
    allowedClientKeys: [],
    verificationMode: 'hybrid',
    trustedDevicesFile: DEFAULT_TRUSTED_DEVICES_PATH,
    customBootstrap: [],
    authPin: {
      enabled: true,
      unattended: null
    },
    telegramAlert: {
      enabled: false,
      botToken: '',
      chatId: ''
    }
  }
}

function parsePort(value, field, { allowZero = false } = {}) {
  const numeric = typeof value === 'string' ? Number(value.trim()) : value
  const minimum = allowZero ? 0 : 1

  if (!Number.isInteger(numeric) || numeric < minimum || numeric > 65535) {
    throw new ConfigError(
      `${field} must be an integer between ${minimum} and 65535`,
      'CONFIG_INVALID'
    )
  }

  return numeric
}

function parseBoolean(value, field, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${field} must be true or false`, 'CONFIG_INVALID')
  }
  return value
}

function normalizeBootstrap(value) {
  if (value === undefined) return []

  if (!Array.isArray(value)) {
    throw new ConfigError('customBootstrap must be an array of "host:port" strings', 'CONFIG_INVALID')
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError(
        `customBootstrap[${index}] must be a non-empty "host:port" string`,
        'CONFIG_INVALID'
      )
    }

    const trimmed = entry.trim()

    // Support the optional "[suggested-ip@]host:port" syntax used by hyperdht.
    const atIndex = trimmed.lastIndexOf('@')
    const hostPort = atIndex === -1 ? trimmed : trimmed.slice(atIndex + 1)
    const colonIndex = hostPort.lastIndexOf(':')

    if (colonIndex <= 0 || colonIndex === hostPort.length - 1) {
      throw new ConfigError(
        `customBootstrap[${index}] must look like "host:port"`,
        'CONFIG_INVALID'
      )
    }

    const host = hostPort.slice(0, colonIndex)
    const port = Number(hostPort.slice(colonIndex + 1))

    if (host.trim() === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(
        `customBootstrap[${index}] must look like "host:port" with a valid port`,
        'CONFIG_INVALID'
      )
    }

    return trimmed
  })
}

function normalizeAllowedKeys(value) {
  if (value === undefined) return []

  if (!Array.isArray(value)) {
    throw new ConfigError('allowedClientKeys must be an array of public keys', 'CONFIG_INVALID')
  }

  const seen = new Set()
  const keys = []

  for (let i = 0; i < value.length; i++) {
    let normalized
    try {
      normalized = normalizeClientPublicKeyHex(value[i])
    } catch (err) {
      throw new ConfigError(
        `allowedClientKeys[${i}] is invalid: ${err.message}`,
        'CONFIG_INVALID'
      )
    }

    if (!seen.has(normalized)) {
      seen.add(normalized)
      keys.push(normalized)
    }
  }

  return keys
}

function normalizeAuthPin(value, verificationMode) {
  if (value === undefined) {
    return { enabled: verificationMode !== 'key-only', unattended: null }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('authPin must be an object', 'CONFIG_INVALID')
  }

  if (value.unattendedPasswordHash !== undefined) {
    throw new ConfigError(
      'v1.1 authPin format detected; run p2pgate setup to migrate the credential',
      'AUTH_CONFIG_UPGRADE_REQUIRED'
    )
  }

  // verificationMode is authoritative. authPin.enabled is retained as a legacy
  // compatibility field and kept consistent with the selected mode.
  const enabled = verificationMode !== 'key-only'
  let unattended = null

  if (value.unattended !== undefined && value.unattended !== null) {
    try {
      const parsed = parseScramVerifier(value.unattended)
      unattended = {
        saltHex: parsed.saltHex,
        storedKeyHex: parsed.storedKeyHex,
        serverKeyHex: parsed.serverKeyHex
      }
    } catch (err) {
      throw new ConfigError(`authPin.unattended is invalid: ${err.message}`, 'CONFIG_INVALID')
    }
  }

  return { enabled, unattended }
}

function normalizeTelegram(value) {
  if (value === undefined) {
    return { enabled: false, botToken: '', chatId: '' }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('telegramAlert must be an object', 'CONFIG_INVALID')
  }

  const enabled = parseBoolean(value.enabled, 'telegramAlert.enabled', false)
  const botToken = value.botToken === undefined || value.botToken === null
    ? ''
    : String(value.botToken).trim()
  const chatId = value.chatId === undefined || value.chatId === null
    ? ''
    : String(value.chatId).trim()

  if (enabled && (!botToken || !chatId)) {
    throw new ConfigError(
      'telegramAlert.enabled requires both botToken and chatId',
      'CONFIG_INVALID'
    )
  }

  return { enabled, botToken, chatId }
}

/**
 * Merges a raw configuration object with defaults and validates every field.
 */
function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('configuration must be a JSON object', 'CONFIG_INVALID')
  }

  const base = defaultConfig()
  const mode = raw.mode === undefined ? base.mode : String(raw.mode).trim().toLowerCase()

  if (!VALID_MODES.has(mode)) {
    throw new ConfigError('mode must be "server" or "client"', 'CONFIG_INVALID')
  }

  let masterSecret
  try {
    masterSecret = assertMasterSecret(raw.masterSecret)
  } catch (err) {
    throw new ConfigError(err.message, err.code || 'CONFIG_INVALID')
  }

  const targetHost = raw.targetHost === undefined
    ? base.targetHost
    : String(raw.targetHost).trim()

  if (targetHost !== TARGET_HOST) {
    throw new ConfigError(
      'targetHost must be 127.0.0.1 (p2pgate never forwards to a remote host)',
      'CONFIG_INVALID'
    )
  }

  const clientKeyPath = raw.clientKeyPath === undefined || String(raw.clientKeyPath).trim() === ''
    ? base.clientKeyPath
    : path.resolve(expandHome(String(raw.clientKeyPath)))

  let verificationMode
  try {
    if (raw.verificationMode !== undefined) {
      verificationMode = normalizeVerificationMode(raw.verificationMode)
    } else if (raw.authPin && raw.authPin.enabled === false) {
      // v1.2 compatibility: authPin.enabled=false meant no interactive PIN.
      verificationMode = 'key-only'
    } else {
      verificationMode = 'hybrid'
    }
  } catch (err) {
    throw new ConfigError(err.message, 'CONFIG_INVALID')
  }

  const trustedDevicesFile = raw.trustedDevicesFile === undefined ||
    String(raw.trustedDevicesFile).trim() === ''
    ? base.trustedDevicesFile
    : path.resolve(expandHome(String(raw.trustedDevicesFile)))

  return {
    mode,
    masterSecret,
    targetHost,
    targetPort: parsePort(raw.targetPort === undefined ? base.targetPort : raw.targetPort, 'targetPort'),
    localPort: parsePort(
      raw.localPort === undefined ? base.localPort : raw.localPort,
      'localPort',
      { allowZero: true }
    ),
    clientKeyPath,
    allowedClientKeys: normalizeAllowedKeys(raw.allowedClientKeys),
    verificationMode,
    trustedDevicesFile,
    customBootstrap: normalizeBootstrap(raw.customBootstrap),
    authPin: normalizeAuthPin(raw.authPin, verificationMode),
    telegramAlert: normalizeTelegram(raw.telegramAlert)
  }
}

function resolveConfigPath(explicitPath) {
  if (explicitPath !== undefined && explicitPath !== null && String(explicitPath).trim() !== '') {
    return path.resolve(expandHome(String(explicitPath)))
  }

  const local = path.resolve(process.cwd(), 'config.json')
  if (fs.existsSync(local)) return local

  return DEFAULT_CONFIG_PATH
}

async function readConfigRaw(configPath) {
  const absolutePath = path.resolve(configPath)

  let raw
  try {
    raw = await fsp.readFile(absolutePath, 'utf8')
    // The file contains masterSecret, so keep tightening it if a user or
    // editor created it with looser permissions.
    try {
      await fsp.chmod(absolutePath, 0o600)
    } catch {
      // Windows and some filesystems do not enforce POSIX modes.
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new ConfigError(
        `configuration file not found: ${absolutePath}`,
        'CONFIG_NOT_FOUND'
      )
    }
    throw err
  }

  try {
    // Strip a UTF-8 BOM, which some Windows editors add automatically.
    return JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    throw new ConfigError(
      `configuration file is not valid JSON: ${absolutePath}`,
      'CONFIG_INVALID_JSON'
    )
  }
}

async function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath)
  const raw = await readConfigRaw(absolutePath)

  try {
    return normalizeConfig(raw)
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new ConfigError(`${err.message} (file: ${absolutePath})`, err.code)
    }
    throw err
  }
}

async function saveConfig(configPath, config) {
  const absolutePath = path.resolve(expandHome(configPath))
  const normalized = normalizeConfig(config)
  const dir = path.dirname(absolutePath)

  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await fsp.chmod(dir, 0o700)
  } catch {
    // Windows and some filesystems do not enforce POSIX modes.
  }

  const payload = `${JSON.stringify(normalized, null, 2)}\n`
  await fsp.writeFile(absolutePath, payload, { mode: 0o600 })
  try {
    await fsp.chmod(absolutePath, 0o600)
  } catch {
    // See above.
  }

  return normalized
}

module.exports = {
  DEFAULT_CONFIG_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_CLIENT_KEY_PATH,
  ConfigError,
  defaultConfig,
  expandHome,
  normalizeConfig,
  resolveConfigPath,
  readConfigRaw,
  loadConfig,
  saveConfig
}
