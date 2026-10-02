# X1 Privacy

**Confidential balances and transfers for XNT and USDC.x on X1 — permissionless, self-custodial, fully backed.**

[Website](https://x1privacy.vercel.app) · [Whitepaper (PDF)](ui/public/whitepaper.pdf) · [Integration guide](docs/INTEGRATION.md) · [Deployments](docs/DEPLOYMENTS.md) · [Security](SECURITY.md)

> **Status:** live on X1 mainnet. New software, **not yet independently audited** —
> see the [internal security review](docs/AUDIT-2026-10-02.md) and its open
> findings. Only use amounts you can afford to lose.

---

## What it does

On a public ledger every balance and every payment amount is visible to
everyone. X1 Privacy hides the amounts while keeping the assets on X1 and the
keys with the user.

| Step | What happens |
|---|---|
| **Wrap** | Your XNT or USDC.x moves into the program's reserve and you receive the same amount of cXNT or cUSDC.x (less a one-time 0.39% fee). |
| **Send** | Confidential tokens move between confidential accounts. The amount is encrypted on-chain and proven valid in zero knowledge. No fee. |
| **Unwrap** | Confidential tokens are burned and the same amount of the original token leaves the reserve to you. No fee. |

- **Fully backed.** Confidential tokens are only minted against deposits and are
  burned on exit. Supply always equals the reserve, and anyone can check it.
- **Self-custodial.** Encryption keys are derived in your browser from your
  wallet's signature and never leave it.
- **Permissionless.** No sign-up, allow-list or approval. No freeze authority, no
  pause switch, no viewing key.
- **Honest about privacy.** Balances and transfer amounts are hidden. Addresses,
  who paid whom, and wrap / unwrap amounts are public. It is confidentiality of
  amounts, not anonymity.

## How it works

X1 Privacy composes three things that already exist on the chain:

1. **Token-2022 confidential balances** — balances held as twisted-ElGamal
   ciphertexts and updated homomorphically.
2. **The native ZK ElGamal proof program** — verifies the equality, validity and
   range proofs that keep encrypted arithmetic honest.
3. **The X1 Privacy program** (this repository) — owns each reserve, is the only
   mint authority of each confidential token, and enforces that minting and
   burning always match real movements of the backing token.

All proofs are generated on the user's device by the proof module in
[`proofgen/`](proofgen), compiled to WebAssembly. The website is a static page:
it reads the chain and submits transactions the user has signed.

The [whitepaper](ui/public/whitepaper.pdf) explains the design; the
[integration guide](docs/INTEGRATION.md) has the instruction layouts, key
derivation and flows for wallets and apps.

## Mainnet

| | |
|---|---|
| Program | `X1PRVwe2PgSYyWZH2hBtUqAxnpPtp6s14jAgZCu4iF1` |
| cXNT mint (backed by native XNT) | `Bx6dtTUCbLTxwRNaiqWUYHQap1PWTjFvkCEHXqp88dqy` |
| cUSDC.x mint (backed by USDC.x) | `ADXJPNczCQLKg4HeuLaHfcKzwdmuQsfww2gwUYKe8ZX6` |

Full list, including testnet: [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).

## Repository layout

```
program/     On-chain program (Anchor), CLI client, test scripts, launch script, IDL
proofgen/    Proof module: Rust -> WebAssembly (browser) and native CLI
ui/          Web client (single page + bundle), build scripts, end-to-end browser test
docs/        Whitepaper source, integration guide, deployments, security review
```

## Build and test

Requirements: Rust with the Solana toolchain (`cargo build-sbf`), the
`wasm32-unknown-unknown` target, Node.js, and (for the browser test) Python
Playwright.

```bash
# On-chain program
cd program
cargo test -p x1_confidential            # unit tests
cargo build-sbf --tools-version v1.53    # -> target/deploy/x1_confidential.so

# Proof module
cd ../proofgen
cargo test --target x86_64-unknown-linux-gnu      # includes proof verification
cargo build --release --lib                       # -> wasm for the browser
cargo build --release --target x86_64-unknown-linux-gnu --bin proofgen51   # native CLI

# Web client
cd ../ui
npm ci
node build.js                            # bundles public/app.js -> public/app.bundle.js
```

The client's dependencies in `program/` are installed with
`yarn install --ignore-engines`.

### Verify the deployed program

```bash
solana program dump X1PRVwe2PgSYyWZH2hBtUqAxnpPtp6s14jAgZCu4iF1 onchain.so --url https://rpc.mainnet.x1.xyz
cmp <(head -c "$(stat -c %s program/target/deploy/x1_confidential.so)" onchain.so) program/target/deploy/x1_confidential.so && echo identical
```

### Scripts worth knowing

| Script | Purpose |
|---|---|
| `program/tests/ct_support_probe.ts` | Simulation only: does a cluster's token program support the confidential operations the protocol needs? |
| `program/tests/negative_sim.ts` | Simulation only: the hardened paths must reject (wrong token program, bad destinations, cap changes, swaps). |
| `program/tests/native_unwrap_smoke.ts` | Sends a small wrap → repair → unwrap round trip through a live deployment. |
| `ui/e2e/live_e2e.py` | Drives the real page in a headless browser with an injected test wallet and counts wallet prompts. |
| `program/scripts/launch_mainnet.sh` | Staged deployment (`check` sends nothing). |

## Fees

0.39% once, on wrap, in the token being wrapped. Transfers and unwraps carry no
protocol fee. Network fees apply as usual.

## Limits

One wrap or one confidential transfer carries at most 2^48 − 1 base units
(281,474.97 XNT or 281,474,976.71 USDC.x); larger amounts are done in several
operations. Balances are 64-bit, and unwrapping has no per-operation limit.

## Roadmap

- More tokens, each with its own verifiable reserve
- Confidential swaps (designed as a dedicated mechanism; not shipped until safe)
- Independent security audits, published in full
- Reduced governance: upgrade authority under shared control
- Native wallet integration

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
The program is upgradeable and has not been independently audited; the current
review and its open findings are in [docs/AUDIT-2026-10-02.md](docs/AUDIT-2026-10-02.md).

## License

See [LICENSE](LICENSE).

## Disclaimer

Experimental software, provided as is, without warranties of any kind. Nothing
here is financial, legal or tax advice. You are responsible for complying with
the laws that apply to you.
