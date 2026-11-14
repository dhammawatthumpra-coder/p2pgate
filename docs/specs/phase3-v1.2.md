# Phase 3 Upgrade Specification (v1.2 — Final): Mutual SCRAM Verification & Access Rate-Limiting

Upgrade the existing `p2pgate` codebase cleanly in-place from `v1.1` to **`v1.2`** (`"version": "1.2.0"` in `package.json`).

**Migration Rule:** Inspect the existing `v1.1` code first and upgrade the `"authPin"` verification logic and failed-attempt state management cleanly in-place so there are no duplicate configuration keys, conflicting CLI flags, or unused functions. Preserve all `v1.0` capabilities (`masterSecret` dual-slot hourly key rotation, `allowedClientKeys` connection filter, `127.0.0.1` localhost binding, and single external dependency policy).

---

## 1. Credential Modes, Async `scrypt`, & Verifier Storage (`src/crypto-utils.js` & `src/setup-wizard.js`)
1. **Standard Built-in Modules Only:** Use built-in `node:crypto` (asynchronous `crypto.scrypt` wrapped in a Promise so the Node.js event loop never stalls on Termux, plus `createHmac`, `createHash`, `randomBytes`, `timingSafeEqual`) and `node:readline`.
2. **Two Distinct Credential Options under `"authPin"` (Disambiguated by Length):**
   - **Dynamic Session PIN (Strictly 10 Characters, In-Memory Only):**
     - Generate a **10-character** uppercase Base32 code on server startup using unambiguous characters `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (`32^10` > `1.12e15` combinations), displayed clearly on the Termux console as `XXXXX-XXXXX` inside an ASCII box.
     - Keep the Session PIN strictly in memory; never write it to `config.json` or log files.
     - **Case-Insensitive Input Handling (Session PIN Mode Only):** When normalizing user input, if stripping `-` hyphens and spaces yields length `=== 10`, treat it as a Session PIN and convert `.toUpperCase()` so both `abcde-fghij` and `ABCDEFGHIJ` match cleanly.
   - **Optional Unattended Password (Strictly `>= 12` Characters):**
     - Configured via `p2pgate setup` with a strict minimum length of **12 characters** (never uppercase or strip characters from `>= 12` character passwords).
     - Store ONLY SCRAM-style verifier values derived via async `crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })`:
       - `clientKey = HMAC-SHA256(saltedPassword, "p2pgate-client")`
       - `storedKey = SHA256(clientKey)`
       - `serverKey = HMAC-SHA256(saltedPassword, "p2pgate-server")`
       - Save `{ "enabled": true, "unattended": { "saltHex": "...", "storedKeyHex": "...", "serverKeyHex": "..." } }` under `"authPin"` in `config.json` (or `null` if not configured). Add a code comment noting `saltHex` is scoped exclusively to `p2pgate` SCRAM verification and must never be reused elsewhere.
       - If an older `v1.1` hash format is detected in `config.json`, instruct the user in clear Thai to run `p2pgate setup` to update the configuration.
       - Derive the identical `{ saltHex, storedKey, serverKey }` structure in memory for the active 10-character Session PIN whenever generated or refreshed.

---

## 2. Mutual Challenge-Response Verification (`src/server.js` & `src/client.js`)
Perform mutual SCRAM verification over the encrypted stream before opening `net.createConnection` to `127.0.0.1:targetPort`:
1. **Verification Timeout & Frame Cap:** Set a 10-second total verification deadline and cap incoming JSON message size at 4096 bytes.
2. **Secure Client Credential Input (No `--pin` Flag):**
   - Remove/omit any `--pin` CLI flag so credentials never appear in `ps` process lists or shell history.
   - Support ONLY:
     a) Interactive hidden terminal prompt (no echo, default),
     b) `--pin-stdin` (reads one line from `stdin`),
     c) `P2PGATE_PIN` environment variable (immediately execute `delete process.env.P2PGATE_PIN` right after reading into process memory at startup).
   - Reject inputs whose length (after checking whether hyphen-stripped length is 10) is neither `10` (Session PIN) nor `>= 12` (Unattended Password) with a helpful Thai message.
3. **Step 1 (Server Challenge):** Generate a 32-byte random `serverNonce` and send newline-delimited JSON:
   `{ "v": 2, "nonce": "<serverNonceHex>", "pinSalt": "<sessionSaltHex>", "pwdSalt": "<unattendedSaltHexOrNull>" }`
4. **Step 2 (Client Single-Derivation Proof & RAM Caching):**
   - Based on input length (`10` => `"pin"` mode using `pinSalt`; `>= 12` => `"pwd"` mode using `pwdSalt`), run async `scrypt` **only once** for the matching mode! Cache the derived `{ clientKey, storedKey, serverKey }` in client RAM keyed by `saltHex` so subsequent SSH sessions reuse it without re-running `scrypt` unless the salt changes.
   - Build channel-bound `authMessage = serverNonceHex + ":" + clientNonceHex + ":" + clientPublicKeyHex`.
   - Compute `proof = clientKey XOR HMAC-SHA256(storedKey, authMessage)` and send:
     `{ "v": 2, "mode": "pin" | "pwd", "clientNonce": "<clientNonceHex>", "proof": "<hex>" }`.
5. **Step 3 (Server Check & Mutual Confirmation):**
   - Select the active Session PIN verifier (`mode === "pin"`) or Unattended Password verifier (`mode === "pwd"`). Recover `candidateClientKey = proof XOR HMAC-SHA256(storedKey, authMessage)` and check `crypto.timingSafeEqual(SHA256(candidateClientKey), storedKey)`.
   - When valid: clear non-suspended failure counters for that client key, reply `{ "ok": true, "serverSig": "<HMAC-SHA256(matchedServerKey, authMessage)>" }`, and connect to `127.0.0.1:targetPort`.
   - Client MUST verify `serverSig` using `crypto.timingSafeEqual` before piping local SSH traffic.
   - Differentiate error codes (`AUTH_FAILED`, `PIN_ROTATED_OR_INVALID`, `LOCKED_OUT`) and print clear Thai guidance on the client (explaining when the Session PIN may have refreshed on the server screen).

---

## 3. Access Rate-Limiting, Serialized PIN Refresh, & Live Sync (`src/auth-guard.js`)
Create a modular `src/auth-guard.js` integrated with `src/server.js`:
1. **Dependency-Injected Clock (For Fast Deterministic Testing Only):**
   - Accept `{ now = () => Date.now(), failDelayMs = [2500, 3500] }` in `AuthGuard` constructor options so `self-test.js` can simulate 15m / 6h / 24h windows in milliseconds. Do **NOT** add any `P2PGATE_TEST_*` environment variable hooks in production code.
2. **Concurrency Limit:** Allow at most **1 active verification request per `remotePublicKey`** and **3 total** across the server. Close additional simultaneous requests immediately.
3. **Response Delay on Invalid Input:** Wait a randomized **2,500–3,500 ms** (`failDelayMs`) before returning `{ "ok": false, "error": "..." }` and closing the stream.
4. **Serialized PIN Refresh & Persistent Progressive Lockout (`~/.p2pgate/lockout-state.json`):**
   - Persist failed-attempt records per `remotePublicKey` over a rolling 24-hour window in `~/.p2pgate/lockout-state.json` (`0o600` permissions).
   - Track file `mtimeMs` and re-read external changes before atomic temp-file rename writes so running `p2pgate unlock` from another Termux session takes effect immediately on a running server without restarting or overwriting state.
   - Maintain a monotonic `pinGeneration` counter / async serialization lock so concurrent failures never double-refresh the Session PIN:
     - **3 invalid attempts:** Suspend `remotePublicKey` for **15 minutes**, refresh & display a new 10-character Session PIN on the console, and send a Telegram notification if configured.
     - **6 invalid attempts:** Suspend `remotePublicKey` for **6 hours**, refresh the Session PIN again, and send a Telegram notification.
     - **10 invalid attempts:** Mark `remotePublicKey` as **`suspended: true`** in `lockout-state.json`. Check `authGuard.isSuspended(remoteHex)` inside `firewall(remotePublicKey)` for **instant rejection (zero artificial delay)**, and send a Telegram notification.
5. **Local Unlock Command (`src/cli.js`):**
   - Add `p2pgate unlock <clientPublicKeyHex>`, `p2pgate unlock --all`, and `p2pgate unlock --list` (displaying suspended status, 24h failure count, and remaining lockout timer in clear Thai).

---

## 4. Automated Checks & Thai Documentation (`self-test` & `README.md`)
1. Run `npm run check` to verify clean syntax across all modules.
2. Update `self-test` (using constructor-injected `now` and short `failDelayMs`) to verify:
   - Successful connection and TCP echo using the 10-character Session PIN (both uppercase with hyphen and lowercase without hyphen).
   - Successful connection and TCP echo using the `>= 12` character case-sensitive Unattended Password.
   - Invalid PIN handling (response delay applied and no local socket opened to `targetPort`).
   - 3 invalid attempts trigger the 15-minute suspension and Session PIN refresh (proving the old Session PIN is invalidated while the new Session PIN works for another authorized client).
   - 10 invalid attempts trigger persistent suspension across reloads, and live `unlock` restores access without restarting the server.
3. Update `README.md` in beginner-friendly **Thai** covering `v1.2`: 10-character Session PIN, Unattended Password setup, `--pin-stdin` / hidden prompt usage, progressive lockout rules, and unlocking via `p2pgate unlock --list` / `p2pgate unlock --all`.


# Final Approval — Start Implementing `v1.2` Now

All 8 implementation notes from your review are **approved**. Apply all 8 points strictly as you proposed, plus the 1 edge-case safeguard in item #2 below, and proceed directly to full code implementation and verification:

1. **Fresh `pinSalt` on Every Session PIN Refresh:** Generate a brand-new `crypto.randomBytes(16)` `pinSalt` every time the Session PIN is initialized or refreshed so client RAM caches keyed by `saltHex` never serve stale keys.
2. **Hard-Reject `< 12` Chars in Setup & Disambiguate Hyphens Safely:**
   - Enforce `password.length >= 12` strictly inside `p2pgate setup` (reject length `< 12`, including `11`, immediately).
   - **Order of Length Check on Client:** Trim only leading/trailing newline/whitespace first. If `trimmed.length >= 12`, ALWAYS classify as `"pwd"` mode as-is (so a 12-char password containing hyphens is never misclassified as a 10-char PIN). Only when `trimmed.length === 10` OR (`trimmed.length === 11` matching `/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/`), strip `-` and `.toUpperCase()` as `"pin"` mode. Reject any other input length cleanly in Thai.
3. **Strict Default-Deny for Unconfigured `"pwd"` Mode:** If a client sends `mode: "pwd"` when `unattended` is `null` (not configured), apply the standard invalid-attempt accounting/delay and return `AUTH_FAILED` — never fall back to Session PIN.
4. **Explicit Credential Source Precedence:** Enforce `--pin-stdin` > `P2PGATE_PIN` (with immediate `delete process.env.P2PGATE_PIN`) > interactive hidden prompt, and document this order in `README.md`.
5. **Client `serverSig` Mismatch Handling:** Verify `serverSig` with `crypto.timingSafeEqual` against the cached `serverKey`; on mismatch, clear the RAM cache immediately and abort before piping local traffic.
6. **Self-Test Coverage for PIN Invalidation:** Include the two-client test case (Client A fails 3 times -> Session PIN & `pinSalt` refresh -> Client B with old PIN fails -> Client B with new Session PIN succeeds).
7. **Safe Concurrent State File Updates:** Use an exclusive lockfile (`fs.open(..., 'wx')` with short retry loop and stale-lock cleanup) around re-read + atomic temp-file rename on `lockout-state.json`.
8. **Thai `README.md` Shell History Guidance:** Clearly advise users in Thai to use the default hidden prompt or `--pin-stdin` instead of inline `P2PGATE_PIN=...` commands to avoid shell history exposure.

Write all updated/new files completely now, run `npm run check` and `npm run self-test`, and show the verification output when complete.
