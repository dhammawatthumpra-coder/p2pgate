# Soak — compressed mux channels, 4 hours on a real 4G link

**Date:** 2026-11-21
**Build:** p2pgate 1.13.5 + compression prototype (`fd658ef`)
**Link:** Windows Wi-Fi ↔ Termux/Android 4G via the public DHT
**Result: PASS** — 240/240 cycles, 0 failures, no growth in RSS on either side.

## Configuration

| Setting | Value |
|---|---|
| Duration | 240 min |
| Cycle | every 60 s, mixed payloads |
| Bulk payload | 256 KiB, echoed back and hash-verified |
| Cases | text, log, binary, 50 interactive round trips, abrupt reset |
| Client restarts | every 60 min (3 planned) |
| Data | ~75 MB total (38.7 MB each direction) |

## Totals

| Metric | Value |
|---|---|
| Cycles | 240 |
| Failures | **0** |
| Error codes | none |
| Integrity failures | **0** (every echo matched SHA-256) |
| Client restarts | 3 (all scheduled, none error-driven) |

## Client-side timings (per cycle, ms)

| Case | Runs | p50 | p95 | max |
|---|---|---|---|---|
| text 256 KiB | 48 | 254 | 458 | 482 |
| log 256 KiB | 48 | 353 | 2937 | 3525 |
| binary 256 KiB | 48 | 404 | 640 | 1104 |
| interactive (50 RT) | 48 | 2520 | 3220 | 3350 |
| abrupt reset | 48 | 44 | 48 | 58 |

Interactive per-round-trip latency: **p50 178 ms, max 699 ms** (4G RTT through the
tunnel, including the compression flush).

The log p95 tail (2.9–3.5 s for 256 KiB) is link congestion, not the codec: the same
payload took 0.25–0.4 s at p50, and no cycle failed or lost bytes. Binary and text tails
stay under 0.5 s.

## Memory

| Side | First | Last | Min | Max |
|---|---|---|---|---|
| Client RSS | 69.9 MB | 71.8 MB | 65.7 MB | 75.5 MB |
| Server RSS | 64.5 MB | 60.8 MB | 59.4 MB | 74.1 MB |
| Server heap | 9.9 MB | 9.2 MB | — | 11.3 MB |

Both sides are flat over 4 hours — no leak attributable to the compression streams
(compressors and decompressors are per channel and destroyed with it).

## Server delivery (first byte → close, per connection)

252 connections, 38.7 MB received: p50 0.04 s, p95 2.46 s, max 3.05 s. The p95 is the
interactive case (50 round trips on one connection), not a stalled bulk transfer.

## What this covers

- zstd negotiation on every channel (server answers `compress.algorithm`)
- both directions under load, including the echo path
- half-close after every transfer
- channel churn on a long-lived carrier (240 channels, 3 carrier rebuilds)
- abrupt resets (48) without affecting later cycles
- incompressible data (binary) with no corruption or slowdown beyond link noise

## Still open before release

1. `compress: "auto"` sampling (currently the client compresses whenever asked).
2. Decompression output cap (bomb guard).
3. Non-mux tunnels are not covered.
4. A longer soak with parallel channels (this run used one channel at a time).

## Parallel channels (1 hour, 4 at a time)

Same harness with `SOAK_PARALLEL=4`: every bulk case opens four channels concurrently,
each 256 KiB and echoed.

| Metric | Value |
|---|---|
| Cycles | 60 |
| Failures | **0** |
| Restarts | 0 |
| Connections | 168 |
| Data | 37.9 MB each direction |

| Case (4 × 256 KiB) | p50 | p95 | max |
|---|---|---|---|
| text | 440 ms | 840 ms | 1101 ms |
| log | 459 ms | 1623 ms | 2879 ms |
| binary | 977 ms | 1329 ms | 1338 ms |
| interactive (50 RT) | 2651 ms | 3584 ms | 4059 ms |
| abrupt reset | 46 ms | 49 ms | 52 ms |

Per-round-trip latency under parallel load: p50 257 ms, max 609 ms (single-channel run:
178 / 699 ms).

Aggregate throughput for text improved from **1.0 MB/s** (one 256 KiB transfer at a time,
p50 254 ms) to **2.3 MB/s** (four at once, 1 MiB in 440 ms). The single channel was limited
by per-transfer latency, not by the link; four channels overlap those round trips. A single
large transfer still reaches ~4.5 MB/s.

Memory stayed flat: client RSS 76.9 → 78.2 MB (max 82.1), server 57.2 → 64.3 MB, server
heap 10.3 → 9.3 MB (max 10.3).

## Reproduce

```powershell
# Termux (isolated HOME, ECHO target, RSS monitor)
cd ~/p2p-link-test
HOME=$PWD/home P2P_PKG=$PWD/pkg ECHO=1 \
  OUT=$PWD/soak-received.jsonl STATS=$PWD/soak-stats.jsonl \
  MASTER_SECRET=... PASSWORD=... \
  setsid nohup node termux-server.js > soak-server.log 2>&1 < /dev/null &

# Windows
$env:SOAK_HOURS='4'; $env:SOAK_INTERVAL_SEC='60'; $env:SOAK_KB='256'
node spike\soak\soak-client.js
node spike\soak\analyze.js spike\soak\soak.jsonl
```
