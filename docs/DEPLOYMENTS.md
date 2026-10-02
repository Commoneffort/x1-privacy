# Deployments

All addresses below are public on-chain accounts.

## X1 mainnet

| | Address |
|---|---|
| X1 Privacy program | `X1PRVwe2PgSYyWZH2hBtUqAxnpPtp6s14jAgZCu4iF1` |
| Token program of the confidential mints | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (the chain's Token-2022) |
| ZK ElGamal proof program | `ZkE1Gama1Proof11111111111111111111111111111` (native) |
| Record program (proof staging; `spl-record` 0.3.0 built from source) | `Gwi2C6TfDHR8kG6YJphktj3VtNxbQFcRddNjcbrDmg8C` |
| On-chain IDL account (Anchor) | `5mF2ACzc1DGPF3oJWx4FLucMFuzWfLPM7n6XQNJ1hThz` |
| Fee recipient (owner of the fee token accounts) | `GACCq8Yd4szdB7mCcaViFNwDEej4crZe43YoSPCzmb8M` |

| Token | Backing | Confidential mint | Config | Reserve |
|---|---|---|---|---|
| cXNT | native XNT, via wrapped-native `So11111111111111111111111111111111111111112` | `Bx6dtTUCbLTxwRNaiqWUYHQap1PWTjFvkCEHXqp88dqy` | `DZqftH6XUhenkhyQQC4jbUJsj5UfzragPf4SSqqgJBn9` | `Gbfj8rdYoospK5nqAjWxKycJ6kRYRxnzx8dNi9M4gRE` |
| cUSDC.x | USDC.x `B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq` | `ADXJPNczCQLKg4HeuLaHfcKzwdmuQsfww2gwUYKe8ZX6` | `6WyWL9hSDZ5ZJk5kuv5g7yf4kpM1hyvkM2tHACbYJAer` | `1ibwevwaah2V9hbrWm8iK1guxjXqs9UAQNMsAYKiyhQ` |

Both confidential mints: mint authority = their config account (a program
address), no freeze authority, automatic account approval, no auditor key, same
decimals as the backing token, no supply cap.

Program binary: 414,992 bytes, sha256
`072886301d23f68b311686e380ff980ee73c7503d21315cf4922cc4397b700be`.
The program is upgradeable; the upgrade authority is a single key today (see the
audit notes on governance).

Website: https://x1privacy.vercel.app

## X1 testnet

| | Address |
|---|---|
| X1 Privacy program | `G1qWQ6Mn6EVyQXoDmubTJYMtWe6HT8EEMXAwVbdGna7A` |
| Token program of the confidential mints | `5YJHiUfvTaoyyvhQVp7bVz1hbXbhLxaERAyFryVn9hhL` (a Token-2022 build with confidential transfers enabled; testnet's own Token-2022 does not support them) |
| Record program | `Gwi2C6TfDHR8kG6YJphktj3VtNxbQFcRddNjcbrDmg8C` |

Website (with a faucet for mock USDC.x): https://x1privacy-testnet.vercel.app
