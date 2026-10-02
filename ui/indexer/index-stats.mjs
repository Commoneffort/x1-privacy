// X1 Privacy — public statistics indexer.
//
// Reads the protocol's on-chain history and writes one aggregated JSON file for
// the stats page. It needs no key and sends nothing. Everything it reports is
// already public: wrap and unwrap amounts, and the NUMBER of confidential
// transfers (their amounts are encrypted and are not, and cannot be, read here).
//
//   node indexer/index-stats.mjs
//
// Environment:
//   STATS_DEPLOYMENT  deployment state JSON (network, rpc, program, tokens) — the same file the site serves
//   STATS_STATE       where the indexer keeps its progress (so each run only reads new transactions)
//   STATS_OUT         output file served to the stats page
//
// RPC nodes prune old history, so run it regularly (e.g. every few minutes).
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

const DEPLOYMENT = process.env.STATS_DEPLOYMENT || "/var/www/x1privacy/state.json";
const STATE = process.env.STATS_STATE || path.join(os.homedir(), ".x1privacy-indexer", "state.json");
const OUT = process.env.STATS_OUT || "/var/www/x1privacy/stats.json";
const HOURLY_DAYS = 14;        // hourly resolution is published for this many recent days
const WRAP_FEE_BPS = 39n;

const DISC_DEPOSIT = Buffer.from([73, 19, 230, 11, 25, 247, 11, 181]);
const DISC_WITHDRAW = Buffer.from([192, 153, 197, 143, 238, 85, 204, 38]);
const CT_EXT = 27, CT_CONFIGURE = 2, CT_TRANSFER = 7;

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const conn = new Connection(dep.rpc, "finalized");
const PROGRAM = new PublicKey(dep.program);
const TOKEN_PROGRAM = new PublicKey(dep.confTokenProgram);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { program: dep.program, tokens: {} }; }
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const emptyBucket = () => ({ wrapped: "0", unwrapped: "0", fees: "0", wraps: 0, unwraps: 0, transfers: 0 });
const add = (a, b) => (BigInt(a) + BigInt(b)).toString();

function newTokenState() {
  return { lastSig: null, wrapped: "0", unwrapped: "0", fees: "0", wraps: 0, unwraps: 0, transfers: 0, repairs: 0,
    accounts: 0, wallets: [], hours: {}, firstTime: null, lastTime: null };
}

// One finalized transaction -> the protocol events it contains for `mint`.
function eventsOf(tx, mint) {
  const msg = tx.transaction.message;
  const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const out = [];
  for (const ix of msg.compiledInstructions) {
    const prog = keys.get(ix.programIdIndex);
    const data = Buffer.from(ix.data);
    const acct = (i) => keys.get(ix.accountKeyIndexes[i]);
    if (prog.equals(PROGRAM) && data.length >= 16) {
      // deposit / withdraw accounts: vault, config, mint, ...
      if (!acct(2) || !acct(2).equals(mint)) continue;
      const amount = data.readBigUInt64LE(8);
      if (data.subarray(0, 8).equals(DISC_DEPOSIT)) out.push({ kind: "wrap", amount });
      else if (data.subarray(0, 8).equals(DISC_WITHDRAW)) out.push({ kind: "unwrap", amount });
    } else if (prog.equals(TOKEN_PROGRAM) && data.length >= 2 && data[0] === CT_EXT) {
      // confidential-transfer extension; account 1 is the mint for both instructions
      if (!acct(1) || !acct(1).equals(mint)) continue;
      if (data[1] === CT_TRANSFER) {
        // a transfer from an account to itself is the client's balance repair, not a payment
        out.push({ kind: acct(0).equals(acct(2)) ? "repair" : "transfer" });
      } else if (data[1] === CT_CONFIGURE) out.push({ kind: "account" });
    }
  }
  return { events: out, payer: keys.get(0).toBase58() };
}

async function newSignatures(mint, until) {
  const all = [];
  let before;
  for (;;) {
    const page = await conn.getSignaturesForAddress(mint, { before, until: until || undefined, limit: 1000 }, "finalized");
    all.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return all.reverse(); // oldest first
}

async function indexToken(sym, t, st) {
  const mint = new PublicKey(t.mint);
  const sigs = await newSignatures(mint, st.lastSig);
  const wallets = new Set(st.wallets);
  let n = 0;
  for (const s of sigs) {
    if (!s.err) {
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
      if (tx && tx.meta && !tx.meta.err) {
        const { events, payer } = eventsOf(tx, mint);
        const time = tx.blockTime || s.blockTime || 0;
        const hour = new Date(time * 1000).toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
        for (const e of events) {
          const b = st.hours[hour] || (st.hours[hour] = emptyBucket());
          if (e.kind === "wrap") {
            const fee = (e.amount * WRAP_FEE_BPS) / 10000n;
            st.wrapped = add(st.wrapped, e.amount); st.fees = add(st.fees, fee); st.wraps++;
            b.wrapped = add(b.wrapped, e.amount); b.fees = add(b.fees, fee); b.wraps++;
          } else if (e.kind === "unwrap") {
            st.unwrapped = add(st.unwrapped, e.amount); st.unwraps++;
            b.unwrapped = add(b.unwrapped, e.amount); b.unwraps++;
          } else if (e.kind === "transfer") { st.transfers++; b.transfers++; }
          else if (e.kind === "repair") st.repairs++;
          else if (e.kind === "account") st.accounts++;
          if (e.kind !== "repair") wallets.add(payer);
        }
        if (events.length && time) { st.firstTime = st.firstTime || time; st.lastTime = time; }
      }
    }
    st.lastSig = s.signature;
    if (++n % 50 === 0) { st.wallets = [...wallets]; saveState(); }
  }
  st.wallets = [...wallets];
  return sigs.length;
}

let state = loadState();
if (state.program !== dep.program) state = { program: dep.program, tokens: {} }; // different deployment: start over
function saveState() { writeAtomic(STATE, JSON.stringify(state)); }

async function tokenAmount(addr) { try { return (await conn.getTokenAccountBalance(new PublicKey(addr), "confirmed")).value.amount; } catch { return null; } }
async function configSupply(addr) {
  const info = await conn.getAccountInfo(new PublicKey(addr), "confirmed");
  return info && info.data.length >= 152 ? info.data.readBigUInt64LE(8 + 136).toString() : null;
}

function publish(live) {
  const cutoff = new Date(Date.now() - HOURLY_DAYS * 86400e3).toISOString().slice(0, 13);
  const tokens = {};
  for (const [sym, t] of Object.entries(dep.tokens)) {
    const st = state.tokens[sym];
    const days = {};
    for (const [h, b] of Object.entries(st.hours)) {
      const d = days[h.slice(0, 10)] || (days[h.slice(0, 10)] = emptyBucket());
      d.wrapped = add(d.wrapped, b.wrapped); d.unwrapped = add(d.unwrapped, b.unwrapped); d.fees = add(d.fees, b.fees);
      d.wraps += b.wraps; d.unwraps += b.unwraps; d.transfers += b.transfers;
    }
    const rows = (obj) => Object.keys(obj).sort().map((k) => ({ t: k, ...obj[k] }));
    tokens[sym] = {
      symbol: t.symbol, backingSymbol: t.backingSymbol, decimals: t.mintDecimals,
      supply: live[sym].supply, reserve: live[sym].reserve,
      wrapped: st.wrapped, unwrapped: st.unwrapped, fees: st.fees,
      wraps: st.wraps, unwraps: st.unwraps, transfers: st.transfers,
      accounts: st.accounts, wallets: st.wallets.length,
      firstTime: st.firstTime, lastTime: st.lastTime,
      daily: rows(days),
      hourly: rows(Object.fromEntries(Object.entries(st.hours).filter(([h]) => h >= cutoff))),
    };
  }
  writeAtomic(OUT, JSON.stringify({ updatedAt: Math.floor(Date.now() / 1000), network: dep.network, program: dep.program, tokens }));
}

const live = {};
for (const [sym, t] of Object.entries(dep.tokens)) {
  const st = state.tokens[sym] || (state.tokens[sym] = newTokenState());
  const n = await indexToken(sym, t, st);
  saveState();
  live[sym] = { supply: await configSupply(t.config), reserve: await tokenAmount(t.reserve) };
  // net wrapped minus unwrapped must equal the on-chain supply (allowing for transactions not finalized yet)
  const derived = (BigInt(st.wrapped) - BigInt(st.fees) - BigInt(st.unwrapped)).toString();
  console.log(`${new Date().toISOString()} ${sym}: +${n} tx | wraps ${st.wraps} unwraps ${st.unwraps} transfers ${st.transfers} accounts ${st.accounts} wallets ${st.wallets.length} | supply on-chain ${live[sym].supply} derived ${derived}${derived === live[sym].supply ? "" : "  (differs: pending finalization or history gap)"}`);
}
publish(live);
