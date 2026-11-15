'use strict'

const dns = require('node:dns/promises')

/**
 * IPv4 / CIDR / port allowlist used by the SOCKS5 gateway.
 *
 * Entry syntax (IPv4 only, no hostnames in the config):
 *   127.0.0.1:8080
 *   192.168.1.0/24:*          (any port)
 *   10.0.0.0/8:443
 */
function ipv4ToInt(ip) {
  const parts = String(ip).trim().split('.')

  if (parts.length !== 4) return null

  let value = 0

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value * 256) + octet
  }

  return value >>> 0
}

function parseAllowEntry(text) {
  const raw = typeof text === 'string' ? text.trim() : ''

  if (raw === '') {
    const err = new Error('socks.allow entries must be non-empty strings')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  const colon = raw.lastIndexOf(':')

  if (colon <= 0 || colon === raw.length - 1) {
    const err = new Error(
      `socks.allow entry "${raw}" must look like "ip[:port]", "cidr:*" or "cidr:port"`
    )
    err.code = 'CONFIG_INVALID'
    throw err
  }

  const hostPart = raw.slice(0, colon)
  const portPart = raw.slice(colon + 1)

  let port = null

  if (portPart !== '*') {
    port = Number(portPart)

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      const err = new Error(`socks.allow entry "${raw}" has an invalid port`)
      err.code = 'CONFIG_INVALID'
      throw err
    }
  }

  let base = hostPart
  let bits = 32

  if (hostPart.includes('/')) {
    const [network, prefix] = hostPart.split('/')
    base = network
    bits = Number(prefix)

    if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
      const err = new Error(`socks.allow entry "${raw}" has an invalid prefix length`)
      err.code = 'CONFIG_INVALID'
      throw err
    }
  }

  const baseInt = ipv4ToInt(base)

  if (baseInt === null) {
    const err = new Error(
      `socks.allow entry "${raw}" must use an IPv4 address or CIDR (no hostnames)`
    )
    err.code = 'CONFIG_INVALID'
    throw err
  }

  return { base: baseInt, bits, port, text: raw }
}

function maskFor(bits) {
  if (bits === 0) return 0
  return (0xffffffff << (32 - bits)) >>> 0
}

function isIpAllowed(ip, port, entries) {
  const value = ipv4ToInt(ip)
  if (value === null) return false

  for (const entry of entries) {
    if (entry.port !== null && entry.port !== port) continue
    const mask = maskFor(entry.bits)
    if ((value & mask) >>> 0 === (entry.base & mask) >>> 0) return true
  }

  return false
}

/**
 * Resolves a client-requested host to an allowed IPv4 address.
 *
 * IP literals are matched directly. Hostnames are resolved on the server and
 * every resolved address must match the allowlist, so a hostile DNS answer can
 * never reach a destination the operator did not allow.
 */
async function resolveAllowedHost(host, port, entries) {
  if (typeof host !== 'string' || host.trim() === '') return null

  const candidate = host.trim()

  if (ipv4ToInt(candidate) !== null) {
    return isIpAllowed(candidate, port, entries) ? candidate : null
  }

  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251})$/.test(candidate)) return null

  let addresses

  try {
    addresses = await dns.lookup(candidate, { all: true, family: 4, verbatim: true })
  } catch {
    return null
  }

  for (const address of addresses) {
    if (isIpAllowed(address.address, port, entries)) return address.address
  }

  return null
}

module.exports = {
  ipv4ToInt,
  parseAllowEntry,
  isIpAllowed,
  resolveAllowedHost
}
