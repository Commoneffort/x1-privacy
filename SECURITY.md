# Security

X1 Privacy holds user funds in on-chain reserves. Please treat every report as
urgent and private.

## Reporting a vulnerability

Do **not** open a public issue for anything that could put funds or user
privacy at risk. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository.

Please include what is affected (program, proof module, web client), how to
reproduce it, and what an attacker gains. We will acknowledge the report, keep
you informed, and credit you unless you prefer otherwise.

## Scope

| Component | Location |
|---|---|
| On-chain program | `program/programs/x1_confidential` — mainnet `X1PRVwe2PgSYyWZH2hBtUqAxnpPtp6s14jAgZCu4iF1` |
| Proof module (wasm / CLI) | `proofgen/` |
| Web client | `ui/` — https://x1privacy.xyz |

Out of scope: the chain's own Token-2022 and ZK ElGamal proof programs, wallet
extensions, RPC providers.

## Status

The protocol has had an internal review and **one independent security review**
(October 2026). Both are summarised in
[`docs/AUDIT-2026-10-02.md`](docs/AUDIT-2026-10-02.md), including the issues
that remain open. Further independent audits will be published here as they
complete.

## Verifying what is deployed

```bash
cd program && cargo build-sbf --tools-version v1.53
solana program dump X1PRVwe2PgSYyWZH2hBtUqAxnpPtp6s14jAgZCu4iF1 onchain.so --url https://rpc.mainnet.x1.xyz
cmp <(head -c "$(stat -c %s target/deploy/x1_confidential.so)" onchain.so) target/deploy/x1_confidential.so && echo identical
```

For each token, anyone can check that the reserve covers the supply: read the
config account (`"conf-mint"`, mint), then compare its `confidential_supply`
with the reserve token account's balance and the confidential mint's supply.
