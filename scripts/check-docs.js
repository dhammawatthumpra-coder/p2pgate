'use strict'

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = String(pkg.version)
const stable = version.split('-')[0]
const minor = stable.split('.').slice(0, 2).join('.')

const problems = []

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath))
}

// READMEs always ship with the package, so their header must match the version.
for (const readme of ['README.md', 'README.th.md']) {
  if (!exists(readme)) {
    problems.push(`${readme}: missing`)
    continue
  }

  const text = read(readme)

  if (!text.includes(`(v${minor})`)) {
    problems.push(`${readme}: header must contain "(v${minor})" for package.json ${version}`)
  }

  if (!text.includes(`v${version}.md`)) {
    problems.push(`${readme}: project structure must list "v${version}.md"`)
  }

  // The badge image is cached by GitHub/npm; a stale cache shows "in progress"
  // for a release that is already analysed. Tie the query to the version so
  // every release fetches a fresh image.
  if (!text.includes(`badge.socket.dev/npm/package/p2pgate?v=${version}`)) {
    problems.push(`${readme}: Socket badge must use "?v=${version}" to bust the image cache`)
  }
}

const changelogText = read('CHANGELOG.md')
if (!changelogText.includes(`## [${version}]`)) {
  problems.push(`CHANGELOG.md: missing "## [${version}]" section`)
}

// The docs/ tree is not published to npm, so these checks only run in the repo.
if (exists('docs')) {
  const releaseNotes = `docs/releases/v${version}.md`
  if (!exists(releaseNotes)) {
    problems.push(`missing ${releaseNotes}`)
  }

  if (exists('docs/README.md')) {
    const index = read('docs/README.md')
    if (!index.includes(`releases/v${version}.md`)) {
      problems.push(`docs/README.md: missing link to releases/v${version}.md`)
    }
  }
}

if (problems.length > 0) {
  process.stderr.write('docs check failed:\n')
  for (const problem of problems) {
    process.stderr.write(`  - ${problem}\n`)
  }
  process.stderr.write('\nFix the files above, then run: npm run docs:check\n')
  process.exit(1)
}

process.stdout.write(
  `docs check passed for v${version}${exists('docs') ? '' : ' (installed package: docs/ skipped)'}\n`
)
