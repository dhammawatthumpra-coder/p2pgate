# Where the remaining speed is (and where it is not)

**Date:** 2026-11-20
**Link:** Windows Wi-Fi ↔ Termux 4G over the public DHT, ~3.5–4.3 MB/s once flowing.
Follow-up to `results.md` (compression) — this file tests the other "make it faster" ideas.

## Summary of levers

| Lever | Measured effect | Verdict |
|---|---|---|
| zstd-1 compression | 1.4–1.5× @ 8 MiB, 2.9–3.9× @ 64 MiB, 1.0× on binary | **the only big win** |
| Higher compression level | 0 to −10% (CPU costs more than the saved bytes) | no |
| Warm client (reuse mux carrier) | ~2 s saved per transfer after the first | **free — just keep the client running** |
| 4 channels over one mux carrier | 0% (2.19–2.93 vs 3.19–3.43 MB/s single) | no |
| 4 separate connections (no mux) | 3 of 4 never delivered; run hung, killed after 30 min | not usable as-is |
| Faster codec (Rust) | < 3% (compressor is 38× faster than the link) | no |
| LZ4 instead of zstd | ratio 30–55% worse; break-even at 41–63 MB/s link | no (`spike/lz4/results.md`) |
| Bigger frames (16 → 64 KiB) | not tested; ~256 frames/s means framing is < 1% | low priority |

## 1. Setup is 2.2 s — and a warm client removes it

A 1-byte transfer took **2.18 s** client-side while the server saw it for 0.006 s, so
~2.2 s is DHT connect + auth + first-frame, not data.

Three 64 MiB transfers through **one** long-lived client:

```
transfer 1  16.14 s  (3.97 MB/s)
transfer 2  19.96 s  (3.21 MB/s)
transfer 3  16.38 s  (3.91 MB/s)
```

The mux carrier is reused, so after the first connection there is no re-handshake. The
spread is link variance (±20%), but the mechanism is real and free: **for repeated work,
run the client once instead of starting it per transfer.** For a 8 MiB transfer the 2.2 s
is over half the total time, so this matters most for small files.

## 2. Striping across channels does not create bandwidth

`send-multi.js` splits one 64 MiB file across N sockets through one client.

| Mode | Time (64 MiB) | Aggregate |
|---|---|---|
| single connection, no mux | 18.68 s | 3.43 MB/s |
| single connection, mux | 20.06 s | 3.19 MB/s |
| 4 channels, one mux carrier | 21.81 s / 29.19 s | 2.93 / 2.19 MB/s |
| 4 separate connections, no mux | hung | — |

Four parallel channels just share the same ~4 MB/s pipe and add scheduling overhead. Four
*independent* connections did not work in this test: one delivered its 16 MiB, the other
three never authenticated and the run had to be killed. Whether that is a server
concurrency limit or a handshake race is **not established** — worth a separate
investigation, but it cannot be used as a speed lever today.

This is the honest answer to the "Stargate torus / warp through many paths" idea: parallel
warp tunnels only help if they use **different physical links**. Within one link, the
p2pgate carrier already uses it fully. Real multipath (Wi-Fi + 4G at once) is a transport
problem — that is the p2path direction, not something mux can do.

## 3. Higher compression levels do not pay

64 MiB of logs, link 4.0 MB/s, setup 2.2 s, CPU serial:

| Codec | Ratio | Compressed | CPU | Total | Speedup |
|---|---|---|---|---|---|
| **zstd-1** | 7.55× | 8.47 MB | 0.29 s | **4.60 s** | **3.95×** |
| zstd-6 | 8.98× | 7.13 MB | 0.94 s | 4.92 s | 3.70× |
| zstd-12 | 17.97× | 3.56 MB | 2.07 s | 5.16 s | 3.52× |
| brotli-4 | 7.77× | 8.23 MB | 1.12 s | 5.38 s | 3.38× |
| brotli-9 | 20.28× | 3.16 MB | 5.11 s | 8.10 s | 2.25× |

Even with streaming overlap hiding the CPU, zstd-12 on this data lands around the same
total as zstd-1 (CPU-bound at ~2 s while 3.56 MB needs 0.9 s to send). Level 1 stays the
right default; there is no "turn it up" win.

## 4. What would actually go faster

1. **Compress** (already 2.9–3.9× at 64 MiB, more at larger sizes).
2. **Keep the client running** so only the first transfer pays the 2.2 s setup.
3. **Raise the ratio, not the speed**: a trained zstd dictionary was tested and is a
   **NO-GO** (`spike/dict/results.md`): 2.7× better than fresh zstd per message, but the
   saved 191 B is 0.05 ms against an 80 ms round trip, and bulk JSON is neutral-to-worse.
4. **Use `ssh -C` / `rsync -z`** when the payload is SSH — p2pgate-level compression sees
   ciphertext and cannot help.

Everything else (Rust, more threads, striping, higher levels) is within noise of the link.
The ceiling is the ~4 MB/s path, not the code.
