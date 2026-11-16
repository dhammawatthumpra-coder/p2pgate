'use strict'

// Summarizes a soak CSV (mux-windows.ps1 output) or a server RSS CSV.
// usage: node summarize.js <file.csv>

const fs = require('node:fs')

const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error('usage: node summarize.js <file.csv>')
  process.exit(1)
}

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
const header = lines.shift().split(',')

if (header[0] === 'time' && header.includes('ok')) {
  const rows = lines.map((line) => {
    const cells = line.split(',')
    const row = {}
    header.forEach((key, index) => { row[key] = cells[index] })
    return row
  })

  const ok = rows.filter((row) => row.ok === 'true')
  const failed = rows.filter((row) => row.ok !== 'true')
  const mbps = ok.map((row) => Number(row.mbps)).filter((value) => Number.isFinite(value) && value > 0)
  const rss = rows.map((row) => Number(row.clientRssMB)).filter((value) => Number.isFinite(value) && value > 0)
  const carriers = rows.map((row) => Number(row.carriers)).filter((value) => Number.isFinite(value))

  const min = (list) => (list.length ? Math.min(...list) : 0)
  const max = (list) => (list.length ? Math.max(...list) : 0)
  const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0)

  console.log(`file:        ${file}`)
  console.log(`iterations:  ${rows.length}`)
  console.log(`ok:          ${ok.length}`)
  console.log(`failed:      ${failed.length}`)
  console.log(`window:      ${rows[0] ? rows[0].time : '-'} -> ${rows[rows.length - 1] ? rows[rows.length - 1].time : '-'}`)
  console.log(`throughput:  min ${min(mbps)} / avg ${avg(mbps).toFixed(2)} / max ${max(mbps)} MB/s`)
  console.log(`client RSS:  min ${min(rss)} / max ${max(rss)} MB`)
  console.log(`carriers:    ${max(carriers)} established (reconnects: ${Math.max(0, max(carriers) - 1)})`)

  if (failed.length) {
    console.log('failures:')
    for (const row of failed.slice(0, 20)) {
      console.log(`  ${row.time} bytes=${row.bytes} error=${row.error || '?'}`)
    }
  }

  process.exit(failed.length === 0 ? 0 : 1)
}

if (header.includes('rss_kb') || header[0] === 'time') {
  const rows = lines.map((line) => line.split(',')).filter((cells) => cells.length >= 2)
  const values = rows
    .map((cells) => Number(cells[2]))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((kb) => kb / 1024)

  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 0
  console.log(`file:        ${file}`)
  console.log(`samples:     ${values.length}`)
  console.log(`server RSS:  min ${min.toFixed(1)} / max ${max.toFixed(1)} MB`)
  process.exit(0)
}

console.log('unrecognized csv format:', header.join(','))
process.exit(1)
