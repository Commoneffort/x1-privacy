/// <reference types="node" />
// On-chain end-to-end: wrap NATIVE XNT -> apply -> repair identity handle
// (self-transfer) -> unwrap back to NATIVE XNT, using the same transaction
// composition as the web UI. Uses a fresh confidential account each run.
//   FUNDER_KEYPAIR=<wallet.json> ts-node tests/native_unwrap_smoke.ts [wrap_lamports] [unwrap_lamports]
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getAccountLen, ExtensionType, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction,
} from "@solana/spl-token";
import {
  getReallocateInstruction, getConfigureConfidentialTransferAccountInstruction,
  getConfidentialTransferInstruction, getConfidentialWithdrawInstruction,
  getApplyConfidentialPendingBalanceInstruction, fetchToken,
} from "@solana-program/token-2022";
import { getVerifyProofInstruction } from "@solana-program/zk-elgamal-proof";
import { getInitializeInstruction, getWriteInstruction } from "@solana-program/record";
import { createSolanaRpc, address, createKeyPairSignerFromBytes } from "@solana/kit";
import { deriveElGamalKeypairForOwnerMint, deriveAeKeyForOwnerMint } from "../node_modules/@solana-program/token-2022/dist/src/confidential";
import { AeKey } from "@solana/zk-sdk";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
const IDL = require("../target/idl/x1_confidential.json");
// PROGRAM_ID overrides the id baked into the IDL (e.g. to target another cluster's deployment).
if (process.env.PROGRAM_ID) IDL.address = process.env.PROGRAM_ID;

const RPC = process.env.CONF_RPC || "https://rpc.testnet.x1.xyz";
const PROOFGEN = process.env.PROOFGEN || path.resolve(__dirname, "../../proofgen/target/x86_64-unknown-linux-gnu/release/proofgen51");
const st = JSON.parse(fs.readFileSync(process.env.X1C_STATE || path.join(__dirname, "../client/x1c_state.json"), "utf8"));
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.FUNDER_KEYPAIR!, "utf8"))));
const CONF_TOKEN = new PublicKey(process.env.TOKEN2022_PROGRAM || "5YJHiUfvTaoyyvhQVp7bVz1hbXbhLxaERAyFryVn9hhL");
const RECORD_PROGRAM = new PublicKey(process.env.RECORD_PROGRAM || "CS5QTrrjmkj7ErAtNPsmQ7uGReBuzoU69DfF34KppDV6");
const ZK_PROGRAM = new PublicKey("ZkE1Gama1Proof11111111111111111111111111111");
const FEE_RECIPIENT = new PublicKey("GACCq8Yd4szdB7mCcaViFNwDEej4crZe43YoSPCzmb8M");
const RECORD_META = 33;
// Same compute-unit limits as the web UI (X1 charges for requested units).
const cu = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
const CU_WRAP = 150_000, CU_UNWRAP = 300_000, CU_TRANSFER = 400_000;

function toWeb3Ix(kitIx: any): TransactionInstruction {
  const keys = kitIx.accounts.map((a: any) => {
    const roleNum = Number((typeof a.role === "object" && a.role !== null) ? (a.role.value ?? a.role) : a.role);
    return { pubkey: new PublicKey(a.address), isSigner: roleNum === 2 || roleNum === 3, isWritable: roleNum === 1 || roleNum === 3 };
  });
  let prog = kitIx.programAddress;
  if (prog === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") prog = CONF_TOKEN.toBase58();
  else if (prog === "recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5") prog = RECORD_PROGRAM.toBase58();
  return new TransactionInstruction({ keys, programId: new PublicKey(prog), data: Buffer.from(kitIx.data) });
}

async function main() {
  const wrapAmt = BigInt(process.argv[2] || "10000000");
  const unwrapAmt = BigInt(process.argv[3] || "5000000");
  const conn = new Connection(RPC, "confirmed");
  const rpc: any = createSolanaRpc(RPC);
  const provider = new AnchorProvider(conn, { publicKey: payer.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any, { commitment: "confirmed" });
  const program = new (Program as any)(IDL, provider);
  const mint = new PublicKey(st.mint), cfg = new PublicKey(st.config), reserve = new PublicKey(st.reserve);
  if (st.backingMint !== NATIVE_MINT.toBase58()) throw new Error("state is not a native-backed deployment");
  const decimals = (await conn.getAccountInfo(mint))!.data[44];
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), payer.publicKey.toBuffer(), mint.toBuffer()], program.programId);
  const wxnt = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey, false, TOKEN_PROGRAM_ID);
  const feeAccount = getAssociatedTokenAddressSync(NATIVE_MINT, FEE_RECIPIENT, false, TOKEN_PROGRAM_ID);
  const feeOn = (a: bigint) => (a * 39n) / 10000n; // charged on wrap only

  const send = async (label: string, tx: Transaction, signers: Keypair[]) => {
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(...signers);
    const raw = tx.serialize();
    const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed" });
    await conn.confirmTransaction(sig, "confirmed");
    const stt = await conn.getSignatureStatus(sig);
    if (stt.value?.err) throw new Error(label + " failed: " + JSON.stringify(stt.value.err));
    const meta = (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))?.meta;
    console.log(`  ${label}: ok (${raw.length} bytes, ${meta?.computeUnitsConsumed ?? "?"} CU, fee ${meta?.fee ?? "?"} lamports)`);
    return sig;
  };
  const readExt = async (acct: PublicKey) => {
    const t = await fetchToken(rpc, address(acct.toBase58()));
    const ext = (t.data.extensions as any).value.find((e: any) => e.__kind === "ConfidentialTransferAccount");
    return { avail: Buffer.from(ext.availableBalance), dec: Buffer.from(ext.decryptableAvailableBalance), counter: BigInt(ext.pendingBalanceCreditCounter) };
  };
  const stage = async (proof: Buffer, discriminator: number, ctxSize: number) => {
    const ctx = Keypair.generate(), rec = Keypair.generate();
    const space = RECORD_META + proof.length;
    await send("stage proof " + discriminator, new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: ctx.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(ctxSize), space: ctxSize, programId: ZK_PROGRAM }),
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: rec.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(space), space, programId: RECORD_PROGRAM }),
      toWeb3Ix(getInitializeInstruction({ recordAccount: rec.publicKey.toBase58() as any, authority: payer.publicKey.toBase58() as any })),
    ), [payer, ctx, rec]);
    for (let off = 0; off < proof.length; off += 900) {
      await send("write proof", new Transaction().add(toWeb3Ix(getWriteInstruction({ recordAccount: rec.publicKey.toBase58() as any, authority: payer.publicKey.toBase58() as any, offset: BigInt(off), data: proof.subarray(off, off + 900) as any }))), [payer]);
    }
    const verify = toWeb3Ix(getVerifyProofInstruction({ discriminator, proofAccount: rec.publicKey.toBase58() as any, offset: RECORD_META, contextState: ctx.publicKey.toBase58() as any, contextStateAuthority: payer.publicKey.toBase58() as any }));
    return { ctx: ctx.publicKey, verify };
  };

  // 1. fresh confidential account with keys we hold
  const signer = await createKeyPairSignerFromBytes(payer.secretKey);
  const keys = await deriveElGamalKeypairForOwnerMint({ signer, owner: address(payer.publicKey.toBase58()), mint: address(mint.toBase58()) });
  const aesRaw = await deriveAeKeyForOwnerMint({ signer, owner: address(payer.publicKey.toBase58()), mint: address(mint.toBase58()) });
  const aes = AeKey.fromBytes(aesRaw);
  const secretHex = Buffer.from(keys.secretKey).toString("hex"), aesHex = Buffer.from(aesRaw).toString("hex");
  const pubHex = Buffer.from(new PublicKey(keys.elgamalPubkey as any).toBytes()).toString("hex");
  const acct = Keypair.generate();
  const space = getAccountLen([ExtensionType.ConfidentialTransferAccount]);
  await send("create conf account", new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: acct.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(space), space, programId: CONF_TOKEN }),
    new TransactionInstruction({ programId: CONF_TOKEN, data: Buffer.from([1]), keys: [
      { pubkey: acct.publicKey, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false }, { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false }] }),
  ), [payer, acct]);
  const pkProof = execFileSync(PROOFGEN, ["pubkey"], { input: secretHex, encoding: "utf8" }).trim();
  await send("configure conf account", new Transaction().add(
    toWeb3Ix(getReallocateInstruction({ token: acct.publicKey.toBase58() as any, payer: payer.publicKey.toBase58() as any, owner: payer.publicKey.toBase58() as any, newExtensionTypes: [ExtensionType.ConfidentialTransferAccount] })),
    toWeb3Ix(getConfigureConfidentialTransferAccountInstruction({ token: acct.publicKey.toBase58() as any, mint: mint.toBase58() as any, authority: payer.publicKey.toBase58() as any, decryptableZeroBalance: new Uint8Array(aes.encrypt(0n).toBytes()) as any, maximumPendingBalanceCreditCounter: 1n << 16n, proofInstructionOffset: 1 })),
    toWeb3Ix(getVerifyProofInstruction({ discriminator: 4, proofData: Buffer.from(pkProof, "base64") as any })),
  ), [payer]);

  // 2. wrap native XNT
  const net = wrapAmt - feeOn(wrapAmt);
  await send("WRAP native -> cXNT", new Transaction().add(
    cu(CU_WRAP),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, wxnt, payer.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wxnt, lamports: wrapAmt }),
    createSyncNativeInstruction(wxnt, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, feeAccount, FEE_RECIPIENT, NATIVE_MINT, TOKEN_PROGRAM_ID),
    await program.methods.confidentialDeposit(new BN(wrapAmt.toString())).accounts({
      vault, config: cfg, mint, backingMint: NATIVE_MINT, userConf: acct.publicKey, backingSource: wxnt, reserve, feeAccount,
      owner: payer.publicKey, confTokenProgram: CONF_TOKEN, backingTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction(),
    createCloseAccountInstruction(wxnt, payer.publicKey, payer.publicKey, [], TOKEN_PROGRAM_ID),
  ), [payer]);

  // 3. apply pending
  let ext = await readExt(acct.publicKey);
  await send("apply pending", new Transaction().add(toWeb3Ix(getApplyConfidentialPendingBalanceInstruction({
    token: acct.publicKey.toBase58() as any, authority: payer.publicKey.toBase58() as any,
    expectedPendingBalanceCreditCounter: ext.counter, newDecryptableAvailableBalance: new Uint8Array(aes.encrypt(net).toBytes()) as any }))), [payer]);

  // 4. repair the identity handle with a 1-unit self-transfer (as the UI does)
  ext = await readExt(acct.publicKey);
  const identity = ext.avail.subarray(32, 64).every((b) => b === 0);
  console.log("  available handle is identity after wrap-only:", identity);
  let current = net;
  if (identity) {
    const td = JSON.parse(execFileSync(PROOFGEN, ["transfer", secretHex, aesHex, ext.avail.toString("hex"), ext.dec.toString("hex"), "1", pubHex], { input: secretHex, encoding: "utf8" }).trim());
    const eq = await stage(Buffer.from(td.equality, "base64"), 3, 33 + 128);
    const val = await stage(Buffer.from(td.ciphertextValidity, "base64"), 12, 33 + 352);
    const rng = await stage(Buffer.from(td.range, "base64"), 7, 33 + 264);
    await send("self-transfer (heal)", new Transaction().add(cu(CU_TRANSFER), eq.verify, val.verify, rng.verify, toWeb3Ix(getConfidentialTransferInstruction({
      sourceToken: acct.publicKey.toBase58() as any, mint: mint.toBase58() as any, destinationToken: acct.publicKey.toBase58() as any,
      equalityRecord: eq.ctx.toBase58() as any, ciphertextValidityRecord: val.ctx.toBase58() as any, rangeRecord: rng.ctx.toBase58() as any,
      authority: payer.publicKey.toBase58() as any,
      newSourceDecryptableAvailableBalance: new Uint8Array(aes.encrypt(BigInt(td.newAvailableBalance)).toBytes()) as any,
      transferAmountAuditorCiphertextLo: Buffer.from(td.auditorLo, "base64") as any, transferAmountAuditorCiphertextHi: Buffer.from(td.auditorHi, "base64") as any,
      equalityProofInstructionOffset: 0, ciphertextValidityProofInstructionOffset: 0, rangeProofInstructionOffset: 0 }))), [payer]);
    current = BigInt(td.newAvailableBalance);
    ext = await readExt(acct.publicKey);
  }

  // 5. unwrap to native XNT — same composition as the UI's final transaction
  const wd = JSON.parse(execFileSync(PROOFGEN, ["withdraw", secretHex, ext.avail.toString("hex"), current.toString(), unwrapAmt.toString()], { encoding: "utf8" }).trim());
  const weq = await stage(Buffer.from(wd.equality, "base64"), 3, 33 + 128);
  const wrp = await stage(Buffer.from(wd.range, "base64"), 6, 33 + 264);
  const before = { native: await conn.getBalance(payer.publicKey), supply: (await program.account.confidentialMintConfig.fetch(cfg)).confidentialSupply.toString(),
    reserve: (await conn.getTokenAccountBalance(reserve, "confirmed")).value.amount, fee: (await conn.getTokenAccountBalance(feeAccount, "confirmed")).value.amount };
  await send("UNWRAP cXNT -> native", new Transaction().add(
    cu(CU_UNWRAP),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, wxnt, payer.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
    weq.verify, wrp.verify,
    toWeb3Ix(getConfidentialWithdrawInstruction({ token: acct.publicKey.toBase58() as any, mint: mint.toBase58() as any,
      equalityRecord: weq.ctx.toBase58() as any, rangeRecord: wrp.ctx.toBase58() as any, authority: payer.publicKey.toBase58() as any,
      amount: unwrapAmt, decimals, newDecryptableAvailableBalance: new Uint8Array(aes.encrypt(BigInt(wd.newAvailableBalance)).toBytes()) as any,
      equalityProofInstructionOffset: 0, rangeProofInstructionOffset: 0 })),
    await program.methods.confidentialWithdraw(new BN(unwrapAmt.toString())).accounts({
      vault, config: cfg, mint, backingMint: NATIVE_MINT, userConf: acct.publicKey, backingDest: wxnt, reserve,
      owner: payer.publicKey, confTokenProgram: CONF_TOKEN, backingTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction(),
    createCloseAccountInstruction(wxnt, payer.publicKey, payer.publicKey, [], TOKEN_PROGRAM_ID),
  ), [payer]);
  const after = { native: await conn.getBalance(payer.publicKey), supply: (await program.account.confidentialMintConfig.fetch(cfg)).confidentialSupply.toString(),
    reserve: (await conn.getTokenAccountBalance(reserve, "confirmed")).value.amount, fee: (await conn.getTokenAccountBalance(feeAccount, "confirmed")).value.amount };
  const mintSupply = (await conn.getAccountInfo(mint, "confirmed"))!.data.readBigUInt64LE(36).toString();
  console.log("RESULT:" + JSON.stringify({
    ok: true, unwrapped: unwrapAmt.toString(), nativeReceivedNetOfTxFee: (after.native - before.native).toString(),
    supplyDelta: (BigInt(after.supply) - BigInt(before.supply)).toString(), reserveDelta: (BigInt(after.reserve) - BigInt(before.reserve)).toString(),
    feeDelta: (BigInt(after.fee) - BigInt(before.fee)).toString(), supply: after.supply, reserve: after.reserve, mintSupply,
    tempWxntClosed: (await conn.getAccountInfo(wxnt, "confirmed")) === null, remainingConfidential: wd.newAvailableBalance,
  }));
}
main().catch((e) => { console.error("ERROR", e?.message || e); if (e?.logs) console.error((e.logs || []).slice(-12).join("\n")); process.exit(1); });
