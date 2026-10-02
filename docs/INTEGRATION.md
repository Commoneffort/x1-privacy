# X1 Privacy — Integration guide for wallets and apps

This guide is everything a wallet or app needs to support X1 Privacy natively:
show confidential balances, wrap, send, receive and unwrap. The protocol is
permissionless — no key, registration or approval is needed to integrate.

The reference implementation is the open web client at https://x1privacy.vercel.app
(`app.bundle.js`, with the proof module `proofgen51.wasm`). The program's IDL is
served at `/idl.json`, and the live addresses at `/api/state`.

## 1. Addresses

| | Mainnet |
|---|---|
| X1 Privacy program | `X1PRVwe2PgSYyWZH2hBtUqAxnpPtp6s14jAgZCu4iF1` |
| Token program of the confidential mints | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (Token-2022) |
| ZK proof program | `ZkE1Gama1Proof11111111111111111111111111111` |
| Record program (proof staging) | `Gwi2C6TfDHR8kG6YJphktj3VtNxbQFcRddNjcbrDmg8C` |
| cXNT mint (backing: native XNT via `So11111111111111111111111111111111111111112`) | `Bx6dtTUCbLTxwRNaiqWUYHQap1PWTjFvkCEHXqp88dqy` |
| cUSDC.x mint (backing: `B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq`) | `ADXJPNczCQLKg4HeuLaHfcKzwdmuQsfww2gwUYKe8ZX6` |

Always read `/api/state` (or the on-chain config accounts) rather than
hard-coding the token list: more tokens will be added. A testnet deployment
with a faucet is at https://x1privacy-testnet.vercel.app.

Program-derived addresses (program id as above):

| Account | Seeds |
|---|---|
| Config of a confidential mint (also its mint authority and the reserve's owner) | `"conf-mint"`, confidential mint |
| Per-user ledger ("vault") | `"vault"`, owner wallet, confidential mint |

Config account layout (after the 8-byte discriminator): `mint` (32), `backing_mint` (32),
`reserve` (32), `authority` (32), `supply_cap` u64, `confidential_supply` u64, `bump` u8.
A confidential mint has the same decimals as its backing mint.

## 2. A user's confidential account

- It is a Token-2022 token account of the confidential mint, owned by the user's
  wallet, with the `ConfidentialTransferAccount` extension configured.
- **Create it at the wallet's associated token address.** Users share the
  confidential account's address to get paid. A client may also accept a wallet
  address and resolve it: the associated account first, then the wallet's other
  token accounts of that mint that carry the extension (older accounts may be at
  other addresses). A wallet with no such account cannot receive yet.
- Creating it is one transaction: create the associated account (idempotent) →
  `Reallocate` with `ConfidentialTransferAccount` → `ConfigureAccount`
  (proof instruction offset 1) → `VerifyPubkeyValidity`.
- New accounts are approved automatically; there is nothing to request.

## 3. Keys

Each (wallet, confidential mint) pair has one ElGamal key pair and one AES key,
derived deterministically from a wallet signature — no extra seed to back up.

1. Message = ASCII `solana-conf-bal/v1` ‖ owner wallet (32 bytes) ‖ confidential mint (32 bytes).
2. `sig` = the wallet's ed25519 `signMessage` over that message (64 bytes).
3. `prk` = HMAC-SHA512(key = `solana-conf-bal/v1`, data = `sig`).
4. AES key = first 16 bytes of HKDF-Expand(`prk`, info `ae`).
5. ElGamal secret scalar = the 64 bytes of HKDF-Expand(`prk`, info `elgamal`), reduced modulo the group order.

A wallet that integrates natively should derive these inside the wallet and
never expose `sig` or the keys to a page. Keep them in memory only.
The proof module exposes the derivation (`elgamal_secret_from_signature`,
`ae_key_from_signature`, `pubkey_from_secret`, `gen_pubkey_proof`).

## 4. Reading a balance

- **Available balance**: decrypt `decryptable_available_balance` with the AES key
  (instant). Confirm it against the ElGamal `available_balance` ciphertext with
  `elgamal_verify_amount` (one scalar multiplication) before trusting it.
- **Incoming (pending) balance**: decrypt `pending_balance_lo` and
  `pending_balance_hi` with the ElGamal secret; amount = `lo + (hi << 16)`.
- Show available + incoming as the user's balance. Incoming funds become
  spendable with `ApplyPendingBalance`, which needs the owner's signature. Put it
  in the same transaction as the next spend: set the new decryptable balance to
  the AES encryption of (available + incoming), pass the account's current
  pending credit counter, and build the spend's proofs against the ciphertext
  the apply will produce (`elgamal_apply_pending`: available + lo + hi·2^16).

### One approval per action

A wrap is one transaction (create vault if missing, deposit, apply). A send or
an unwrap is several (stage proofs, then use them): build them all up front and
have the wallet sign them together (`signAllTransactions`), then send them in
order, confirming each before the next. `gen_transfer_proof_from_sig` returns
`newAvailableCiphertext`, so a following proof (e.g. the unwrap after the
wrap-only repair transfer) can be built before the transfer has landed.

## 5. Wrap (public → confidential)

One transaction. Fee: 0.39% of the amount, taken by the program; the user is
credited `amount - floor(amount * 39 / 10000)`.

For native XNT, first move the coin into the wallet's wrapped-native associated
account in the same transaction (create idempotent → system transfer →
`SyncNative`), and close that account at the end.

Program instruction `confidential_deposit` — data: discriminator
`[73, 19, 230, 11, 25, 247, 11, 181]` ‖ amount (u64 LE).

| # | Account | |
|---|---|---|
| 0 | `vault` | writable |
| 1 | `config` | writable |
| 2 | `mint` | writable |
| 3 | `backing_mint` | read-only |
| 4 | `user_conf` | writable |
| 5 | `backing_source` | writable |
| 6 | `reserve` | writable |
| 7 | `fee_account` | writable |
| 8 | `owner` | writable, signer |
| 9 | `conf_token_program` | read-only |
| 10 | `backing_token_program` | read-only |
| 11 | `system_program` | read-only |

`fee_account` is the fee recipient's associated token account for the backing
mint (create it idempotently in the same transaction if it does not exist yet);
the program rejects any other address. `conf_token_program` and
`backing_token_program` must be the programs that own the two mints. The vault
must exist: create it once with `create_vault` (discriminator `[29, 237, 247, 208, 193, 82, 54, 135]`,
accounts: vault, owner, mint, payer, system program).

The credit arrives as a pending balance — apply it (section 4).

## 6. Send (confidential → confidential)

A plain Token-2022 `ConfidentialTransfer`; the X1 Privacy program is not
involved and there is no protocol fee.

1. Generate the three proofs with `gen_transfer_proof_from_sig` (equality,
   ciphertext validity for sender / recipient / no auditor, and range).
   **Use fresh randomness for every proof.**
2. Stage each proof in a record account and verify it into a context-state
   account (`VerifyCiphertextCommitmentEquality`,
   `VerifyBatchedGroupedCiphertext3HandlesValidity`, `VerifyBatchedRangeProofU128`).
3. Send the transfer with all three proof offsets 0 and the context-state
   accounts, and close the context-state accounts in the same transaction to
   recover their rent.

**Wrap-only balances.** A balance that was only ever wrapped (never transferred)
has an identity decryption handle, which the proof program rejects in the
equality proof. Before the first unwrap of such a balance, send a 1-unit
confidential transfer from the account to itself; the resulting ciphertext has a
real handle. The reference client does this automatically.

## 7. Unwrap (confidential → public)

One transaction, no protocol fee, and no account other than the reserve and the
user's own:

1. verify the equality and range (`VerifyBatchedRangeProofU64`) proofs from
   `gen_withdraw_proof_from_sig` into context-state accounts;
2. Token-2022 confidential `Withdraw` (moves the amount to the account's public balance);
3. program instruction `confidential_withdraw` — data: discriminator
   `[192, 153, 197, 143, 238, 85, 204, 38]` ‖ amount (u64 LE);
4. close the context-state accounts; for native XNT, also close the
   wrapped-native account so the user receives the coin.

| # | Account | |
|---|---|---|
| 0 | `vault` | writable |
| 1 | `config` | writable |
| 2 | `mint` | writable |
| 3 | `backing_mint` | read-only |
| 4 | `user_conf` | writable |
| 5 | `backing_dest` | writable |
| 6 | `reserve` | writable |
| 7 | `owner` | writable, signer |
| 8 | `conf_token_program` | read-only |
| 9 | `backing_token_program` | read-only |
| 10 | `system_program` | read-only |

`backing_dest` must be a token account of the backing mint owned by the signer.

## 8. Network fees

X1 charges for the compute units a transaction *requests*. Set an explicit
limit: about 200k for a wrap, 300k for an unwrap, 400k for a transfer, 120k for
account creation, 40k for applying a pending balance, 60k for staging.

## 9. Errors

| Code | Name | Meaning |
|---|---|---|
| 6000 | `Overflow` | Amount too large — the calculation overflowed. Try a smaller amount. |
| 6001 | `ZeroAmount` | Amount must be greater than zero. |
| 6002 | `InvalidCap` | The supply cap must be greater than zero. |
| 6003 | `CapCantIncrease` | The supply cap can never be increased — it may only be lowered. |
| 6004 | `CapExceeded` | This deposit would exceed the confidential supply cap. Try a smaller amount. |
| 6005 | `InsufficientVaultBalance` | The confidential vault does not hold enough balance for this withdrawal. |
| 6010 | `DestOwnerMismatch` | The destination account is not owned by the required party — refusing to send funds there. |
| 6011 | `FeeDestinationMismatch` | Protocol fee must be paid to the program's designated fee account — refusing to redirect it. |
| 6012 | `InvalidTokenAccount` | An account is not owned by the expected token program — refusing to use it. |
| 6013 | `MintAuthorityNotPda` | The confidential mint's authority is not the conf-mint PDA — this mint was not set up correctly. |
| 6014 | `ReserveNotProgramOwned` | The reserve is not a backing-token account owned by the conf-mint PDA — refusing to use it. |
| 6015 | `TokenProgramMismatch` | The token program supplied does not own this mint — refusing to use it. |
| 6016 | `BurnNotVerified` | The confidential tokens were not burned — refusing to release backing. |
| 6017 | `MintNotVerified` | The confidential tokens were not minted as expected — aborting the deposit. |
| 6018 | `ReserveInvariantViolated` | The reserve no longer covers the outstanding confidential supply — aborting. |
| 6019 | `CapBelowSupply` | The supply cap cannot be lowered below the supply already outstanding. |
| 6020 | `NotUpgradeAuthority` | Only the program's upgrade authority can register a confidential mint. |
| 6021 | `DecimalsMismatch` | The confidential mint must have the same decimals as its backing mint. |
| 6022 | `FreezeAuthorityPresent` | The confidential mint must not have a freeze authority. |
| 6023 | `MintSupplyNotZero` | The confidential mint must have zero supply when it is registered. |
| 6025 | `SwapsDisabled` | Confidential swaps are disabled in this build. |

## 10. What integrators must not do

- Do not send keys, derivation signatures or decrypted balances to any server.
- Do not present the system as anonymous: addresses, wrap and unwrap amounts are
  public; balances and transfer amounts are hidden.
- Do not hard-code the fee or token list; read them from the program and state.

The protocol has not yet been independently audited. Audit reports will be
published as they complete.
