# Phase 8 — Multi-target routing (`targets`)

**Status:** implemented in v1.7.0
**Baseline:** `p2pgate v1.6.4`
**Scope:** one Server process exposes several local services; each Client picks
one by name.

---

## 1. Goal

Before v1.7.0 a Server forwarded to exactly one port (`targetPort`). Reaching
anything else required SSH local forwarding:

```sh
ssh -p 18022 -L 8080:127.0.0.1:8080 localhost
```

That works, but it makes SSH the router: every extra service needs `sshd`, SSH
keys, and a `-L` flag, and a device without `sshd` (Android app, container, IoT
daemon) cannot expose anything.

v1.7.0 moves that decision into p2pgate itself:

```sh
p2pgate connect --target web --port 8080
# 127.0.0.1:8080 on the client  ->  127.0.0.1:8080 on the server
```

Non-goals for this phase:

- no arbitrary `host:port` from the client (SSRF)
- no SOCKS5 (planned later)
- no TUN/L3 routing
- no LAN targets (still `127.0.0.1` only)

---

## 2. Config

```json
{
  "targets": {
    "ssh":  { "host": "127.0.0.1", "port": 2222 },
    "web":  { "host": "127.0.0.1", "port": 8080 },
    "db":   { "host": "127.0.0.1", "port": 5432, "allow": ["<clientKeyHex>"] }
  },
  "defaultTarget": "ssh"
}
```

| Field | Rules |
|---|---|
| target name | `^[A-Za-z0-9_-]{1,32}$`, not `__proto__` / `constructor` / `prototype` |
| `host` | optional, must be `127.0.0.1` |
| `port` | integer 1–65535 |
| `allow` | optional array of client public keys; `"*"` means any authenticated client |
| `defaultTarget` | must name an existing target |

If `targets` is absent, the loader creates:

```json
{ "targets": { "default": { "host": "127.0.0.1", "port": <targetPort> } },
  "defaultTarget": "default" }
```

so every existing config keeps working unchanged.

---

## 3. Wire protocol

The client adds one optional field to the SCRAM proof message:

```json
{ "v": 3, "mode": "pwd", "clientNonce": "...", "proof": "...", "target": "web" }
```

Server handling:

1. verify the SCRAM proof as before
2. resolve `target` against the server-side map (`defaultTarget` when absent)
3. enforce `allow` for that target against the client public key
4. reply with success plus the resolved target

```json
{ "v": 3, "ok": true, "serverSig": "...",
  "target": { "name": "web", "host": "127.0.0.1", "port": 8080 } }
```

On failure the server replies before success:

```json
{ "v": 3, "ok": false, "error": "TARGET_UNKNOWN" }
{ "v": 3, "ok": false, "error": "TARGET_FORBIDDEN" }
```

These do **not** increment the lockout counter: they are authorisation
decisions, not credential guesses.

`AUTH_VERSION` stays at 3. Old clients omit `target` and therefore get
`defaultTarget`; old servers ignore the extra field only if they never receive
it, which is why the field is optional in both directions.

---

## 4. Client surface

```sh
p2pgate connect --target web            # persist into client.json
p2pgate client  --target web            # one run only
```

- `--target` is validated client-side with the same name regex.
- `connect` stores the value in `~/.p2pgate/client.json` so later runs reuse it.
- The client logs the resolved target after authentication:

  ```text
  TARGET web -> 127.0.0.1:8080
  TUNNEL established slot=... serverKey=... target=web
  ```

- The local listener port stays independent (`--port`), because it belongs to
  the client machine.

---

## 5. Server surface

- `FORWARD client=... slot=... target=web -> 127.0.0.1:8080`
- `AUTH OK client=... method=pwd target=web`
- `status --json` adds `targets: ["default","web"]` and `defaultTarget`
- `status`/Telegram startup text reports the default target port
- `p2pgate server --port <n>` overrides the **default** target for that run only

---

## 6. Security model

| Risk | Mitigation |
|---|---|
| Client requests an arbitrary address | Clients send a name only; unknown names are rejected |
| Client reaches a service it should not | Optional per-target `allow` list |
| Prototype pollution via target name | Names validated; map is a `Map` on the server |
| Forwarding to a remote host | `host` must be `127.0.0.1` |
| Target probing reveals inventory | Unknown and forbidden both return an error, no service contact |
| Tunnels opened by unauthorised keys | Existing auth (SCRAM/password/trusted) still runs first |

Invariant kept: p2pgate never forwards outside `127.0.0.1`. Reaching a LAN host
would require an explicit local relay, which this phase deliberately omits.

---

## 7. Backward compatibility

| Combination | Result |
|---|---|
| v1.7 client → v1.7 server | full target routing |
| v1.6 client → v1.7 server | no `target` field → `defaultTarget` |
| v1.7 client → v1.6 server | server ignores/declines the extra field: the server reads `mode`/`proof` only, so the connection still authenticates as the single target (field is unused) |
| Config without `targets` | synthetic `default` target |

If an older server ever rejects the extra field, the client falls back through
its normal error path; no silent wrong-target routing is possible because the
server always answers which target it selected.

---

## 8. Acceptance tests

Added to `src/self-test.js` (41 checks total):

1. `multi-target routing reaches the selected service` — two echo servers with
   distinct banners; `--target web` reads the web banner
2. `unknown target is rejected without touching the default target`
3. `per-target allowlist rejects a client key`
4. `a client without a target still uses the default target`

Manual verification (Windows + Termux): `connect --target web` prints
`TARGET web -> 127.0.0.1:8080` and the client-side banner comes from the web
target, while the default target still answers on the plain path.

---

## 9. Open questions for the next phase

1. SOCKS5 (`--socks5`) with a server-side allowlist of `host:port`
2. Multiple targets in one client process (`--target web,db`)
3. Per-target `verificationMode` overrides
4. Audit filtering/search by target
