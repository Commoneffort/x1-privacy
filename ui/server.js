import express from "express";
import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import https from "https";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROG = path.resolve(__dirname, "../program");
// NETWORK selects the cluster defaults. Mainnet uses the chain's own Token-2022
// program (it supports confidential transfers there) and never runs a faucet.
const NETWORK = process.env.NETWORK === "mainnet" ? "mainnet" : "testnet";
const MAINNET = NETWORK === "mainnet";
const RPC = process.env.CONF_RPC || (MAINNET ? "https://rpc.mainnet.x1.xyz" : "https://rpc.testnet.x1.xyz");
const PROOFGEN = process.env.PROOFGEN || path.resolve(__dirname, "../proofgen/target/x86_64-unknown-linux-gnu/release/proofgen51");
const BACKING_TOKEN_PROGRAM = process.env.BACKING_TOKEN_PROGRAM || "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// No default on mainnet: the record program id is only known once it is deployed there.
const RECORD_PROGRAM = process.env.RECORD_PROGRAM || (MAINNET ? "" : "Gwi2C6TfDHR8kG6YJphktj3VtNxbQFcRddNjcbrDmg8C") // testnet: official spl-record 0.3.0 built from source;
const TOKEN2022_PROGRAM = process.env.TOKEN2022_PROGRAM || (MAINNET ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" : "5YJHiUfvTaoyyvhQVp7bVz1hbXbhLxaERAyFryVn9hhL");
if (MAINNET && !RECORD_PROGRAM) throw new Error("NETWORK=mainnet requires RECORD_PROGRAM");
// Defaults to the program id baked into the IDL (kept in sync by set_program_id.py).
const PROGRAM_ID = process.env.PROGRAM_ID || JSON.parse(fs.readFileSync(path.join(PROG, "target/idl/x1_confidential.json"), "utf8")).address;
// X1C_STATE / X1C_USDCX_STATE / X1C_MOCK_USDCX select which deployment files are served.
const STATE_FILE = process.env.X1C_STATE || path.join(PROG, "client/x1c_state.json");

// ---------------------------------------------------------------------------
// Keys. This server is reachable by browsers, so it must NEVER hold a key with
// authority over the protocol (program upgrade authority, cap governance).
//
//   FAUCET_KEYPAIR  — a low-value testnet wallet: holds the XNT the faucet hands
//                     out, pays ATA rent, and is the mint authority of the MOCK
//                     USDC.x mint. Faucet endpoints are disabled if it is absent.
//   ADMIN_KEYPAIR   — only read by the /api/action CLI bridge, which is itself
//                     disabled unless ADMIN_TOKEN is set.
// ---------------------------------------------------------------------------
const FAUCET_KEYPAIR = process.env.FAUCET_KEYPAIR || ""; // testnet only; the faucet stays off without it
const ADMIN_KEYPAIR = process.env.ADMIN_KEYPAIR || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

function loadKeypair(file) {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(file, "utf8"))));
}
let faucetPayer = null;
if (!MAINNET) try {
  faucetPayer = loadKeypair(FAUCET_KEYPAIR);
  console.log("Faucet wallet:", faucetPayer.publicKey.toBase58());
} catch (e) {
  console.warn("Faucet keypair missing (" + FAUCET_KEYPAIR + ") — faucet endpoints disabled.");
}

// Faucet limits (whole tokens per request; one request per recipient per window).
const FAUCET_XNT = BigInt(process.env.FAUCET_XNT || "500");
const FAUCET_TOKEN = BigInt(process.env.FAUCET_TOKEN || "5000");
const FAUCET_WINDOW_MS = Number(process.env.FAUCET_WINDOW_MS || 10 * 60 * 1000);
const IP_MAX_PER_WINDOW = Number(process.env.FAUCET_IP_MAX || 5);

const app = express();
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY);
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "no-referrer");
  // No inline scripts: the UI wires its buttons with data-act attributes. The
  // derived confidential keys live in this page, so script and connect targets
  // are pinned to this origin and the RPC.
  res.set("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    // the RPC over HTTPS, plus its WebSocket (transaction confirmations use it)
    "connect-src 'self' " + new URL(RPC).origin + " " + new URL(RPC).origin.replace(/^http/, "ws"),
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; "));
  next();
});
app.use(express.static(path.join(__dirname, "public")));

const conn = new Connection(RPC, "confirmed");
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
};
const readState = () => readJson(STATE_FILE);

// USDC.x (testnet mock) deployment. Kept in its own files so the cXNT
// deployment is never touched.
const USDCX_STATE_FILE = process.env.X1C_USDCX_STATE || path.join(PROG, "client/x1c_usdcx_state.json");
const USDCX_BACKING_FILE = process.env.X1C_MOCK_USDCX || path.join(PROG, "client/mockusdcx.json");
const readUsdcxState = () => readJson(USDCX_STATE_FILE);
const readMockUsdcx = () => readJson(USDCX_BACKING_FILE);

// Only ever expose PUBLIC deployment addresses. The state files are written by
// the CLI and may also contain key material.
const PUBLIC_STATE_KEYS = ["mint", "backingMint", "reserve", "config", "supplyCap", "vault", "swap"];
function publicState(state) {
  if (!state) return null;
  const out = {};
  for (const k of PUBLIC_STATE_KEYS) if (typeof state[k] === "string" && state[k]) out[k] = state[k];
  return out;
}

function parsePubkey(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return null;
  try { return new PublicKey(value); } catch { return null; }
}

// Decimals (base Mint layout, byte 44) and owning token program, straight from
// each mint account.
const mintCache = new Map();
async function mintInfo(mintB58) {
  if (!mintB58) return null;
  if (mintCache.has(mintB58)) return mintCache.get(mintB58);
  try {
    const info = await conn.getAccountInfo(new PublicKey(mintB58));
    if (info && info.data.length >= 82) {
      const out = { decimals: info.data[44], program: info.owner.toBase58() };
      mintCache.set(mintB58, out);
      return out;
    }
  } catch { /* fall through */ }
  return null;
}
async function mintDecimals(mintB58, fallback) {
  const m = await mintInfo(mintB58);
  return m ? m.decimals : fallback;
}

// One token entry for the UI, with decimals and token programs read from chain.
async function tokenEntry(symbol, backingSymbol, t) {
  const backing = await mintInfo(t.backingMint);
  const conf = await mintInfo(t.mint);
  if (!backing || !conf) return null;
  return {
    symbol, backingSymbol,
    backingMint: t.backingMint, backingDecimals: backing.decimals, backingProgram: backing.program,
    mint: t.mint, mintDecimals: conf.decimals,
    reserve: t.reserve, config: t.address || t.config,
    supplyCap: t.supplyCap, confidentialSupply: t.confidentialSupply,
  };
}

// Build the token registry the UI consumes. cXNT is authoritative from the live
// on-chain config read; cUSDC.x comes from its deployment file.
async function buildTokens(onchain) {
  const tokens = {};
  const xntCfg = (onchain && onchain.config) ? onchain.config : publicState(readState());
  if (xntCfg && xntCfg.mint) {
    const e = await tokenEntry("cXNT", "XNT", xntCfg);
    if (e) tokens.cXNT = e;
  }
  const u = readUsdcxState();
  if (u && u.mint) {
    const e = await tokenEntry("cUSDC.x", "USDC.x", u);
    if (e) tokens["cUSDC.x"] = e;
  }
  return tokens;
}

// CLI bridge (admin only — see /api/action). Verbs that change governance or
// create deployments are deliberately NOT reachable over HTTP.
const ACTION_CLIENTS = {
  "deposit": "client/x1c.ts",
  "withdraw": "client/x1c.ts",
  "create-vault": "client/x1c.ts",
  "create-account": "client/x1c.ts",
  "new-account": "client/x1c_swap.ts",
  "status": "client/x1c_swap.ts",
};
const ACTION_ARG = /^[A-Za-z0-9._-]{1,64}$/;
const runClient = (args) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "npx", ["ts-node", "--compiler-options",
        '{"module":"commonjs","esModuleInterop":true,"skipLibCheck":true,"target":"es2020","resolveJsonModule":true}',
        ACTION_CLIENTS[args[0]], ...args],
      { cwd: PROG, env: { ...process.env, CONF_RPC: RPC, PROOFGEN, RECORD_PROGRAM, TOKEN2022_PROGRAM, BACKING_TOKEN_PROGRAM, FUNDER_KEYPAIR: ADMIN_KEYPAIR }, timeout: 240000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || stdout || err.message));
        const m = stdout.match(/RESULT:(\{.*\})/s);
        if (m) return resolve(JSON.parse(m[1]));
        return resolve({ ok: true, raw: stdout.trim() });
      }
    );
    child.stderr && child.stderr.on("data", (d) => process.env.DBG && console.error("[client]", d.toString()));
  });

// fetch on-chain vault + mint + swap + account (read-only: no real wallet needed)
async function fetchOnchain(state) {
  const out = { rpc: RPC, program: PROGRAM_ID };
  try {
    const readOnly = Keypair.generate();
    const idl = JSON.parse(fs.readFileSync(path.join(PROG, "target/idl/x1_confidential.json"), "utf8"));
    const provider = new anchor.AnchorProvider(conn, {
      publicKey: readOnly.publicKey,
      signTransaction: async () => { throw new Error("read-only provider"); },
      signAllTransactions: async () => { throw new Error("read-only provider"); },
    }, { commitment: "confirmed" });
    const program = new anchor.Program(idl, provider);

    if (state?.vault) {
      const v = await program.account.vault.fetch(new PublicKey(state.vault));
      out.vault = {
        address: state.vault,
        owner: v.owner.toBase58(),
        mint: v.mint.toBase58(),
        totalConfidential: v.totalConfidential.toString(),
        nonce: v.nonce.toString(),
      };
    }
    if (state?.config) {
      const c = await program.account.confidentialMintConfig.fetch(new PublicKey(state.config));
      try {
        const bal = await conn.getTokenAccountBalance(c.reserve, "confirmed");
        out.reserveBacking = bal.value.amount;
      } catch { out.reserveBacking = "0"; }
      out.config = {
        address: state.config,
        mint: c.mint.toBase58(),
        backingMint: c.backingMint.toBase58(),
        reserve: c.reserve.toBase58(),
        authority: c.authority.toBase58(),
        supplyCap: c.supplyCap.toString(),
        confidentialSupply: c.confidentialSupply.toString(),
        bump: c.bump,
      };
    }
    if (state?.mint) {
      const mi = await conn.getAccountInfo(new PublicKey(state.mint));
      out.mint = { address: state.mint, dataLen: mi ? mi.data.length : 0 };
    }
    if (state?.backingMint) {
      const mi = await conn.getAccountInfo(new PublicKey(state.backingMint));
      out.backingMint = { address: state.backingMint, dataLen: mi ? mi.data.length : 0 };
    }
    if (state?.swap) {
      const s = await program.account.swap.fetch(new PublicKey(state.swap));
      const statuses = ["Open", "Locked", "Settled", "Cancelled"];
      out.swap = {
        address: state.swap,
        maker: s.maker.toBase58(),
        taker: s.taker.toBase58(),
        mint: s.mint.toBase58(),
        makerEscrow: s.makerEscrow.toBase58(),
        status: statuses[s.status] || String(s.status),
      };
    }
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Faucet guards: fixed amounts, one grant per recipient per window, and a
// per-IP ceiling. In-memory only (testnet faucet); resets on restart.
// ---------------------------------------------------------------------------
const recipientSeen = new Map(); // "<kind>:<recipient>" -> timestamp
const ipSeen = new Map();        // ip -> [timestamps]
function faucetGuard(kind) {
  return (req, res, next) => {
    if (!faucetPayer) return res.status(503).json({ ok: false, error: "faucet is not configured on this server" });
    const to = parsePubkey(req.body && req.body.to);
    if (!to) return res.status(400).json({ ok: false, error: "a valid recipient address is required" });
    const now = Date.now();
    const ip = req.ip || "unknown";
    const hits = (ipSeen.get(ip) || []).filter((t) => now - t < FAUCET_WINDOW_MS);
    if (hits.length >= IP_MAX_PER_WINDOW) return res.status(429).json({ ok: false, error: "too many requests — try again later" });
    hits.push(now);
    ipSeen.set(ip, hits);
    if (kind) {
      const key = kind + ":" + to.toBase58();
      const last = recipientSeen.get(key) || 0;
      if (now - last < FAUCET_WINDOW_MS) return res.status(429).json({ ok: false, error: "this wallet was funded recently — try again later" });
      recipientSeen.set(key, now);
      res.on("finish", () => { if (res.statusCode >= 400) recipientSeen.delete(key); });
    }
    req.recipient = to;
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of recipientSeen) if (now - t >= FAUCET_WINDOW_MS) recipientSeen.delete(k);
  for (const [k, ts] of ipSeen) if (!ts.some((t) => now - t < FAUCET_WINDOW_MS)) ipSeen.delete(k);
}, 60 * 1000).unref();

async function sendFaucetTx(tx) {
  const block = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = block.blockhash;
  tx.feePayer = faucetPayer.publicKey;
  tx.sign(faucetPayer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

function xntMint() {
  const state = readState();
  const mint = parsePubkey(state && state.backingMint);
  if (!mint) throw new Error("no cXNT deployment configured");
  return mint;
}
function mockUsdcxMint() {
  const mock = readMockUsdcx();
  const mint = parsePubkey(mock && mock.mint);
  if (!mint) throw new Error("no mock usdcx deployment");
  return mint;
}

// Create `owner`'s ATA for `mint` if missing (faucet wallet pays rent).
async function ensureAta(mint, owner) {
  const { createAssociatedTokenAccountInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
  const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const existing = await conn.getAccountInfo(ata);
  const ix = existing ? null : createAssociatedTokenAccountInstruction(faucetPayer.publicKey, ata, owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  return { ata, ix };
}

// Faucet: move a FIXED amount of XNT from the faucet wallet to a target wallet
// (testnet funding only). Creates the target's XNT ATA if needed.
app.post("/api/faucet", faucetGuard("xnt"), async (req, res) => {
  try {
    const mint = xntMint();
    const to = req.recipient;
    const { createTransferInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
    const { ata: toAta, ix: createIx } = await ensureAta(mint, to);
    const fromAta = await getAssociatedTokenAddress(mint, faucetPayer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const decimals = BigInt(await mintDecimals(mint.toBase58(), 9));
    const tx = new anchor.web3.Transaction();
    if (createIx) tx.add(createIx);
    tx.add(createTransferInstruction(fromAta, toAta, faucetPayer.publicKey, FAUCET_XNT * 10n ** decimals, [], TOKEN_PROGRAM_ID));
    const sig = await sendFaucetTx(tx);
    res.json({ ok: true, to: to.toBase58(), amount: Number(FAUCET_XNT), ata: toAta.toBase58(), sig });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Create the receiving wallet's XNT ATA WITHOUT funding. Needed so withdraw
// (cXNT -> XNT unwrap) has a destination even if that wallet never held XNT.
app.post("/api/ensure-xnt-ata", faucetGuard(null), async (req, res) => {
  try {
    const to = req.recipient;
    const { ata, ix } = await ensureAta(xntMint(), to);
    if (!ix) return res.json({ ok: true, to: to.toBase58(), ata: ata.toBase58(), created: false });
    const sig = await sendFaucetTx(new anchor.web3.Transaction().add(ix));
    res.json({ ok: true, to: to.toBase58(), ata: ata.toBase58(), created: true, sig });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/state", async (req, res) => {
  const state = publicState(readState());
  const onchain = await fetchOnchain(state);
  const tokens = await buildTokens(onchain);
  res.json({
    network: NETWORK, rpc: RPC, program: PROGRAM_ID,
    confTokenProgram: TOKEN2022_PROGRAM, recordProgram: RECORD_PROGRAM,
    faucet: !!faucetPayer && !MAINNET,
    state, tokens, ...onchain,
  });
});

// Fund a wallet with a FIXED amount of the MOCK USDC.x (testnet only). The
// faucet wallet must be the mock mint's mint authority.
app.post("/api/faucet-token", faucetGuard("usdcx"), async (req, res) => {
  try {
    const mint = mockUsdcxMint();
    const to = req.recipient;
    const { createMintToInstruction, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
    const { ata: toAta, ix: createIx } = await ensureAta(mint, to);
    const decimals = BigInt(await mintDecimals(mint.toBase58(), 6));
    const tx = new anchor.web3.Transaction();
    if (createIx) tx.add(createIx);
    tx.add(createMintToInstruction(mint, toAta, faucetPayer.publicKey, FAUCET_TOKEN * 10n ** decimals, [], TOKEN_PROGRAM_ID));
    const sig = await sendFaucetTx(tx);
    res.json({ ok: true, to: to.toBase58(), amount: Number(FAUCET_TOKEN), ata: toAta.toBase58(), sig });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Ensure a wallet has a MOCK USDC.x ATA (no funding). For withdraw destination.
app.post("/api/ensure-ata", faucetGuard(null), async (req, res) => {
  try {
    const to = req.recipient;
    const { ata, ix } = await ensureAta(mockUsdcxMint(), to);
    if (!ix) return res.json({ ok: true, to: to.toBase58(), ata: ata.toBase58(), created: false });
    const sig = await sendFaucetTx(new anchor.web3.Transaction().add(ix));
    res.json({ ok: true, to: to.toBase58(), ata: ata.toBase58(), created: true, sig });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Operator-only CLI bridge. Disabled unless ADMIN_TOKEN and ADMIN_KEYPAIR are
// both set; requires `Authorization: Bearer <ADMIN_TOKEN>`. The web UI never
// calls it.
function isAdmin(req) {
  if (!ADMIN_TOKEN || !ADMIN_KEYPAIR) return false;
  const given = Buffer.from(String(req.get("authorization") || ""));
  const want = Buffer.from("Bearer " + ADMIN_TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
app.post("/api/action", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "forbidden" });
  const { action, args = [] } = req.body || {};
  if (typeof action !== "string" || !ACTION_CLIENTS[action]) return res.status(400).json({ ok: false, error: "unknown action" });
  if (!Array.isArray(args) || args.length > 4 || !args.every((a) => ACTION_ARG.test(String(a)))) {
    return res.status(400).json({ ok: false, error: "invalid args" });
  }
  try {
    const result = await runClient([action, ...args.map(String)]);
    const state = publicState(readState());
    const onchain = await fetchOnchain(state);
    res.json({ ok: true, result, state, onchain });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Listen on loopback by default; put a reverse proxy in front, or set HOST
// explicitly, to expose it.
const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || 8910;
const HTTPS_PORT = process.env.HTTPS_PORT || 8913;
app.listen(PORT, HOST, () => console.log(`X1-Confidential UI on http://${HOST}:${PORT}`));

// Direct HTTPS listener (secure context for wallet-extension injection).
try {
  const key = fs.readFileSync(process.env.TLS_KEY || "/etc/nginx/certs/conf.key");
  const cert = fs.readFileSync(process.env.TLS_CERT || "/etc/nginx/certs/conf.crt");
  const httpsServer = https.createServer({ key, cert }, app);
  httpsServer.listen(HTTPS_PORT, HOST, () =>
    console.log(`X1-Confidential UI on https://${HOST}:${HTTPS_PORT}`));
} catch (e) {
  console.log("HTTPS listener skipped:", e.message);
}
