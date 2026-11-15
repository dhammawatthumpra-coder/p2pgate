# Phase 11 — v1.9.0 hardening

**Status:** implemented in v1.9.0
**Baseline:** `p2pgate v1.8.4`
**Theme:** catch configuration mistakes before they become outages, and tighten
SOCKS5 to per-client policy.

---

## 1. Scope

| Area | Change |
|---|---|
| Config | `p2pgate config validate` / `config show` |
| Doctor | secret fingerprint + age, target reachability, SOCKS policy |
| SOCKS5 | `socks.perClient` overrides the global allowlist per client key |
| UX | empty input at the credential prompt is ignored quietly |
| Tests | 48 → 50 checks |

Non-goals: UDP ASSOCIATE, IPv6 destinations, TUN, relay, p2phub integration.

---

## 2. `config validate` / `config show`

```sh
p2pgate config validate [--json] [--config <path>]
p2pgate config show     [--json] [--config <path>]
```

### validate

Runs the same normaliser the daemon uses and reports:

- `mode`, `authMode`, `verificationMode`
- `masterSecret` fingerprint (never the value)
- `targets` names + default target
- SOCKS status: enabled, allow entry count, per-client count

Exit code `1` on invalid or missing config, and `--json` returns
`{ ok: false, error, message }` so scripts can branch on it.

### show

Prints the normalised config (what the daemon actually sees, not the raw file)
with secrets masked:

| Field | Replacement |
|---|---|
| `masterSecret` | `<redacted sha256:xxxxxxxxxxxx>` |
| `authPin.unattended` | `<scram-verifier:set>` |
| `telegramAlert.botToken` | `<set>` |

`p2pgate master show --reveal` remains the explicit way to print the real
value.

---

## 3. Doctor additions

| Check | Level | Notes |
|---|---|---|
| `masterSecret` fingerprint | ok | always printed |
| config age ≥ 180 days | warn | "consider `p2pgate master reset`" |
| each `targets.<name>` reachable on `127.0.0.1` | ok / warn | 1.5 s TCP probe |
| SOCKS disabled | ok | |
| SOCKS allowlist `0.0.0.0/0` | warn | effectively an open proxy |
| SOCKS per-client entries | ok | count only |

Doctor remains read-only: it probes TCP but never starts the tunnel.

---

## 4. `socks.perClient`

```json
"socks": {
  "enabled": true,
  "allow": ["192.168.1.0/24:8080"],
  "perClient": {
    "<clientPublicKeyHex>": ["10.0.0.0/8:443"]
  }
}
```

Rules:

- keys are normalised client public keys; invalid keys fail config validation
- each value must be a non-empty array of `ip:port` / `cidr:port` / `cidr:*`
- `perClient` requires `socks.enabled: true`
- **override, not union**: if a client key is present, only that list applies
- clients without an entry fall back to the global `allow`

Rationale: least privilege per device without maintaining a second policy file.

---

## 5. UX

- pressing Enter on an empty credential prompt re-prompts silently instead of
  printing a validation error (mis-typed newlines were noisy in practice)

---

## 6. Tests

New checks:

1. `config redaction hides secret material`
2. `SOCKS per-client allowlist overrides the global list`

Existing 48 checks stay green; total **50**.

Manual:

```text
p2pgate config validate            → ok + summary, no secret
p2pgate config show                → masked masterSecret
p2pgate doctor                     → target live/dead, SOCKS policy warning
```
