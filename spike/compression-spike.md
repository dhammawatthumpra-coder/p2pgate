# Spike — compress before the tunnel?

**Date:** 2026-11-20
**Question:** the "Stargate" pipeline compresses before sending; would that make
p2pgate transfers faster?

> **Update:** the loopback numbers below understate the real-world win. A real
> Windows↔4G/Termux test (`spike/real-link/results.md`) measured **2.9–3.9× at 64 MiB**
> on compressible data, because the slower link makes the compression ratio count. Read
> that file first; this one explains the mechanics and the codec choice.

**Verdict:** yes for compressible payloads, but it scales with size — 0.9× at 4 MiB,
1.6× at 16 MiB, 2.7× at 256 MiB — and neutral for random/encrypted data. The win is
compression, not the extra crypto layers. An early modeled estimate overshot (6.46×)
because it ignored the ~1.5 s fixed connection cost per stream.

## Measurement (real end-to-end)

Loopback DHT tunnel (`--mux`, server + client in one process), payload compressed at the
edge and decompressed at the far end. Effective throughput counts original bytes /
(compress + tunnel + decompress). Times are wall clock, so the tunnel's fixed ~1.2 s
connection setup is included exactly as a user would feel it.

### gzip-1, 16 MiB (first run)

| Payload | Ratio | Raw tunnel | With compression | Effective | Speedup |
|---|---|---|---|---|---|
| text-like (3.9:1) | 3.9× | 5.2 MB/s | 1.85 s | 7.7 MB/s | **1.49×** |
| random (1:1) | 1.0× | 6.2 MB/s | 3.23 s | 4.2 MB/s | **0.67×** |

### zstd-1 (Node 24 built-in), text-like corpus

| Size | Ratio | Raw tunnel | With compression | Effective | Speedup |
|---|---|---|---|---|---|
| 4 MiB | 7.24× | 1.72 s | 1.86 s | 2.2 MB/s | **0.91×** |
| 8 MiB | 7.70× | 2.46 s | 1.84 s | 4.3 MB/s | **1.30×** |
| 16 MiB | 7.84× | 2.42 s | 1.43 s | 10.6 MB/s | **1.60×** |
| 64 MiB | 8.16× | 4.90 s | 1.81 s | 29.1 MB/s | **2.23×** |
| 256 MiB | 7.59× | 13.88 s | 3.55 s | 50.2 MB/s | **2.72×** |
| 256 MiB random | 1.00× | 21.3 MB/s | 10.82 s | 21.4 MB/s | **1.00×** |

Integrity verified by SHA-256 in every case.

Why the speedup grows with size: each tunnel stream pays ~1.5 s of connection setup, which
compression cannot remove. A 4 MiB payload shrinks to 0.55 MiB but still spends the same
1.5 s, so it actually comes out slightly slower; by 256 MiB the setup is amortised and the
compression ratio shows through.

Also note the compressed stream does **not** move at the raw per-byte rate (33.7 MiB went
through at ~9.5 MiB/s vs 18–21 MiB/s for raw). Compressing before send means the data is
already smaller, so fewer frames are left to fill the pipe and the fixed cost dominates
even more. A streaming implementation that overlaps compression with sending would close
that gap — the numbers above compress everything first, then send.

## Which codec, and does Rust help?

Node 24 ships **zstd, brotli and gzip** in `node:zlib` (verified on Windows 24.15 and
Termux 24.22.3), so this needs no new dependency and no native build.

Codec cost measured in isolation (16 MiB, compress + decompress only):

| Codec | Ratio (text) | Compress | Decompress |
|---|---|---|---|
| gzip-1 | 2.62× | 0.27 s | 0.11 s |
| **zstd-1** | 7.84× | **0.04 s** | **0.04 s** |
| zstd-3 | 5.62× | 0.09 s | 0.05 s |
| brotli-1 | 3.53× | 0.13 s | 0.12 s |
| brotli-4 | 4.45× | 0.65 s | 0.09 s |

Conclusions:

- **zstd level 1 is the right default**: best ratio with the least CPU. Higher levels cost
  CPU for no gain here.
- Compression throughput at level 1 is ~290 MB/s (32 MiB in 0.11 s), far above the
  tunnel's 15–20 MB/s. So even the 0.9 s spent compressing 256 MiB disappears if it is
  streamed in parallel with sending.
- Incompressible data is neutral with zstd (0.94–1.00×) and clearly negative with gzip
  (0.81×). **The heuristic must switch compression off when a sample does not shrink.**
- **Rust is not the lever.** The fastest compressors are C libraries (`libzstd`,
  `liblz4`, `libbrotli`); the Rust `zstd` crate binds the same C library, and pure-Rust
  ports (e.g. `lz4_flex`) are competitive rather than faster. Node's built-in zstd is
  already that native code path, so a Rust port has nothing to win — same conclusion as
  the mux codec spike (`spike/mux/results.md`).

## What this means for p2pgate

- Compression must be **adaptive**: only when the payload actually compresses.
- **A transparent tunnel cannot see file boundaries**, and for SSH the payload is
  already encrypted by sshd → incompressible. The right lever for SSH is `ssh -C`
  (compress before SSH encrypts), not compression inside p2pgate.
- For plain services (HTTP/MCP/DB over the tunnel) compression can help ~1.5× or more.
- Connection pooling and parallel workers from the Stargate design are already covered
  by the mux carrier (one auth, many channels); extra parallel streams do not add
  bandwidth on one link.

## What from Stargate should NOT be copied

| Layer | Why not |
|---|---|
| AES-256-GCM on top of the tunnel | HyperDHT already provides authenticated encryption (Noise); a second layer adds CPU and a second key to manage, no security gain |
| ChaCha20 permutation / XOR obfuscation | no benefit on top of encryption, requires whole-buffer shuffling (breaks streaming), and the `phi` seed travels in the payload |
| Custom key distribution (`SHARED_KEY_256`, `phi_val`) | weaker than the existing SCRAM/Noise identity; rolling this into p2pgate would lower its security |

## Next idea with a real edge: a zstd dictionary

Small, repetitive payloads (JSON APIs, MCP calls, HTTP headers) compress poorly with a
fresh window but very well against a trained dictionary. A per-target dictionary can give
multi-x ratios at a few hundred microseconds, with no protocol change beyond a flag.
Worth its own spike before building anything.

## If pursued

A narrow feature: per-target `compress: "auto" | "always" | "off"` negotiated like mux,
with a sampler that measures the first ~64 KiB and disables compression when the ratio
is < ~1.1×. Use Node's built-in `zlib` (zstd first, gzip fallback for older Nodes) to
respect the single-dependency rule. Stream the compressor into the socket instead of
buffering the whole file, so compression overlaps transfer and memory stays bounded.

Gate: on a real 4G/Wi-Fi link, compressible traffic must improve ≥ 1.2× end-to-end and
incompressible traffic must not regress more than ~5%.

## Reproduce

```powershell
cd D:\tunnel\p2pgate
node spike\compression-spike.js gzip 1              # 16 MiB default
$env:P2P_SIZE_MB='256'; node spike\compression-spike.js zstd 1
node spike\compression-bench.js                    # codec cost in isolation
```
