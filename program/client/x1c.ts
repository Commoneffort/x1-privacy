/// <reference types="node" />
// X1-Confidential client — REAL, reserve-backed confidential layer (v2).
//
// Program `X1PRVwe2PgSYyWZH2hBtUqAxnpPtp6s14jAgZCu4iF1`.
// No self-minting, no thin air. The confidential mint authority is the
// conf-mint PDA, supply is hard-capped at genesis, and confidential tokens are
// only ever created against REAL backing that moves into a program-owned
// RESERVE, and burned against releasing that same backing.
//
//   init-mint <cap_raw> [backing_mint]  — create conf mint (PDA authority) + reserve
//   create-vault                        — vault PDA for (owner, mint)
//   create-account                      — confidential Token-2022 account
//   deposit <amount>                    — wrap: backing ATA -> RESERVE, then mint conf 1:1
//   withdraw <amount>                   — unwrap: release backing RESERVE -> ATA
//   set-cap <new_cap_raw>               — governance: lower the supply cap
// (Confidential swaps are experimental and live in x1c_swap.ts.)
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAccountLen, ExtensionType, getMintLen, createInitializeMint2Instruction,
  createMintToInstruction, createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  getReallocateInstruction,
  getConfigureConfidentialTransferAccountInstruction,
  getInitializeConfidentialTransferMintInstruction,
} from "@solana-program/token-2022";
import { getVerifyProofInstruction } from "@solana-program/zk-elgamal-proof";
import {
  getInitializeInstruction, getWriteInstruction,
} from "@solana-program/record";
import { ConfidentialKeys } from "@solana/zk-sdk";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { execFileSync } from "child_process";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as bs58 from "bs58";
import { signAsync } from "@noble/ed25519";
const IDL = require("../target/idl/x1_confidential.json");
// PROGRAM_ID overrides the id baked into the IDL (e.g. to target another cluster's deployment).
if (process.env.PROGRAM_ID) IDL.address = process.env.PROGRAM_ID;

const RPC_URL = process.env.CONF_RPC || "https://rpc.testnet.x1.xyz";
const FUNDER_KEYPAIR = process.env.FUNDER_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");
// Protocol fee recipient (0.39% on wrap; unwrap is free). MUST match `fee_recipient()` in
// lib.rs and FEE_RECIPIENT in ui/public/app.js.
const FEE_RECIPIENT = new PublicKey("GACCq8Yd4szdB7mCcaViFNwDEej4crZe43YoSPCzmb8M");
// The fee recipient's ATA for (mint, tokenProgram) — the exact destination the
// program enforces. Creates it (payer-funded) if missing.
async function ensureFeeAta(conn: Connection, payer: Keypair, mint: PublicKey, program: PublicKey): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, FEE_RECIPIENT, false, program);
  const info = await conn.getAccountInfo(ata).catch(() => null);
  if (!info) {
    await sendAndWait(
      conn,
      new Transaction().add(
        createAssociatedTokenAccountInstruction(payer.publicKey, ata, FEE_RECIPIENT, mint, program)
      ),
      [payer]
    );
  }
  return ata;
}
function feeOn(amount: bigint): bigint { return (amount * 39n) / 10000n; } // wrap only; unwrap is free
// Real XNT lives on Tokenkeg (classic SPL Token); confidential mints live on the
// zk-ops token-2022. The deposit/withdraw relay needs BOTH programs.
const BACKING_TOKEN_PROGRAM = new PublicKey(process.env.BACKING_TOKEN_PROGRAM || "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const PROOFGEN = process.env.PROOFGEN || path.resolve(__dirname, "../../proofgen/target/x86_64-unknown-linux-gnu/release/proofgen51");
const ZK_PROGRAM = new PublicKey("ZkE1Gama1Proof11111111111111111111111111111");
const TOKEN_2022_PROGRAM = new PublicKey(process.env.TOKEN2022_PROGRAM || "5YJHiUfvTaoyyvhQVp7bVz1hbXbhLxaERAyFryVn9hhL");
const RECORD_PROGRAM = new PublicKey(process.env.RECORD_PROGRAM || "CS5QTrrjmkj7ErAtNPsmQ7uGReBuzoU69DfF34KppDV6");
const RECORD_META = 33;
// Decimals used only when init-mint has to create a fresh test backing mint.
// A confidential mint always takes the decimals of the backing mint it wraps
// (the program enforces this), since tokens are minted 1:1 in raw units.
const DEFAULT_BACKING_DECIMALS = 9;
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || IDL.address);
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
// The program's ProgramData account: init-mint proves the caller is the upgrade authority.
const [PROGRAM_DATA] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_LOADER_UPGRADEABLE);

async function readMintDecimals(conn: Connection, mint: PublicKey): Promise<number> {
  const info = await conn.getAccountInfo(mint);
  if (!info || info.data.length < 82) throw new Error("not a mint: " + mint.toBase58());
  return info.data[44];
}

// X1C_STATE lets a second deployment (or a smoke test) keep its own state file.
const STATE_FILE = process.env.X1C_STATE || path.join(__dirname, "x1c_state.json");
function loadState(): any { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
function saveState(s: any) { fs.writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...s }, null, 2)); }

function deriveVaultPDA(owner: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer(), mint.toBuffer()], PROGRAM_ID);
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
  return new TransactionInstruction({ keys, programId: new PublicKey(prog), data: dataBuf });
}

async function sendAndWait(conn: Connection, tx: Transaction, signers: any[]) {
  return await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}

async function stageRecord(conn: Connection, payer: Keypair, proof: Buffer): Promise<PublicKey> {
  const kp = Keypair.generate();
  const space = RECORD_META + proof.length;
  const lamports = await conn.getMinimumBalanceForRentExemption(space);
  const createIx = SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey, lamports, space, programId: RECORD_PROGRAM });
  const initIx = toWeb3Ix(getInitializeInstruction({ recordAccount: kp.publicKey.toBase58() as any, authority: payer.publicKey.toBase58() as any }));
  await sendAndWait(conn, new Transaction().add(createIx, initIx), [payer, kp]);
  const writeIx = toWeb3Ix(getWriteInstruction({ recordAccount: kp.publicKey.toBase58() as any, authority: payer.publicKey.toBase58() as any, offset: 0n, data: proof as any }));
  await sendAndWait(conn, new Transaction().add(writeIx), [payer]);
  return kp.publicKey;
}

function deriveAndProve(owner: PublicKey, mint: PublicKey) {
  const seed = new Uint8Array(64);
  seed.set(owner.toBytes(), 0);
  seed.set(mint.toBytes(), 32);
  const message = ConfidentialKeys.signerMessage(seed);
  const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(FUNDER_KEYPAIR, "utf8"))));
  const signingKey = new Uint8Array(funder.secretKey.slice(0, 32));
  const signature = signAsync(message, signingKey);
  return signature.then((sig) => {
    const keys = ConfidentialKeys.fromSignature(sig.slice(0, 64));
    const elgamal = keys.elgamal();
    const elgamalPubkey = new PublicKey(new Uint8Array(elgamal.pubkey().toBytes()));
    const secretBytes = new Uint8Array(elgamal.secret().toBytes());
    const secretHex = Buffer.from(secretBytes).toString("hex");
    const proofB64 = execFileSync(PROOFGEN, ["pubkey"], { input: secretHex, encoding: "utf8" }).trim();
    return { elgamalPubkey, proofB64 };
  });
}

async function createConfAccount(conn: Connection, payer: Keypair, owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
  const { proofB64 } = await deriveAndProve(owner, mint);
  const space = getAccountLen([ExtensionType.ConfidentialTransferAccount]);
  const lamports = await conn.getMinimumBalanceForRentExemption(space);
  const ata = Keypair.generate();
  const createIx = SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: ata.publicKey, lamports, space, programId: TOKEN_2022_PROGRAM });
  const initAcctIx = new TransactionInstruction({
    keys: [
      { pubkey: ata.publicKey, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
    ],
    programId: TOKEN_2022_PROGRAM,
    data: Buffer.from([1]),
  });
  const createTx = new Transaction().add(createIx, initAcctIx);
  createTx.feePayer = payer.publicKey;
  createTx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  createTx.sign(payer, ata);
  await conn.sendRawTransaction(createTx.serialize());
  await conn.confirmTransaction(bs58.encode(createTx.signatures[0].signature!), "confirmed");

  const reallocIx = toWeb3Ix(getReallocateInstruction({ token: ata.publicKey.toBase58() as any, payer: owner.toBase58() as any, owner: owner.toBase58() as any, newExtensionTypes: [ExtensionType.ConfidentialTransferAccount] }));
  const confIx = toWeb3Ix(getConfigureConfidentialTransferAccountInstruction({ token: ata.publicKey.toBase58() as any, mint: mint.toBase58() as any, authority: owner.toBase58() as any, decryptableZeroBalance: new Uint8Array(32) as any, maximumPendingBalanceCreditCounter: 1n << 16n, proofInstructionOffset: 1 }));
  const verifyPubkeyIx = toWeb3Ix(getVerifyProofInstruction({ discriminator: 4, proofData: Buffer.from(proofB64, "base64") as any }));
  const tx = new Transaction().add(reallocIx, confIx, verifyPubkeyIx);
  tx.feePayer = owner;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(FUNDER_KEYPAIR, "utf8")))));
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return ata.publicKey;
}

/// Get (and create if needed) a standard ATA for the given owner+mint.
/// Create (or reuse) a DIRECT nondeterministic Token-2022 token account for a
/// given owner+mint, since the canonical ATA program does not target the custom
/// token-2022 id (so ATA creation via spl-token fails). Returns the account pubkey.
async function getOrCreateDirectTokenAccount(
  conn: Connection,
  payer: Keypair,
  owner: PublicKey, // the pubkey that owns the token account (signs transfers out)
  mint: PublicKey,
  key: string,
  program?: PublicKey, // which token program manages this account (default = conf zk-ops)
): Promise<{ pubkey: PublicKey; keypair: Keypair | null }> {
  const st = loadState();
  if (st[`${key}_pub`]) {
    return { pubkey: new PublicKey(st[`${key}_pub`]), keypair: null };
  }
  const prog = program || TOKEN_2022_PROGRAM;
  const space = getAccountLen([]);
  const lamports = await conn.getMinimumBalanceForRentExemption(space);
  const acc = Keypair.generate();
  const createIx = SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: acc.publicKey, lamports, space, programId: prog });
  // initialize with the GIVEN owner pubkey (may be an off-curve PDA — token-2022
  // does not require the owner to sign a fresh initialize_account).
  const initIx = new TransactionInstruction({
    keys: [
      { pubkey: acc.publicKey, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
    ],
    programId: prog,
    data: Buffer.from([1]), // InitializeAccount
  });
  const tx = new Transaction().add(createIx, initIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(payer, acc);
  await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(bs58.encode(tx.signatures[0].signature!), "confirmed");
  saveState({ [`${key}_pub`]: acc.publicKey.toBase58() });
  return { pubkey: acc.publicKey, keypair: acc };
}

async function main() {
  const mode = process.argv[2];
  if (!mode) {
    console.log("usage: x1c.ts <init-mint|set-cap|create-vault|create-account|deposit|withdraw> ...");
    return;
  }
  const conn = new Connection(RPC_URL, "confirmed");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(FUNDER_KEYPAIR, "utf8"))));
  const provider = new AnchorProvider(conn, {
    publicKey: payer.publicKey,
    signTransaction: async (tx: any) => { tx.sign(payer); return tx; },
    signAllTransactions: async (txs: any[]) => { txs.forEach(t => t.sign(payer)); return txs; },
  } as any, { commitment: "confirmed" });
  const program = new (Program as any)(IDL, provider);
  const state = loadState();

  // ============================ INIT-MINT (REAL, backed, capped) =============
  if (mode === "init-mint") {
    // args: init-mint <supply_cap_raw> [backing_mint]
    const capRaw = BigInt(process.argv[3] || "1000000000000");
    if (capRaw <= 0n) throw new Error("init-mint <supply_cap_raw> [backing_mint]");

    // 1. Backing mint = the REAL asset this confidential token wraps.
    let backingMint: PublicKey;
    const backingArg = process.argv[4];
    let backingKeypair = null;
    if (backingArg) {
      backingMint = new PublicKey(backingArg);
    } else {
      const bm = Keypair.generate();
      backingKeypair = bm;
      const blen = getMintLen([]);
      const blamports = await conn.getMinimumBalanceForRentExemption(blen);
      const bCreate = SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: bm.publicKey, lamports: blamports, space: blen, programId: TOKEN_2022_PROGRAM });
      const bInit = createInitializeMint2Instruction(bm.publicKey, DEFAULT_BACKING_DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM);
      await sendAndWait(conn, new Transaction().add(bCreate, bInit), [payer, bm]);
      // treasury (payer) mints a REAL supply of backing so users can be funded
      backingMint = bm.publicKey;
      saveState({ backingMint: backingMint.toBase58() });
    }

    // 2. Conf-mint PDA = confidential mint's authority (program-controlled).
    //    It derives from the mint's public key, which is known BEFORE we create
    //    the account — so we set the mint authority to the PDA directly,
    //    meaning no user wallet can ever mint confidential tokens.
    const mint = Keypair.generate();
    const [cfg0, pdaBump] = deriveConfMintPDA(mint.publicKey);
    pdaBump; // (unused marker for clarity)
    const mintLen = getMintLen([ExtensionType.ConfidentialTransferMint]);
    const lamports = await conn.getMinimumBalanceForRentExemption(mintLen);
    const createIx = SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports, space: mintLen, programId: TOKEN_2022_PROGRAM });
    const initCt = toWeb3Ix(getInitializeConfidentialTransferMintInstruction({ mint: mint.publicKey.toBase58() as any, authority: { __option: "Some", value: cfg0.toBase58() as any }, autoApproveNewAccounts: true, auditorElgamalPubkey: { __option: "None" } as any }));
    // same decimals as the backing mint; mint authority = conf-mint PDA; NO freeze authority
    const decimals = await readMintDecimals(conn, backingMint);
    const initMint = createInitializeMint2Instruction(mint.publicKey, decimals, cfg0, null, TOKEN_2022_PROGRAM);
    await sendAndWait(conn, new Transaction().add(createIx, initCt, initMint), [payer, mint]);
    const [cfg] = deriveConfMintPDA(mint.publicKey);
    if (cfg.toBase58() !== cfg0.toBase58()) throw new Error("conf-mint pda mismatch");

    // 3. Reserve = program-owned token account holding backing. Its owner is the
    //    conf-mint PDA (off-curve) so the program can release backing on unwrap.
    //    Created directly under the token-2022 program (ATA program targets canonical
    //    token id, not our custom one). The reserve is owned by the off-curve PDA;
    //    token-2022 allows an off-curve owner via the signer=authority on transfer.
    // The reserve must live under the token program that owns the backing mint.
    const backingInfo = await conn.getAccountInfo(backingMint);
    if (!backingInfo) throw new Error("backing mint not found: " + backingMint.toBase58());
    const { pubkey: reserve } = await getOrCreateDirectTokenAccount(conn, payer, cfg, backingMint, `reserve_${mint.publicKey.toBase58()}`, backingInfo.owner);

    // 4. Register under the program with the hard cap.
    await program.methods.initConfidentialMint(new BN(capRaw.toString()))
      .accounts({
        config: cfg, mint: mint.publicKey, backingMint, reserve,
        payer: payer.publicKey, program: PROGRAM_ID, programData: PROGRAM_DATA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM,
      }).signers([payer]).rpc();

    saveState({ mint: mint.publicKey.toBase58(), confAcct: "", backingMint: backingMint.toBase58(), reserve: reserve.toBase58(), supplyCap: capRaw.toString(), config: cfg.toBase58() });
    console.log("RESULT:" + JSON.stringify({ ok: true, mint: mint.publicKey.toBase58(), configPda: cfg.toBase58(), backingMint: backingMint.toBase58(), reserve: reserve.toBase58(), supplyCap: capRaw.toString() }));
    return;
  }

  if (!state?.mint) throw new Error("no mint — run init-mint first");
  const mint = new PublicKey(state.mint);
  const backingMint = state.backingMint ? new PublicKey(state.backingMint) : null;
  const [cfg] = deriveConfMintPDA(mint);
  const [vaultPDA] = deriveVaultPDA(payer.publicKey, mint);

  if (mode === "set-cap") {
    const newCap = BigInt(process.argv[3] || "0");
    if (newCap <= 0n) throw new Error("set-cap <new_cap_raw> (can only lower)");
    await program.methods.setCap(new BN(newCap.toString())).accounts({ config: cfg, mint, authority: payer.publicKey }).signers([payer]).rpc();
    saveState({ supplyCap: newCap.toString() });
    console.log("RESULT:" + JSON.stringify({ ok: true, supplyCap: newCap.toString() }));
    return;
  }

  // ============================ CREATE-VAULT ==================================
  if (mode === "create-vault") {
    await program.methods.createVault().accounts({ vault: vaultPDA, owner: payer.publicKey, mint, payer: payer.publicKey, systemProgram: SystemProgram.programId }).signers([payer]).rpc();
    saveState({ vault: vaultPDA.toBase58() });
    console.log("RESULT:" + JSON.stringify({ ok: true, vault: vaultPDA.toBase58() }));
    return;
  }

  // ============================ CREATE-ACCOUNT ================================
  if (mode === "create-account") {
    const acct = await createConfAccount(conn, payer, payer.publicKey, mint);
    saveState({ confAcct: acct.toBase58() });
    console.log("RESULT:" + JSON.stringify({ ok: true, confidentialAccount: acct.toBase58() }));
    return;
  }

  const confAcct = state.confAcct ? new PublicKey(state.confAcct) : null;
  if (!confAcct) throw new Error("no confidential account — run create-account first");
  if (!backingMint || !state.reserve) throw new Error("no backing/reserve — re-init-mint");

  // ============================ DEPOSIT ========================================
  // wrap: move REAL backing ATA -> RESERVE; the program mints conf tokens 1:1
  // (hard-capped) via its PDA authority, and the owner relays the Deposit CPI.
  if (mode === "deposit") {
    const amount = BigInt(process.argv[3] || "0");
    if (amount <= 0n) throw new Error("deposit <amount>");
    // Ensure the payer's BACKING token account exists (source of the real value).
    const { pubkey: backingSource } = await getOrCreateDirectTokenAccount(conn, payer, payer.publicKey, backingMint, "backingSource", BACKING_TOKEN_PROGRAM);
    // If the backing token account is empty (or backing was just created), fund it a
    // real amount from the treasury (payer is the backing mint authority = real issuer).
    const bal = await conn.getTokenAccountBalance(backingSource).catch(() => ({ value: { amount: "0" } }));
    if (bal.value.amount === "0") {
      // treasury mints the REAL backing the user is about to deposit
      await sendAndWait(conn, new Transaction().add(createMintToInstruction(backingMint, backingSource, payer.publicKey, amount, [], BACKING_TOKEN_PROGRAM)), [payer]);
    }
    const reserve = new PublicKey(state.reserve);
    const feeAccount = await ensureFeeAta(conn, payer, backingMint, BACKING_TOKEN_PROGRAM);
    await program.methods.confidentialDeposit(new BN(amount.toString()))
      .accounts({
        vault: vaultPDA, config: cfg, mint, backingMint, userConf: confAcct,
        backingSource, reserve, feeAccount,
        owner: payer.publicKey, confTokenProgram: TOKEN_2022_PROGRAM, backingTokenProgram: BACKING_TOKEN_PROGRAM, systemProgram: SystemProgram.programId,
      }).signers([payer]).rpc();
    console.log("RESULT:" + JSON.stringify({ ok: true, deposited: amount.toString(), net: (amount - feeOn(amount)).toString(), fee: feeOn(amount).toString(), backingSource: backingSource.toBase58(), reserve: reserve.toBase58(), vault: vaultPDA.toBase58() }));
    return;
  }

  // ============================ WITHDRAW ======================================
  if (mode === "withdraw") {
    const amount = BigInt(process.argv[3] || "0");
    if (amount <= 0n) throw new Error("withdraw <amount>");
    const { pubkey: backingDest } = await getOrCreateDirectTokenAccount(conn, payer, payer.publicKey, backingMint, "backingDest", BACKING_TOKEN_PROGRAM);
    const reserve = new PublicKey(state.reserve);
    await program.methods.confidentialWithdraw(new BN(amount.toString()))
      .accounts({
        vault: vaultPDA, config: cfg, mint, backingMint, userConf: confAcct,
        backingDest, reserve,
        owner: payer.publicKey, confTokenProgram: TOKEN_2022_PROGRAM, backingTokenProgram: BACKING_TOKEN_PROGRAM, systemProgram: SystemProgram.programId,
      }).signers([payer]).rpc();
    console.log("RESULT:" + JSON.stringify({ ok: true, withdrawn: amount.toString(), fee: "0", backingDest: backingDest.toBase58(), reserve: reserve.toBase58(), vault: vaultPDA.toBase58() }));
    return;
  }

  console.log("unknown mode: " + mode);
}

main().catch((e) => { console.error("ERROR", e?.message || e); if (e?.stack) console.error(e.stack); if (e?.logs) console.error("logs:", (e.logs||[]).slice(-12)); process.exit(1); });
