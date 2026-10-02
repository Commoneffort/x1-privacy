// Shared testnet faucet logic for the Vercel deployment.
//
// The signing key (FAUCET_SECRET_KEY, a Solana JSON byte array) belongs to a
// dedicated hot wallet that holds only a stock of test tokens and a little
// native XNT for fees. It has NO authority over the protocol or any mint.
//
// Abuse limits without server state: the recipient must already have created
// their own token account (so the faucet never pays rent), and a wallet is only
// topped up while it holds less than one grant.
const { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } = require("@solana/web3.js");
const { createTransferInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const state = require("../state.json");

const RPC = process.env.CONF_RPC || "https://rpc.testnet.x1.xyz";

function tokenAmount(info) {
  return info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : null;
}

// tokenKey: key in state.tokens; grantWhole: whole backing tokens per request.
function faucetHandler(tokenKey, grantWhole) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
    try {
      const token = state.tokens && state.tokens[tokenKey];
      if (!token) return res.status(503).json({ ok: false, error: "this token has no faucet" });
      if (!process.env.FAUCET_SECRET_KEY) return res.status(503).json({ ok: false, error: "faucet is not configured" });
      const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.FAUCET_SECRET_KEY)));

      const toStr = req.body && req.body.to;
      if (typeof toStr !== "string" || toStr.length < 32 || toStr.length > 44) {
        return res.status(400).json({ ok: false, error: "a valid recipient address is required" });
      }
      let to;
      try { to = new PublicKey(toStr); } catch { return res.status(400).json({ ok: false, error: "a valid recipient address is required" }); }

      const mint = new PublicKey(token.backingMint);
      const grant = BigInt(grantWhole) * 10n ** BigInt(token.backingDecimals);
      const conn = new Connection(RPC, "confirmed");
      const toAta = getAssociatedTokenAddressSync(mint, to, true, TOKEN_PROGRAM_ID);
      const fromAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_PROGRAM_ID);
      const [toInfo, fromInfo] = await conn.getMultipleAccountsInfo([toAta, fromAta]);

      const have = tokenAmount(toInfo);
      if (have === null) return res.status(400).json({ ok: false, error: "create your " + token.backingSymbol + " token account first" });
      if (have >= grant) return res.status(429).json({ ok: false, error: "this wallet already holds faucet funds" });
      const stock = tokenAmount(fromInfo);
      if (stock === null || stock < grant) return res.status(503).json({ ok: false, error: "the " + token.backingSymbol + " faucet is empty" });

      // X1 prices a transaction by the compute units it requests; a transfer needs ~5k.
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 30000 }), createTransferInstruction(fromAta, toAta, payer.publicKey, grant, [], TOKEN_PROGRAM_ID));
      const block = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = block.blockhash;
      tx.feePayer = payer.publicKey;
      tx.sign(payer);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
      await conn.confirmTransaction({ signature: sig, ...block }, "confirmed");
      return res.status(200).json({ ok: true, to: to.toBase58(), amount: Number(grantWhole), ata: toAta.toBase58(), sig });
    } catch (e) {
      console.error("faucet error:", e && e.message);
      return res.status(500).json({ ok: false, error: "faucet transaction failed — try again" });
    }
  };
}

module.exports = { faucetHandler };
