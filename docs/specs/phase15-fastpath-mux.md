# Phase 15 — mux over fast-path (trusted devices)

**Status:** design draft (target v1.13.0)
**Baseline:** `p2pgate v1.12.1`
**Related:** [`phase14-mux.md`](phase14-mux.md)

---

## 1. Problem

In 1.12 `--mux` only works on a **challenged** session. A **trusted** device takes
the fast path: the server answers `FASTPATH_READY` and pipes to the target before it
ever reads the client's proof, so there is no point in the handshake where mux can be
negotiated. The client's `--mux` therefore degrades to one stream per connection:

```text
MUX unavailable (fast-path or older server); using dedicated streams
```

The typical user is exactly this case — one or two sessions, trusted device — so mux
is invisible to most people. Soak results (`docs/SOAK.md` §1.5) show mux is stable;
the missing piece is fast-path.

## 2. Constraints

1. **Old clients must not break.** A 1.12 client pipes payload immediately after
   `FASTPATH_READY`; any bytes the server injects or consumes must be preserved.
2. **Old servers must not break.** A 1.12 server pipes immediately without reading,
   so a new client must not send anything before it knows mux is supported.
3. **No new dependency**, no change to the challenged flow, no change to `AUTH_VERSION`
   semantics (the field stays `3`; the capability is additive).
4. **Trust does not widen.** Fast-path already proves the device key is trusted; mux
   channels must still resolve targets per channel (`resolveTarget` /
   `resolveSocksTarget`) exactly as dedicated streams do.
5. **Bounded work.** Peeking must be capped in bytes and time; no unbounded buffers.

## 3. Options considered

| Option | Idea | Why not |
|---|---|---|
| A. Client preface before auth | client sends `{"mux":1}\n` as its first bytes | an old server forwards those bytes to the target (e.g. sshd) as garbage; breaks constraint 1 |
| B. **Capability in `FASTPATH_READY` + bounded peek** | server advertises mux, client asks immediately, server waits briefly | **chosen** |
| C. Second carrier after fastpath | open a second DHT stream just for mux | pays a second DHT lookup; defeats the point |
| D. Upgrade after first payload byte | server switches once it sees data | cannot distinguish "ready for mux" from real payload; no clean point to switch |

## 4. Wire design

### 4.1 Server advertises (additive field)

```json
{"v":3,"status":"FASTPATH_READY","mux":{"version":1,"maxChannels":128}}
```

Old clients ignore `mux` (their decoder keeps unknown fields out of the way).
The field is omitted when the server runs with `mux: false` in config.

### 4.2 Client asks (only when it wants mux and the capability is present)

One control line, sent immediately after `FASTPATH_READY`, before any payload:

```json
{"v":3,"mux":{"version":1}}
```

### 4.3 Server accepts

```json
{"v":3,"mux":{"version":1,"maxChannels":128}}
```

…then the stream switches to the mux session (`startMuxSession`) and the first frame
follows. If the peeked bytes are not a valid upgrade, the server forwards **exactly
those bytes** as `leftover` to `forwardToTarget` and behaves as 1.12.

### 4.4 Detection rules (strict)

A peeked line is an upgrade only when **all** hold:

- it is terminated by `\n` within `MAX_UPGRADE_BYTES` (512),
- it parses as a JSON object,
- `v === AUTH_VERSION`,
- `mux.version` is an integer the server supports (currently `1`).

Anything else — including binary payload that happens to start with `{` — is payload
and is forwarded byte-for-byte.

## 5. Server changes

1. `fastpath` branch writes `FASTPATH_READY` with the capability (config-gated).
2. New helper `peekControlLine(stream, { timeoutMs, maxBytes })`:
   - resolves `{ line: string|null, leftover: Buffer }`,
   - **never rejects on timeout or on non-JSON bytes**; it resolves with what it read,
   - detaches its listeners and never leaves the stream paused.
3. If the line is a valid upgrade:
   - reply with the acceptance message,
   - `startMuxSession(stream, entry, remoteHex, leftover)`,
   - log `FASTPATH mux=1`, audit `auth.fastpath` with `mux: true`.
4. Otherwise `forwardToTarget(stream, entry, remoteHex, slot, leftover)` (no change),
   log `FASTPATH mux=0` at most once per connection.
5. Timeout default `muxPeekMs = 300` (env `P2PGATE_MUX_PEEK_MS` for tests); `0` disables
   the peek entirely (exactly 1.12 behaviour).

### 5.1 State machine

```text
connected
  -> decideDevice()
     -> decline      : DECLINED, close
     -> fastpath     : FASTPATH_READY(+mux?)
                       -> peek (<=300 ms, <=512 B)
                          -> upgrade OK      : MUX_READY, mux session
                          -> anything else   : forward leftover to target
     -> challenge    : CHALLENGE_REQUIRED -> proof -> (mux as in 1.12)
```

## 6. Client changes

1. `authenticateEncrypted()` returns `{ status, mux, leftover }` for the fastpath
   path instead of throwing the capability away.
2. `getMuxCarrier()`:
   - fastpath **with** capability → send `{"v":3,"mux":{"version":1}}`, wait for the
     acceptance line, then build `MuxCarrier` with the remaining leftover bytes;
   - fastpath **without** capability (old server) → `muxUnsupported`, one quiet log line;
   - challenged → unchanged.
3. The upgrade must be written before any payload; `handleLocalSocket` already defers
   payload until auth completes, so no reordering is needed.
4. Failure to get an acceptance within `muxOpenTimeout` (10 s) → destroy the stream and
   fall back to a dedicated stream (never leave the local socket hanging).

## 7. Latency

| Case | Added latency |
|---|---|
| mux client (sends upgrade immediately) | none — peek resolves in one RTT |
| non-mux client with pending payload (SSH, HTTP) | none — first bytes arrive immediately |
| non-mux client, server-first protocol, idle client | up to `muxPeekMs` once per connection |
| challenged sessions | none (unchanged) |

SSH and HTTP clients both speak first, so the third row is rare. Operators who dislike
it can set `muxPeekMs` to `0` (server) or `mux: false`.

## 8. Security review

- The upgrade is only reachable on **already trusted** devices; challenged sessions are
  unchanged, so this adds no new authentication path.
- Channels still pass `resolveTarget` / `resolveSocksTarget` per open; a fast-path
  device gains no new authority by using mux.
- Peek is capped (512 B, 300 ms) and never buffers unbounded input.
- Upgrade after payload started is impossible: the window closes on the first
  non-matching byte.
- Server-side carrier/channel caps from 1.12.1 still apply (64 / 512).
- Logging: `FASTPATH mux=1|0`, no target or payload data in logs.

## 9. Compatibility

| Client | Server | Result |
|---|---|---|
| 1.12.x | 1.12.x | as today (fastpath = dedicated streams) |
| 1.12.x | 1.13.x | client ignores `mux` field, sends payload; server peeks, forwards |
| 1.13.x | 1.12.x | client sees no capability, falls back quietly |
| 1.13.x | 1.13.x | mux over fast-path |

## 10. Config / CLI

| Knob | Where | Default | Meaning |
|---|---|---|---|
| `mux` | server config | `true` | advertise mux on fast-path |
| `muxPeekMs` | server config | `300` | peek window; `0` disables |
| `--mux` | client | off | opt-in, unchanged in 1.13.0 |
| `--no-mux` | client | — | force dedicated streams |

## 11. Tests (self-test additions)

1. fastpath + mux: trusted registry key, `--mux` → `muxActive === true`, 1 MiB echo intact.
2. payload starting with `{`: target expects `{"a":1}\n` → arrives intact (peek must not eat it).
3. server-first target with a non-mux client: banner arrives within 1 s.
4. oversized "upgrade" (600 B, no newline) → treated as payload, no hang.
5. old-client simulation (`mux: false`) on a 1.13 server → bytes intact.
6. server `mux: false` → no capability, client falls back once, no warning spam.
7. `muxPeekMs = 0` → byte-for-byte identical to 1.12 behaviour.
8. status/log: `FASTPATH mux=1` appears exactly once per carrier.

## 12. Rollout

1. Ship behind the existing opt-in client flag in **1.13.0**.
2. Soak (`scripts/soak/`) with a **trusted** device this time, 4 h.
3. If clean, consider enabling mux by default **for `--socks5` only** in 1.13.x.
4. Rollback is config-only: `mux: false` on the server, or `--no-mux` on the client.

## 13. Open questions

- Is 300 ms the right peek? Measure on 4G; 150 ms may be enough.
- Should `maxChannels` come from server config rather than a constant?
- Should `two-step` (always-challenge) sessions also advertise mux? Not needed today.

## 14. Effort

Server ~120 lines (peek helper + branch + caps), client ~50 lines, self-test ~200 lines,
soak script reuse. Estimate **2–3 days** part-time plus one overnight soak.
