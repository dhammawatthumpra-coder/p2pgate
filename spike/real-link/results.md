# Real-link test — does compression make p2pgate transfers faster?

**Date:** 2026-11-20
**Link:** Windows (Wi-Fi) ↔ Android/Termux (4G) over the public HyperDHT, p2pgate
1.13.5 on both ends, isolated HOME (the user's real `~/.p2pgate` was not touched).
**Verdict:** **yes, on a real link.** zstd-1 gave 1.4–1.5× at 8 MiB and **2.9–3.9× at
64 MiB** for compressible files, and ~1.0× for incompressible ones. This reverses the
loopback conclusion, which understated the win because loopback is CPU-bound.

## Method

A TCP sink on the Termux side accepts bytes and reports `{bytes, seconds, sha256}`
(seconds = first byte → close, so the tunnel's ~2.3 s DHT setup is excluded from that
number). The Windows side connects through a normal p2pgate client, writes the file, and
reports its own wall time (which *includes* setup). The compressed case sends a
zstd-1-compressed file through the same tunnel; compression and decompression are timed
separately on Windows and added.

Payloads (64 MiB each, identical bytes across cases):

| Payload | zstd-1 ratio | Contents |
|---|---|---|
| text | 4.44× | the project's own README/docs/source concatenated |
| log | 7.55× | realistic application log lines |
| binary | 1.00× | random bytes (stand-in for jpg/mp4/zip) |

## Results — 8 MiB

| Case | Raw | Compressed transfer | + zstd CPU | Effective | Speedup |
|---|---|---|---|---|---|
| text | 4.26 s | 2.99 s (1.81 MB) | 0.08 s | 1.88 → 2.61 MB/s | **1.39×** |
| log | 4.34 s | 2.74 s (1.06 MB) | 0.06 s | 1.84 → 2.86 MB/s | **1.55×** |
| binary | 4.43 s | 4.13 s (8.00 MB) | 0.04 s | 1.81 → 1.92 MB/s | **1.0×** (noise; the "compressed" file is 2 bytes larger) |

## Results — 64 MiB

| Case | Raw | Compressed transfer | + zstd CPU | Effective | Speedup |
|---|---|---|---|---|---|
| text, mux | 20.06 s | 6.28 s (14.4 MB) | 0.66 s | 3.19 → 9.22 MB/s | **2.89×** |
| text, no mux | 18.68 s | 5.60 s (14.4 MB) | 0.66 s | 3.43 → 10.22 MB/s | **2.98×** |
| log, mux | 18.58 s | 4.33 s (8.47 MB) | 0.48 s | 3.44 → 13.31 MB/s | **3.86×** |

Server-side rate once data is flowing: **3.8–4.1 MB/s** raw and compressed alike
(3.77 / 4.03 / 4.10 / 3.86 MB/s), i.e. the tunnel moves the same bytes/second whether or
not they are compressed — the win comes purely from having fewer bytes.

Client-minus-server time was 2.0–2.5 s in every case: the DHT connect. That is why the
speedup grows with file size.

## Projection for larger files

Using the measured block rates (not guesses): at 256 MiB, text ≈ **3.7×**, logs ≈ **5.0×**,
because the 2.3 s setup becomes a small fraction. At 8 MiB it is only 1.4–1.5×, and below
~4 MiB compression can lose outright (the setup dominates).

## Why loopback said 2.7× and the real link says 3–4×

Loopback moved 20 MB/s, so the CPU spent compressing was a visible share and the tunnel
was the bottleneck. On this link (4 MB/s) the network is the bottleneck, so the ratio
translates almost fully, and 0.66 s of CPU on a 20 s transfer is noise.

## Is Rust the lever? No.

zstd-1 compresses 64 MiB in 0.44 s = **145 MB/s**, about 38× the link. Even a 10× faster
compressor would change the total by under 3%. The Rust `zstd` crate wraps the same C
`libzstd`, so there is nothing to win (see `spike/mux/results.md` for the same result on
the framing codec).

## Limits that decide whether to build it

1. **Only unencrypted payloads benefit.** This test used a raw TCP sink — what a plain
   HTTP/DB/rsync service looks like. `scp`/SSH inside the tunnel is already encrypted, so
   compression there is ~1.0×. For SSH the right answer stays `ssh -C` / `rsync -z`,
   which needs no code change and gets the same kind of win.
2. **Must be optional and adaptive.** Incompressible data is neutral with zstd (1.06×) but
   *negative* with gzip (0.81× measured earlier). Sample the first ~64 KiB and disable
   below ~1.1×.
3. **Node 20 has no zstd** (`engines: >=20`). Either require >=22.15 or fall back to gzip.
4. **Stream, don't buffer.** The numbers above compress the whole file first; streaming
   would hide the 0.66 s and keep memory bounded, worth a few more percent.

## Reproduce

```powershell
# on Termux
cd ~/p2p-link-test
HOME=$PWD/home MASTER_SECRET=<hex> PASSWORD=<pw> OUT=$PWD/received.jsonl \
  nohup node termux-server.js > server.log 2>&1 &

# on Windows (regenerate payloads first)
$env:SIZE_MB='64'; node spike\real-link\gen-payloads.js
$env:MASTER_SECRET='<hex>'; $env:PASSWORD='<pw>'; $env:MUX='1'
node spike\real-link\send.js payloads\text-64m.bin text64-raw
node spike\real-link\send.js payloads\text-64m.zst text64-zst
node spike\real-link\cpu-cost.js
```
