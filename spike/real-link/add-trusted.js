'use strict'

// Adds a trusted device to an isolated trusted_devices file on the test device.
// Env: P2P_PKG (path to the p2pgate tree), TRUSTED_FILE, KEY (public key hex)

const { DeviceRegistry } = require(`${process.env.P2P_PKG}/src/device-registry`)

async function main () {
  const registry = new DeviceRegistry({
    configKeys: [],
    filePath: process.env.TRUSTED_FILE,
    verificationMode: 'hybrid',
    posixCheck: async () => ({ ok: true })
  })

  await registry.init()
  await registry.addDevice({
    key: process.env.KEY,
    profile: 'trusted',
    label: 'fastpath-real'
  })
  console.log('added')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
