# Project Handoff Specification: `p2pgate`

## Role & Objective for AI Coding Agent
You are a Senior Security & Network Systems Engineer. Build a complete, production-ready, zero-bloat Peer-to-Peer TCP port tunneling CLI tool named **`p2pgate`** from scratch.

Do NOT leave placeholders, `TODO` comments, or partial implementations. Deliver every file listed below completely implemented, syntax-verified, and ready to run.

---

## 1. Project Context & Target Environments
- **Purpose:** Tunnel TCP traffic (primarily OpenSSH on port `8022`) across CGNAT/firewalls using decentralized UDP hole punching (`hyperdht`) with strict Zero-Trust security controls.
- **Server Host Environment:** Android 14 (Redmi 14C, `arm64`, non-root) running 24/7 inside **Termux** with Node.js LTS (`>=20.0.0`).
- **Client Environment:** Windows, macOS, Linux, or another Android Termux device with Node.js LTS (`>=20.0.0`).
- **User Persona:** The owner is a non-programmer who is security-conscious.
  - **Code & Identifiers:** English (clean, auditable CommonJS JavaScript).
  - **User-Facing Text (`README.md`, setup wizard prompts, CLI help, and error guidance):** Clear, polite, beginner-friendly **Thai language**.

---

## 2. Strict Dependency & Supply-Chain Policy (CRITICAL)
1. **Single External Dependency Only:** `dependencies` in `package.json` MUST contain **ONLY ONE** package: `hyperdht` pinned to an exact version (no `^` or `~`). Check npm for the latest stable `6.x` release (or use `"6.17.1"` if offline) and generate a clean `package-lock.json`.
2. **Zero Extra Packages:** Do NOT install `commander`, `yargs`, `chalk`, `colors`, `dotenv`, `axios`, `ws`, `prettier`, or any devDependencies.
3. **Built-in Node Modules Only:** Use standard `node:*` modules exclusively (`node:net`, `node:crypto`, `node:fs`, `node:fs/promises`, `node:path`, `node:os`, `node:readline/promises`, `node:util` with `parseArgs`).

---

## 3. Required Repository File Structure

```text
p2pgate/
├── .gitignore
├── .npmrc
├── package.json
├── config.example.json
├── README.md
├── scripts/
│   └── termux-boot.sh
└── src/
    ├── cli.js
    ├── config-loader.js
    ├── crypto-utils.js
    ├── keygen.js
    ├── setup-wizard.js
    ├── server.js
    └── client.js
```

### `package.json` Template
```json
{
  "name": "@private/p2pgate",
  "version": "1.0.0",
  "private": true,
  "description": "Minimal Zero-Trust P2P Gateway for Termux",
  "engines": {
    "node": ">=20.0.0"
  },
  "bin": {
    "p2pgate": "./src/cli.js"
  },
  "scripts": {
    "setup": "node src/cli.js setup",
    "keygen": "node src/cli.js keygen",
    "server": "node src/cli.js server",
    "client": "node src/cli.js client",
    "check": "node --check src/cli.js && node --check src/config-loader.js && node --check src/crypto-utils.js && node --check src/keygen.js && node --check src/setup-wizard.js && node --check src/server.js && node --check src/client.js"
  },
  "dependencies": {
    "hyperdht": "6.17.1"
  }
}
```

### `.npmrc` Requirements
```ini
save-exact=true
fund=false
audit=true
```

### `.gitignore` Requirements
Must ignore `node_modules/`, `config.json`, `*.key`, `*.secret`, `keys/`, `logs/`, and `.DS_Store` so private secrets are never accidentally committed.

---

## 4. Core Security & Architecture Specifications

### 4.1 Cryptographic Key & Rolling Seed Derivation (`src/crypto-utils.js`)
- **Master Secret Validation:** Require `masterSecret` to be a 64-character hex string (32 random bytes). Reject weak, short, or example values immediately.
- **Hourly Rolling Discovery Seed (Anti-Tracking on DHT):**
  - Compute the UTC hour slot: `slot = Math.floor(timestampMs / 3_600_000)`.
  - Derive a deterministic 32-byte seed for a given `slot` using Node's built-in `crypto.hkdfSync`:
    - Algorithm: `'sha256'`
    - IKM: `Buffer.from(masterSecret, 'hex')`
    - Salt: `Buffer.from('p2pgate-v1-rolling-slot', 'utf8')`
    - Info: `Buffer.from(`slot:${slot}`, 'utf8')`
    - Length: `32`
  - **IMPORTANT Node.js Caveat:** `crypto.hkdfSync` returns an `ArrayBuffer`. Convert it strictly via `Buffer.from(arrayBuffer)` before passing it to `HyperDHT.keyPair(seedBuffer)`.
- **Static Client Identity Keypair (`src/keygen.js`):**
  - Generate a random 32-byte seed via `crypto.randomBytes(32)`, derive `{ publicKey, secretKey }` using `HyperDHT.keyPair(seed)`, and save `{ seed: seed.toString('hex'), publicKey: publicKey.toString('hex'), createdAt }` to a local JSON keyfile (default `~/.p2pgate/client-key.json`) with `0o600` file permissions (`0o700` on `~/.p2pgate`).
  - Print the 64-char hex `publicKey` clearly so the user can add it to the server's `allowedClientKeys` array.

### 4.2 Protocol-Level Key Whitelist & Intrusion Alerting (`src/server.js`)
- **Protocol-Level Firewall:**
  - Normalize all entries in `config.allowedClientKeys` to lowercase 64-char hex strings in a `Set`. Fail startup if `allowedClientKeys` is empty.
  - Inside `dht.createServer({ firewall(remotePublicKey) { ... } }, onConnection)`:
    - Convert `remotePublicKey` to lowercase hex.
    - If `allowedSet.has(remoteHex)` is `false`:
      - Log the blocked attempt with ISO timestamp and remote public key hex.
      - Trigger asynchronous rate-limited intrusion notification (max 1 alert per 60 seconds per unknown key) if Telegram alerting is enabled in `config.json`.
      - Return `true` (`true` in `hyperdht` firewall means **deny/drop handshake** immediately before any TCP socket to `127.0.0.1` is opened).
    - If allowed, return `false` (`false` means **allow connection**).
- **Optional Telegram Intrusion Alert:**
  - In `config.json`, support optional `telegramAlert: { enabled: false, botToken: "", chatId: "" }`.
  - Use Node's native `fetch` with an `AbortSignal.timeout(5000)` to `https://api.telegram.org/bot<TOKEN>/sendMessage` on unauthorized attempts (and optionally on server startup). Never crash the server if `fetch` fails or offline.

### 4.3 Dual-Slot Graceful Hourly Rotation (`src/server.js`)
- **Clock-Skew Resilience:** At startup, listen simultaneously on **two** server keypairs:
  1. `currentSlot` (current UTC hour)
  2. `previousSlot` (`currentSlot - 1`)
- **Zero-Drop Rotation:** Check every 60 seconds if the UTC hour slot has advanced:
  - Start a new listener for the new `currentSlot`.
  - Keep `previousSlot` active.
  - For expired slots older than `currentSlot - 1`: stop accepting new DHT connections (`server.close()`), **while keeping any already-established encrypted stream / SSH session alive** until the user disconnects naturally (verify or decouple active socket forwarding from listener shutdown so ongoing SSH sessions never drop on the hour mark).

### 4.4 Strict Localhost Binding & Leak-Free Stream Piping (`src/server.js` & `src/client.js`)
- **Server Forwarding (`src/server.js`):**
  - Connect strictly to `127.0.0.1` and `config.targetPort` (default `8022`). Never allow arbitrary host forwarding unless explicitly `127.0.0.1`.
- **Client Listener (`src/client.js`):**
  - Bind the local TCP listener strictly to `127.0.0.1` on `config.localPort` (default `8022`) — NEVER `0.0.0.0`.
  - Initialize `new HyperDHT({ keyPair: clientKeyPair })`.
  - On each incoming local TCP connection to `127.0.0.1:localPort`:
    - Derive the expected server `publicKey` for `currentSlot` from `masterSecret`.
    - Attempt `dht.connect(serverPubKey, { keyPair: clientKeyPair })` with a connection timeout (e.g., 12 seconds).
    - If connecting to `currentSlot` times out or errors, automatically retry once against `currentSlot - 1` (handles slight clock drift around the top of the hour).
- **Stream Cleanup:**
  - Attach `error`, `end`, and `close` handlers on **both** the encrypted `HyperDHT` stream and the local `net.Socket` (or use `stream.pipeline` with proper error callbacks) so neither side ever throws an unhandled exception or leaks file descriptors over months of uptime.
  - Set `socket.setKeepAlive(true, 30_000)` on local TCP sockets.
  - Handle `SIGINT` and `SIGTERM` cleanly (`await dht.destroy()`).

### 4.5 Unified CLI & Interactive Setup Wizard (`src/cli.js` & `src/setup-wizard.js`)
- `src/cli.js` must start with `#!/usr/bin/env node` and support:
  - `p2pgate setup` — Interactive wizard (in clear Thai) asking whether this device is `1) Server (Termux)` or `2) Client (PC/Phone)`, auto-generating `masterSecret` (on Server) or asking to paste it (on Client), generating client keys if needed, and saving `~/.p2pgate/config.json` (or `./config.json` via `--config <path>`) with `0o600` permissions.
  - `p2pgate keygen` — Generates/displays the client keypair and prints the 64-char hex Public Key.
  - `p2pgate server [--config <path>]` — Starts the hardened P2P gateway server.
  - `p2pgate client [--config <path>] [--port <localPort>]` — Starts the local client tunnel listener.
  - `p2pgate help` — Prints concise usage instructions in Thai.

### 4.6 Termux Auto-Boot Script (`scripts/termux-boot.sh`)
Provide a ready-to-copy script for `~/.termux/boot/start-p2pgate.sh` that:
1. Uses `#!/data/data/com.termux/files/usr/bin/sh`
2. Acquires `termux-wake-lock`
3. Starts `sshd` if not running
4. Runs `p2pgate server` inside a background supervision loop (`while true; do ... sleep 5; done`) appending logs to `~/.p2pgate/server.log` with basic log size rotation so storage on the phone never fills up.

---

## 5. Configuration Schema (`config.example.json`)
```json
{
  "mode": "server",
  "masterSecret": "REPLACE_WITH_64_HEX_CHARS_GENERATED_BY_SETUP",
  "targetHost": "127.0.0.1",
  "targetPort": 8022,
  "localPort": 8022,
  "clientKeyPath": "~/.p2pgate/client-key.json",
  "allowedClientKeys": [
    "REPLACE_WITH_64_HEX_CLIENT_PUBLIC_KEY"
  ],
  "customBootstrap": [],
  "telegramAlert": {
    "enabled": false,
    "botToken": "",
    "chatId": ""
  }
}
```
*(Note: If `customBootstrap` is a non-empty array of `"host:port"` strings, pass `{ bootstrap: config.customBootstrap }` into `new HyperDHT(...)` so the user can optionally run fully private LAN/Intranet bootstrap nodes in the future.)*

---

## 6. Verification & Acceptance Criteria (Must Run Before Finishing)
Before completing the task, you MUST execute and verify:
1. `npm install --ignore-scripts` (or verify whether `hyperdht` prebuilds load cleanly without postinstall scripts; document exact Termux install flags in `README.md`).
2. `npm run check` to confirm zero syntax errors across all files.
3. Write and run a quick automated local smoke test (using a local in-memory `HyperDHT.bootstrapper` node so no external internet is required during testing) verifying:
   - Deterministic HKDF slot key derivation matches between client and server.
   - An unauthorized client keypair is **rejected** by the `firewall` hook.
   - An authorized client keypair **connects** and echoes TCP bytes end-to-end.
   *(Delete any temporary test artifacts or keep as a built-in `node src/self-test.js` using zero external test libraries.)*
4. Write `README.md` in clear, step-by-step **Thai** covering:
   - Installing on Redmi 14C (Termux) + locking down OpenSSH (`PasswordAuthentication no`).
   - Generating client keys on PC/Mac/Phone (`p2pgate keygen`) and adding the Public Key to Redmi 14C.
   - Connecting from anywhere (`p2pgate client` + `ssh -p 8022 localhost`).
   - Enabling auto-start with Termux:Boot.
