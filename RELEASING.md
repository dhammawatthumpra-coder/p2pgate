# Releasing p2pgate

The order matters, and it is enforced by `node scripts/release.js`.

## Golden rule

```
bump + docs  ->  commit  ->  npm publish  ->  wait for npm  ->  tag + GitHub release
```

Never tag or announce before npm serves the version **and** the README that belongs to it.
Tagging early is what left the npm page showing the previous README in 1.13.6.

## Checklist

1. **Code + tests.** `npm test` must pass.
2. **README.** Any new user-facing flag, config key or command goes into `README.md`
   **and** `README.th.md`. `npm run release:check` fails if a CLI flag is undocumented.
3. **Version.** Bump `package.json` (and `package-lock.json`), then update:
   - `README.md`, `README.th.md` — Socket badge `?v=<version>` and `--version` example
   - `CHANGELOG.md` — `## [<version>]` section
   - `docs/releases/v<version>.md` — release notes
   - `docs/README.md` — link to the new release notes
   - `docs/HANDOFF.md` — version, tag, release, npm state
4. **Preflight.** `npm run release:preflight`
   - runs `scripts/check-release.js`
   - refuses a dirty working tree
   - prints the publish command
5. **Commit and push.**
6. **Publish.** The owner runs it; the OTP is never shared:
   ```sh
   npm publish --otp=<code>
   ```
7. **After publish.** `node scripts/release.js --after-publish`
   - waits until `npm view p2pgate version` equals the new version
   - verifies the npm README contains `?v=<version>`
   - only then creates and pushes the tag, then the GitHub release
8. **Record it.** Set `docs/HANDOFF.md` to `released` and commit.

## What `scripts/check-release.js` enforces

- both READMEs point at `package.json`'s version
- the release-notes file exists and is linked from `docs/README.md`
- `CHANGELOG.md` has a section for the version
- every CLI flag in `src/cli.js` is documented in the README (allow list for aliases)
- warns when the README links to `docs/…` files that are not in `files` (they break on npm)

## Why a separate after-publish step

`npm publish` returns before the version is servable: new versions sit in **Validating**
for minutes, and npm keeps serving the previous version's README until the new one is
live. Tagging immediately produces a release that points at something users cannot
install, and the npm page shows stale docs. The wait is part of the process, not an
inconvenience.
