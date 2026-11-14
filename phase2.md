# Phase 2 Upgrade Specification (`v1.1`): Challenge-Response Access PIN / Password Layer

Keep all existing `v1.0` security controls (`masterSecret` hourly rolling slots + `allowedClientKeys` protocol firewall) intact, and add an **application-layer Challenge-Response Password/PIN gate** BEFORE piping traffic to `127.0.0.1:targetPort`.

## Requirements:
1. **Zero Extra Dependencies:** Continue using ONLY built-in `node:crypto` and `node:readline`.
2. **Server Password Modes (`src/server.js` & `config.json`):**
   - Add `"authPin": { "enabled": true, "unattendedPasswordHash": "" }` to config.
   - Every time `p2pgate server` starts, generate a random 8-character alphanumeric **Session PIN** (excluding ambiguous chars `0,O,1,I,l`) and display it clearly in a box on the Termux console (NEVER send it to DHT or logs).
   - Also allow an optional permanent **Unattended Password** configured via `p2pgate setup` (stored ONLY as a salted `crypto.scryptSync` hash in `config.json`, never plaintext) so the owner can still connect when away from home.
3. **Zero-Plaintext Challenge-Response Handshake:**
   - When an authorized client connects over the encrypted `HyperDHT` stream, DO NOT connect to `127.0.0.1:targetPort` yet.
   - Server sends a 32-byte random `nonce` with a 10-second authentication timeout.
   - Client prompts the user interactively for the PIN/Password (hidden input, or reads from `--pin` / env `P2PGATE_PIN` once at startup and caches in memory for that `p2pgate client` session so multiple SSH tabs work smoothly) and sends `HMAC-SHA256(nonce, pinOrPassword)`.
   - Server verifies the HMAC against the active Session PIN (or verifies via a secondary scrypt-derived token for the unattended password) using `crypto.timingSafeEqual`.
   - Only if valid, server replies `OK` and pipes the stream to `127.0.0.1:targetPort`.
4. **Anti-Brute-Force Lockout:**
   - Track failed PIN attempts per `remotePublicKey`. After **3 failed attempts**, block that `remotePublicKey` for **15 minutes**, log the event, and fire the Telegram alert.
5. **Update `self-test.js` & `README.md` (in Thai):**
   - Add automated tests verifying wrong PIN rejection, 3-strike lockout, and valid PIN forwarding.
