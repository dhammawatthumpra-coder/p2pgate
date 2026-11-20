# Spike — compress before the tunnel?

**Date:** 2026-11-20
**Question:** the "Stargate" pipeline compresses before sending; would that make
p2pgate transfers faster?
**Verdict:** yes for compressible payloads, no for random/encrypted ones — the win is
compression, not the extra crypto/obfuscation layers.

## Measurement

Loopback DHT tunnel (`--mux`, 16 MiB one-way), gzip level 1 at the edge, decompressed at
the far end. Effective throughput counts original bytes / (compress + tunnel + decompress).

| Payload | Ratio | Raw tunnel | With compression | Effective | Speedup |
|---|---|---|---|---|---|
| text-like (3.9:1) | 3.9× | 5.2 MB/s | 1.85 s | 7.7 MB/s | **1.49×** |
| random (1:1) | 1.0× | 6.2 MB/s | 3.23 s | 4.2 MB/s | **0.67×** |

Integrity verified by SHA-256 in both cases. Compression cost was small (0.15 s per
16 MiB at level 1); the random case loses because CPU is spent for zero byte savings.

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

## If pursued

A narrow feature: per-target `compress: "auto" | "always" | "off"` negotiated like mux,
with a sampler that measures the first ~64 KiB and disables compression when the ratio
is < ~1.1×. Use Node's built-in `zlib` (gzip/brotli) to respect the single-dependency
rule, or revisit zstd only if the policy allows a dependency.

Gate: on a real 4G/Wi-Fi link, compressible traffic must improve ≥ 1.2× end-to-end and
incompressible traffic must not regress more than ~5%.

## Reproduce

```powershell
cd D:\tunnel\p2pgate
node spike\compression-spike.js
```
