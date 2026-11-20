# Spike — zstd dictionary for MCP / JSON-RPC traffic

**Date:** 2026-11-21
**Question:** small, repetitive JSON messages compress poorly with a fresh zstd window.
Would a trained dictionary give a meaningful end-to-end win over the tunnel?
**Verdict: NO-GO.** The dictionary works (8.3× vs 3.1× on 932-byte messages), but the
bytes it saves are ~191 B per message = **0.05 ms** at 4 MB/s, against an ~80 ms RTT. On
bulk JSON it is neutral-to-worse.

## What was measured

600 training messages and 200 held-out messages of realistic MCP traffic: `initialize`,
`tools/list` with 20 tool schemas, `tools/call` requests and results, plus SSE frames
(`event: message\ndata: {...}\n\n`). Average message 932 B.

Dictionary trained offline with `zstd --train` (16 KiB and 8 KiB). Node 24 can consume it
directly (`zlib.zstdCompressSync(buf, { dictionary })`), so no runtime dependency would be
needed — only a pre-trained blob.

## Per-message result (200 held-out messages, 182 KB)

| Variant | Avg bytes/msg | Ratio | Saved vs raw | Compress µs | Decompress µs |
|---|---|---|---|---|---|
| fresh zstd-1 | 303.6 | 3.07× | 67.4% | ≈50 | ≈30 |
| dict 8k | 119.7 | 7.79× | 87.2% | ≈70 | ≈35 |
| **dict 16k** | **112.7** | **8.27×** | **87.9%** | ≈67 | ≈30 |
| dict 16k, no dict ID | 108.7 | 8.58× | 88.3% | ≈56 | ≈30 |

The dictionary is a real 2.7× improvement over fresh compression **on bytes**. But:

```
per message saved vs fresh: 190.9 B
at 4 MB/s that is 0.05 ms
one request/response RTT ~80 ms -> the saving is 0.06% of a round trip
```

MCP is latency-bound, not bandwidth-bound. A tool call is ~1 KB; whether it leaves as 304 B
or 113 B changes the wire time by 50 µs. It cannot be felt.

## Continuous stream (how a tunnel actually compresses)

A tunnel compresses the byte stream, not individual messages, so the window learns the
JSON shape after the first few messages:

| 182 KB of MCP traffic | Packed | Ratio |
|---|---|---|
| fresh zstd-1, one frame | 9.1 KB | 20.0× |
| dict 16k, one frame | 7.4 KB | 24.7× |

Difference: 1.7 KB per connection = **0.4 ms**. Also invisible.

## Bulk JSON (the case where bytes do matter)

1 MB of unique NDJSON events (agent streaming):

| Variant | Packed | Ratio |
|---|---|---|
| fresh zstd-1 | 99.6 KB | 10.28× |
| dict 16k | 104.0 KB | 9.85× |

Fresh zstd already gets ~10× on JSON and the dictionary makes it slightly **worse** (the
dictionary occupies window and adds a header without adding matches).

## Why

- A dictionary helps when the payload is smaller than the window (a few hundred bytes).
  At that size the absolute saving is tens to hundreds of bytes.
- As soon as the stream is a few KB, zstd's own history does the same job.
- MCP latency comes from the round trip and the tunnel setup (2.2 s measured), not from
  the size of a 1 KB frame.

## Decision

**Do not add a dictionary.** It would add a per-target artifact to train, ship and version,
for ≤0.06% of a round trip. Plain zstd-1 already gives 10× on bulk JSON and 3× on
per-message JSON.

It would only make sense in a different regime: a very low-bandwidth link (tens of KB/s)
with payloads under ~2 KB and no round-trip cost — not p2pgate's use case.

## Reproduce

```powershell
cd D:\tunnel\p2pgate\spike\dict
node gen-mcp-corpus.js
zstd --train -r corpus\train -o corpus\dict-16k.bin --maxdict=16384
node bench-dict.js
```
