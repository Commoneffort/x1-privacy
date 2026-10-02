/// <reference types="node" />
// On-chain smoke test: wrap NATIVE XNT into cXNT with the same instruction
// sequence the web UI uses (wrap native -> deposit -> close the temp account).
//   FUNDER_KEYPAIR=<wallet.json> ts-node tests/native_wrap_smoke.ts <lamports>
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction,
} from "@solana/spl-token";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
const IDL = require("../target/idl/x1_confidential.json");
// PROGRAM_ID overrides the id baked into the IDL (e.g. to target another cluster's deployment).
if (process.env.PROGRAM_ID) IDL.address = process.env.PROGRAM_ID;

const RPC = process.env.CONF_RPC || "https://rpc.testnet.x1.xyz";
const st = JSON.parse(fs.readFileSync(process.env.X1C_STATE || path.join(__dirname, "../client/x1c_state.json"), "utf8"));
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.FUNDER_KEYPAIR!, "utf8"))));
const CONF_TOKEN = new PublicKey(process.env.TOKEN2022_PROGRAM || "5YJHiUfvTaoyyvhQVp7bVz1hbXbhLxaERAyFryVn9hhL");
const FEE_RECIPIENT = new PublicKey("GACCq8Yd4szdB7mCcaViFNwDEej4crZe43YoSPCzmb8M");

async function main() {
  const amount = BigInt(process.argv[2] || "10000000");
  const conn = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(conn, { publicKey: payer.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any, { commitment: "confirmed" });
  const program = new (Program as any)(IDL, provider);
  const mint = new PublicKey(st.mint), cfg = new PublicKey(st.config), reserve = new PublicKey(st.reserve);
  if (st.backingMint !== NATIVE_MINT.toBase58()) throw new Error("state is not a native-backed deployment");
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), payer.publicKey.toBuffer(), mint.toBuffer()], program.programId);
  const wxnt = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey, false, TOKEN_PROGRAM_ID);
  const feeAccount = getAssociatedTokenAddressSync(NATIVE_MINT, FEE_RECIPIENT, false, TOKEN_PROGRAM_ID);

  const before = await conn.getBalance(payer.publicKey);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, wxnt, payer.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wxnt, lamports: amount }),
    createSyncNativeInstruction(wxnt, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, feeAccount, FEE_RECIPIENT, NATIVE_MINT, TOKEN_PROGRAM_ID),
    await program.methods.confidentialDeposit(new BN(amount.toString())).accounts({
      vault, config: cfg, mint, backingMint: NATIVE_MINT, userConf: new PublicKey(st.confAcct), backingSource: wxnt, reserve, feeAccount,
      owner: payer.publicKey, confTokenProgram: CONF_TOKEN, backingTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction(),
    createCloseAccountInstruction(wxnt, payer.publicKey, payer.publicKey, [], TOKEN_PROGRAM_ID),
  );
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  console.log("tx size", tx.serialize().length, "bytes (limit 1232)");
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  const after = await conn.getBalance(payer.publicKey);
  const c = await program.account.confidentialMintConfig.fetch(cfg);
  const res = await conn.getTokenAccountBalance(reserve, "confirmed");
  const fee = await conn.getTokenAccountBalance(feeAccount, "confirmed");
  const wx = await conn.getAccountInfo(wxnt, "confirmed");
  console.log("RESULT:" + JSON.stringify({
    ok: true, sig, wrapped: amount.toString(), nativeSpent: (before - after).toString(),
    confidentialSupply: c.confidentialSupply.toString(), reserve: res.value.amount, feeAccountBalance: fee.value.amount,
    tempWxntAccountClosed: wx === null,
  }));
}
main().catch((e) => { console.error("ERROR", e?.message || e); if (e?.logs) console.error((e.logs || []).slice(-10).join("\n")); process.exit(1); });
