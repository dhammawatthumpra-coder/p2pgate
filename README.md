# p2pgate (v1.4)

**English** | [ไทย](README.th.md)

A small peer-to-peer TCP tunnel for reaching SSH on a device behind CGNAT or a
firewall without exposing an inbound port. It combines **mutual SCRAM**,
**verification policy modes**, a **dual-source device registry**, and a
**local control plane**.

Designed for **Redmi 14C (Android 14, Termux)**, but works on Windows, macOS,
Linux, and other Android devices with Node.js 20 or newer.

> Version 1.4 adds a local control socket (`status`, `pin`, `revoke`),
> the `doctor` command, and mandatory expiry (or explicit `--permanent`)
> for trusted devices.
> **Update both Server and Client to v1.4** to use the full command set.
> The tunnel/auth protocol remains compatible with v1.3.
>
> Manual testing guide (Thai): [`TESTING.md`](TESTING.md)

---

## What p2pgate does

```text
[PC / Mac / phone]
ssh -p 8022 localhost
        │
        ▼
  p2pgate client  ──── HyperDHT (UDP + encrypted + hole punching) ────►  p2pgate server
  (binds 127.0.0.1 only)                                                (Termux on phone)
                                                                              │
                                                                              │ 1) registry/policy
                                                                              │ 2) fast-path or SCRAM
                                                                              │ 3) verify serverSig
                                                                              ▼
                                                                       127.0.0.1:8022
                                                                           sshd
```

- No inbound SSH port exposed to the internet
- Client listens only on `127.0.0.1`
- Server checks public keys from **two sources**: `config.json` and
  `trusted_devices`
- **hybrid:** `trusted` devices use the fast path; others use two-step
- **key-only:** public key only; no PIN prompt
- **two-step:** PIN/password required every time, even for trusted devices
- Client connects first and asks for a PIN only when the Server requires
  two-step
- Local control socket for `status`, `pin`, and `revoke` without restarting
- `p2pgate doctor` checks the installation and prints actionable diagnostics
- Trusted devices must have an expiry or an explicit `--permanent`
- Progressive lockout: 3 attempts/15 minutes, 6/6 hours, 10/permanent
- `p2pgate unlock` restores access immediately
- Exactly one external dependency: `hyperdht`

---

## 1) Verification modes

Configure in `config.json`:

```json
"verificationMode": "hybrid"
```

| Mode | Default | Behavior |
|---|---|---|
| `hybrid` | Yes | `trusted` devices use the fast path; `scram` devices use two-step |
| `key-only` | No | Public key only; no Session PIN and no PIN prompt |
| `two-step` | No | Public key plus PIN/password on every connection |

### hybrid

- A device registered as `trusted` in `trusted_devices` and not expired starts
  a session immediately after the public-key check
- Devices from `config.json`, or devices with the `scram` profile, require
  two-step verification
- If the Server runs without a terminal and has no Unattended Password,
  two-step devices are declined, but trusted devices can still use the fast path

### key-only

- Suitable for automation or a Server running in the background
- Every registered, non-expired key uses the fast path
- **No Session PIN is created** and no PIN is requested
- Protect the client key file carefully because there is no second factor

### two-step

- Requires both the public key and PIN/password on every connection
- The `trusted` profile in `trusted_devices` is not used as a fast path
- Best for environments that need the strictest policy

> A v1.2 config without `verificationMode` is treated as `hybrid`.
> A legacy config with `authPin.enabled: false` is treated as `key-only`.

---

## 2) Dual-source device registry

The Server merges devices from:

1. `allowedClientKeys` in `config.json` (implicit `scram` profile)
2. The `trusted_devices` file (default `~/.p2pgate/trusted_devices`)

Set the path in `config.json`:

```json
"trustedDevicesFile": "~/.p2pgate/trusted_devices"
```

### File format

```text
# Blank lines and lines starting with # are ignored
trusted <64-char-hex-public-key> primary-workstation
trusted,expires=2026-12-31T23:59:59Z <64-char-hex-public-key> contractor-laptop
scram <64-char-hex-public-key> shared-terminal
<64-char-hex-public-key> legacy-default-two-step-client
```

- A line without options uses the `scram` profile
- `trusted` means fast path under `hybrid` (and every key under `key-only`)
- `scram` means two-step
- `expires=` must be ISO-8601 with a timezone, for example `...Z`
- The label is the remaining text on the line

### Precedence

- Key only in `config.json` → `scram` profile
- Key only in `trusted_devices` → use the file's profile and expiry
- Key in both and the file entry is active → `trusted_devices` wins
- Key in the file but **expired** → declined, even if it is still in
  `config.json`

### File permissions (POSIX)

Before using the fast path, the Server verifies that `trusted_devices`:

- Is a regular file, not a symlink
- Is owned by the current user
- Has no group/other permissions (`chmod 600` or stricter)

If permissions are insecure:

- `hybrid`: `trusted` entries cannot use the fast path (two-step required)
- `key-only`: entries from the file are declined
- `two-step`: two-step is still required as usual

### Live reload

The Server watches the `mtimeMs` of `trusted_devices` and reloads it when the
file changes, without a restart. Prefer editing it through
`p2pgate devices add/remove`, which writes atomically.

---

## 3) Deferred client input

The Client **connects first** and waits for a status frame from the Server:

| Status | Meaning | Client behavior |
|---|---|---|
| `FASTPATH_READY` | Device uses the fast path | No PIN prompt; start sending data |
| `CHALLENGE_REQUIRED` | Two-step required | Read PIN/password, then run SCRAM |
| `DECLINED` | Unlisted, expired, or suspended | Show the reason and close the connection |

- The Client no longer asks for a PIN before connecting
- Fast-path and key-only sessions never prompt for a PIN
- `--pin-stdin` reads stdin **only when challenged** (it does not block the
  fast path)
- `P2PGATE_PIN` is removed from the process environment immediately after the
  Client reads it at startup

After `CHALLENGE_REQUIRED`, the Client sends `READY`. The Server then sends the
SCRAM challenge and starts the 10-second authentication timeout.

---

## 4) Session PIN and Unattended Password

### Session PIN

- 10 characters from the Base32 alphabet:
  `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`
- Displayed as `XXXXX-XXXXX` in an ASCII box on an interactive terminal
- Kept in memory only; never written to config, logs, or disk
- Rotated after 3 or 6 failed attempts (with a new salt each time)
- **key-only does not create a Session PIN**
- A headless Server does not display the PIN; use the fast path, key-only, or
  an Unattended Password

### Unattended Password

- At least 12 characters
- Case-sensitive
- Works with `hybrid`/`two-step` even when the Server has no terminal
- Only the SCRAM verifier is stored (`saltHex`, `storedKeyHex`, `serverKeyHex`)
- Configure it through `p2pgate setup`

```json
"authPin": {
  "enabled": true,
  "unattended": {
    "saltHex": "...",
    "storedKeyHex": "...",
    "serverKeyHex": "..."
  }
}
```

If not configured, the value is `"unattended": null`.

---

## 5) Client credential input

Priority order:

1. `--pin-stdin` — read one line from stdin when the Server requires two-step
2. `P2PGATE_PIN` — environment variable (removed from the process immediately)
3. Hidden prompt — default

> There is no `--pin` flag, so passwords do not appear in `ps` or shell history.
>
> Avoid inline `P2PGATE_PIN=... p2pgate client`; use a hidden prompt or
> `--pin-stdin` from a protected file.

Termux/Linux example:

```sh
install -m 600 /dev/null ~/.p2pgate/pin.txt
nano ~/.p2pgate/pin.txt
p2pgate client --pin-stdin < ~/.p2pgate/pin.txt
```

Windows PowerShell:

```powershell
Get-Content .\pin.txt | p2pgate client --pin-stdin
```

Environment variable example:

```sh
export P2PGATE_PIN='...'
p2pgate client
unset P2PGATE_PIN
```

---

## 6) Progressive lockout and `unlock`

Failures are counted per public key within a 24-hour window:

| Failures | Result |
|---|---|
| 3 | Suspend for 15 minutes + rotate the Session PIN |
| 6 | Suspend for 6 hours + rotate the Session PIN |
| 10 | Permanent suspension |

- Invalid responses are delayed by 2.5–3.5 seconds
- Concurrent verification is limited to 1 per key and 3 in total
- State is stored in `~/.p2pgate/lockout-state.json` with mode `0600`
- Uses a lockfile, atomic rename, and mtime reload
- `p2pgate unlock` affects a running Server immediately

```sh
p2pgate unlock --list
p2pgate unlock <clientPublicKeyHex>
p2pgate unlock --all
```

---

## 7) Device management CLI

```sh
p2pgate devices list
p2pgate devices add <publicKeyHex> --mode trusted \
  --expires 2026-12-31T23:59:59Z --comment "contractor"
p2pgate devices add <publicKeyHex> --mode trusted --permanent
p2pgate devices add <publicKeyHex> --mode scram --comment "shared-terminal"
p2pgate devices remove <publicKeyHex>
```

- `list` shows the merged registry: source, profile, expiry, and label
- `add`/`remove` update `trusted_devices` atomically
- `--mode` defaults to `scram`; use `--mode trusted` for the fast path
- `--expires` must be ISO-8601 with a timezone
- **`--mode trusted` requires either `--expires` or `--permanent`**
  - If neither is supplied, the command is rejected
  - If both are supplied, the command is rejected
  - `--permanent` is valid only for trusted devices
- The command warns that trusted devices bypass the PIN prompt
- `remove` warns if the key is still in `config.json` `allowedClientKeys`
- Use `--config <path>` to select a config file

> CLI output is currently in Thai. The sample below is translated.

```text
- aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  Source: config.json (allowedClientKeys)
  Profile: scram
  Expires: -
  Label: -
  Status: active
  Fast-path: no
```

---

## 8) Local control plane (`status` / `pin` / `revoke`)

Server v1.4 opens a **local control socket** so the owner can manage a running
Server without restarting it and without opening another TCP port.

### Socket location

| Platform | Location |
|---|---|
| Linux / macOS / Termux | `~/.p2pgate/control.sock` (mode `0600`, directory `0700`) |
| Windows | Named pipe `\\.\pipe\p2pgate-control-<hash>` |

- Same-user, same-machine access only
- The socket is removed on graceful shutdown
- A stale socket from a dead process is probed before removal
- If another live Server owns the socket, startup fails with `CONTROL_IN_USE`

### Commands

```sh
p2pgate status
p2pgate pin
p2pgate revoke <clientPublicKeyHex>
```

#### `p2pgate status`

Shows non-secret operational state:

- Verification mode
- Whether a Session PIN is available (never the PIN itself)
- Current slot and listening slots
- Registered device count
- Active connections and connected keys
- Cumulative blocked count
- Uptime, trusted-devices file, and control socket path

#### `p2pgate pin`

Requests the current Session PIN from Server memory over the control socket:

```text
=== Current Session PIN ===
   ABCDE-FGHJK
   generation: 1
```

- The PIN is never written to disk or logs
- `key-only` returns `NO_SESSION_PIN`
- If the Server is not running, the command tells you to start
  `p2pgate server`

#### `p2pgate revoke <key>`

- Permanently suspends the key (`reason: manual`)
- Immediately closes active connections for that key
- Future connections are declined
- If the Server is not running, the command persists the revocation directly
  to the lockout state; it takes effect when the Server reads the state

Restore access with:

```sh
p2pgate unlock <clientPublicKeyHex>
```

> `revoke` operates at the p2pgate layer. SSH sessions piped through the tunnel
> are closed with the stream. Check sshd separately if you need an OS-level
> session kill.

---

## 9) `p2pgate doctor`

A read-only diagnostic command. Output is currently in Thai with
`✅` / `⚠️` / `❌`.

```sh
p2pgate doctor
p2pgate doctor --config /path/to/config.json
```

It checks:

1. Node.js version (must be >= 20)
2. Config file exists, parses, and validates
3. `verificationMode` and related fields
4. Permissions of config, client key, trusted_devices, and lockout state
   - On Windows it reports that POSIX permission checks are skipped
5. Device registry: count, expired entries, trusted entries without expiry,
   file permissions, empty registry
6. Target: Server checks whether `127.0.0.1:<targetPort>` is listening;
   Client checks whether the local port is available
7. Control plane: queries `status` if the Server is running
8. Lockout state: suspended and revoked counts
9. Warning when a headless Server cannot expose a Session PIN
10. Client key presence and validity in Client mode

- Exit code `0` when there is no `❌`
- Exit code `1` when a critical check fails
- Never prints `masterSecret`, seeds, verifier values, or PINs

---

## 10) Requirements

- Android phone + Termux + Termux:Boot (F-Droid), optional
- Node.js 20 or newer
- OpenSSH on the Server and `ssh` on the Client
- Internet access that allows outbound UDP

---

## 11) Install on Termux (Redmi 14C)

```sh
pkg update && pkg upgrade -y
pkg install nodejs openssh nano procps -y
node -v
```

Copy the project to `~/p2pgate`, then:

```sh
cd ~/p2pgate
npm install --ignore-scripts --no-audit --no-fund
npm link --ignore-scripts
npm run check
npm run self-test
```

If a native prebuild is unavailable:

```sh
pkg install python build-essential -y
npm install --no-audit --no-fund
```

---

## 12) Harden SSH

```sh
passwd
sshd
```

Create an SSH key on the Client:

```sh
ssh-keygen -t ed25519
```

Add `id_ed25519.pub` to Termux:

```sh
mkdir -p ~/.ssh
nano ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

Disable password authentication:

```sh
nano $PREFIX/etc/ssh/sshd_config
```

```text
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
```

```sh
pkill sshd
sshd
ssh -p 8022 localhost
```

---

## 13) Server setup

```sh
cd ~/p2pgate
p2pgate setup
```

Choose `1) Server` and select a mode:

```text
1) hybrid (recommended)
2) key-only
3) two-step
```

- `hybrid`: trusted devices use the fast path; others use two-step
- `key-only`: no PIN prompt (and no unattended password prompt)
- `two-step`: PIN/password on every connection

Then:

1. Paste the Client public key
2. Configure an Unattended Password (except in key-only mode)
3. Save the config
4. Add trusted devices if needed:
   ```sh
   p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z --comment "laptop"
   ```
5. Start the Server:
   ```sh
   p2pgate server
   ```

In an interactive terminal with hybrid/two-step, the Session PIN is shown in a
box. In headless mode the PIN is not shown; use trusted fast-path or an
Unattended Password.

---

## 14) Client setup

```sh
cd p2pgate
npm install --ignore-scripts --no-audit --no-fund
npm link --ignore-scripts
p2pgate setup
```

Choose `2) Client`, paste the `masterSecret`, and set the local port.

Add the Client public key on the Server:

```sh
p2pgate setup
```

Or register it as a trusted device:

```sh
p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z --comment "my-pc"
```

Start the tunnel:

```sh
p2pgate client
```

- `FASTPATH_READY`: no PIN prompt
- `CHALLENGE_REQUIRED`: prompt for PIN/password in the Client terminal
- `DECLINED`: show the reason and close

Then open another terminal:

```sh
ssh -p 8022 localhost
```

---

## 15) Daily use

```sh
# Server
cd ~/p2pgate
p2pgate server

# Client
cd p2pgate
p2pgate client
ssh -p 8022 localhost
```

- Trusted devices under hybrid do not need a PIN
- `scram` devices need a PIN/password
- `key-only` never asks for a PIN
- `two-step` asks every time
- If the PIN rotates or the key is suspended, the Client reports it

---

## 16) Termux:Boot

```sh
mkdir -p ~/.termux/boot
cp ~/p2pgate/scripts/termux-boot.sh ~/.termux/boot/start-p2pgate.sh
chmod +x ~/.termux/boot/start-p2pgate.sh
```

- Set Termux battery usage to Unrestricted
- Open Termux:Boot at least once
- Reboot the device

Modes suitable for headless operation:

- `key-only` — no PIN
- `hybrid` + trusted devices — those devices use the fast path
- `hybrid`/`two-step` + Unattended Password

The Session PIN is never written to a file or log.

Log:

```sh
tail -f ~/.p2pgate/server.log
```

---

## 17) Telegram (optional)

1. Create a bot with `@BotFather`
2. Copy the Bot Token
3. Send one message to the bot
4. Read the Chat ID from `getUpdates`

Notifications are sent when:

- An unknown key attempts to connect (rate-limited to once per 60 seconds per
  key)
- 3 failed attempts → 15-minute suspension + PIN rotation
- 6 failed attempts → 6-hour suspension + PIN rotation
- 10 failed attempts → permanent suspension

Messages never contain the PIN or password.

---

## 18) Security

- **`masterSecret`** derives the hourly Server keys
- **`allowedClientKeys` + `trusted_devices`** form the registry
- **`hybrid`** gives the fast path only to trusted devices
- **`key-only`** has no PIN — protect the client key and registry carefully
- **`two-step`** is the strictest mode
- **Session PIN** lives in RAM only
- **Unattended Password** stores only a SCRAM verifier
- **SCRAM mutual authentication** verifies both the Client proof and the Server
  signature
- **No `--pin`** and `P2PGATE_PIN` is removed from the process environment
- **`trusted_devices`** must be owned by the user and `chmod 600`;
  insecure permissions disable the fast path
- **Progressive lockout:** 3/15m, 6/6h, 10/permanent
- **Control socket** is local-only (`0600` or a per-user named pipe)
  - The PIN is read from RAM and sent only over the socket
  - `revoke` closes active connections and persists a permanent suspension
  - There is no TCP listener for the control plane
- **Trusted devices** bypass the PIN, so they require an expiry or an explicit
  `--permanent`
- **Internal ports** bind to `127.0.0.1`
- **Config, key, lockout, and trusted_devices files** use mode `0600`
- **doctor** never prints secrets and never modifies files

> p2pgate does not replace all SSH security.
> It lets you reach SSH without exposing an inbound port to the public internet.

---

## 19) Command reference

| Command | Purpose |
|---|---|
| `p2pgate setup` | Configure and select a verification mode |
| `p2pgate keygen` | Create/show the Client key |
| `p2pgate server` | Start the Server |
| `p2pgate client` | Start the Client; ask for credentials only when required |
| `p2pgate client --pin-stdin` | Read a credential from stdin when challenged |
| `p2pgate devices list` | Show the merged registry |
| `p2pgate devices add <key> --mode trusted --expires ...` | Add a temporary trusted device |
| `p2pgate devices add <key> --mode trusted --permanent` | Add a permanent trusted device (explicit intent) |
| `p2pgate devices add <key> --mode scram` | Add a device that requires two-step |
| `p2pgate devices remove <key>` | Remove a device from trusted_devices |
| `p2pgate status` | Show Server status over the control socket |
| `p2pgate pin` | Request the Session PIN from a running Server |
| `p2pgate revoke <key>` | Revoke a key and close active connections |
| `p2pgate doctor` | Diagnose the installation and suggest fixes |
| `p2pgate unlock --list` | Show lockout/revocation state |
| `p2pgate unlock <key>` | Unlock one key |
| `p2pgate unlock --all` | Unlock all keys |
| `p2pgate help` | Show help |
| `npm run check` | Syntax check |
| `npm run self-test` | Test modes, registry, control, doctor, lockout, rotation |
| `npm test` | Run `check` + `self-test` |

Default files:

- Config: `~/.p2pgate/config.json`
- Client key: `~/.p2pgate/client-key.json`
- Trusted devices: `~/.p2pgate/trusted_devices`
- Lockout state: `~/.p2pgate/lockout-state.json`
- Control socket: `~/.p2pgate/control.sock` (Windows: named pipe)

---

## 20) Troubleshooting

### `STATUS_DECLINED`

- `unlisted`: key is not in the registry → `p2pgate devices list`
- `expired`: expired → update `--expires` or add it again
- `insecure_registry`: trusted_devices permissions are unsafe → `chmod 600`
- `interactive_unavailable`: headless Server with no terminal and no Unattended
  Password → use trusted fast-path, key-only, or set an Unattended Password
- `busy`: another verification is in progress → retry

### `p2pgate status` / `pin` does not work

- A Server must be running under the same user
- Check that `~/.p2pgate/control.sock` exists (Windows uses a named pipe)
- If the Server crashed and left a stale socket, start it again; the Server
  probes and removes an unowned socket
- `CONTROL_IN_USE` means another Server owns the socket; stop the old one first

### `revoke` does not stop a connection

- Run `p2pgate revoke <key>` against the running Server
- If the Server is not running, the command only persists state; it applies
  when the Server reads the state
- Check `p2pgate unlock --list` for
  "revoked by revoke command" status
- Restore with `p2pgate unlock <key>`

### `devices add --mode trusted` is rejected

Provide exactly one of:

```sh
p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z
p2pgate devices add <key> --mode trusted --permanent
```

If you use `--permanent`, review the list periodically with
`p2pgate devices list`.

### `doctor` shows ❌

Read the hint below the line, such as unsafe file permissions, an empty
registry, a missing Client key, or an invalid config. Fix it and rerun
`p2pgate doctor`. A `⚠️` warning does not change the exit code to 1.

### A trusted device does not use the fast path

- Check that `verificationMode` is `hybrid` or `key-only`
- Check that the file is `chmod 600` and owned by the current user
- Check that the entry is not expired
- Check that `config.json` is not overriding it (the file should win)
- Check that the Server reloaded the file (`devices list` / mtime)

### key-only does not ask for a PIN

This is expected for `key-only`. Use `hybrid` or `two-step` if you want a PIN.

### two-step asks for a PIN every time

This is expected. Even devices in `trusted_devices` do not use the fast path in
this mode.

### Client does not ask for a PIN

- No prompt is expected after `FASTPATH_READY` or in `key-only`
- To require a prompt, use `hybrid` with the `scram` profile, or `two-step`

### `PIN_REQUIRED`

The Client needs two-step but has no terminal, no `--pin-stdin`, and no
`P2PGATE_PIN`.

### `PIN_ROTATED_OR_INVALID`

- The PIN may have rotated after 3/6 failures or a Server restart
- Check the latest PIN on the Server console or use the Unattended Password

### `LOCKED_OUT`

```sh
p2pgate unlock --list
p2pgate unlock <clientPublicKeyHex>
p2pgate unlock --all
```

### `AUTH_CONFIG_UPGRADE_REQUIRED`

A v1.1 config was found. Run:

```sh
p2pgate setup
```

### Is a v1.2 config still supported?

Yes. Without `verificationMode` it is treated as `hybrid`. If
`authPin.enabled: false`, it is treated as `key-only`.

### `PEER_NOT_FOUND`

- Check that the Server is running
- Check that `masterSecret` matches
- Check the registry/public key
- Check UDP connectivity
- The Client automatically tries the previous hour's slot

### `EADDRINUSE`

```sh
p2pgate client --port 8023
ssh -p 8023 localhost
```

### SSH `Permission denied (publickey)`

- Check `~/.ssh/authorized_keys` and its permissions
- Check `PasswordAuthentication no` and restart sshd

---

## 21) Project structure

```text
p2pgate/
├── .github/
│   └── workflows/
│       └── ci.yml
├── .editorconfig
├── .gitattributes
├── .gitignore
├── .npmrc
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
├── LICENSE
├── NOTICE
├── README.md
├── README.th.md
├── TESTING.md
├── config.example.json
├── docs/
│   ├── README.md
│   ├── releases/
│   │   └── v1.4.0.md
│   └── specs/
│       ├── phase2-v1.1.md
│       ├── phase3-v1.2.md
│       ├── phase4-v1.3.0.md
│       ├── phase5-v1.4.0.md
│       └── project-spec.md
├── package.json
├── package-lock.json
├── scripts/
│   └── termux-boot.sh
└── src/
    ├── cli.js
    ├── auth.js
    ├── auth-guard.js
    ├── device-registry.js
    ├── control.js
    ├── doctor.js
    ├── config-loader.js
    ├── crypto-utils.js
    ├── keygen.js
    ├── setup-wizard.js
    ├── server.js
    ├── client.js
    └── self-test.js
```

### Development and CI

- Manual testing guide (Thai): [`TESTING.md`](TESTING.md)
- Version history: [`CHANGELOG.md`](CHANGELOG.md)
- Contribution guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security policy: [`SECURITY.md`](SECURITY.md)
- The GitHub Actions workflow (`.github/workflows/ci.yml`) runs
  `npm ci --ignore-scripts`, `npm run check`, and `npm run self-test` on
  Ubuntu (Node 20/22/24), Windows (24), and macOS (24) when GitHub Actions
  is available for the account.
- Run the same checks locally before pushing:

```sh
npm test
```

---

## 22) Technical notes

- **Registry merge:** config keys = scram; file entries override; an expired
  file entry denies access
- **POSIX check:** symlink/owner/group-other permissions before the fast path
- **Live reload:** `mtimeMs` + atomic rename
- **Status frames v3:** `DECLINED`, `FASTPATH_READY`, `CHALLENGE_REQUIRED`,
  `READY`
- **Client READY:** sent after obtaining a credential so typing time is not
  counted against the 10-second timeout
- **Control protocol:** newline-delimited JSON, version `1`, max 4096 bytes,
  5-second timeout
- **Control commands:** `status`, `pin`, `revoke`
  - `status` never returns the PIN
  - `pin` reads from memory only
  - `revoke` calls `AuthGuard.revoke(key, 'manual')` and closes active streams
- **Control socket:** POSIX `0600`, Windows named pipe, stale-socket probe
  before removal
- **doctor:** read-only, exit 1 on `❌`, never prints secrets
- **Trusted expiry:** the CLI requires `--expires` or `--permanent`; existing
  file entries remain compatible
- **SCRAM:** mutual challenge/response with `serverSig` verification
- **Session PIN:** 10 Base32 characters, a new salt on every creation/rotation
- **Async scrypt:** `crypto.scrypt` (N=16384, r=8, p=1)
- **Lockout:** 24-hour failure window, lockfile, atomic rename, mtime reload
- **Concurrency:** 1 per key, 3 total
- **Invalid delay:** 2.5–3.5 seconds (the self-test uses shorter values)
- **No `P2PGATE_TEST_*` environment hooks**
- **Self-test:** uses `HyperDHT.bootstrapper` and injected clock/delay

---

## 23) License

p2pgate is licensed under the **Apache License 2.0**.

- [`LICENSE`](LICENSE)
- [`NOTICE`](NOTICE)

Copyright 2026 dhammawatthumpra-coder
