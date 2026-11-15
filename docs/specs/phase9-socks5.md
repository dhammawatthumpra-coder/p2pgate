# Phase 9 — SOCKS5 gateway

**Status:** implemented in v1.8.0
**Baseline:** `p2pgate v1.7.0`
**Scope:** optional client-side SOCKS5 listener; the Server decides which
destinations are reachable.

---

## 1. Goal

Multi-target routing (v1.7.0) exposes named loopback services. That covers
"reach this one service", but not "let my browser reach any host on the
Server's LAN".

The SOCKS5 gateway fills that gap without a TUN device:

```sh
p2pgate connect -s <secret> -p <password> --socks5 1080
# browser -> SOCKS5 127.0.0.1:1080 -> server -> allowlisted destination
```

Non-goals:

- no UDP ASSOCIATE (DNS-over-SOCKS, games, VoIP)
- no BIND
- no IPv6 destinations in v1.8
- no transparent interception; applications must be SOCKS-aware
- not an internet exit node by default — the allowlist is mandatory

---

## 2. Server config

```json
{
  "socks": {
    "enabled": true,
    "allow": ["127.0.0.1:3000", "192.168.1.0/24:8080", "10.0.0.0/8:*"]
  }
}
```

| Rule | Detail |
|---|---|
| entry syntax | `ip:port`, `cidr:port`, `cidr:*` |
| address family | IPv4 only in v1.8 |
| hostnames in config | rejected (no DNS in policy) |
| empty allow + enabled | startup fails with `CONFIG_INVALID` |
| disabled | any SOCKS request returns `SOCKS_DISABLED` |

Normalisation lives in `config-loader.js` (`normalizeSocks`) and the runtime
checks in `src/allowlist.js`.

---

## 3. Protocol

### 3.1 SOCKS5 handshake (client process)

- greeting: only method `0x00` (no auth) is offered; p2pgate auth is the real
  authentication and happens on the tunnel
- request: `CMD=0x01` (CONNECT), `ATYP=0x01` (IPv4) or `0x03` (domain)
- unsupported: `CMD` other than CONNECT → `0x07`; `ATYP` IPv6 → `0x08`
- reply: success is sent only **after** the tunnel is authenticated, so a
  denied destination never looks like an open proxy

### 3.2 Tunnel auth (client → server)

The SCRAM proof message gains an optional object:

```json
{ "v": 3, "mode": "pwd", "clientNonce": "...", "proof": "...",
  "socks": { "host": "192.168.1.50", "port": 8080 } }
```

Server:

1. verifies the proof
2. `resolveAllowedHost(host, port, allowlist)`:
   - IPv4 literal → direct match
   - hostname → resolve (A records only) and **every** candidate must match
     the allowlist; the first allowed address is used
3. denied → `{ "ok": false, "error": "SOCKS_DENIED" }`
4. allowed → success reply with `target.name = "socks"` and the resolved IP

DNS rebinding is therefore bounded: the policy is IP-based and is applied to
the resolved address, not the requested name.

---

## 4. Security model

| Risk | Mitigation |
|---|---|
| Client requests an arbitrary address | Server allowlist is authoritative |
| DNS name points at an unlisted IP | Every resolved address is checked |
| Client uses SOCKS to reach the Server's own SSH | `127.0.0.1:*` is not allowed unless listed |
| Open-proxy abuse | Disabled by default; allowlist required; `0.0.0.0/0` is the operator's explicit choice |
| Auth bypass via SOCKS | SOCKS handshake happens before tunnel auth, but no data flows until SCRAM succeeds |
| Response confusion | SOCKS success reply is only sent after authentication succeeds |

Log events: `SOCKS ALLOW`, `SOCKS DENIED`, `AUTH OK ... target=socks`,
`FORWARD ... target=socks -> <ip>:<port>`.

Audit records `auth.success` with `target: "socks"`; destination host/port is
included in the server log, not in the audit record (keeps the audit schema
stable).

---

## 5. CLI

```sh
p2pgate connect --socks5 1080          # stored as socks5Port in client.json
p2pgate client  --socks5 1080          # one run only
```

- `--socks5` and `--target` are mutually exclusive
- SOCKS mode replaces the raw TCP listener; `--port` is ignored in that mode
- banner prints `SOCKS5: 127.0.0.1:<port>` and the client logs
  `SOCKS5 listening on 127.0.0.1:<port>`

---

## 6. Limitations (v1.8)

- IPv4 only; IPv6 destinations are rejected
- TCP only
- one tunnel per SOCKS connection, so the p2pgate auth handshake runs per
  connection (cheap after the first, because the SCRAM verifier is cached per
  salt)
- destination is resolved on the Server; local DNS on the Client is not used
  (`--socks5-hostname` and proxy-side resolution behave the same)

---

## 7. Acceptance tests

`npm test` (45 checks) includes:

1. `SOCKS5 CONNECT reaches an allowlisted destination`
2. `SOCKS5 resolves a hostname and checks the resolved IP`
3. `SOCKS5 denies a destination outside the allowlist`
4. `SOCKS5 is refused when the server has it disabled`

Manual verification (Windows + Termux):

```text
curl --noproxy "" --socks5-hostname 127.0.0.1:18053 http://127.0.0.1:18052/
→ SOCKS-OK

curl --noproxy "" --socks5-hostname 127.0.0.1:18053 http://127.0.0.1:18051/
→ SOCKS failure (exit 97); server logs `SOCKS DENIED destination=127.0.0.1:18051`
```

> Tip: `NO_PROXY=127.0.0.1` in many shells makes curl bypass the proxy, which
> looks like a broken allowlist. Use `--noproxy ""` when testing.

---

## 8. Next

1. IPv6 destinations and CIDR v6
2. UDP ASSOCIATE (needs framing over DHT streams)
3. Per-client allowlists (reuse `targets.*.allow`)
4. Per-connection audit records with destination
