'use strict'

const SUPPORTED = Object.freeze(['en', 'th'])
const DEFAULT_LANGUAGE = 'en'

function normalizeLanguage(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return null
  if (normalized === 'th' || normalized.startsWith('th_') || normalized.startsWith('th-')) {
    return 'th'
  }
  if (normalized === 'en' || normalized.startsWith('en_') || normalized.startsWith('en-')) {
    return 'en'
  }
  return null
}

function detectLanguage() {
  const explicit = normalizeLanguage(process.env.P2PGATE_LANG)
  if (explicit) return explicit

  const locale = process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANG ||
    ''
  return normalizeLanguage(locale) || DEFAULT_LANGUAGE
}

let currentLanguage = detectLanguage()

function setLanguage(value) {
  if (value === undefined || value === null || value === '') {
    currentLanguage = detectLanguage()
    return currentLanguage
  }

  const normalized = normalizeLanguage(String(value))
  if (!normalized) {
    const err = new Error(`unsupported language: ${value}`)
    err.code = 'LANG_INVALID'
    throw err
  }

  currentLanguage = normalized
  return currentLanguage
}

function getLanguage() {
  return currentLanguage
}

function isThai() {
  return currentLanguage === 'th'
}

function interpolate(template, variables) {
  if (!variables || typeof variables !== 'object') return template

  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) return match
    return String(variables[key])
  })
}

/**
 * Pick a localized message.
 * @param {string} th Thai text
 * @param {string} en English text
 * @param {object} variables interpolation values
 */
function t(th, en, variables) {
  return interpolate(currentLanguage === 'th' ? th : en, variables)
}

module.exports = {
  SUPPORTED,
  DEFAULT_LANGUAGE,
  setLanguage,
  getLanguage,
  isThai,
  normalizeLanguage,
  t
}
