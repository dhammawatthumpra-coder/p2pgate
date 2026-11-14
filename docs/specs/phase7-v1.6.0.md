# Phase 7 Handoff Specification (`v1.6.0`)

## Zero-Setup Password Mode and One-Line Connect

Baseline: `p2pgate v1.5.0`

This phase changes the default onboarding from an interactive setup wizard to a
zero-setup server and a client that needs only `masterSecret + password`.

---

## 1. Goals

1. `p2pgate server` works on a fresh machine with **no setup**:
   - creates `~/.p2pgate/config.json`
   - generates `masterSecret`
   - generates a persistent connection password
   - stores only a SCRAM verifier
   - starts immediately
2. `p2pgate connect` works on a fresh client:
   - no `p2pgate setup`
   - prompts for `masterSecret` and password
   - generates the client key automatically
   - saves a client config for reuse
3. `p2pgate connect -s <masterSecret> -p <password>` supports one-line usage.
4. Add `authMode`:
   - `password`: unknown client keys may authenticate with the connection
     password
   - `registry`: existing key-whitelist behavior
5. Keep `p2pgate setup` for advanced configuration.
6. Add `P2PGATE_LANG=en|th` and `--lang`.

Non-goals:

- No new npm dependency.
- No change to the HyperDHT transport.
- No multi-target support.
- No password reset without a server restart in this phase.

---

## 2. Zero-Setup Server

When `p2pgate server` cannot find a config:

```text
generate masterSecret (32 random bytes, 64 hex)
generate connection password (24 Base32 characters)
derive SCRAM verifier
write config with:
  authMode: password
  allowedClientKeys: []
  verificationMode: hybrid
  authPin.unattended: <verifier>
  auditLog enabled
start Server
```

- If stdout is a TTY, print `masterSecret` and password once.
- If stdout is not a TTY, write credentials to
  `~/.p2pgate/quickstart.txt` with mode `0600` and log only the path.
- On subsequent starts, print `masterSecret` in an interactive terminal and
  remind the user that the password came from the first run; use
  `p2pgate password reset` to rotate it.
- `p2pgate password reset` updates the verifier in the config and prints the
  new password once. The running Server must be restarted.

---

## 3. Password Auth Mode

Config:

```json
{
  "authMode": "password",
  "authPin": {
    "enabled": true,
    "unattended": { "saltHex": "...", "storedKeyHex": "...", "serverKeyHex": "..." }
  }
}
```

Server behavior:

- Empty `allowedClientKeys` is valid.
- Unknown client keys receive `CHALLENGE_REQUIRED` instead of `DECLINED`.
- Successful SCRAM with the connection password returns `AUTH OK`.
- Registered `trusted` devices may still use fast-path.
- Registered `scram` devices are challenged.
- Suspended/revoked keys are still declined.
- If `authPin.unattended` is missing, startup fails with
  `PASSWORD_NOT_CONFIGURED`.

Existing configs without `authMode` and with non-empty `allowedClientKeys` are
treated as `registry`. This preserves v1.5 behavior.

---

## 4. Client Connect

```sh
p2pgate connect
p2pgate connect -s <masterSecret> -p <password>
```

- Client config: `~/.p2pgate/client.json`.
- Client key: `~/.p2pgate/client-key.json`, generated if missing.
- Password sources:
  1. `-p/--password`
  2. `--password-stdin`
  3. `P2PGATE_PASSWORD`
  4. hidden prompt
- masterSecret sources:
  1. `-s/--secret`
  2. `--secret-stdin`
  3. `P2PGATE_MASTER_SECRET`
  4. existing client config
  5. hidden prompt
- `-s` and `-p` values are visible in shell history/process lists; print a
  warning when `-p` is used.
- `--secret-stdin` and `--password-stdin` are mutually exclusive.

---

## 5. Language

- `P2PGATE_LANG=en|th`
- `--lang en|th`
- Fallback to `LANG`/`LC_ALL`, then `en`.
- New quickstart, setup, server, connect, and help strings are localized.
- Legacy command details are migrated incrementally.

---

## 6. Security

- Connection password: 24 Base32 characters, stored only as a verifier.
- Password mode accepts unknown keys; this is weaker than a registry.
- Password and masterSecret must not be written to audit logs.
- `quickstart.txt` is `0600` and should be deleted after copying.
- `p2pgate password reset` requires config access and restart.
- Registered trusted devices can be used for fast-path later.

---

## 7. Acceptance Tests

`npm test` must pass, including:

1. Password-mode server starts with an empty registry.
2. A previously unregistered client key authenticates with the password.
3. A wrong password is rejected and does not reach the target.
4. Existing registry mode still enforces the whitelist.
5. `p2pgate server` auto-creates config and credentials.
6. `p2pgate connect -s -p` starts a tunnel and echo works.
7. `password reset` writes a new verifier.
8. Setup easy mode still works.
9. `P2PGATE_LANG=en|th` changes setup/quickstart output.
