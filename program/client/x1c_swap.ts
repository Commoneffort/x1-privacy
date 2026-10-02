/// <reference types="node" />
// X1-Confidential — CONFIDENTIAL SWAP CLIENT (EXPERIMENTAL)
//
// The swap instructions are DISABLED on-chain unless the program is built with
// `--features experimental-swaps`. The escrow design cannot bind the plaintext
// amount of either leg and does not enforce the taker's payment, so it is not
// safe for real value. This client is kept for local experiments only.
//
// Program `X1PRVwe2PgSYyWZH2hBtUqAxnpPtp6s14jAgZCu4iF1`.
//
// Design (client-driven, trustless):
//   * open-swap: the MAKER locks their confidential tokens into a program-owned
//     escrow token account (owner = conf-mint PDA). The maker derives the
//     escrow's ElGamal/AES keys deterministically from (escrow, mint) — so the
//     maker (and only the maker, who signs the derivation) holds the secrets
//     needed to later prove settlement. The order records ONLY ElGamal
//     commitments, never plaintext amounts.
//   * settle-swap: the TAKER builds the ConfidentialTransfer instruction moving
//     escrow -> taker (ZK proofs from the MAKER's escrow keys), and the program
//     relays it signed by the conf-mint PDA (authority). The taker's own leg
//     (taker -> maker) is a separate signed instruction in the same tx — atomic.
//     Permissionless: anyone can submit the settle tx; the program enforces
//     correctness via the on-chain ZK proofs.
//   * cancel-swap: the MAKER releases escrow -> maker, program-signed.
//
// This shares the exact ZK proof pipeline proven in the reference
// (conf_vault.ts doTransfer): proofgen51 generates equality + ciphertext-
// validity + range proofs; the client stages them into record accounts +
// context-state accounts; VerifyProof instructions run in the same tx.
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAccountLen, ExtensionType, createMintToInstruction,
  createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  getReallocateInstruction,
  getConfigureConfidentialTransferAccountInstruction,
  getConfidentialTransferInstruction,
  getApplyConfidentialPendingBalanceInstruction,
  getConfidentialDepositInstruction,
} from "@solana-program/token-2022";
import { getVerifyProofInstruction } from "@solana-program/zk-elgamal-proof";
import {
  getInitializeInstruction, getWriteInstruction,
} from "@solana-program/record";
import { fetchToken } from "@solana-program/token-2022";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { execSync } from "child_process";
import * as os from "os";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as bs58 from "bs58";
import {
  createSolanaRpc, address, createKeyPairSignerFromBytes,
} from "@solana/kit";
import {
  deriveElGamalKeypairForOwnerMint,
  deriveAeKeyForOwnerMint,
} from "../node_modules/@solana-program/token-2022/dist/src/confidential";
import { AeKey, AeCiphertext } from "@solana/zk-sdk";
const IDL = require("../target/idl/x1_confidential.json");
// PROGRAM_ID overrides the id baked into the IDL (e.g. to target another cluster's deployment).
if (process.env.PROGRAM_ID) IDL.address = process.env.PROGRAM_ID;

const RPC_URL = process.env.CONF_RPC || "http://localhost:18890";
const FUNDER_KEYPAIR = process.env.FUNDER_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");
const PROOFGEN = process.env.PROOFGEN || path.resolve(__dirname, "../../proofgen/target/x86_64-unknown-linux-gnu/release/proofgen51");
const ZK_PROGRAM = new PublicKey("ZkE1Gama1Proof11111111111111111111111111111");
const TOKEN_2022_PROGRAM = new PublicKey(process.env.TOKEN2022_PROGRAM || "5YJHiUfvTaoyyvhQVp7bVz1hbXbhLxaERAyFryVn9hhL");
const RECORD_PROGRAM = new PublicKey(process.env.RECORD_PROGRAM || "CS5QTrrjmkj7ErAtNPsmQ7uGReBuzoU69DfF34KppDV6");
const RECORD_META = 33;
// Protocol fee (0.39% on wrap; unwrap is free). MUST match `fee_recipient()` / FEE_BPS in lib.rs.
const FEE_RECIPIENT = new PublicKey("GACCq8Yd4szdB7mCcaViFNwDEej4crZe43YoSPCzmb8M");
const BACKING_TOKEN_PROGRAM = new PublicKey(process.env.BACKING_TOKEN_PROGRAM || "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
function feeOn(amount: bigint): bigint { return (amount * 39n) / 10000n; }
// token-2022 AuthorityType::AccountOwner = 2 (NOT 0=MintTokens).
const TOK_AUTH_ACCOUNT_OWNER = 2;
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || IDL.address);

// X1C_STATE lets a second deployment (or a smoke test) keep its own state file.
const STATE_FILE = process.env.X1C_STATE || path.join(__dirname, "x1c_state.json");
function loadState(): any { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
function saveState(s: any) { fs.writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...s }, null, 2)); }

function deriveVaultPDA(owner: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer(), mint.toBuffer()], PROGRAM_ID);
}
function deriveSwapPDA(maker: PublicKey, mint: PublicKey, seed: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("swap"), maker.toBuffer(), mint.toBuffer(), seed], PROGRAM_ID);
}
function deriveConfMintPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("conf-mint"), mint.toBuffer()], PROGRAM_ID);
}

function toWeb3Ix(kitIx: any, overrideProgram?: PublicKey): TransactionInstruction {
  // defensive role extraction: handles raw numbers, object wrappers, or booleans
  const keys = kitIx.accounts.map((a: any) => {
    const rawRole = (typeof a.role === 'object' && a.role !== null) ? (a.role.value ?? a.role) : a.role;
    const roleNum = Number(rawRole);
    return {
      pubkey: new PublicKey(a.address),
      isSigner: roleNum === 2 || roleNum === 3 || !!a.isSigner,
      isWritable: roleNum === 1 || roleNum === 3 || !!a.isWritable,
    };
  });
  // defensive data conversion: Uint8Array, Buffer, Array, or fallback
  let dataBuf: Buffer;
  if (Buffer.isBuffer(kitIx.data)) dataBuf = kitIx.data;
  else if (kitIx.data instanceof Uint8Array) dataBuf = Buffer.from(kitIx.data.buffer, kitIx.data.byteOffset, kitIx.data.byteLength);
  else if (Array.isArray(kitIx.data)) dataBuf = Buffer.from(kitIx.data as number[]);
  else dataBuf = Buffer.from(Object.values(kitIx.data));
  let prog = overrideProgram ? overrideProgram.toBase58() : kitIx.programAddress;
  if (prog === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") prog = TOKEN_2022_PROGRAM.toBase58();
  else if (prog === "CS5QTrrjmkj7ErAtNPsmQ7uGReBuzoU69DfF34KppDV6") prog = RECORD_PROGRAM.toBase58();
  else if (prog === "ZkE1Gama1Proof11111111111111111111111111111" || prog.startsWith("ZkE1Gama")) prog = ZK_PROGRAM.toBase58();
  return new TransactionInstruction({ keys, programId: new PublicKey(prog), data: dataBuf });
}

async function sendAndWait(conn: Connection, tx: Transaction, signers: any[]) {
  return await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}

function payer(): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(FUNDER_KEYPAIR, "utf8"))));
}

async function createContextProof(conn: Connection, payerKp: Keypair, proofBytes: Buffer, discriminator: number, contextSize: number):
  Promise<{ contextAccount: Keypair, verifyIx: TransactionInstruction }> {
  const contextAccount = Keypair.generate();
  const lamports = await conn.getMinimumBalanceForRentExemption(contextSize);
  const createIx = SystemProgram.createAccount({ fromPubkey: payerKp.publicKey, newAccountPubkey: contextAccount.publicKey, lamports, space: contextSize, programId: ZK_PROGRAM });
  const verifyIx = toWeb3Ix(getVerifyProofInstruction({ discriminator, proofData: proofBytes as any, contextState: contextAccount.publicKey.toBase58() as any, contextStateAuthority: payerKp.publicKey.toBase58() as any }));
  return { contextAccount, verifyIx };
}

async function stageRecord(conn: Connection, payerKp: Keypair, proof: Buffer): Promise<PublicKey> {
  const recordKeypair = Keypair.generate();
  const recordSpace = RECORD_META + proof.length;
  const recordLamports = await conn.getMinimumBalanceForRentExemption(recordSpace);
  const createRecordIx = SystemProgram.createAccount({ fromPubkey: payerKp.publicKey, newAccountPubkey: recordKeypair.publicKey, lamports: recordLamports, space: recordSpace, programId: RECORD_PROGRAM });
  const initRecordIx = toWeb3Ix(getInitializeInstruction({ recordAccount: recordKeypair.publicKey.toBase58() as any, authority: payerKp.publicKey.toBase58() as any }));
  await sendAndWait(conn, new Transaction().add(createRecordIx, initRecordIx), [payerKp, recordKeypair]);
  const writeRecordIx = toWeb3Ix(getWriteInstruction({ recordAccount: recordKeypair.publicKey.toBase58() as any, authority: payerKp.publicKey.toBase58() as any, offset: 0n, data: proof as any }));
  await sendAndWait(conn, new Transaction().add(writeRecordIx), [payerKp]);
  return recordKeypair.publicKey;
}

/// Generate the 3 ZK proofs + auditor ciphertexts for a confidential transfer
/// out of a source account whose (secret, aes) we hold.
function genTransferProofs(secretHex: string, aesHex: string, availBalHex: string, decryptableHex: string, amount: bigint, destPubHex: string): any {
  const out = execSync(
    `echo ${secretHex} | ${PROOFGEN} transfer ${secretHex} ${aesHex} ${availBalHex} ${decryptableHex} ${amount} ${destPubHex}`,
    { encoding: "utf8" }
  ).trim();
  return JSON.parse(out);
}

/// Read a confidential token account's extension ciphertexts (availableBalance
/// + decryptableAvailableBalance raw bytes).
async function readConfCiphertexts(conn: Connection, ata: PublicKey): Promise<{ avail: Buffer, decryptable: Buffer }> {
  const rpc: any = createSolanaRpc(RPC_URL);
  const tok = await fetchToken(rpc, address(ata.toBase58()));
  const ext = (tok.data.extensions as any).value.find((e: any) => e.__kind === 'ConfidentialTransferAccount');
  if (!ext) throw new Error("not a configured confidential account: " + ata.toBase58());
  // IMPORTANT: the equality proof reads the LOW 64 bytes of availableBalance
  // (the Pedersen+AE ciphertext for the available amount opening). Pass only
  // subarray(0,64) — matching conf_vault.ts — or proofgen fails with
  // "InconsistentInput" on the full 128-byte buffer.
  return { avail: Buffer.from(ext.availableBalance as any).subarray(0, 64), decryptable: Buffer.from(ext.decryptableAvailableBalance as any) };
}

/// Derive escrow ElGamal + AES keys from a signing keypair (the maker) for the
/// (owner, mint) pair. Returns the raw secret hex + aes hex, plus the pubkey hex.
async function deriveEscrowKeys(sigKp: Keypair, owner: PublicKey, mint: PublicKey) {
  const sig = await createKeyPairSignerFromBytes(sigKp.secretKey);
  const kp = await deriveElGamalKeypairForOwnerMint({ signer: sig, owner: address(owner.toBase58()), mint: address(mint.toBase58()) });
  const aesRaw = await deriveAeKeyForOwnerMint({ signer: sig, owner: address(owner.toBase58()), mint: address(mint.toBase58()) });
  return {
    secretHex: Buffer.from(kp.secretKey).toString("hex"),
    elgamalPubHex: Buffer.from(new PublicKey(kp.elgamalPubkey as any).toBytes()).toString("hex"),
    aesRaw,
    aes: AeKey.fromBytes(aesRaw),
  };
}

/// Re-randomize the available-balance opening via a tiny self-transfer round-trip
/// (maker -> throwaway confidential account -> back). After apply_pending_balance
/// the available-balance ciphertext carries a ZERO opening, which makes the
/// equality proof fail (SigmaProof(InconsistentInput)). The round-trip gives the
/// opening a non-zero value so the maker's transfer proofs verify.
async function rerandomizeAvailable(
  conn: Connection, payerKp: Keypair,
  keys: { secretHex: string, aesHex: string, aes: AeKey, elgamalPubHex: string, aesRaw: Uint8Array },
  ata: PublicKey, mint: PublicKey,
): Promise<void> {
  // create a throwaway confidential account (owner = payer)
  const tmp = Keypair.generate();
  await sendAndWait(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payerKp.publicKey, toPubkey: tmp.publicKey, lamports: 10_000_000 })), [payerKp]);
  const tmpSigner = await createKeyPairSignerFromBytes(tmp.secretKey);
  const tmpKeys = await deriveElGamalKeypairForOwnerMint({ signer: tmpSigner, owner: address(tmp.publicKey.toBase58()), mint: address(mint.toBase58()) });
  const tmpAesRaw = await deriveAeKeyForOwnerMint({ signer: tmpSigner, owner: address(tmp.publicKey.toBase58()), mint: address(mint.toBase58()) });
  const tmpAes = AeKey.fromBytes(tmpAesRaw);
  const tmpSecretHex = Buffer.from(tmpKeys.secretKey).toString("hex");
  const tmpAesHex = Buffer.from(tmpAesRaw).toString("hex");
  const tmpPubHex = Buffer.from(new PublicKey(tmpKeys.elgamalPubkey as any).toBytes()).toString("hex");
  const { pubkey: tmpAta } = await (async () => {
    const acct = Keypair.generate();
    const space = getAccountLen([ExtensionType.ConfidentialTransferAccount]);
    const lamports = await conn.getMinimumBalanceForRentExemption(space);
    await sendAndWait(conn, new Transaction()
      .add(SystemProgram.createAccount({ fromPubkey: payerKp.publicKey, newAccountPubkey: acct.publicKey, lamports, space, programId: TOKEN_2022_PROGRAM }))
      .add(new TransactionInstruction({ keys: [
        { pubkey: acct.publicKey, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: tmp.publicKey, isSigner: false, isWritable: false },
        { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
      ], programId: TOKEN_2022_PROGRAM, data: Buffer.from([1]) })), [payerKp, acct]);
    const realloc = toWeb3Ix(getReallocateInstruction({ token: acct.publicKey.toBase58() as any, payer: payerKp.publicKey.toBase58() as any, owner: tmp.publicKey.toBase58() as any, newExtensionTypes: [ExtensionType.ConfidentialTransferAccount] }));
    const conf = toWeb3Ix(getConfigureConfidentialTransferAccountInstruction({ token: acct.publicKey.toBase58() as any, mint: mint.toBase58() as any, authority: tmp.publicKey.toBase58() as any, decryptableZeroBalance: new Uint8Array(tmpAes.encrypt(0n).toBytes()) as any, maximumPendingBalanceCreditCounter: 1n << 16n, proofInstructionOffset: 1 }));
    const pk = execSync(`echo ${tmpSecretHex} | ${PROOFGEN} pubkey`, { encoding: "utf8" }).trim();
    const ver = toWeb3Ix(getVerifyProofInstruction({ discriminator: 4, proofData: Buffer.from(pk, "base64") as any }));
    await sendAndWait(conn, new Transaction().add(realloc, conf, ver), [payerKp, tmp]);
    return { pubkey: acct.publicKey };
  })();

  // leg 1: tiny maker -> tmp (verify+transfer in ONE tx, proven pattern)
  const tiny = 1n;
  const leg1 = await buildConfTransferInstructions(conn, payerKp, keys, ata, mint, tmpPubHex, tiny);
  const b1 = buildTransferIx(ata, mint, tmpAta, leg1.ctxAccounts, leg1.records, leg1.tj, keys.aes, payerKp.publicKey);
  await sendAndWait(conn, new Transaction().add(...b1.verifies, b1.transfer), [payerKp]);

  // leg 2: tmp -> maker (read tmp avail/decryptable, build proofs, verify+transfer bundle)
  const tmpKeysForLeg2: any = { secretHex: tmpSecretHex, aesHex: tmpAesHex, aes: tmpAes };
  const leg2 = await buildConfTransferInstructions(conn, payerKp, tmpKeysForLeg2, tmpAta, mint, keys.elgamalPubHex, tiny);
  const b2 = buildTransferIx(tmpAta, mint, ata, leg2.ctxAccounts, leg2.records, leg2.tj, tmpAes, tmp.publicKey);
  await sendAndWait(conn, new Transaction().add(...b2.verifies, b2.transfer), [payerKp, tmp]);
}

/// Build the full set of instructions for ONE confidential transfer.
/// Returns the raw proof JSON + ctx accounts + records, so callers can assemble
/// the final token-2022 ConfidentialTransfer with the correct authority.
async function buildConfTransferInstructions(
  conn: Connection, payerKp: Keypair,
  sourceKeys: { secretHex: string, aesHex: string, aes: AeKey },
  ata: PublicKey, mint: PublicKey, destPubHex: string, amount: bigint,
): Promise<{ tj: any, ctxAccounts: Keypair[], records: PublicKey[] }> {
  const { avail, decryptable } = await readConfCiphertexts(conn, ata);
  const tj = genTransferProofs(sourceKeys.secretHex, sourceKeys.aesHex, avail.toString("hex"), decryptable.toString("hex"), amount, destPubHex);
  const eq = Buffer.from(tj.equality, "base64"), val = Buffer.from(tj.ciphertextValidity, "base64"), rp = Buffer.from(tj.range, "base64");
  const eqP = await createContextProof(conn, payerKp, eq, 3, 33 + 128);
  const valP = await createContextProof(conn, payerKp, val, 12, 33 + 352);
  const rpP = await createContextProof(conn, payerKp, rp, 7, 33 + 264);
  await sendAndWait(conn, new Transaction()
    .add(SystemProgram.createAccount({ fromPubkey: payerKp.publicKey, newAccountPubkey: eqP.contextAccount.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(33 + 128), space: 33 + 128, programId: ZK_PROGRAM }))
    .add(SystemProgram.createAccount({ fromPubkey: payerKp.publicKey, newAccountPubkey: valP.contextAccount.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(33 + 352), space: 33 + 352, programId: ZK_PROGRAM }))
    .add(SystemProgram.createAccount({ fromPubkey: payerKp.publicKey, newAccountPubkey: rpP.contextAccount.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(33 + 264), space: 33 + 264, programId: ZK_PROGRAM })),
    [payerKp, eqP.contextAccount, valP.contextAccount, rpP.contextAccount]);
  const eqR = await stageRecord(conn, payerKp, eq);
  const valR = await stageRecord(conn, payerKp, val);
  const rpR = await stageRecord(conn, payerKp, rp);
  return { tj, ctxAccounts: [eqP.contextAccount, valP.contextAccount, rpP.contextAccount], records: [eqR, valR, rpR] };
}

/// Build the token-2022 ConfidentialTransfer instruction + its 3 VerifyProof
/// instructions (equality, ciphertext-validity, range) that MUST run in the SAME
/// transaction BEFORE the transfer — matching the proven conf_vault.ts doTransfer.
function buildTransferIx(
  source: PublicKey, mint: PublicKey, dest: PublicKey,
  ctxAccounts: Keypair[], records: PublicKey[],
  tj: any, aes: AeKey, authority: PublicKey,
): { verifies: TransactionInstruction[], transfer: TransactionInstruction } {
  const eqV = toWeb3Ix(getVerifyProofInstruction({ discriminator: 3, proofAccount: records[0].toBase58() as any, offset: RECORD_META, contextState: ctxAccounts[0].publicKey.toBase58() as any, contextStateAuthority: payer().publicKey.toBase58() as any }));
  const valV = toWeb3Ix(getVerifyProofInstruction({ discriminator: 12, proofAccount: records[1].toBase58() as any, offset: RECORD_META, contextState: ctxAccounts[1].publicKey.toBase58() as any, contextStateAuthority: payer().publicKey.toBase58() as any }));
  const rpV = toWeb3Ix(getVerifyProofInstruction({ discriminator: 7, proofAccount: records[2].toBase58() as any, offset: RECORD_META, contextState: ctxAccounts[2].publicKey.toBase58() as any, contextStateAuthority: payer().publicKey.toBase58() as any }));
  const transfer = toWeb3Ix(getConfidentialTransferInstruction({
    sourceToken: source.toBase58() as any, mint: mint.toBase58() as any, destinationToken: dest.toBase58() as any,
    equalityRecord: ctxAccounts[0].publicKey.toBase58() as any,
    ciphertextValidityRecord: ctxAccounts[1].publicKey.toBase58() as any,
    rangeRecord: ctxAccounts[2].publicKey.toBase58() as any,
    authority: authority.toBase58() as any,
    newSourceDecryptableAvailableBalance: new Uint8Array(aes.encrypt(BigInt(tj.newAvailableBalance)).toBytes()) as any,
    transferAmountAuditorCiphertextLo: Buffer.from(tj.auditorLo, "base64") as any,
    transferAmountAuditorCiphertextHi: Buffer.from(tj.auditorHi, "base64") as any,
    equalityProofInstructionOffset: 0, ciphertextValidityProofInstructionOffset: 0, rangeProofInstructionOffset: 0,
  }));
  return { verifies: [eqV, valV, rpV], transfer };
}

async function main() {
  const mode = process.argv[2];
  if (!mode) { console.log("usage: x1c_swap.ts <new-account|set-maker-source|open-swap|settle-swap|status> ..."); return; }
  const conn = new Connection(RPC_URL, "confirmed");
  const payerKp = payer();
  const provider = new AnchorProvider(conn, {
    publicKey: payerKp.publicKey,
    signTransaction: async (tx: any) => { tx.sign(payerKp); return tx; },
    signAllTransactions: async (txs: any[]) => { txs.forEach(t => t.sign(payerKp)); return txs; },
  } as any, { commitment: "confirmed" });
  const program = new (Program as any)(IDL, provider);
  const state = loadState();
  const mint = new PublicKey(state.mint);
  const [cfg] = deriveConfMintPDA(mint);
  const [vaultPDA] = deriveVaultPDA(payerKp.publicKey, mint);

  if (mode === "new-account") {
    // Create a confidential account owned by the maker, configured with the SAME
    // deterministic (owner,mint) derivation the swap client uses for proofs, and
    // its AES-encrypted zero recorded. This avoids the legacy x1c.ts mismatch.
    const ownerSigner = await createKeyPairSignerFromBytes(payerKp.secretKey);
    const aKeys = await deriveElGamalKeypairForOwnerMint({ signer: ownerSigner, owner: address(payerKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
    const aAesRaw = await deriveAeKeyForOwnerMint({ signer: ownerSigner, owner: address(payerKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
    const aAes = AeKey.fromBytes(aAesRaw);
    const ata = Keypair.generate();
    const space = getAccountLen([ExtensionType.ConfidentialTransferAccount]);
    const lamports = await conn.getMinimumBalanceForRentExemption(space);
    const createIx = SystemProgram.createAccount({ fromPubkey: payerKp.publicKey, newAccountPubkey: ata.publicKey, lamports, space, programId: TOKEN_2022_PROGRAM });
    const initAcctIx = new TransactionInstruction({
      keys: [{ pubkey: ata.publicKey, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: payerKp.publicKey, isSigner: false, isWritable: false }, { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false }],
      programId: TOKEN_2022_PROGRAM, data: Buffer.from([1]),
    });
    await sendAndWait(conn, new Transaction().add(createIx, initAcctIx), [payerKp, ata]);
    const reallocIx = toWeb3Ix(getReallocateInstruction({ token: ata.publicKey.toBase58() as any, payer: payerKp.publicKey.toBase58() as any, owner: payerKp.publicKey.toBase58() as any, newExtensionTypes: [ExtensionType.ConfidentialTransferAccount] }));
    const confIx = toWeb3Ix(getConfigureConfidentialTransferAccountInstruction({ token: ata.publicKey.toBase58() as any, mint: mint.toBase58() as any, authority: payerKp.publicKey.toBase58() as any, decryptableZeroBalance: new Uint8Array(aAes.encrypt(0n).toBytes()) as any, maximumPendingBalanceCreditCounter: 1n << 16n, proofInstructionOffset: 1 }));
    const pkProof = execSync(`echo ${Buffer.from(aKeys.secretKey).toString("hex")} | ${PROOFGEN} pubkey`, { encoding: "utf8" }).trim();
    const verifyPubkeyIx = toWeb3Ix(getVerifyProofInstruction({ discriminator: 4, proofData: Buffer.from(pkProof, "base64") as any }));
    await sendAndWait(conn, new Transaction().add(reallocIx, confIx, verifyPubkeyIx), [payerKp, ata]);
    saveState({ confAcct: ata.publicKey.toBase58(), confAcctSecretHex: Buffer.from(aKeys.secretKey).toString("hex"), confAcctAesHex: Buffer.from(aAesRaw).toString("hex") });
    console.log("RESULT:" + JSON.stringify({ ok: true, confidentialAccount: ata.publicKey.toBase58(), note: "confidential account created with consistent swap derivation" }));
    return;
  }

  if (mode === "perm-transfer") {
    // PERMISSIONLESS CLIENT-OWNED confidential transfer — no custom program.
    // Uses ONLY the proven helpers already in this file (same configure as
    // new-account, deposit, apply, rerandomize, buildTransferIx). Sender and
    // recipient are fresh client-owned conf accounts on the shared conf mint.
    const amt = BigInt(process.argv[3] || "0");
    if (amt <= 0n) throw new Error("perm-transfer <amount>");
    // sender conf account (fresh, client-owned)
    const rpc0: any = createSolanaRpc(RPC_URL);
    const senderAta = Keypair.generate();
    const sspace = getAccountLen([ExtensionType.ConfidentialTransferAccount]);
    const slam = await conn.getMinimumBalanceForRentExemption(sspace);
    const sCreate = SystemProgram.createAccount({ fromPubkey: payerKp.publicKey, newAccountPubkey: senderAta.publicKey, lamports: slam, space: sspace, programId: TOKEN_2022_PROGRAM });
    const sInit = new TransactionInstruction({ keys: [{ pubkey: senderAta.publicKey, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: payerKp.publicKey, isSigner: false, isWritable: false }, { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false }], programId: TOKEN_2022_PROGRAM, data: Buffer.from([1]) });
    await sendAndWait(conn, new Transaction().add(sCreate, sInit), [payerKp, senderAta]);
    const sSigner = await createKeyPairSignerFromBytes(payerKp.secretKey);
    const sKeys = await deriveElGamalKeypairForOwnerMint({ signer: sSigner, owner: address(payerKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
    const sAesRaw = await deriveAeKeyForOwnerMint({ signer: sSigner, owner: address(payerKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
    const sAes = AeKey.fromBytes(sAesRaw);
    const sRealloc = toWeb3Ix(getReallocateInstruction({ token: senderAta.publicKey.toBase58() as any, payer: payerKp.publicKey.toBase58() as any, owner: payerKp.publicKey.toBase58() as any, newExtensionTypes: [ExtensionType.ConfidentialTransferAccount] }));
    const sConf = toWeb3Ix(getConfigureConfidentialTransferAccountInstruction({ token: senderAta.publicKey.toBase58() as any, mint: mint.toBase58() as any, authority: payerKp.publicKey.toBase58() as any, decryptableZeroBalance: new Uint8Array(sAes.encrypt(0n).toBytes()) as any, maximumPendingBalanceCreditCounter: 1n << 16n, proofInstructionOffset: 1 }));
    const sPk = execSync(`echo ${Buffer.from(sKeys.secretKey).toString("hex")} | ${PROOFGEN} pubkey`, { encoding: "utf8" }).trim();
    const sVerify = toWeb3Ix(getVerifyProofInstruction({ discriminator: 4, proofData: Buffer.from(sPk, "base64") as any }));
    await sendAndWait(conn, new Transaction().add(sRealloc, sConf, sVerify), [payerKp, senderAta]);
    // recipient conf account (fresh, client-owned)
    const recAta = Keypair.generate();
    const rspace = getAccountLen([ExtensionType.ConfidentialTransferAccount]);
    const rlam = await conn.getMinimumBalanceForRentExemption(rspace);
    const rCreate = SystemProgram.createAccount({ fromPubkey: payerKp.publicKey, newAccountPubkey: recAta.publicKey, lamports: rlam, space: rspace, programId: TOKEN_2022_PROGRAM });
    const rInit = new TransactionInstruction({ keys: [{ pubkey: recAta.publicKey, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: payerKp.publicKey, isSigner: false, isWritable: false }, { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false }], programId: TOKEN_2022_PROGRAM, data: Buffer.from([1]) });
    await sendAndWait(conn, new Transaction().add(rCreate, rInit), [payerKp, recAta]);
    const rSigner = await createKeyPairSignerFromBytes(payerKp.secretKey);
    const rKeys = await deriveElGamalKeypairForOwnerMint({ signer: rSigner, owner: address(payerKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
    const rAesRaw = await deriveAeKeyForOwnerMint({ signer: rSigner, owner: address(payerKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
    const rAes = AeKey.fromBytes(rAesRaw);
    const rRealloc = toWeb3Ix(getReallocateInstruction({ token: recAta.publicKey.toBase58() as any, payer: payerKp.publicKey.toBase58() as any, owner: payerKp.publicKey.toBase58() as any, newExtensionTypes: [ExtensionType.ConfidentialTransferAccount] }));
    const rConf = toWeb3Ix(getConfigureConfidentialTransferAccountInstruction({ token: recAta.publicKey.toBase58() as any, mint: mint.toBase58() as any, authority: payerKp.publicKey.toBase58() as any, decryptableZeroBalance: new Uint8Array(rAes.encrypt(0n).toBytes()) as any, maximumPendingBalanceCreditCounter: 1n << 16n, proofInstructionOffset: 1 }));
    const rPk = execSync(`echo ${Buffer.from(rKeys.secretKey).toString("hex")} | ${PROOFGEN} pubkey`, { encoding: "utf8" }).trim();
    const rVerify = toWeb3Ix(getVerifyProofInstruction({ discriminator: 4, proofData: Buffer.from(rPk, "base64") as any }));
    await sendAndWait(conn, new Transaction().add(rRealloc, rConf, rVerify), [payerKp, recAta]);
    // deposit to sender + apply + rerandomize (proven sequence)
    const sendKeys = { secretHex: Buffer.from(sKeys.secretKey).toString("hex"), aesHex: Buffer.from(sAesRaw).toString("hex"), aes: sAes };
    const sElPubHex = Buffer.from(new PublicKey(sKeys.elgamalPubkey as any).toBytes()).toString("hex");
    await sendAndWait(conn, new Transaction().add(createMintToInstruction(mint, senderAta.publicKey, payerKp.publicKey, amt, [], TOKEN_2022_PROGRAM)), [payerKp]);
    const depIxP = toWeb3Ix(getConfidentialDepositInstruction({ token: senderAta.publicKey.toBase58() as any, mint: mint.toBase58() as any, authority: payerKp.publicKey.toBase58() as any, amount: amt, decimals: (await conn.getAccountInfo(mint))!.data[44] }));
    await sendAndWait(conn, new Transaction().add(depIxP), [payerKp]);
    const applyP = toWeb3Ix(getApplyConfidentialPendingBalanceInstruction({ token: senderAta.publicKey.toBase58() as any, authority: payerKp.publicKey.toBase58() as any, expectedPendingBalanceCreditCounter: 1n, newDecryptableAvailableBalance: new Uint8Array(sAes.encrypt(amt).toBytes()) as any }));
    await sendAndWait(conn, new Transaction().add(applyP), [payerKp]);
    // rerandomize (proven)
    await rerandomizeAvailable(conn, payerKp, { secretHex: sendKeys.secretHex, aesHex: sendKeys.aesHex, aes: sAes, elgamalPubHex: sElPubHex, aesRaw: sAesRaw }, senderAta.publicKey, mint);
    // transfer sender -> recipient (proven verify+transfer bundle)
    const rElPubHex = Buffer.from(new PublicKey(rKeys.elgamalPubkey as any).toBytes()).toString("hex");
    const trP = await buildConfTransferInstructions(conn, payerKp, sendKeys, senderAta.publicKey, mint, rElPubHex, amt);
    const bP = buildTransferIx(senderAta.publicKey, mint, recAta.publicKey, trP.ctxAccounts, trP.records, trP.tj, sAes, payerKp.publicKey);
    await sendAndWait(conn, new Transaction().add(...bP.verifies, bP.transfer), [payerKp]);
    // read both balances
    const stF = await fetchToken(rpc0, address(recAta.publicKey.toBase58()));
    const rExt = (stF.data.extensions as any).value.find((e: any) => e.__kind === 'ConfidentialTransferAccount');
    const rDec = rAes.decrypt(AeCiphertext.fromBytes(new Uint8Array(Buffer.from(rExt.decryptableAvailableBalance)))!);
    console.log("RESULT:" + JSON.stringify({ ok: true, sender: senderAta.publicKey.toBase58(), recipient: recAta.publicKey.toBase58(), transferred: amt.toString(), recipientDecryptable: rDec ? rDec.toString() : "ERR", note: "PERMISSIONLESS client-owned confidential transfer" }));
    return;
  }

  if (mode === "perm-send") {
    // PERMISSIONLESS CONSENT TRANSFER: the funded confAcct (from deposit mode) is
    // the sender; transfer to a fresh client-owned recipient. ONE ConfidentialTransfer
    // with verify instructions bundled in the same tx. No swap program, no throwaway
    // rerandomize (available is non-zero after apply-pending).
    const amt = BigInt(process.argv[3] || "0");
    if (amt <= 0n) throw new Error("perm-send <amount>");
    const senderAta = new PublicKey(state.confAcct);
    // recipient conf account (owner = payer)
    const recKp = Keypair.generate();
    const recAta = Keypair.generate();
    const rspace = getAccountLen([ExtensionType.ConfidentialTransferAccount]);
    const rlam = await conn.getMinimumBalanceForRentExemption(rspace);
    const rCreate = SystemProgram.createAccount({ fromPubkey: payerKp.publicKey, newAccountPubkey: recAta.publicKey, lamports: rlam, space: rspace, programId: TOKEN_2022_PROGRAM });
    const rInit = new TransactionInstruction({ keys: [{ pubkey: recAta.publicKey, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: recKp.publicKey, isSigner: false, isWritable: false }, { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false }], programId: TOKEN_2022_PROGRAM, data: Buffer.from([1]) });
    await sendAndWait(conn, new Transaction().add(rCreate, rInit), [payerKp, recAta]);
    const rSigner = await createKeyPairSignerFromBytes(recKp.secretKey);
    const rKeys = await deriveElGamalKeypairForOwnerMint({ signer: rSigner, owner: address(recKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
    const rAesRaw = await deriveAeKeyForOwnerMint({ signer: rSigner, owner: address(recKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
    const rAes = AeKey.fromBytes(rAesRaw);
    const rRealloc = toWeb3Ix(getReallocateInstruction({ token: recAta.publicKey.toBase58() as any, payer: payerKp.publicKey.toBase58() as any, owner: recKp.publicKey.toBase58() as any, newExtensionTypes: [ExtensionType.ConfidentialTransferAccount] }));
    const rConf = toWeb3Ix(getConfigureConfidentialTransferAccountInstruction({ token: recAta.publicKey.toBase58() as any, mint: mint.toBase58() as any, authority: recKp.publicKey.toBase58() as any, decryptableZeroBalance: new Uint8Array(rAes.encrypt(0n).toBytes()) as any, maximumPendingBalanceCreditCounter: 1n << 16n, proofInstructionOffset: 1 }));
    const rPk = execSync(`echo ${Buffer.from(rKeys.secretKey).toString("hex")} | ${PROOFGEN} pubkey`, { encoding: "utf8" }).trim();
    const rVerify = toWeb3Ix(getVerifyProofInstruction({ discriminator: 4, proofData: Buffer.from(rPk, "base64") as any }));
    await sendAndWait(conn, new Transaction().add(rRealloc, rConf, rVerify), [payerKp, recKp]);
    // sender keys (state-conf derived — same as new-account)
    const sSigner = await createKeyPairSignerFromBytes(payerKp.secretKey);
    const sKeys = await deriveElGamalKeypairForOwnerMint({ signer: sSigner, owner: address(payerKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
    const sAesRaw = state.confAcctAesHex ? Buffer.from(state.confAcctAesHex, "hex") : await deriveAeKeyForOwnerMint({ signer: sSigner, owner: address(payerKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
    const sAes = AeKey.fromBytes(sAesRaw);
    const sendKeys = { secretHex: Buffer.from(sKeys.secretKey).toString("hex"), aesHex: Buffer.from(sAesRaw).toString("hex"), aes: sAes };
    const rElPubHex = Buffer.from(new PublicKey(rKeys.elgamalPubkey as any).toBytes()).toString("hex");
    // build + send the consent transfer (verify+transfer in ONE tx)
    const trP = await buildConfTransferInstructions(conn, payerKp, sendKeys, senderAta, mint, rElPubHex, amt);
    const bP = buildTransferIx(senderAta, mint, recAta.publicKey, trP.ctxAccounts, trP.records, trP.tj, sAes, payerKp.publicKey);
    await sendAndWait(conn, new Transaction().add(...bP.verifies, bP.transfer), [payerKp]);
    // read recipient decryptable
    const rpcR: any = createSolanaRpc(RPC_URL);
    const rt = await fetchToken(rpcR, address(recAta.publicKey.toBase58()));
    const rExt = (rt.data.extensions as any).value.find((e: any) => e.__kind === 'ConfidentialTransferAccount');
    const rDec = rAes.decrypt(AeCiphertext.fromBytes(new Uint8Array(Buffer.from(rExt.decryptableAvailableBalance)))!);
    console.log("RESULT:" + JSON.stringify({ ok: true, sender: senderAta.toBase58(), recipient: recAta.publicKey.toBase58(), transferred: amt.toString(), recipientDecryptable: rDec ? rDec.toString() : "ERR", note: "PERMISSIONLESS consent transfer (no swap program, verify+transfer one tx)" }));
    return;
  }

  if (mode === "set-maker-source") {
    const src = process.argv[3]; if (!src) throw new Error("set-maker-source <conf_acct_b58>");
    saveState({ confAcct: new PublicKey(src).toBase58() });
    console.log("RESULT:" + JSON.stringify({ ok: true, confAcct: src }));
    return;
  }

  if (mode === "deposit") {
    // Reproduce the PROVEN pipeline from conf_vault.ts depositVault():
    // 1) program's confidential_deposit: backing->reserve transfer, PDA mint to
    //    source, then ConfidentialDeposit CPI (converts to encrypted confidential),
    // 2) ApplyPendingBalance with the FULL deposit -> decryptable == available,
    // 3) rerandomize the opening (zero-opening fix) via tiny self-transfer.
    // This guarantees decryptable available ALWAYS equals the ElGamal available
    // balance, so proofgen's equality check never sees InconsistentInput.
    const amount = BigInt(process.argv[3] || "0");
    if (amount <= 0n) throw new Error("deposit <amount>");
    const makerSource = new PublicKey(state.confAcct);
    const makerConfKeys = await deriveEscrowKeys(payerKp, payerKp.publicKey, mint);
    // backing source (real value moved into reserve)
    const backingSource = new PublicKey(state.backingSource_pub || "");
    const reserve = new PublicKey(state.reserve);
    const cfg = new PublicKey(state.config);
    const [vaultPDA] = deriveVaultPDA(payerKp.publicKey, mint);
    if (!backingSource) throw new Error("no backingSource in state; run init-mint first");
    const bal = await conn.getTokenAccountBalance(backingSource).catch(() => ({ value: { amount: "0" } }));
    if (bal.value.amount === "0") {
      const bm = new PublicKey(state.backingMint);
      await sendAndWait(conn, new Transaction().add(createMintToInstruction(bm, backingSource, payerKp.publicKey, amount, [], BACKING_TOKEN_PROGRAM)), [payerKp]);
    }
    // program confidential_deposit: backing->reserve + fee + PDA mint + ConfidentialDeposit CPI
    const backingMintPk = new PublicKey(state.backingMint);
    const feeAccount = getAssociatedTokenAddressSync(backingMintPk, FEE_RECIPIENT, false, BACKING_TOKEN_PROGRAM);
    if (!(await conn.getAccountInfo(feeAccount))) {
      await sendAndWait(conn, new Transaction().add(createAssociatedTokenAccountInstruction(payerKp.publicKey, feeAccount, FEE_RECIPIENT, backingMintPk, BACKING_TOKEN_PROGRAM)), [payerKp]);
    }
    await program.methods.confidentialDeposit(new BN(amount.toString()))
      .accounts({ vault: vaultPDA, config: cfg, mint, backingMint: backingMintPk, userConf: makerSource, backingSource, reserve, feeAccount, owner: payerKp.publicKey, confTokenProgram: TOKEN_2022_PROGRAM, backingTokenProgram: BACKING_TOKEN_PROGRAM, systemProgram: SystemProgram.programId })
      .signers([payerKp]).rpc();
    // apply pending with FULL deposit (decryptable := cur + amount)
    const rpc: any = createSolanaRpc(RPC_URL);
    const tok = await fetchToken(rpc, address(makerSource.toBase58()));
    const ex0: any = (tok.data.extensions as any).value.find((e: any) => e.__kind === 'ConfidentialTransferAccount');
    let curBal = 0n;
    const curC0 = AeCiphertext.fromBytes(new Uint8Array(Buffer.from(ex0.decryptableAvailableBalance)));
    if (curC0) try { curBal = makerConfKeys.aes.decrypt(curC0); } catch { /* 0 */ }
    // the wrap credits the amount NET of the 0.39% protocol fee
    const newTotal = curBal + amount - feeOn(amount);
    const applyIx = toWeb3Ix(getApplyConfidentialPendingBalanceInstruction({
      token: makerSource.toBase58() as any, authority: payerKp.publicKey.toBase58() as any,
      expectedPendingBalanceCreditCounter: 1n,
      newDecryptableAvailableBalance: new Uint8Array(makerConfKeys.aes.encrypt(newTotal).toBytes()) as any,
    }));
    await sendAndWait(conn, new Transaction().add(applyIx), [payerKp]);
    // rerandomize the zero-opening via tiny self-transfer
    const rerand = { secretHex: makerConfKeys.secretHex, aesHex: Buffer.from(makerConfKeys.aesRaw).toString("hex"), aes: makerConfKeys.aes, elgamalPubHex: "", aesRaw: makerConfKeys.aesRaw };
    // derive the elgamal pub hex for the maker source
    const msSigner = await createKeyPairSignerFromBytes(payerKp.secretKey);
    const msKp = await deriveElGamalKeypairForOwnerMint({ signer: msSigner, owner: address(payerKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
    rerand.elgamalPubHex = Buffer.from(new PublicKey(msKp.elgamalPubkey as any).toBytes()).toString("hex");
    await rerandomizeAvailable(conn, payerKp, rerand, makerSource, mint);
    console.log("RESULT:" + JSON.stringify({ ok: true, deposited: amount.toString(), decryptedNow: newTotal.toString(), confAcct: makerSource.toBase58() }));
    return;
  }

  if (mode === "open-swap") {
    const makerAmt = BigInt(process.argv[3] || "0");
    const takerAmt = BigInt(process.argv[4] || "0");
    if (makerAmt <= 0n || takerAmt <= 0n) throw new Error("open-swap <maker_amount> <taker_amount>");
    const seed = new Uint8Array(randomBytes(32));
    const [swapPDA] = deriveSwapPDA(payerKp.publicKey, mint, seed);

    // escrow token account, OWNED BY THE MAKER first (so the client can configure
    // it confidential top-level, per the proven conf_vault pattern), owner = maker.
    const escrowKp = Keypair.generate();
    const espace = getAccountLen([]);
    const elamports = await conn.getMinimumBalanceForRentExemption(espace);
    const eCreate = SystemProgram.createAccount({ fromPubkey: payerKp.publicKey, newAccountPubkey: escrowKp.publicKey, lamports: elamports, space: espace, programId: TOKEN_2022_PROGRAM });
    const eInit = new TransactionInstruction({
      keys: [
        { pubkey: escrowKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: payerKp.publicKey, isSigner: false, isWritable: false }, // owner = maker
        { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
      ],
      programId: TOKEN_2022_PROGRAM, data: Buffer.from([1]),
    });
    await sendAndWait(conn, new Transaction().add(eCreate, eInit), [payerKp, escrowKp]);

    // derive the escrow's ElGamal/AES keys (maker signs) — maker holds secrets
    const escrowKeys = await deriveEscrowKeys(payerKp, escrowKp.publicKey, mint);
    // configure confidential: Reallocate + Configure (owner = maker signs at top-level)
    const reallocIx = toWeb3Ix(getReallocateInstruction({ token: escrowKp.publicKey.toBase58() as any, payer: payerKp.publicKey.toBase58() as any, owner: payerKp.publicKey.toBase58() as any, newExtensionTypes: [ExtensionType.ConfidentialTransferAccount] }));
    const confIx = toWeb3Ix(getConfigureConfidentialTransferAccountInstruction({ token: escrowKp.publicKey.toBase58() as any, mint: mint.toBase58() as any, authority: payerKp.publicKey.toBase58() as any, decryptableZeroBalance: new Uint8Array(escrowKeys.aes.encrypt(0n).toBytes()) as any, maximumPendingBalanceCreditCounter: 1n << 16n, proofInstructionOffset: 1 }));
    const pkProof = execSync(`echo ${escrowKeys.secretHex} | ${PROOFGEN} pubkey`, { encoding: "utf8" }).trim();
    const verifyPubkeyIx = toWeb3Ix(getVerifyProofInstruction({ discriminator: 4, proofData: Buffer.from(pkProof, "base64") as any }));
    await sendAndWait(conn, new Transaction().add(reallocIx, confIx, verifyPubkeyIx), [payerKp, escrowKp]);

    // transfer escrow OWNERSHIP to the conf-mint PDA (SetAuthority, maker signs)
    // encoding: [6=SetAuthority][authority_type][1=Some][cfg 32B];
    // AccountOwner = 2 (NOT 0=MintTokens). Built via the package enum so it stays canonical.
    const setAuthIx = new TransactionInstruction({
      keys: [
        { pubkey: escrowKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: payerKp.publicKey, isSigner: true, isWritable: false }, // current owner
      ],
      programId: TOKEN_2022_PROGRAM,
      data: Buffer.concat([Buffer.from([6, TOK_AUTH_ACCOUNT_OWNER]), Buffer.from([1]), cfg.toBuffer()]),
    });
    await sendAndWait(conn, new Transaction().add(setAuthIx), [payerKp]);

    // 3. open_swap: relay maker -> escrow confidential transfer (authority=maker)
    const makerSource = new PublicKey(state.confAcct);
    // Prefer the swap-derived secret keys if this account was made by new-account;
    // else derive on the fly (must match the account's configured derivation).
    const makerSigner = await createKeyPairSignerFromBytes(payerKp.secretKey);
    let makerKeys: any, makerAesRaw: Uint8Array;
    if (state.confAcctSecretHex) {
      makerKeys = { secretKey: Buffer.from(state.confAcctSecretHex, "hex") };
      makerAesRaw = Buffer.from(state.confAcctAesHex, "hex");
    } else {
      makerKeys = await deriveElGamalKeypairForOwnerMint({ signer: makerSigner, owner: address(payerKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
      makerAesRaw = await deriveAeKeyForOwnerMint({ signer: makerSigner, owner: address(payerKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
    }
    const makerAes = AeKey.fromBytes(makerAesRaw);
    // maker elgamal pub (for self-transfer rerandomize + as maker source pubkey)
    let makerElgamalPubHex: string;
    if (state.confAcctSecretHex) {
      const kp2 = await deriveElGamalKeypairForOwnerMint({ signer: makerSigner, owner: address(payerKp.publicKey.toBase58()), mint: address(mint.toBase58()) });
      makerElgamalPubHex = Buffer.from(new PublicKey(kp2.elgamalPubkey as any).toBytes()).toString("hex");
    } else {
      makerElgamalPubHex = Buffer.from(new PublicKey(makerKeys.elgamalPubkey as any).toBytes()).toString("hex");
    }
    const makerSrcKeys = { secretHex: typeof makerKeys.secretKey === "string" ? makerKeys.secretKey : Buffer.from(makerKeys.secretKey).toString("hex"), aesHex: Buffer.from(makerAesRaw).toString("hex"), aes: makerAes };
    // The maker source is expected to be already self-consistent (deposited via
    // the `deposit` mode, which applies pending + rerandomizes). Open directly.
    const destPubHex = escrowKeys.elgamalPubHex;
    const tr = await buildConfTransferInstructions(conn, payerKp, makerSrcKeys, makerSource, mint, destPubHex, makerAmt);
    // authority for the maker->escrow leg = the maker wallet
    const transferIx = buildTransferIx(makerSource, mint, escrowKp.publicKey, tr.ctxAccounts, tr.records, tr.tj, makerAes, payerKp.publicKey);

    const mlo = new Uint8Array(64), mhi = new Uint8Array(64), tlo = new Uint8Array(64), thi = new Uint8Array(64);

    const sig = await program.methods.openSwap(
      Array.from(seed),
      Array.from(mlo), Array.from(mhi), Array.from(tlo), Array.from(thi),
      Buffer.from(transferIx.transfer.data).toString("base64"),
    ).accounts({ swap: swapPDA, config: cfg, mint, makerSource, escrow: escrowKp.publicKey, maker: payerKp.publicKey, confTokenProgram: TOKEN_2022_PROGRAM, systemProgram: SystemProgram.programId })
      .remainingAccounts([
        // token-2022 ConfidentialTransfer accounts in order:
        { pubkey: makerSource, isWritable: true, isSigner: false },
        { pubkey: mint, isWritable: false, isSigner: false },
        { pubkey: escrowKp.publicKey, isWritable: true, isSigner: false },
        { pubkey: tr.ctxAccounts[0].publicKey, isWritable: false, isSigner: false }, // ctx_eq
        { pubkey: tr.ctxAccounts[1].publicKey, isWritable: false, isSigner: false }, // ctx_val
        { pubkey: tr.ctxAccounts[2].publicKey, isWritable: false, isSigner: false }, // ctx_range
        { pubkey: payerKp.publicKey, isWritable: false, isSigner: true }, // authority (=maker)
      ])
      .signers([payerKp])
      .rpc();

    saveState({ swap: swapPDA.toBase58(), swapSeed: Buffer.from(seed).toString("base64"), escrow: escrowKp.publicKey.toBase58(), escrowSecretHex: escrowKeys.secretHex, escrowAesHex: Buffer.from(escrowKeys.aesRaw).toString("hex"), swapMakerAmt: makerAmt.toString(), swapTakerAmt: takerAmt.toString() });
    console.log("RESULT:" + JSON.stringify({ ok: true, swap: swapPDA.toBase58(), escrow: escrowKp.publicKey.toBase58(), makerAmt: makerAmt.toString(), takerAmt: takerAmt.toString(), openSig: sig, note: "confidential open_swap complete (escrow configured then PDA-owned)" }));
    return;
  }

  if (mode === "settle-swap") {
    const swapB58 = process.argv[3]; const takerConfAcct = process.argv[4];
    if (!swapB58 || !takerConfAcct) throw new Error("settle-swap <swap_b58> <taker_conf_acct>");
    const swapPDA = new PublicKey(swapB58);
    const st = await (program.account as any).swap.fetch(swapPDA);
    const escrow = new PublicKey(st.makerEscrow);
    const takerDestTok = new PublicKey(takerConfAcct);
    // maker holds the escrow's secret keys (from open-swap saved state)
    const escrowKeys = { secretHex: state.escrowSecretHex, aesHex: state.escrowAesHex, aes: AeKey.fromBytes(Buffer.from(state.escrowAesHex, "hex")) };
    // dest pubkey = the TAKER's ElGamal pubkey (public, in the taker's extension)
    const rpcS: any = createSolanaRpc(RPC_URL);
    const tTokS = await fetchToken(rpcS, address(takerDestTok.toBase58()));
    const tExt = (tTokS.data.extensions as any).value.find((e: any) => e.__kind === 'ConfidentialTransferAccount');
    if (!tExt) throw new Error("taker account is not configured as confidential");
    const takerDestPubHex = Buffer.from(new PublicKey(tExt.elgamalPubkey as string).toBytes()).toString("hex");
    const makerAmt = BigInt(state.swapMakerAmt || "0");
    const makerLeg = await buildConfTransferInstructions(conn, payerKp, escrowKeys, escrow, mint, takerDestPubHex, makerAmt);
    // 0.2% protocol fee leg (escrow -> fee recipient's CONFIDENTIAL account).
    // Requires the fee recipient to have a confidential account for this mint
    // (one-time setup). Fee amount is confidential (never plaintext on-chain).
    const feeAcct = new PublicKey(process.env.FEE_CONF_ACCT || state.feeConfAcct || "");
    if (!feeAcct.toBase58()) throw new Error("set FEE_CONF_ACCT (fee recipient's confidential account for this mint) or run: x1c_swap.ts init-fee-account");
    const feeToken = await fetchToken(rpcS, address(feeAcct.toBase58()));
    const feeExt = (feeToken.data.extensions as any).value.find((e: any) => e.__kind === 'ConfidentialTransferAccount');
    if (!feeExt) throw new Error("fee account is not configured as confidential");
    const feeDestPubHex = Buffer.from(new PublicKey(feeExt.elgamalPubkey as string).toBytes()).toString("hex");
    const feeAmt = (makerAmt * 20n) / 10000n;
    const feeLeg = await buildConfTransferInstructions(conn, payerKp, escrowKeys, escrow, mint, feeDestPubHex, feeAmt);
    // relay escrow->taker (maker leg) + escrow->fee (fee leg), both with the conf-mint
    // PDA as authority (program signs via invoke_signed). remaining_accounts = [maker-leg..., fee-leg...]
    const tr2 = buildTransferIx(escrow, mint, takerDestTok, makerLeg.ctxAccounts, makerLeg.records, makerLeg.tj, escrowKeys.aes, cfg);
    const trFee = buildTransferIx(escrow, mint, feeAcct, feeLeg.ctxAccounts, feeLeg.records, feeLeg.tj, escrowKeys.aes, cfg);
    const settleSig = await program.methods.settleSwap(Buffer.from(tr2.transfer.data).toString("base64"), Buffer.from(trFee.transfer.data).toString("base64"))
      .accounts({ swap: swapPDA, config: cfg, mint, escrow, takerDest: takerDestTok, taker: payerKp.publicKey, feeEscrow: feeAcct, confTokenProgram: TOKEN_2022_PROGRAM, systemProgram: SystemProgram.programId })
      .remainingAccounts([
        { pubkey: escrow, isWritable: true, isSigner: false },
        { pubkey: mint, isWritable: false, isSigner: false },
        { pubkey: takerDestTok, isWritable: true, isSigner: false },
        { pubkey: makerLeg.ctxAccounts[0].publicKey, isWritable: false, isSigner: false },
        { pubkey: makerLeg.ctxAccounts[1].publicKey, isWritable: false, isSigner: false },
        { pubkey: makerLeg.ctxAccounts[2].publicKey, isWritable: false, isSigner: false },
        { pubkey: cfg, isWritable: false, isSigner: false }, // authority = PDA
        { pubkey: escrow, isWritable: true, isSigner: false },
        { pubkey: mint, isWritable: false, isSigner: false },
        { pubkey: feeAcct, isWritable: true, isSigner: false },
        { pubkey: feeLeg.ctxAccounts[0].publicKey, isWritable: false, isSigner: false },
        { pubkey: feeLeg.ctxAccounts[1].publicKey, isWritable: false, isSigner: false },
        { pubkey: feeLeg.ctxAccounts[2].publicKey, isWritable: false, isSigner: false },
        { pubkey: cfg, isWritable: false, isSigner: false }, // authority = PDA
      ])
      .signers([payerKp])
      .rpc();
    console.log("RESULT:" + JSON.stringify({ ok: true, swap: swapB58, sig: settleSig, fee: feeAmt.toString(), note: "maker leg (escrow->taker) + mandatory 0.2% fee leg (escrow->fee) settled under PDA authority" }));
    return;
  }

  if (mode === "status") {
    const swapB58 = process.argv[3]; if (!swapB58) throw new Error("status <swap_b58>");
    const acct = await (program.account as any).swap.fetch(new PublicKey(swapB58));
    console.log("RESULT:" + JSON.stringify({ ok: true, swap: swapB58, state: acct }));
    return;
  }
}

main().catch((e) => { console.error("ERROR", e?.message || e); if (e?.stack) console.error(e.stack); if (e?.logs) console.error("logs:", (e.logs||[]).slice(-12)); process.exit(1); });
