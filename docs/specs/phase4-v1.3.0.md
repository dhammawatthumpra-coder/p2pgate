# Phase 4 Software Specification and Handoff Guide (v1.3.0)

> Converted from the original `phase4_v1.3.0_handoff_spec.docx`.

**Phase 4 Software Specification and Handoff Guide (Version 1.3.0)**

| **Status**  | Engineering Handoff Specification — Ready for Implementation |
|-------------|--------------------------------------------------------------|
| **Author**  | Core Platform & Security Engineering                         |
| **Date**    | November 14, 2026                                            |
| **Version** | 1.3.0 (Upgrade from Baseline v1.2.0)                         |

# 1. Overview and Project Goal

This document provides the Phase 4 engineering handoff specification to upgrade the application from version 1.2.0 to version 1.3.0. The goal of Phase 4 is to introduce configurable Verification Policy Modes at the server level alongside a Dual-Source Client Registry file, enabling streamlined fast-path session initialization for registered workstations while preserving full backward compatibility with version 1.2.0 configurations.

# 2. Baseline Summary (Version 1.2.0)

The current project structure includes package.json, config-loader.js, setup-wizard.js, cli.js, client.js, server.js, auth.js, auth-guard.js, keygen.js, crypto-utils.js, and self-test.js. Version 1.2.0 completed the following foundational capabilities:

- Mutual challenge-response verification using stored verifiers in config.json and ephemeral 10-character Base32 session codes in memory.

- Standard input and environment variable support on the client CLI, clearing environment variables immediately after reading.

- State persistence with file locking, atomic file replacement, modification-time (mtime) state reloading, and CLI state management commands.

# 3. Phase 4 Functional Architecture

## 3.1 Server Verification Policy Modes

Introduce a top-level configuration property named verificationMode in config.json. When loading existing version 1.2.0 configuration files, the loader MUST default verificationMode to “hybrid” to ensure zero breaking changes.

| **Policy Mode** | **Default** | **Session Verification Behavior** |
|----|----|----|
| **hybrid** | Yes | Evaluates per-device profiles (“trusted” fast-path vs. “scram” two-step challenge-response). |
| **key-only** | No | Verifies registered client public keys exclusively; disables session codes and interactive prompts. |
| **two-step** | No | Enforces both registered public-key identity and interactive challenge-response for every connection. |

1.  **hybrid (Default Mode):**

- Supports per-device session behavior.

- Devices registered with the fast-path profile (“trusted”) initialize their session immediately after public-key identity verification without interactive code entry.

- Devices registered with the standard profile (“scram”) complete the two-step challenge-response flow.

- When running in non-interactive background environments without a preconfigured fallback verifier, the service starts normally and serves “trusted” devices while declining interactive-only requests.

2.  **key-only (Direct Key Verification Mode):**

- Verifies registered client public keys exclusively.

- Skips generating in-memory session codes and disables interactive challenge-response prompts altogether.

- Designed for automated workflows, background services, and non-interactive environments.

3.  **two-step (Strict Dual Verification Mode):**

- Requires both registered client public-key identity and interactive challenge-response verification for every connection, regardless of per-device fast-path settings.

## 3.2 Dual-Source Device Registry (trusted_devices)

Allow client public keys to be managed across both config.json and an external line-oriented text file named trusted_devices (configurable via trustedDevicesFile in config.json).

### 3.2.1 Line Format

- Blank lines and lines starting with “#” are ignored as comments.

- Entry format with options: \[mode-and-options\] \[64-char-hex-public-key\] \[optional-device-label\]

- Entry format without options (defaults to standard two-step profile): \[64-char-hex-public-key\] \[optional-device-label\]

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr>
<th># Example trusted_devices file<br />
trusted &lt;64-char-hex-public-key&gt; primary-workstation<br />
trusted,expires=2026-12-31T23:59:59Z &lt;64-char-hex-public-key&gt; contractor-laptop<br />
scram &lt;64-char-hex-public-key&gt; shared-terminal<br />
&lt;64-char-hex-public-key&gt; legacy-default-two-step-client</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

### 3.2.2 Supported Options

- trusted: Enables fast-path session startup under hybrid and key-only server modes.

- scram: Uses standard two-step challenge-response verification.

- expires=ISO-8601-UTC: Sets an automatic expiration timestamp for temporary collaborator or device access.

### 3.2.3 Merge and Precedence Rules

- Entries present only in config.json use the standard two-step profile by default.

- Entries present only in trusted_devices apply their declared profile and optional expiration timestamp.

- When the same public key appears in both files and is active, the trusted_devices entry takes precedence.

- When a public key in trusted_devices has passed its expires timestamp, access MUST be declined even if the key is still listed in config.json.

- File ownership and owner-only read/write permissions MUST be checked on POSIX systems before honoring fast-path entries.

- Track file mtime to automatically reload trusted_devices changes on the fly without restarting the server process.

# 4. Session Handshake Sequence Updates

Update the initial message exchange across server.js, client.js, and auth.js so that fast-path clients never display unnecessary input prompts:

4.  **Connection Initialization:**

- Complete transport connection and read the client public key identifier.

- Check active status in auth-guard.js and evaluate merged rules from config.json, trusted_devices, expiration timestamps, and server verificationMode.

5.  **Server Initial Status Frame:**

- Send STATUS_DECLINED and close cleanly if the key is unlisted, expired, or inactive.

- Send STATUS_FASTPATH_READY and connect the target local service stream immediately when fast-path criteria are met.

- Send STATUS_CHALLENGE_REQUIRED when standard two-step verification is needed.

6.  **Client Deferred Input Handling:**

- Connect to the server first before reading interactive user input.

- Upon receiving STATUS_FASTPATH_READY, skip interactive prompts, clear any temporary environment variable, and begin streaming immediately.

- Upon receiving STATUS_CHALLENGE_REQUIRED, read the credential via standard input, environment variable, or hidden prompt, and complete the existing mutual verification sequence.

| **Status Frame** | **Trigger Condition** | **Server Action** | **Client Action** |
|----|----|----|----|
| **STATUS_DECLINED** | Key unlisted, expired, or marked inactive | Transmit frame and close socket cleanly | Abort connection and report rejection |
| **STATUS_FASTPATH_READY** | Key active and eligible for fast-path under policy | Bridge target local service stream immediately | Clear temp env vars, skip prompt, start stream |
| **STATUS_CHALLENGE_REQUIRED** | Key active and requires two-step verification | Initiate mutual SCRAM challenge-response | Read credential (stdin/env/prompt) and verify |

# 5. CLI Commands, Setup Wizard, and Testing

## 5.1 CLI Subcommands (cli.js)

Add a “devices” command group in cli.js using atomic temp-file replacement:

- devices list: Display all merged device keys, indicating source file, active profile, expiration date, and label.

- devices add \[publicKeyHex\] \[--mode trusted\|scram\] \[--expires timestamp\] \[--comment label\]: Validate and write the entry to trusted_devices.

- devices remove \[publicKeyHex\]: Remove the entry from trusted_devices and notify the user if the key also exists in config.json.

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr>
<th># CLI Subcommand Reference<br />
node cli.js devices list<br />
node cli.js devices add &lt;publicKeyHex&gt; --mode trusted --expires 2026-12-31T23:59:59Z --comment "ops-laptop"<br />
node cli.js devices remove &lt;publicKeyHex&gt;</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 5.2 Setup Wizard and Configuration (setup-wizard.js, config-loader.js)

- Bump package.json version to 1.3.0.

- Add verificationMode selection (hybrid, key-only, two-step) to setup-wizard.js.

- Skip mandatory fallback credential prompts when key-only mode is selected.

## 5.3 Quality Assurance Checklist (self-test.js and README.md)

- Confirm npm run check passes cleanly across all files.

- Add automated test cases in self-test.js covering all three verification modes, dual-source precedence, expiration handling, POSIX file permission validation, and live mtime reload.

- Update Thai documentation in README.md with examples for verificationMode, trusted_devices, and CLI usage.
