'use strict'

const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const {
  generateMasterSecret,
  deriveScramVerifier,
  serializeScramVerifier,
  SESSION_PIN_ALPHABET
} = require('./crypto-utils')
const {
  DEFAULT_CONFIG_DIR,
  DEFAULT_CLIENT_KEY_PATH
} = require('./config-loader')
const {
  DEFAULT_TRUSTED_DEVICES_PATH
} = require('./device-registry')
const {
  DEFAULT_AUDIT_LOG_PATH,
  DEFAULT_AUDIT_MAX_BYTES
} = require('./audit-log')

const DEFAULT_SERVER_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, 'config.json')
const DEFAULT_CLIENT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, 'client.json')
const DEFAULT_QUICKSTART_PATH = path.join(DEFAULT_CONFIG_DIR, 'quickstart.txt')
const CONNECTION_PASSWORD_LENGTH = 24

function generateConnectionPassword(length = CONNECTION_PASSWORD_LENGTH) {
  let value = ''

  while (value.length < length) {
    value += SESSION_PIN_ALPHABET[crypto.randomInt(0, SESSION_PIN_ALPHABET.length)]
  }

  return value
}

function defaultAuditLog() {
  return {
    enabled: true,
    path: DEFAULT_AUDIT_LOG_PATH,
    maxBytes: DEFAULT_AUDIT_MAX_BYTES
  }
}

async function createServerPasswordConfig(options = {}) {
  const password = generateConnectionPassword()
  const verifier = await deriveScramVerifier(password)
  const masterSecret = generateMasterSecret()

  return {
    password,
    masterSecret,
    config: {
      mode: 'server',
      masterSecret,
      authMode: 'password',
      targetHost: '127.0.0.1',
      targetPort: Number.isInteger(options.targetPort) ? options.targetPort : 8022,
      localPort: Number.isInteger(options.localPort) ? options.localPort : 8022,
      clientKeyPath: DEFAULT_CLIENT_KEY_PATH,
      allowedClientKeys: [],
      verificationMode: 'hybrid',
      trustedDevicesFile: DEFAULT_TRUSTED_DEVICES_PATH,
      auditLog: defaultAuditLog(),
      customBootstrap: [],
      authPin: {
        enabled: true,
        unattended: serializeScramVerifier(verifier)
      },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }
  }
}

function createClientPasswordConfig({ masterSecret, clientKeyPath, localPort }) {
  return {
    mode: 'client',
    masterSecret,
    authMode: 'password',
    targetHost: '127.0.0.1',
    targetPort: 8022,
    localPort: Number.isInteger(localPort) ? localPort : 8022,
    clientKeyPath: clientKeyPath || DEFAULT_CLIENT_KEY_PATH,
    allowedClientKeys: [],
    verificationMode: 'hybrid',
    trustedDevicesFile: DEFAULT_TRUSTED_DEVICES_PATH,
    auditLog: defaultAuditLog(),
    customBootstrap: [],
    authPin: { enabled: true, unattended: null },
    telegramAlert: { enabled: false, botToken: '', chatId: '' }
  }
}

async function writeQuickstartFile({
  configPath = DEFAULT_SERVER_CONFIG_PATH,
  masterSecret,
  password,
  targetPort = 8022
} = {}) {
  const dir = path.dirname(path.resolve(DEFAULT_QUICKSTART_PATH))
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await fsp.chmod(dir, 0o700)
  } catch {
    // Windows and some filesystems do not enforce POSIX modes.
  }

  const content = [
    'p2pgate quickstart credentials',
    '',
    `config: ${path.resolve(configPath)}`,
    `masterSecret: ${masterSecret}`,
    `password: ${password}`,
    `targetPort: ${targetPort}`,
    '',
    'Client:',
    `  p2pgate connect -s ${masterSecret} -p <password>`,
    '',
    'Keep this file private. Delete it after copying the credentials.',
    ''
  ].join('\n')

  await fsp.writeFile(DEFAULT_QUICKSTART_PATH, content, { mode: 0o600 })
  try {
    await fsp.chmod(DEFAULT_QUICKSTART_PATH, 0o600)
  } catch {
    // See above.
  }

  return DEFAULT_QUICKSTART_PATH
}

module.exports = {
  DEFAULT_SERVER_CONFIG_PATH,
  DEFAULT_CLIENT_CONFIG_PATH,
  DEFAULT_QUICKSTART_PATH,
  CONNECTION_PASSWORD_LENGTH,
  generateConnectionPassword,
  createServerPasswordConfig,
  createClientPasswordConfig,
  writeQuickstartFile
}
