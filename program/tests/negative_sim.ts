/// <reference types="node" />
// Simulation-only checks (nothing is sent): the hardened paths must reject.
//   X1C_STATE=<state.json> FUNDER_KEYPAIR=<authority.json> ts-node tests/negative_sim.ts
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import * as fs from "fs";
const IDL = require("../target/idl/x1_confidential.json");
// PROGRAM_ID overrides the id baked into the IDL (e.g. to target another cluster's deployment).
if (process.env.PROGRAM_ID) IDL.address = process.env.PROGRAM_ID;

const RPC = process.env.CONF_RPC || "https://rpc.testnet.x1.xyz";
const st = JSON.parse(fs.readFileSync(process.env.X1C_STATE!, "utf8"));
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.FUNDER_KEYPAIR!, "utf8"))));
const TOKENKEG = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const CONF_TOKEN = new PublicKey(process.env.TOKEN2022_PROGRAM || "5YJHiUfvTaoyyvhQVp7bVz1hbXbhLxaERAyFryVn9hhL");
const RECORD = new PublicKey(process.env.RECORD_PROGRAM || "CS5QTrrjmkj7ErAtNPsmQ7uGReBuzoU69DfF34KppDV6");

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(conn, { publicKey: payer.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any, { commitment: "confirmed" });
  const program = new (Program as any)(IDL, provider);
  const mint = new PublicKey(st.mint), backingMint = new PublicKey(st.backingMint), cfg = new PublicKey(st.config), reserve = new PublicKey(st.reserve);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), payer.publicKey.toBuffer(), mint.toBuffer()], program.programId);
  const names: Record<number, string> = {}; for (const e of IDL.errors) names[e.code] = e.name;

  const sim = async (label: string, expect: string, ix: any) => {
    const tx = new Transaction().add(ix);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const r = await conn.simulateTransaction(tx);
    const err: any = r.value.err;
    const custom = err?.InstructionError?.[1]?.Custom;
    const got = custom !== undefined ? (names[custom] || "Custom(" + custom + ")") : (err ? JSON.stringify(err) : "SUCCESS");
    const line = (r.value.logs || []).filter((l) => /Error|failed|insufficient/i.test(l)).slice(-1)[0] || "";
    console.log(`${got === expect ? "PASS" : "FAIL"}  ${label}\n      expected ${expect}, got ${got}${line ? "\n      " + line.slice(0, 160) : ""}`);
  };
  const wd = (confTokenProgram: PublicKey, backingDest: PublicKey, amount: number) =>
    program.methods.confidentialWithdraw(new BN(amount)).accounts({
      vault, config: cfg, mint, backingMint, userConf: new PublicKey(st.confAcct), backingDest, reserve,
      owner: payer.publicKey, confTokenProgram, backingTokenProgram: TOKENKEG, systemProgram: SystemProgram.programId,
    }).instruction();
  const dest = new PublicKey(st.backingDest_pub || st.backingSource_pub);

  await sim("withdraw with a substitute token program for the burn (record program)", "TokenProgramMismatch", await wd(RECORD, dest, 1000));
  await sim("withdraw with a substitute token program for the burn (Tokenkeg)", "TokenProgramMismatch", await wd(TOKENKEG, dest, 1000));
  await sim("withdraw with the real token program but no burnable balance", "Custom(1)", await wd(CONF_TOKEN, dest, 1000));
  await sim("withdraw paying out to the reserve itself", "DestOwnerMismatch", await wd(CONF_TOKEN, reserve, 1000));
  await sim("set_cap below the outstanding supply", "CapBelowSupply",
    await program.methods.setCap(new BN(1)).accounts({ config: cfg, mint, authority: payer.publicKey }).instruction());
  await sim("set_cap to zero", "InvalidCap",
    await program.methods.setCap(new BN(0)).accounts({ config: cfg, mint, authority: payer.publicKey }).instruction());
  await sim("set_cap raise", "CapCantIncrease",
    await program.methods.setCap(new BN("2000000000000000")).accounts({ config: cfg, mint, authority: payer.publicKey }).instruction());
  const seed = Array.from(new Uint8Array(32).fill(7));
  const [swap] = PublicKey.findProgramAddressSync([Buffer.from("swap"), payer.publicKey.toBuffer(), mint.toBuffer(), Buffer.from(seed)], program.programId);
  const z = Array.from(new Uint8Array(64));
  await sim("open_swap (swaps disabled in this build)", "SwapsDisabled",
    await program.methods.openSwap(seed, z, z, z, z, Buffer.alloc(169)).accounts({
      swap, config: cfg, mint, makerSource: new PublicKey(st.confAcct), escrow: new PublicKey(st.confAcct),
      maker: payer.publicKey, confTokenProgram: CONF_TOKEN, systemProgram: SystemProgram.programId,
    }).instruction());
}
main().catch((e) => { console.error("ERROR", e?.message || e); process.exit(1); });
