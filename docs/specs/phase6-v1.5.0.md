# Phase 6 Handoff Specification (`v1.5.0`)

## Auditability, Key Protection, and Automation

Baseline: `p2pgate v1.4.1`

This phase adds security and operability improvements without adding a new
external dependency. All functionality must use built-in Node.js modules plus
the existing `hyperdht` dependency.

---

## 1. Goals

1. Add a local **JSONL audit log** for authentication, control, and device
   management events.
2. Add **passphrase-protected client keys** (scrypt + AES-256-GCM) while keeping
   plaintext keys backward compatible.
3. Add machine-readable output:
   - `p2pgate status --json`
   - `p2pgate doctor --json`
4. Harden the local control plane:
   - require a per-server **control token** for every request
   - verify POSIX socket ownership/permissions
   - use the token as defense-in-depth on Windows named pipes
5. Show **lockout/revocation state** in `p2pgate devices list`.

Non-goals for this phase:

- No new npm dependencies.
- No protocol change to the HyperDHT tunnel or SCRAM handshake.
- No multi-target or per-key target policies (future phase).
- No master-secret rotation (future phase).
- No external audit/SIEM integration.

---

## 2. Versioning

- `package.json` version: `1.5.0`.
- `npm run check` includes any new source file.
- Control protocol version becomes `2`; Client and Server must both be v1.5.
- Tunnel/auth protocol remains compatible with v1.4.

---

## 3. Audit Log (`src/audit-log.js`)

### 3.1 Location and format

Default file: `~/.p2pgate/audit.log`, mode `0600`, parent `0700`.

One JSON object per line:

```json
{"ts":"2026-11-15T10:00:00.000Z","event":"auth.success","source":"server","key":"<hex>","mode":"pin"}
```

- Append-only.
- No PIN, password, master secret, seed, verifier, control token, or full
  key file content.
- Fields are limited to primitives; long strings are truncated.
- Writes are serialized and asynchronous; an audit failure must never block
  authentication or shutdown indefinitely.

### 3.2 Configuration

```json
"auditLog": {
  "enabled": true,
  "path": "~/.p2pgate/audit.log",
  "maxBytes": 5242880
}
```

- `enabled` defaults to `true`.
- `maxBytes` defaults to 5 MiB.
- Rotation keeps one previous file: `audit.log.1`.

### 3.3 Events

Server:

- `server.start`, `server.stop`
- `auth.fastpath`
- `auth.success` (`mode`: `pin` or `pwd`)
- `auth.failure` (`mode`, `attempts`, `locked`)
- `auth.declined` (`reason`)
- `control.revoke` (`key`, `closed`)
- `session.pin.rotate` (`generation`, `reason`)

CLI:

- `device.add`, `device.remove`
- `device.revoke` (offline fallback)
- `device.unlock`, `device.unlock_all`
- `device.revoke` may also be emitted by the Server as `control.revoke` when
  the control socket is used.

### 3.4 CLI and doctor

- `p2pgate doctor` checks audit file permissions and size.
- Do not print audit contents by default.

---

## 4. Passphrase-Protected Client Key

### 4.1 File format

Keep the existing plaintext format working:

```json
{ "seed": "<hex>", "publicKey": "<hex>", "createdAt": "..." }
```

Encrypted format (version `2`):

```json
{
  "version": 2,
  "encrypted": true,
  "publicKey": "<hex>",
  "createdAt": "...",
  "kdf": "scrypt",
  "kdfParams": { "N": 16384, "r": 8, "p": 1, "keylen": 32, "saltHex": "<hex>" },
  "cipher": "aes-256-gcm",
  "ivHex": "<hex>",
  "tagHex": "<hex>",
  "ciphertextHex": "<hex>"
}
```

- `publicKey` remains visible so `doctor` and `devices` can inspect metadata
  without decrypting.
- The seed is encrypted with AES-256-GCM.
- scrypt parameters match the existing auth implementation.

### 4.2 Key generation and migration

- `p2pgate keygen --passphrase`:
  - new key: prompt twice and write an encrypted key
  - existing plaintext key: prompt twice and encrypt it in place (same keypair)
  - existing encrypted key: prompt current passphrase, then new passphrase
- `p2pgate keygen --passphrase-stdin`:
  - read one line from stdin
  - only for creating a new key or encrypting an existing plaintext key
- Plaintext keys remain valid.
- Do not add a `--passphrase` command-line value.

### 4.3 Client loading

- `loadClientKey(keyPath, { passphrase })` must decrypt when needed.
- Missing passphrase:
  - interactive terminal: prompt hidden, up to 3 attempts
  - non-interactive: throw `KEY_PASSPHRASE_REQUIRED`
- Wrong passphrase: throw `KEY_PASSPHRASE_INVALID` after authentication tag
  failure; do not reveal whether the file or passphrase was wrong.
- `P2PGATE_KEY_PASSPHRASE` is read once and deleted from the environment.
- `--key-passphrase-stdin` is mutually exclusive with `--pin-stdin`.
- Plaintext keys do not require a passphrase.

### 4.4 Doctor

- Inspect key metadata without decrypting.
- Encrypted key: ✅.
- Plaintext key: ⚠️ recommend `p2pgate keygen --passphrase`.
- Never prompt for or print a passphrase.

---

## 5. JSON Output

### 5.1 `status --json`

- On success: print the control `status` response as JSON, including
  `"ok": true`, and exit `0`.
- On failure: print `{ "ok": false, "error": "...", "message": "..." }` and
  exit `1`.
- No Thai text on stdout in JSON mode.

### 5.2 `doctor --json`

```json
{
  "ok": false,
  "exitCode": 1,
  "summary": { "critical": 1, "warnings": 2 },
  "checks": [
    { "level": "ok|warn|error", "title": "...", "detail": "..." }
  ]
}
```

- `doctor` must not write human-readable progress to stdout in JSON mode.
- Exit code follows the critical check count.

---

## 6. Control Plane Hardening

### 6.1 Control token

- Generate a 32-byte random token per Server start.
- Store at `~/.p2pgate/control.token`, mode `0600`.
- Remove it on graceful shutdown.
- Every request includes the token.
- Server compares SHA-256 digests with `crypto.timingSafeEqual`.
- Missing/wrong token returns `UNAUTHORIZED` and does not execute the command.
- Control protocol version becomes `2`.

### 6.2 POSIX socket check

After listen, `lstat` the socket and require:

- socket type
- owner is the current user
- group/other permissions are zero

If the check fails, close the control server and fail startup with
`CONTROL_INSECURE`.

### 6.3 Windows

Node core cannot set a custom DACL on a libuv named pipe. The per-user token
file provides authentication in addition to the default pipe DACL. Document
this explicitly; do not claim DACL enforcement.

### 6.4 Doctor

`doctor` reads the token file for its control probe. It must never print the
token.

---

## 7. `devices list` Lockout State

For each merged device, print:

- lockout state: normal, suspended until, permanent, or manual revocation
- failures in the 24-hour window
- level

Implementation reads the default AuthGuard state without writing it.

---

## 8. Required Files

- `src/audit-log.js` (new)
- `src/config-loader.js` (auditLog)
- `src/server.js` (audit events, control token)
- `src/control.js` (protocol v2, token, POSIX check)
- `src/keygen.js` (encrypted key format)
- `src/client.js` (passphrase loading)
- `src/cli.js` (flags, JSON, audit, devices lockout)
- `src/doctor.js` (JSON, key metadata, audit check, token)
- `src/self-test.js` (new coverage)
- `config.example.json`
- `README.md`, `README.th.md`
- `CHANGELOG.md`
- `docs/specs/phase6-v1.5.0.md` (this file)

---

## 9. Acceptance Tests

`npm run check` and `npm test` must pass.

New self-test coverage:

1. Audit log writes valid JSONL, contains auth/control events, and never
   contains a PIN, password, seed, master secret, or control token.
2. Audit rotation moves the old file to `.1`.
3. Encrypted key round-trip with correct passphrase.
4. Wrong passphrase is rejected.
5. Plaintext key still loads.
6. Client connects using an encrypted key with a passphrase.
7. `status --json` is valid JSON and has `ok: true`.
8. `doctor --json` is valid JSON and respects exit codes.
9. Control request without/with wrong token is rejected.
10. Correct token works.
11. POSIX control socket has mode `0600` and correct owner (skip on Windows).
12. `devices list` shows normal/suspended/revoked states.

Manual tests:

- `p2pgate keygen --passphrase`
- `p2pgate client` with encrypted key
- `p2pgate client --key-passphrase-stdin`
- `p2pgate status --json`
- `p2pgate doctor --json`
- audit log contains no secrets

---

## 10. Security Requirements

- No secret is written to the audit log.
- The control token is never printed or included in status output.
- The token file is local-only and `0600`.
- Passphrases are never accepted as command-line arguments.
- Passphrase and PIN buffers are not logged.
- Audit failures are logged to the server log but never block auth.
- Existing v1.4 plaintext keys and configs remain compatible.
