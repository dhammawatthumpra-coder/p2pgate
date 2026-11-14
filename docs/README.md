# Documentation

## Specifications

| Document | Version | Description |
|---|---|---|
| [Project handoff specification](specs/project-spec.md) | v1.0 | Original architecture, security model, file layout, and acceptance criteria |
| [Phase 2 — PIN/password gate](specs/phase2-v1.1.md) | v1.1 | Challenge-response PIN/password layer and first lockout rules |
| [Phase 3 — Mutual SCRAM](specs/phase3-v1.2.md) | v1.2 | SCRAM verification, async scrypt, progressive lockout, live unlock |
| [Phase 4 — Verification modes](specs/phase4-v1.3.0.md) | v1.3.0 | Verification policy modes, trusted_devices registry, status frames v3 |
| [Phase 5 — Control plane](specs/phase5-v1.4.0.md) | v1.4.0 | Local control socket, doctor, trusted-device expiry enforcement |
| [Phase 6 — Auditability](specs/phase6-v1.5.0.md) | v1.5.0 | Audit log, encrypted keys, JSON output, control token |

The Phase 4 document was converted from the original `.docx` handoff file to
Markdown for easier review and diffing.

## Other documents

- [Release notes v1.5.0](releases/v1.5.0.md)
- [Release notes v1.4.1](releases/v1.4.1.md)
- [Release notes v1.4.0](releases/v1.4.0.md)
- [Manual acceptance testing](../TESTING.md) (Thai)
- [Changelog](../CHANGELOG.md)
- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
