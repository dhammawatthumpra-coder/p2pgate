# Spike results — mux codec in Rust

**Date:** 2026-11-20
**Baseline:** p2pgate 1.13.5 (`src/mux.js`)
**Verdict: NO-GO** — Rust is faster per operation, but the codec is not where p2pgate spends time.

---

## 1. What was tested

Only the deterministic part of `src/mux.js`:

- `encodeFrame(type, flags, channelId, payload)`
- `FrameParser.push(chunk)` (frame decoding, including frames split across chunks)

Not ported (by design): `MuxCarrier`, `MuxChannel`, transport, auth, CLI.

## 2. Parity (gate G1)

116 fixtures generated **from the JS implementation**:

- every frame type, including p2path's `CONTROL` (`0x10`)
- zero-length payloads, channel id `0xffffffff`
- exactly `MAX_FRAME` (16 KiB) payloads and rejection of larger lengths
- one frame per chunk, several frames per chunk, every two-way split
- one byte per chunk (header split across 11+ pushes)
- trailing partial header, empty chunks

Result: **116 cases, 0 mismatches** — byte-identical frames and identical frame order.

```
parity: 116 cases, 0 mismatches
```

## 3. Throughput (gate G3)

Windows 11, Node 24, Rust 1.96, release build, single run each (±10%). Payload is
pseudo-random so the optimizer cannot elide the copy; the Rust parser copies each
payload like `FrameParser` does (`Buffer.from`).

| Payload | Operation | Node (ns/op) | Rust (ns/op) | Speedup |
|---|---|---|---|---|
| 64 B | encode | 225.7 | 57.1 | 4.0× |
| 64 B | parse | 261.7 | 65.4 | 4.0× |
| 16 KiB | encode | 19,903 | 846 | 23.5× |
| 16 KiB | parse | 12,786 | 2,135 | 6.0× |

So the "Rust is much faster" claims are real for the function itself, and the 16 KiB
encode gap is mostly Node's `Buffer.allocUnsafe` + copy overhead.

## 4. Does it matter for p2pgate? (the actual question)

A frame is 16 KiB. At the throughput measured on a real Wi-Fi link (~2 MB/s), the
tunnel moves **128 frames/s**:

| | Node | Rust | Difference |
|---|---|---|---|
| encode + parse per frame | 32.7 µs | 3.0 µs | −29.7 µs |
| per second at 2 MB/s | 4.2 ms (0.42% CPU) | 0.38 ms (0.04%) | **−0.38% CPU** |

Even at an unrealistic 50 MB/s (3,200 frames/s) the saving is ~9% CPU — while
HyperDHT's Noise encryption (native `sodium`), UDP I/O, and the DHT handshake dominate
everything else. At normal speed the change is inside the noise of a single GC pause.

**The 18× claim is about CPU-bound applications** (Prettier formatting, Fuse.js search).
p2pgate is network-bound: its cost centre is the ~2 s DHT connect and the link itself,
not the 16 KiB memcpy per frame.

## 5. Other gates

| Gate | Result |
|---|---|
| G1 parity | **PASS** (0/116 mismatches) |
| G2 install on Termux without Rust | **not attempted** — pointless once G3's share is ~0.4%; it would require `napi-rs` cross-builds for `android-arm64` and new prebuilt binaries per platform |
| G4 memory | no plausible win: RSS is dominated by V8 + HyperDHT, not the codec (server ~55–70 MB in soak) |
| G5 maintenance | would add a second implementation of the same format (Rust + JS must stay in sync forever) |

## 6. Decision

**Do not port.** Keep the JS codec.

Revisit only if one of these becomes true:

1. a real profile shows mux framing above ~10% of CPU (today it is <0.5%), or
2. a maintained Rust implementation of HyperDHT/hyperswarm exists (that is the actual
   cost centre), or
3. the goal changes from speed to **single binary / memory footprint**, in which case a
   full port is a different project with its own gates.

## 7. Reproduce

```powershell
cd D:\tunnel\p2pgate\spike\mux
node gen-fixtures.js > fixtures\mux-cases.jsonl
cargo build --release
Get-Content fixtures\mux-cases.jsonl | .\target\release\mux-codec-spike.exe parity
node bench-node.js 1000000 64
.\target\release\mux-codec-spike.exe bench 1000000 64
node bench-node.js 20000 16384
.\target\release\mux-codec-spike.exe bench 20000 16384
```
