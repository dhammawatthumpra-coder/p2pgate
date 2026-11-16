# Phase 13 — Ping and traffic counters

**Status:** implemented in v1.11.0
**Baseline:** `p2pgate v1.10.0`

---

## 1. `p2pgate ping`

Measures protocol-level reachability without opening a listener:

```sh
p2pgate ping            # 3 pings against the current slot, then the previous slot
p2pgate ping --count 5
p2pgate ping --json
```

Output:

```text
=== p2pgate ping ===
slot 498557  serverKey 16db1bcb…
   auth 92 ms   rtt min/avg/max 0/1/1 ms   (2 pings)
```

### Flow

```text
client → connect(slot) → SCRAM handshake with { ping: true }
server → { ok, serverSig, ping: true }
client → { v, ping: { nonce } }
server → { v, ping: { nonce } }          ← RTT measured here
client → close
```

- `authMs` measures the SCRAM round trip separately from the ping RTT
- the server closes the stream after the client disconnects; idle timeout 30 s
- slots: current, then previous (mirrors normal connect behaviour)
- exit code `1` when no slot answers

Security: ping uses the same authentication as a normal session; unauthenticated
frames are rejected before any ping reply.

---

## 2. Traffic counters

The Server keeps in-memory counters for every forwarded stream:

| Counter | Meaning |
|---|---|
| `totalIn` | bytes received from clients (client → server direction) |
| `totalOut` | bytes sent to clients (server → target replies) |
| `active[]` | per-stream `{ id, peer, target, kind, startedAt, in, out }` |

- `kind` is `tcp` or `udp`
- closing a stream removes it from `active` but keeps the totals
- nothing is written to disk and no per-byte logging happens

Exposed in `p2pgate status` and `status --json`:

```text
Traffic รวม: in 1.2 KiB / out 8.4 MiB
Stream ที่ใช้งาน: 2
  - ssh (tcp) peer=3d8f1df0… in 512 B out 8.4 MiB
  - dns (udp) peer=3d8f1df0… in 120 B out 240 B
```

`p2pgate status --watch` refreshes every second (clears the screen on a TTY) and
stops with Ctrl+C.

---

## 3. Tests

New checks (54 total):

1. `status reports in-memory traffic counters`
2. `ping measures RTT without opening a listener`

Manual:

```text
$ p2pgate ping --count 2 -p <password>
slot 498557  serverKey 16db1bcb…
   auth 92 ms   rtt min/avg/max 0/1/1 ms   (2 pings)
```

---

## 4. Limitations

- counters are per process and reset on restart
- no historical graphs or persistence
- `status --watch` polls the control socket once per second (cheap, but not a
  metrics endpoint)

---

## 5. Next

- `doctor` check for ping reachability
- optional Prometheus-style `/metrics` on the control socket (local only)
