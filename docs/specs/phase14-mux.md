# Phase 14 — Stream multiplexing (`--mux`)

**Status:** design draft (target v1.12.0)
**Baseline:** `p2pgate v1.11.4`

---

## 1. Problem

Measured on a real link:

```text
p2pgate ping --count 3
   connect 2130/2263/2424 ms   auth 26/28/32 ms
```

Every local connection opens a new HyperDHT stream: `connect ≈ 2.2 s` of DHT
lookup + hole punching, while authentication costs only ~28 ms.

For a single SSH session that is fine. For `--socks5` it is not: a single web
page commonly opens 20–40 parallel connections, so the page waits for 20–40
independent DHT lookups.

Goal: open **one authenticated carrier** and create cheap logical channels
inside it, so new connections pay ~0 ms of transport setup.

---

## 2. Options considered

| Option | Complexity | Verdict |
|---|---|---|
| **Warm pool** (pre-open N authenticated streams) | low | rejected: after auth the server connects the target immediately, so idle pooled streams hold idle sshd/web connections; also fixed pool size |
| **Multiplexing** (one carrier, many channels) | medium | chosen |
| Per-connection DHT (today) | none | keep as fallback |

---

## 3. Constraint: fast-path sessions

The server decides `fastpath` from the device registry **before** reading
anything from the stream, then immediately connects the target and pipes.

Therefore a mux handshake cannot be negotiated on a fast-path stream without
either

1. delaying the target connection (protocol detection), which adds up to one
   RTT of latency to every trusted connection, or
2. changing the auth order.

**Decision for v1.12:** mux is available only when the session is
**challenged** (`password`, `two-step`, or a `scram`-profile key). Trusted
(fast-path) devices keep the per-connection behaviour unless the operator
registers that key as `scram`.

Consequences:

- `--mux` with a trusted key logs a warning and falls back to one stream per
  connection (no regression, no silent slowdown).
- The spec keeps the door open for fast-path mux later (see §11).

---

## 4. Protocol

### 4.1 Carrier handshake

The SCRAM proof message gains one optional field:

```json
{ "v": 3, "mode": "pwd", "clientNonce": "...", "proof": "...",
  "mux": { "version": 1, "maxChannels": 128 } }
```

Server accepts with:

```json
{ "v": 3, "ok": true, "serverSig": "...", "mux": { "version": 1, "maxChannels": 64 } }
```

`maxChannels` is the negotiated minimum of both sides; the default is **128**.
If the server does not support mux it answers without the field and the client
falls back.

### 4.2 Frame format

```text
 0        1        2                6                10
 +--------+--------+----------------+----------------+
 | type   | flags  |  channelId     |    length      |  payload
 +--------+--------+----------------+----------------+
   uint8    uint8     uint32 BE        uint32 BE        length bytes
```

- header = 10 bytes, `length ≤ 16384`
- `channelId` is chosen by the opener; `0` is reserved for carrier control
- `flags`: `0x01 FIN` (half-close), `0x02 RESET` (abort)

### 4.3 Frame types

| Type | Direction | Payload |
|---|---|---|
| `0x01 OPEN` | either | UTF-8 JSON `{ target?: string, socks?: {host,port}, kind: "tcp" }` |
| `0x02 OPEN_OK` | server | UTF-8 JSON `{ target, host, port }` |
| `0x03 OPEN_ERR` | server | UTF-8 JSON `{ error }` |
| `0x04 DATA` | both | raw bytes |
| `0x05 WINDOW` | both | uint32 credit increment |
| `0x06 CLOSE` | both | empty (graceful) |
| `0x07 PING` / `0x08 PONG` | both | uint64 token (carrier keepalive) |

`OPEN` carries exactly the information the current per-connection handshake
carries: a **target name** from `targets`/`udpTargets`, or a SOCKS destination
that is checked against `socks.allow`. The server never accepts a raw
`host:port` for TCP targets.

### 4.4 Channel lifecycle

```text
client                       server
  |-- OPEN(target=web) ------->|
  |<------------- OPEN_OK -----|
  |<=========== DATA =========>|
  |-- CLOSE ------------------>|
  |<------------------- CLOSE -|
```

- server validates the target/allowlist per channel; denial = `OPEN_ERR` with
  the same error codes as today (`TARGET_UNKNOWN`, `TARGET_FORBIDDEN`,
  `SOCKS_DENIED`)
- only one target per channel; no mixing
- unknown `channelId` → `RESET` and a log line
- `OPEN` timeout 10 s, idle channel timeout 120 s (configurable)
- carrier idle timeout: **5 minutes** without channels (see §5)

### 4.5 Flow control

Per channel, credit-based:

- initial window 256 KiB per direction
- receiver sends `WINDOW` when consumed bytes ≥ window/2
- sender must not exceed available credit; excess is buffered up to 64 KiB per
  channel, beyond that the channel is `RESET`
- carrier-level: if total buffered bytes exceed 4 MiB, stop reading from the
  DHT stream (TCP backpressure) instead of dropping

---

## 5. Client design

New module `src/mux.js`:

```text
MuxClient
  openChannel({ target | socks }) -> Duplex-like channel
  close()
  stats()
```

- one carrier per (serverKey, config); lazily created
- `--mux` enables it for `--socks5` and `--target` modes
- `p2pgate connect` keeps the single-target path unless `--mux` is given
- carrier reconnect: channels fail with `MUX_CARRIER_CLOSED`; the client opens a
  new carrier on the next request. No channel resumption (same as today's
  streams).
- carrier idle timeout **5 minutes**: with zero channels the carrier closes and
  the next request pays one DHT connect (~2 s). Five minutes covers normal
  browsing/shell bursts; raising it to 10 minutes only trades idle sockets for
  less reconnects.
- keepalive `PING` every 30 s while idle; carrier considered dead after 3
  missed PONGs.

SOCKS integration: each accepted SOCKS connection opens one channel with
`socks: {host, port}`; the existing handshake code is bypassed.

---

## 6. Server design

`src/mux.js` shared framing + `runMuxSession(stream, ...)` in `server.js`:

- authenticate once (normal SCRAM), then enter mux loop
- per channel: create TCP socket to the resolved target (or UDP session later)
- reuse `forwardToTarget`'s pipe logic, but write into `DATA` frames with
  credit accounting
- enforce `maxChannels` (128 by default); beyond that answer
  `OPEN_ERR { error: "MUX_BUSY" }`
- audit `auth.success` once per carrier; per-channel events are logged but not
  audited (volume)

---

## 7. Metrics

Extend `traffic` from v1.11:

```json
"traffic": {
  "totalIn": 1234,
  "totalOut": 5678,
  "carriers": 1,
  "channels": 12,
  "active": [ { "carrier": 1, "channel": 7, "target": "web", "in": 10, "out": 20 } ]
}
```

`p2pgate status --watch` shows channels per carrier.

---

## 8. Security

| Risk | Mitigation |
|---|---|
| Channel reaches arbitrary destination | same allowlists as today (`targets`, `udpTargets`, `socks.allow`) |
| Channel ID confusion / cross-talk | IDs scoped per carrier; unknown ID → `RESET` |
| Memory growth from unread channels | per-channel buffer cap + carrier backpressure |
| One channel starving others | per-channel windows, round-robin writes |
| Fast-path auth bypass | mux requires a challenged session (see §3) |
| Header fuzzing | length limits, type whitelist, strict UTF-8 for JSON payloads |

---

## 9. Compatibility

| Combination | Behaviour |
|---|---|
| 1.12 client + 1.12 server, `--mux` | mux |
| 1.12 client + 1.11 server, `--mux` | server ignores the field → fallback per connection |
| 1.11 client + 1.12 server | normal per-connection streams |
| Fast-path key + `--mux` | warning + fallback |

No config migration; `--mux` is opt-in. A later release may default it on for
`socks5` only.

---

## 10. Tests

Self-test additions (target ~65 checks):

1. framing: encode/decode round-trip, oversize frame rejected
2. two channels echo concurrently on one carrier
3. channel open with an unknown target → `OPEN_ERR TARGET_UNKNOWN`
4. SOCKS channel denied by `socks.allow` → `OPEN_ERR SOCKS_DENIED`
5. per-channel flow control: sender blocked at window edge, resumes after
   `WINDOW`
6. `FIN` half-close works; `RESET` aborts
7. max channels exceeded → `MUX_BUSY`
8. carrier close fails all open channels with a clear error
9. fast-path client with `--mux` falls back (no mux frames sent)
10. no regression: existing 57 checks stay green

Manual: open a page through `--socks5` with 20+ requests and compare first-byte
time before/after.

---

## 11. Future

- Fast-path mux: requires a pre-auth capability frame with protocol detection;
  must prove no added RTT before shipping.
- Multiple carriers per server (e.g., 2–4) to reduce head-of-line blocking.
- Channel prioritisation for interactive SSH over bulk transfers.
- UDP channels (reuse the framing; server UDP session per channel).

---

## 12. Decisions (2026-11-16)

1. **`maxChannels` default: 128** on both sides; the carrier uses the minimum of
   the two.
2. **`--mux` default: off in 1.12.0.** It flips on for `--socks5` in a 1.12.x
   patch only after a soak passes and the fast-path fallback is proven silent.
   Turning it on is otherwise side-effect free: challenged sessions get mux and
   trusted sessions fall back to one stream per connection.
3. **Carrier idle timeout: 5 minutes** with zero channels. With a challenge session
   the next request then pays one DHT connect (~2 s); 5 minutes covers normal
   browsing and shell bursts. Exposed as `MUX_IDLE_MS` internally, configurable
   later if operators ask.
4. **Audit: no per-channel events by default.** A page load can open 20–40
   channels and would flood `audit.log`. Channel visibility comes from
   `status --json` (`traffic.active[]`) and debug logs. If an operator needs it
   later, add `mux.auditChannels: true` (off by default) instead of changing the
   default behaviour.

### Still open (non-blocking)

- Fast-path mux (pre-auth capability frame) — needs a latency proof.
- Multiple carriers per server (2–4) to reduce head-of-line blocking.
- Channel prioritisation for interactive SSH over bulk transfers.
- UDP channels.
