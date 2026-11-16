# Phase 12 — UDP forwarding

**Status:** implemented in v1.10.0 (opt-in)
**Baseline:** `p2pgate v1.9.1`

---

## 1. Why

`hyperdht@6.36` exposes streams only — there is no datagram API. p2pgate was
therefore TCP-only. That blocks DNS, NTP, game traffic and anything else that
speaks UDP.

v1.10 adds **UDP-over-stream**: datagrams are framed inside the existing
authenticated tunnel. It stays on Termux, needs no kernel feature, and is off by
default.

---

## 2. Config

Server:

```json
"udpTargets": {
  "dns": { "host": "127.0.0.1", "port": 53 },
  "ntp": { "host": "127.0.0.1", "port": 123 }
}
```

- names follow the `targets` rules (`A-Za-z0-9_-`, 1–32 chars)
- `host` must be `127.0.0.1` (same invariant as TCP targets)
- clients send a **name**, never `host:port`

Client (optional defaults):

```json
"udpTarget": "dns",
"udpListen": 5353
```

CLI:

```sh
p2pgate udp --target dns --listen 5353
```

---

## 3. Framing

```text
[length: uint16 big-endian][payload]
```

| Limit | Value | Behaviour |
|---|---|---|
| max datagram | 1200 bytes | dropped, logged |
| empty datagram | 0 bytes | refused |
| invalid length in stream | 0 or > 1200 | session closed (`UDP framing error`) |

1200 bytes keeps the encapsulated payload under a typical 1500 MTU and avoids
IP fragmentation surprises.

---

## 4. Sessions

A UDP "session" is one tunnel stream per client source endpoint:

| Event | Behaviour |
|---|---|
| first datagram from `ip:port` | open tunnel stream, authenticate, forward |
| reply from target | framed back to the same `ip:port` |
| idle | stream closed after `udpIdleTimeoutMs` (default 60 s) |
| stream error/close | session removed, next datagram re-opens |
| client shutdown | all sessions closed |

Because replies can only return through the same stream, the Server cannot be
used as a UDP reflector.

---

## 5. Security

| Risk | Mitigation |
|---|---|
| Reflection/amplification | replies only on the originating stream; no arbitrary `sendto` |
| Open resolver | targets are fixed in server config; unknown names → `UDP_TARGET_UNKNOWN` |
| Session exhaustion | idle timeout + one session per source endpoint |
| Oversized payloads | hard cap at 1200 bytes on both sides |
| Arbitrary destination | never accepted from the client |

Auth is the same SCRAM handshake; the proof message gains
`"udp": { "target": "dns" }`.

---

## 6. Logs

Server:

```text
UDP SESSION client=<key> target=dns -> 127.0.0.1:53
UDP SESSION closed client=<key> target=dns datagrams=12
UDP framing error client=<key>: invalid datagram length 0
```

Client:

```text
UDP TUNNEL established slot=... target=dns
UDP LISTENING on 127.0.0.1:5353 (target dns)
```

---

## 7. Tests

`npm test` adds:

1. `UDP datagrams are forwarded through the tunnel` (echo)
2. `UDP datagrams above the limit are dropped` (1400 bytes → no reply)

Manual CLI check:

```text
$ p2pgate udp --target echo --listen 5354
✅ UDP tunnel is ready
$ (send "hello-udp")
ECHO:hello-udp
server: UDP SESSION client=... target=echo -> 127.0.0.1:54540
```

---

## 8. Limitations (v1.10)

- IPv4 only
- TCP-style auth per session: a new source endpoint pays one handshake
- no multiplexing of several endpoints over one stream
- no ordering/retransmission — datagrams may be lost, like UDP
- no UDP through SOCKS5

---

## 9. Next

1. Session multiplexing (one stream, many endpoints)
2. IPv6
3. Per-target allowlists (`udpTargets.<name>.allow`) mirroring TCP targets
4. Doctor check for UDP targets
