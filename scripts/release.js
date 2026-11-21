'use strict'

// Release helper. Two steps, because npm publish needs the owner's OTP:
//
//   node scripts/release.js                  # preflight: checks + publish instructions
//   npm publish --otp=<code>                 # owner runs this
//   node scripts/release.js --after-publish  # wait for npm, verify README, tag, release
//
// The after-publish step never tags before npm serves the version AND the README that
// belongs to it, which is what went wrong in earlier releases.

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')

const pkg = require('../package.json')
const version = pkg.version
const tag = `v${version}`
const root = path.join(__dirname, '..')
const REGISTRY = 'https://registry.npmjs.org/p2pgate'

function run (command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...options
  })
}

function fetchPackument () {
  return new Promise((resolve, reject) => {
    const request = https.get(REGISTRY, { headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`registry returned HTTP ${res.statusCode}`))
        return
      }

      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(err)
        }
      })
    })

    request.on('error', reject)
  })
}

async function waitForPublish (waitMinutes) {
  const deadline = Date.now() + waitMinutes * 60_000
  let latest = ''

  while (Date.now() < deadline) {
    const doc = await fetchPackument()
    latest = doc['dist-tags'] && doc['dist-tags'].latest ? doc['dist-tags'].latest : ''
    if (latest === version) return doc
    process.stdout.write('.')
    await new Promise((resolve) => setTimeout(resolve, 30_000))
  }

  return { latest }
}

function preflight () {
  const check = run(process.execPath, ['scripts/check-release.js'], { stdio: 'inherit' })
  if (check.status !== 0) process.exit(check.status || 1)

  const status = run('git', ['status', '--porcelain'])
  if (status.stdout.trim() !== '') {
    process.stderr.write('Working tree is not clean. Commit everything first.\n')
    process.exit(1)
  }

  process.stdout.write(`\nReady to publish v${version}.\n`)
  process.stdout.write('Publish it yourself (the OTP stays yours):\n\n')
  process.stdout.write('  npm publish --otp=<code>\n\n')
  process.stdout.write('Then run:\n\n')
  process.stdout.write('  node scripts/release.js --after-publish\n\n')
}

async function afterPublish () {
  const notesFile = path.join('docs', 'releases', `${tag}.md`)
  if (!fs.existsSync(path.join(root, notesFile))) {
    throw new Error(`missing ${notesFile}`)
  }

  const waitMinutes = Number(process.env.RELEASE_WAIT_MINUTES || 45)
  process.stdout.write(`Waiting for npm to serve ${version} `)
  const doc = await waitForPublish(waitMinutes)
  process.stdout.write('\n')

  const latest = doc['dist-tags'] && doc['dist-tags'].latest
  if (latest !== version) {
    throw new Error(`npm latest is ${latest || 'unknown'}, not ${version}. Not tagging.`)
  }

  const readme = typeof doc.readme === 'string' ? doc.readme : ''
  if (!readme.includes(`?v=${version}`)) {
    throw new Error(
      `npm serves ${version} but its README does not contain ?v=${version}. Not tagging.\n` +
      'Wait for the README to update (or check that README.md was committed before publish).'
    )
  }

  process.stdout.write(`npm latest is ${version} and its README shows ?v=${version}.\n`)

  const existingTag = run('git', ['tag', '-l', tag]).stdout.trim()
  if (existingTag === '') {
    const created = run('git', ['tag', tag])
    if (created.status !== 0) throw new Error(created.stderr)

    const pushed = run('git', ['push', 'origin', tag])
    if (pushed.status !== 0) throw new Error(pushed.stderr)
    process.stdout.write(`Tag ${tag} pushed.\n`)
  } else {
    process.stdout.write(`Tag ${tag} already exists.\n`)
  }

  const releaseExists = run('gh', ['release', 'view', tag]).status === 0
  if (!releaseExists) {
    const released = run(
      'gh',
      ['release', 'create', tag, '--title', `${tag}`, '--notes-file', notesFile],
      { stdio: 'inherit' }
    )
    if (released.status !== 0) throw new Error('gh release create failed')
    process.stdout.write(`GitHub release ${tag} created.\n`)
  } else {
    process.stdout.write(`GitHub release ${tag} already exists.\n`)
  }

  process.stdout.write('\nDone. Update docs/HANDOFF.md to "released" and commit.\n')
}

if (process.argv.includes('--after-publish')) {
  afterPublish().catch((err) => {
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  })
} else {
  preflight()
}
