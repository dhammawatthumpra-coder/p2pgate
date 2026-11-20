# Spike — LZ4 instead of zstd?

**Date:** 2026-11-21
**Question:** LZ4 is much faster than zstd. On a tunnel that is CPU-bound at high speed,
would LZ4's speed beat zstd's ratio?
**Verdict: NO-GO.** LZ4 gives up 30–55% of the compression ratio and buys CPU time that
p2pgate cannot use. It wins only above ~40–60 MB/s of link throughput; the tunnel's own
data path caps at ~12–20 MB/s.

## Measured

Same payloads as the compression tests, `lz4-napi` 2.10.0 (native lz4_flex frame API),
compared against zstd-1 in the same process. End-to-end model: 4 MB/s link + 2.2 s setup,
CPU serial.

| Payload | Codec | Ratio | Compressed | CPU | Total | Speedup |
|---|---|---|---|---|---|---|
| log 64 MB | **zstd-1** | **7.55×** | **8.47 MB** | 0.36 s | **4.67 s** | **3.89×** |
| log 64 MB | lz4 | 4.36× | 14.67 MB | 0.21 s | 6.07 s | 3.00× |
| text 64 MB | **zstd-1** | **4.44×** | **14.40 MB** | 0.54 s | **6.34 s** | **2.87×** |
| text 64 MB | lz4 | 2.42× | 26.50 MB | 0.35 s | 9.17 s | 1.98× |
| binary 64 MB | zstd-1 | 1.00× | 64.00 MB | 0.24 s | 18.44 s | 0.99× |
| binary 64 MB | lz4 | 1.00× | 64.00 MB | 0.09 s | 18.29 s | 1.00× |
| NDJSON 1 MB | **zstd-1** | **10.28×** | 0.10 MB | 0.01 s | 2.23 s | 1.10× |
| NDJSON 1 MB | lz4 | 4.59× | 0.22 MB | 0.01 s | 2.26 s | 1.08× |

LZ4 is 1.7–2.2× faster to compress, but it saves 0.15–0.19 s of CPU while adding
2.3–9.4 MB of traffic. At 4 MB/s, every extra MB costs 0.25 s.

## Break-even

LZ4 wins when `S/B × (1/ratio_lz4 − 1/ratio_zstd) < cpu_zstd − cpu_lz4`:

| Payload | Break-even link rate |
|---|---|
| logs | ≈ 41 MB/s |
| text | ≈ 63 MB/s |
| NDJSON | never (same CPU, half the ratio) |

p2pgate's own data path tops out around 12–20 MB/s per process on loopback (measured:
`spike/mux/results.md`), and the 4G link is 4 MB/s. **The break-even point is unreachable**,
so LZ4 is strictly worse here.

## Note on LZ4 HC

`lz4-napi` 2.10.0's frame API exposes only checksum options — no compression level
(`FrameCompressOptions = { contentChecksum, blockChecksums }`), so `highCompression` was
ignored and the three LZ4 variants produced identical output. LZ4 HC typically improves
the ratio by 10–25%; on logs that would be ~5.2×, still far below zstd-1's 7.55×, and it
costs several times the CPU. The conclusion does not change.

## Why zstd-1 keeps winning

- At 4 MB/s the link is 36× slower than zstd-1 (~145 MB/s), so compressor speed is free.
- Bytes on the wire are what cost time — and they also cost Noise encryption and UDEX
  work per byte, so saving bytes saves CPU too.
- LZ4 is designed for decompression speed at 100 MB/s+ (databases, caches, real-time
  pipelines), not for ratio on a slow link.

## Decision

**Keep zstd-1.** Do not add an LZ4 dependency (which would also break the
single-dependency rule for a loss).

## Reproduce

```powershell
cd D:\tunnel\p2pgate\spike\lz4
npm install lz4-napi        # spike only, not a p2pgate dependency
node bench-lz4.js
```
