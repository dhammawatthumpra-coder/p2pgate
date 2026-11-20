# Spike — port one p2pgate module to Rust

**Status:** proposed (no code yet)
**Timebox:** 2 days
**Baseline:** p2pgate 1.13.5 (Node 24, single dependency `hyperdht`)

---

## 1. Question

Is it worth moving **one deterministic module** of p2pgate to Rust, given that the
transport (HyperDHT) must stay in Node and users install with `npm i -g` on Termux?

This is not a rewrite of p2pgate. It answers a narrow, measurable question: does the
port pay for its install and maintenance cost?

## 2. Why not a full rewrite

- HyperDHT (DHT + Noise + hole punching) has no mature Rust equivalent; replacing it is
  a multi-month project on its own.
- p2pgate is I/O-bound. CPU savings do not change how it feels over a network.
- A native module changes install behaviour on Termux, which is the product's main
  advantage.

## 3. Candidate (in order)

| Module | Why | Risk |
|---|---|---|
| **`mux` codec** (`encodeFrame`, `FrameParser`) | Pure functions, byte-exact, already covered by tests | low |
| `udp` framing (`encodeFrame`, `createDecoder`) | Smaller, same shape | low |
| `allowlist` (CIDR parse/match) | Pure, but hot only during connect | low |

Start with **mux codec only**. Do not port `MuxCarrier`/`MuxChannel` (they are I/O
state machines); they stay in JS.

## 4. Method

1. **Fixtures from the JS source** (not hand-written):
   - generate ≥200 cases: every frame type, zero-length payloads, 16 KiB max frame,
     oversized rejection, header split across chunks (1-byte feeds), multiple frames per
     chunk, `CONTROL` type `0x10`.
   - store as JSONL in `spike/mux/fixtures/`.
2. **Rust crate** `spike/mux/` with two functions: `encode(frame) -> bytes` and
   `parse(chunks) -> frames`, implemented to match the JS behaviour exactly.
3. **Node binding**: `napi-rs` (prebuilt `.node`) behind a flag in a scratch harness —
   **do not modify `src/`** until parity passes.
4. **Diff**: replay every fixture against JS and Rust; compare bytes and frame order.
5. Optional: `rust-anything` may drive record/diff around the same fixtures instead of
   the hand-written harness. Not required.

## 5. Gates

| Gate | Threshold | How |
|---|---|---|
| G1 parity | 100% of fixtures byte-identical, including chunk splits | automated diff |
| G2 install | `npm i -g` on Termux arm64 succeeds **without** Rust/cargo, install size grows ≤ 2 MB | fresh Termux test |
| G3 CPU | encode+parse ≥ **1.5×** faster per frame than JS (1M frames) | microbench |
| G4 memory | server RSS at idle improves ≥ 20%, or transfer RSS peak improves ≥ 10% | `status`/proc sampling |
| G5 maintenance | added files ≤ ~600 LOC, no new build step for contributors beyond `npm test` | review |

**Decision rule:** ship to users only if **G1 + G2 pass** and **G3 or G4 shows a
user-visible win**. Otherwise stop, record the numbers, keep JS.

## 6. Non-goals

- Transport, auth, SCRAM, CLI, SOCKS, doctor — all stay in JS.
- No change to the mux wire format or config schema.
- No publish during the spike.

## 7. Risks

| Risk | Mitigation |
|---|---|
| android-arm64 prebuild needs a cross toolchain | if `npm i -g` needs cargo on Termux, that is an automatic **NO-GO** |
| Two implementations drift | parity fixtures run in `npm test` only if the port ships; otherwise delete the crate |
| Node-API version churn | pin `napi-rs` and document Node ≥ 20 |
| Review surface on npm (Socket score) | measure package layout; optional binaries count as new supply-chain surface |

## 8. Deliverables

```
spike/
├── mux/
│   ├── fixtures/*.jsonl      # generated from the JS implementation
│   ├── src/lib.rs            # encode + parse
│   ├── Cargo.toml
│   └── bench.js              # JS vs Rust microbench
└── results.md                # gates table + verdict (GO / NO-GO)
```

`results.md` must include: fixture count, parity failures (if any), ns/frame for both,
install outcome on Termux, RSS numbers, and the final recommendation.

## 9. Environment

- Windows dev box with Rust 1.96 (`cargo` present)
- Termux arm64 (Node 24, p2pgate 1.13.5) for G2/G4
- Use a scratch directory; never touch the user's `~/.p2pgate`

## 10. If the answer is GO

Then (and only then) propose a phase with: binding shipped as an **optional** dependency
(`optionalDependencies` per platform, like esbuild), JS fallback kept forever, and a
`p2pgate --no-native` escape hatch.
