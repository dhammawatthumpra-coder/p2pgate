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
const path = require('node:path')

const pkg = require('../package.json')
const version = pkg.version
const tag = `v${version}`
const root = path.join(__dirname, '..')

function run (command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
}

function sleep (ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function npmLatest () {
  const result = run('npm', ['view', 'p2pgate', 'version'])
  return result.status === 0 ? result.stdout.trim() : ''
}

function npmReadmeHasVersion () {
  const result = run('npm', ['view', 'p2pgate', 'readme'])
  return result.status === 0 && result.stdout.includes(`?v=${version}`)
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

function afterPublish () {
  const notesFile = path.join('docs', 'releases', `${tag}.md`)
  if (!fs.existsSync(path.join(root, notesFile))) {
    process.stderr.write(`missing ${notesFile}\n`)
    process.exit(1)
  }

  const waitMinutes = Number(process.env.RELEASE_WAIT_MINUTES || 45)
  const deadline = Date.now() + waitMinutes * 60_000
  let latest = ''

  process.stdout.write(`Waiting for npm to serve ${version} `)
  while (Date.now() < deadline) {
    latest = npmLatest()
    if (latest === version) break
    process.stdout.write('.')
    sleep(30_000)
  }
  process.stdout.write('\n')

  if (latest !== version) {
    process.stderr.write(`npm latest is ${latest || 'unknown'}, not ${version}. Not tagging.\n`)
    process.exit(1)
  }

  if (!npmReadmeHasVersion()) {
    process.stderr.write(
      `npm serves ${version} but its README does not contain ?v=${version}. Not tagging.\n` +
      'Wait for the README to update (or check that README.md was committed before publish).\n'
    )
    process.exit(1)
  }

  process.stdout.write(`npm latest is ${version} and its README shows ?v=${version}.\n`)

  const existingTag = run('git', ['tag', '-l', tag]).stdout.trim()
  if (existingTag === '') {
    const created = run('git', ['tag', tag])
    if (created.status !== 0) {
      process.stderr.write(created.stderr)
      process.exit(1)
    }

    const pushed = run('git', ['push', 'origin', tag])
    if (pushed.status !== 0) {
      process.stderr.write(pushed.stderr)
      process.exit(1)
    }
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
    if (released.status !== 0) process.exit(released.status || 1)
    process.stdout.write(`GitHub release ${tag} created.\n`)
  } else {
    process.stdout.write(`GitHub release ${tag} already exists.\n`)
  }

  process.stdout.write('\nDone. Update docs/HANDOFF.md to "released" and commit.\n')
}

if (process.argv.includes('--after-publish')) afterPublish()
else preflight()
