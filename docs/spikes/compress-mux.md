# Compression for mux channels (prototype)

**Status:** prototype, opt-in on both ends, **not released**.
**Scope:** mux channels only (`--mux`, or `--socks5` which defaults to mux).
**Default:** off. Turning it on changes nothing until both sides agree.

## Why

Measured on a real Windows ↔ Termux/4G link (`spike/real-link/results.md`): compression
turns a 4.5 MB/s tunnel into an effective 8–9 MB/s for text/logs, and does nothing for
already-compressed data. The cost is CPU on both ends and a per-channel negotiation.

## How it works

1. Client opens a mux channel with
   `{ target?, compress: { version: 1, algorithms: ["zstd","gzip"] } }`.
2. Server picks the first algorithm it supports (zstd when the Node build has it, else
   gzip) and answers `OPEN_OK { ..., compress: { algorithm } }`. If it has compression
   disabled, the field is omitted and the channel stays plain.
3. Both sides wrap the channel with a continuous zlib stream per direction:
   - outbound: socket → compressor → `channel.write()`
   - inbound: `channel.data` → decompressor → socket
4. Every write is followed by `flush()` so interactive channels (SSH keystrokes) are not
   held in the compressor. On 64 KiB chunks this costs ~2% ratio.

No new framing: the mux channel is already a byte stream, and the compressor output is
just bytes to it. Flow control keeps using the existing 256 KiB channel window, counted
in *wire* bytes.

### Auto mode

`compress: "auto"` (or `{ enabled: true, mode: "auto" }`) samples the first 32 KiB or
60 ms of a new client's first channel, compresses that sample in-process and keeps
compression only when it shrinks by at least 10%. The decision is sticky for the process,
so later channels pay no probe. When the sample is not compressible the probe channel is
closed and reopened without compression before any payload leaves. The buffered bytes are
written to the new channel before the socket resumes, so nothing is reordered.

### Bomb guard

Every decompressor counts input and output bytes. The channel is reset when output
exceeds `maxOutputBytes` (default 4 GiB), or after 256 KiB of input when the expansion
ratio exceeds `maxRatio` (default 1000). Both are configurable under `compress`.

### Half-close and tail flush

Two bugs surfaced while testing and are fixed:

- The decompressor must be flushed before the local socket is ended, otherwise the tail
  of the stream is dropped (measured: 4 MiB became 3.62 MiB without this).
- A peer that closes immediately can deliver FIN before the relay attaches its listeners;
  `socket.readableEnded` is checked after attaching so the channel still closes.

## Enable

```bash
# server
p2pgate server --compress          # or "compress": true in config.json

# client
p2pgate connect --compress         # requires --mux on plain tunnels; socks5 has mux by default
```

Config form:

```json
"compress": { "enabled": true, "algorithms": ["zstd", "gzip"] }
```

`--no-compress` wins over the config. A client that asks for compression against a
server that has it disabled falls back to a plain channel (verified in the self-test).

## Measured (real link, 64 MiB, p2pgate 1.13.5 + this patch)

Server-side delivery time (first byte → close), same link, same payloads:

| Payload | Plain | Compressed | Speedup | Wire bytes |
|---|---|---|---|---|
| text (4.44:1) | 11.98 s | 4.64 / 5.22 s | **2.4×** | 14.4 MB |
| log (7.55:1) | 11.54 s | 4.40 s | **2.6×** | 8.5 MB |

Client-perceived (includes the ~2.2 s DHT setup on both runs): **1.9×** for both.

Loopback (tunnel CPU-bound, no network): 8.3 → 13.0 MB/s (1.6×) — compression helps less
when the tunnel itself is the bottleneck, which is expected.

## Known limits

- **Only mux channels.** Plain non-mux tunnels are unchanged. That is deliberate: the
  negotiation lives in the mux OPEN exchange and there is no in-band handshake to add
  without touching the auth/peek path.
- **Node 20 has no zstd** → `gzip` is negotiated instead (3.9:1 vs 7.8:1 on the test
  corpus, still a win). Node ≥ 22.15 uses zstd automatically.
- **Incompressible data is neutral** (1.0×), not harmful, because zstd passes it through
  with a tiny header. gzip is slightly negative (~0.98×) — the `auto` sampling policy is
  not implemented yet; the client currently compresses when asked.
- **The receiving pipeline caps around 14 MB/s** on the test phone (isolated zstd
  decompression does 40 MB/s). On links faster than ~14 MB/s the benefit shrinks; the
  phone side, not the link, becomes the limit.
- SSH payloads are already encrypted → ~1.0×. Use `ssh -C` for those instead.
- No decompression-bomb limit. Peers are authenticated, but a malicious trusted device
  could still spend the server's CPU. Acceptable for an opt-in prototype; needs a cap
  before release.

## Tests

- `src/self-test.js`: negotiation, fallback when the server disables it, 1 MiB round
  trip, wire-savings assertion, incompressible data integrity.
- `spike/compress-test.js`: wire ratio for zstd/gzip/off and the fallback.
- `spike/compress-edge-test.js`: 1 byte, 38 bytes, interactive round trips, 4 MiB random,
  zero-byte connection.
- `spike/real-link/*`: the 4G measurements above.

## Before this could ship

1. ~~`auto` sampling~~ done: first 32 KiB/60 ms probe, sticky per process.
2. ~~Decompression output cap~~ done: 4 GiB / 1000× guards, configurable.
3. Non-mux tunnels: **not done**. The fast-path peek reads the first bytes as payload, so
   compression has to be negotiated before it and skipped for fast-path sessions. That
   touches the auth/peek path (the area behind the 1.13.2/1.13.3 regressions) and needs
   its own change with the fast-path matrix.
4. Parallel-channel soak: 1 hour with 4 channels (`spike/soak/results.md`).
5. ~~Soak~~ done: 4 hours, 240/240 cycles, 0 failures, flat RSS on both ends
   (`spike/soak/results.md`).
