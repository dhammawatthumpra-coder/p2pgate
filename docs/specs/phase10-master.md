# Phase 10 — masterSecret rotation

**Status:** implemented in v1.8.3
**Baseline:** `p2pgate v1.8.2`

---

## 1. Why

`masterSecret` derives the Server's DHT identity (`serverKey`, slot keys) and the
channel key. Until v1.8.2 rotating it meant editing `config.json` by hand and
hoping the client side was updated too. That is error-prone:

- no backup of the previous config
- no confirmation step
- typos produced invalid values (`assertMasterSecret` failed later, not at edit)
- no audit trail

---

## 2. Commands

```sh
p2pgate master show [--reveal] [--json]
p2pgate master reset [--yes] [--dry-run] [--json]
```

### `show`

- default output is a 12-hex fingerprint:
  `sha256(masterSecret)[0:12]`
- `--reveal` prints the full 64-hex value
- works for server and client configs

### `reset`

1. load and validate the config
2. generate 32 random bytes → 64 hex (or use `--secret <hex>` internally)
3. copy the config to `<config>.bak-<ISO timestamp>` with mode `0600`
4. save through `saveConfig` so the file stays normalised
5. print the new value, the backup path, and mode-specific next steps
6. audit `master.reset` with fingerprints only

`--dry-run` performs steps 1–2 and reports the fingerprints and the would-be
backup path without touching the filesystem.

Confirmation:

- interactive TTY → asks for `yes`
- non-interactive → requires `--yes`, otherwise `CONFIRM_REQUIRED`

---

## 3. Semantics

| Field | Effect of rotation |
|---|---|
| `masterSecret` | new value |
| connection password / `authPin.unattended` | unchanged |
| `allowedClientKeys`, `trusted_devices` | unchanged |
| `targets`, `socks` | unchanged |
| Server DHT public key | changes (new slot keys) |
| Existing tunnels | keep running until they reconnect |

Client configs: no restart needed, the next connection uses the new value.
Server configs: restart required, otherwise the old identity stays in memory.

---

## 4. Safety rules

1. Never log the secret. Audit only fingerprints.
2. Always keep a backup before writing; refuse if the backup cannot be written.
3. Refuse when the new value equals the old one (`MASTER_SECRET_UNCHANGED`).
4. Validate length/charset before writing (`MASTER_SECRET_INVALID`).
5. Remind the operator that every Client must be updated — this is printed, not
   assumed.

---

## 5. Tests

`npm test` includes:

- `masterSecret rotation writes a backup and keeps other fields`

Manual check:

```text
p2pgate master show              → masterSecret fingerprint: a8ae6e6ee929
p2pgate master reset --dry-run   → dryRun: true, backupPath: null
p2pgate master reset --yes       → new value printed, backup file created
p2pgate master show --reveal     → matches the value printed by reset
```

---

## 6. Future

- `p2pgate master reset --all-clients` once `p2phub` can distribute secrets
- rotation reminders in `doctor` (age of the current secret)
