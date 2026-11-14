# Phase 5 Handoff Specification (`v1.4.0`)

## Local Control Plane, Doctor, and Safer Trusted Devices

Baseline: `p2pgate v1.3.0`

This phase adds live local management without introducing any new external
dependency. All functionality must use built-in Node.js modules plus the
existing `hyperdht` dependency.

---

## 1. Goals

1. Add a **local control socket** for a running server so the owner can:
   - inspect live status,
   - retrieve the current in-memory Session PIN without writing it to disk,
   - revoke a client key and terminate its active tunnels immediately.
2. Add `p2pgate doctor` to diagnose common installation, permission,
   configuration, registry, sshd, and control-plane problems in Thai.
3. Make `trusted` devices safer by requiring an explicit expiration (or an
   explicit `--permanent`) when adding them through the CLI.
4. Update the self-test and Thai README for `v1.4.0`.

Non-goals for this phase:

- No external dependencies.
- No change to the SCRAM challenge/response protocol.
- No change to the `trusted_devices` on-disk format.
- No master-secret rotation (future phase).
- No cloud/remote control plane.

---

## 2. Versioning

- `package.json` version: `1.4.0`.
- `npm run check` must include every source file.
- Server and Client must both be v1.4.0 for the full CLI feature set.
  The core tunnel/auth protocol remains compatible with v1.3.0.

---

## 3. Local Control Socket (`src/control.js`)

### 3.1 Location and permissions

- POSIX: `~/.p2pgate/control.sock`
- Windows: named pipe `\\.\pipe\p2pgate-control-<home-hash>`
- Configurable through `startServer()` option `controlSocketPath`
  (used by tests).
- POSIX socket mode MUST be `0600`; parent directory `0700`.
- The socket MUST be removed on graceful server shutdown.
- A stale socket from a crashed server MUST be detected and removed only after
  a connection probe confirms no live server is listening.

### 3.2 Protocol

One newline-delimited JSON request and one newline-delimited JSON response per
connection. Maximum request size: 4096 bytes. Request timeout: 5 seconds.

Request:

```json
{ "v": 1, "cmd": "status" }
{ "v": 1, "cmd": "pin" }
{ "v": 1, "cmd": "revoke", "key": "<64-char-hex>" }
```

Response:

```json
{ "ok": true, ... }
{ "ok": false, "error": "CODE", "message": "..." }
```

### 3.3 `status`

Returns non-secret operational state:

- `verificationMode`
- `currentSlot`
- `listeningSlots`
- `sessionGeneration`
- `sessionPinAvailable` (boolean, never the PIN)
- `interactive`
- `registrySize`
- `blockedCount`
- `activeConnections`
- `uptimeMs`
- `trustedDevicesFile`
- `controlSocketPath`

### 3.4 `pin`

Returns the current Session PIN only when a challenge-based mode is active:

```json
{ "ok": true, "pin": "<10-char>", "formatted": "XXXXX-XXXXX", "generation": 1 }
```

- In `key-only`, return `NO_SESSION_PIN`.
- The PIN MUST be read from server memory and sent only over the local control
  socket. It MUST NOT be written to a file, log, or DHT.

### 3.5 `revoke`

- Validate the 64-char hex key.
- Permanently suspend the key in the AuthGuard state with reason `manual`.
- Terminate all active tunnels whose `remoteKey` matches.
- Return the number of closed connections.
- The key can be restored with `p2pgate unlock <key>`.

### 3.6 Server integration

- Track `entry.remoteKey` for every active/auth connection.
- Start the control server as part of `startServer()`.
- Close and unlink the control socket during `server.close()`.
- If another live server owns the socket, fail startup with a clear code
  (`CONTROL_IN_USE`).
- Self-test must use a unique temporary `controlSocketPath` per server.

---

## 4. CLI Control Commands (`src/cli.js`)

Add:

```sh
p2pgate status
p2pgate pin
p2pgate revoke <clientPublicKeyHex>
```

- `status`: print mode, slots, sessions, registry size, control state in Thai.
- `pin`: show the current formatted PIN or a Thai explanation in key-only mode.
- `revoke`:
  - Try the live control socket first.
  - If the server is not running, persist a manual suspension directly via
    `AuthGuard.revoke()` and explain that future connections are blocked.
- All commands accept `--config <path>` where a config is needed.
- Never print the master secret, verifier, or other secrets.

---

## 5. AuthGuard Manual Revocation

Add `AuthGuard.revoke(keyHex, reason = 'manual')`:

- Acquire the state-file lock.
- Re-read external state.
- Set `suspended: true`, `suspendedUntil: 0`, `revoked: true`,
  `reason: 'manual'`, `updatedAt`.
- Preserve existing failure history.
- `getStatus()` must expose `revoked` and `reason`.
- `unlock()` clears it.
- `unlock --list` must show manual revocation distinctly in Thai.

---

## 6. `p2pgate doctor` (`src/doctor.js`)

Read-only diagnostic command. Must print Thai with ✅ / ⚠️ / ❌ and actionable
hints. Must not print secrets.

Checks:

1. Node.js version >= 20.
2. Config file exists, parses, and validates.
3. `verificationMode` and related fields are valid.
4. Config, client key, trusted_devices, and lockout state permissions:
   - POSIX: owner-only, regular file, no group/other permissions.
   - Windows: report that POSIX checks are skipped.
5. Device registry:
   - number of devices,
   - expired entries,
   - trusted entries without expiration,
   - insecure `trusted_devices` permissions,
   - empty registry.
6. Server target:
   - server mode: attempt TCP connect to `127.0.0.1:targetPort` and report
     whether a local service (expected: sshd) is listening.
   - client mode: report whether the local port is available.
7. Control plane:
   - if the server is running, query `status`;
   - otherwise report that live status is unavailable.
8. Lockout state: count suspended/revoked keys.
9. Session-PIN visibility warning:
   - challenge mode + non-interactive server + no unattended verifier and no
     useful trusted fast-path devices -> warn to use key-only/trusted/password.
10. Client key presence and validity for client mode.

Exit code: `0` if no ❌ checks, `1` if any critical check fails.

---

## 7. Trusted Device Expiration Enforcement

In `p2pgate devices add`:

- `--mode trusted` requires either:
  - `--expires <ISO-8601-with-timezone>`, or
  - `--permanent`.
- If both are supplied, reject.
- If neither is supplied, reject with a Thai explanation.
- `--permanent` is valid only with `--mode trusted`.
- Print a warning when adding a trusted device because it bypasses PIN checks.
- Existing permanent trusted entries in the file remain valid for backward
  compatibility; `doctor` should warn about them.
- `devices list` continues to show the profile and expiration.

---

## 8. Required Files

- `src/control.js` (new)
- `src/doctor.js` (new)
- `src/auth-guard.js` (manual revoke)
- `src/server.js` (control integration, remote key tracking)
- `src/cli.js` (status/pin/revoke/doctor, trusted enforcement)
- `src/self-test.js` (control, revoke, doctor coverage)
- `package.json` (version/check)
- `README.md` (Thai v1.4)
- `phase5.md` (this file)

---

## 9. Automated Acceptance Tests

`npm run check` and `npm run self-test` must pass.

Self-test additions:

1. Control `status` returns `verificationMode`, registry size, and slots.
2. Control `pin` returns the same PIN as the running server in hybrid mode.
3. Control `pin` returns `NO_SESSION_PIN` in key-only mode.
4. Control `revoke`:
   - closes an active fast-path tunnel,
   - prevents the same key from reconnecting,
   - can be restored with `unlock`.
5. Control socket file is removed on server close.
6. `doctor` returns structured checks and does not crash with a missing
   control socket or missing sshd.
7. `devices add --mode trusted` without `--expires`/`--permanent` is rejected.

Manual CLI tests:

- `p2pgate status`
- `p2pgate pin`
- `p2pgate revoke <key>`
- `p2pgate doctor`
- `p2pgate devices add <key> --mode trusted` (rejected)
- `p2pgate devices add <key> --mode trusted --permanent` (accepted)

---

## 10. Security Requirements

- Control socket is same-user local-only; no TCP listener.
- No PIN/secret in logs, config, or command-line arguments.
- Revoke closes active streams immediately and persists the block.
- Doctor never prints masterSecret, seeds, verifier values, or PINs.
- Stale control sockets are not blindly trusted.
- Existing v1.3 tunnel/auth behavior remains unchanged.
