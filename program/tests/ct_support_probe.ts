/// <reference types="node" />
// SIMULATION ONLY (nothing is sent, no key is needed): does a cluster's token
// program support the confidential-transfer operations this protocol needs?
// Builds one transaction that creates a confidential mint and account,
// configures the account with a real pubkey-validity proof, mints, deposits and
// applies — and asks the RPC to simulate it with signature checks off.
//   CONF_RPC=<rpc> TOKEN2022_PROGRAM=<token program> PROBE_PAYER=<any funded address> ts-node tests/ct_support_probe.ts
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getMintLen, getAccountLen, ExtensionType, createInitializeMint2Instruction, createMintToInstruction } from "@solana/spl-token";
import {
  getInitializeConfidentialTransferMintInstruction, getReallocateInstruction,
  getConfigureConfidentialTransferAccountInstruction, getConfidentialDepositInstruction,
  getApplyConfidentialPendingBalanceInstruction,
} from "@solana-program/token-2022";
import { getVerifyProofInstruction } from "@solana-program/zk-elgamal-proof";
import { execFileSync } from "child_process";
import * as path from "path";

const RPC = process.env.CONF_RPC!;
const TOKEN = new PublicKey(process.env.TOKEN2022_PROGRAM!);
const payer = new PublicKey(process.env.PROBE_PAYER!);
const PROOFGEN = process.env.PROOFGEN || path.resolve(__dirname, "../../proofgen/target/x86_64-unknown-linux-gnu/release/proofgen51");

function ix(kitIx: any): TransactionInstruction {
  const keys = kitIx.accounts.map((a: any) => { const r = Number(a.role); return { pubkey: new PublicKey(a.address), isSigner: r === 2 || r === 3, isWritable: r === 1 || r === 3 }; });
  const prog = kitIx.programAddress === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? TOKEN : new PublicKey(kitIx.programAddress);
  return new TransactionInstruction({ keys, programId: prog, data: Buffer.from(kitIx.data) });
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const mint = Keypair.generate(), acct = Keypair.generate();
  const mintLen = getMintLen([ExtensionType.ConfidentialTransferMint]);
  const acctLen = getAccountLen([ExtensionType.ConfidentialTransferAccount]);
  // a valid ElGamal secret scalar (little-endian, small) and its pubkey-validity proof
  const secretHex = "2a".padEnd(64, "0");
  const proof = Buffer.from(execFileSync(PROOFGEN, ["pubkey"], { input: secretHex, encoding: "utf8" }).trim(), "base64");
  const P = payer.toBase58() as any, MINT = mint.publicKey.toBase58() as any, ACCT = acct.publicKey.toBase58() as any;
  const steps: [string, TransactionInstruction][] = [
    ["create mint account", SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(mintLen), space: mintLen, programId: TOKEN })],
    ["InitializeConfidentialTransferMint", ix(getInitializeConfidentialTransferMintInstruction({ mint: MINT, authority: { __option: "Some", value: P }, autoApproveNewAccounts: true, auditorElgamalPubkey: { __option: "None" } as any }))],
    ["InitializeMint2", createInitializeMint2Instruction(mint.publicKey, 9, payer, null, TOKEN)],
    ["create token account", SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: acct.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(acctLen), space: acctLen, programId: TOKEN })],
    ["InitializeAccount", new TransactionInstruction({ programId: TOKEN, data: Buffer.from([1]), keys: [
      { pubkey: acct.publicKey, isSigner: false, isWritable: true }, { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: false, isWritable: false }, { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false }] })],
    ["Reallocate", ix(getReallocateInstruction({ token: ACCT, payer: P, owner: P, newExtensionTypes: [ExtensionType.ConfidentialTransferAccount] }))],
    ["ConfigureAccount (needs zk proof)", ix(getConfigureConfidentialTransferAccountInstruction({ token: ACCT, mint: MINT, authority: P, decryptableZeroBalance: new Uint8Array(36) as any, maximumPendingBalanceCreditCounter: 65536n, proofInstructionOffset: 1 }))],
    ["VerifyPubkeyValidity (zk program)", ix(getVerifyProofInstruction({ discriminator: 4, proofData: proof as any }))],
    ["MintTo", createMintToInstruction(mint.publicKey, acct.publicKey, payer, 1000n, [], TOKEN)],
    ["confidential Deposit", ix(getConfidentialDepositInstruction({ token: ACCT, mint: MINT, authority: P, amount: 1000n, decimals: 9 }))],
    ["ApplyPendingBalance", ix(getApplyConfidentialPendingBalanceInstruction({ token: ACCT, authority: P, expectedPendingBalanceCreditCounter: 1n, newDecryptableAvailableBalance: new Uint8Array(36) as any }))],
  ];
  const tx = new Transaction().add(...steps.map((s) => s[1]));
  tx.feePayer = payer;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const r = await conn.simulateTransaction(tx);
  const err: any = r.value.err;
  if (!err) { console.log(`RESULT: SUPPORTED — all ${steps.length} steps simulate OK on ${TOKEN.toBase58()} (${r.value.unitsConsumed} CU)`); return; }
  const idx = err?.InstructionError?.[0];
  console.log("RESULT: FAILED at step", idx, idx !== undefined ? `"${steps[idx][0]}"` : "", JSON.stringify(err));
  console.log((r.value.logs || []).slice(-8).join("\n"));
}
main().catch((e) => { console.error("ERROR", e?.message || e); process.exit(1); });
