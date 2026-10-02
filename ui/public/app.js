// X1 Confidential cXNT — fully self-custodied wallet-signing client.
// Every confidential secret is derived in-browser from the user's wallet
// signature; the wallet signs + broadcasts each tx (feePayer = user).
// Uses the SAME @solana-program libs as the on-chain client for byte-exact
// instruction encoding. Server = static assets + chain reads only.
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, Keypair, ComputeBudgetProgram } from "@solana/web3.js";
import { Buffer } from "buffer";
globalThis.Buffer = Buffer;
import { getAccountLen, ExtensionType, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from "@solana/spl-token";
import {
  getReallocateInstruction,
  getConfigureConfidentialTransferAccountInstruction,
  getConfidentialTransferInstruction,
  getConfidentialWithdrawInstruction,
  getApplyConfidentialPendingBalanceInstruction,
  fetchToken,
} from "@solana-program/token-2022";
import { getVerifyProofInstruction } from "@solana-program/zk-elgamal-proof";
import { getInitializeInstruction } from "@solana-program/record";
import { createSolanaRpc, address, createNoopSigner } from "@solana/kit";

// Network configuration. Everything cluster-specific (RPC, program ids, token
// list, whether a test faucet exists) is loaded at boot from /api/state, which
// is baked per deployment. Nothing below is usable until loadDeployment() ran.
let NETWORK = "";        // "mainnet" | "testnet"
let RPC = "";
let conn = null;         // @solana/web3.js Connection
let rpc = null;          // @solana/kit RPC
let FAUCET_ENABLED = false;

let PROGRAM_ID = null; // x1_confidential program
// Protocol fee recipient (0.39% on wrap only; unwrap is free. Routed by the program to
// this owner's ATA for the token being moved). Must match `fee_recipient()` in lib.rs.
const FEE_RECIPIENT = new PublicKey("GACCq8Yd4szdB7mCcaViFNwDEej4crZe43YoSPCzmb8M");
const FEE_BPS = 39n; // 0.39%, charged once, on wrap. Unwraps and transfers are free.
const FEE_LABEL = "0.39%";
function feeOn(amount){ return (amount*FEE_BPS)/10000n; }
// The fee recipient's ATA for (mint, tokenProgram). Program enforces this exact
// address as the fee destination.
async function feeAta(mint, tokenProgram){ return getAssociatedTokenAddress(mint, FEE_RECIPIENT, false, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID); }
// Returns a create-ix if the fee ATA does not exist yet, else null. The caller
// prepends it to the tx (must run BEFORE the program instruction).
async function feeAtaCreateIx(mint, tokenProgram, payer){
  const ata=await feeAta(mint, tokenProgram);
  const info=await conn.getAccountInfo(ata);
  if(info) return { ata, ix:null };
  return { ata, ix:createAssociatedTokenAccountInstruction(payer, ata, FEE_RECIPIENT, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID) };
}

// ---- Human-readable error mapping -----------------------------------------
// Anchor surfaces program errors as "custom program error: 0x<hex>". Map the
// program's own codes + common token-2022/runtime cases to plain language, so
// users never see raw hex or stack-trace text.
const CUSTOM_ERR = {
  6000:"Amount too large — the calculation overflowed. Try a smaller amount.",
  6001:"Amount must be greater than zero.",
  6002:"The supply cap must be greater than zero.",
  6003:"The supply cap can never be increased — it may only be lowered.",
  6004:"This wrap would exceed the confidential supply cap. Try a smaller amount.",
  6005:"The confidential vault does not have enough balance for this unwrap.",
  6006:"You are not authorized to perform this action.",
  6007:"This swap is not in a state that allows this action.",
  6008:"This swap has already been taken — it cannot be settled again.",
  6009:"Internal error: required accounts are missing from the transaction.",
  6010:"The destination account is not owned by the required party — refusing to send funds there.",
  6011:"Protocol fee must go to the program fee account — refusing to redirect it.",
  6012:"An account is not owned by the expected token program — refusing to use it.",
  6013:"This confidential mint was not set up correctly (its authority is not the conf-mint PDA).",
  6014:"The reserve account is not owned correctly — refusing to use it.",
  6015:"The token program supplied does not own this mint — refusing to use it.",
  6016:"The confidential tokens were not burned — no backing was released.",
  6017:"The confidential tokens were not minted as expected — the wrap was aborted.",
  6018:"The reserve no longer covers the outstanding confidential supply — the operation was aborted.",
  6019:"The supply cap cannot be lowered below the supply already outstanding.",
  6020:"Only the program's upgrade authority can register a confidential mint.",
  6021:"The confidential mint must have the same decimals as its backing mint.",
  6022:"The confidential mint must not have a freeze authority.",
  6023:"The confidential mint must have zero supply when it is registered.",
  6024:"The relayed instruction is not the expected confidential transfer — refusing to sign it.",
  6025:"Confidential swaps are disabled in this build.",
};
const TOKEN_ERR = {
  0:"The token program rejected this token account (invalid account data). Recreate the account and retry.",
  1:"Not enough funds for this operation. Check that the wallet has enough XNT for network fees and enough of the token.",
  2:"Invalid token mint.",
  4:"The owner of this token account does not match what was expected.",
  48:"This account is missing a required token-2022 extension. Create a fresh confidential account and retry.",
};
function humanErrText(e){
  let m = (e && (e.message || e.reason || String(e))) || "Unknown error";
  const cm = m.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if(cm){
    const code = parseInt(cm[1],16);
    if(CUSTOM_ERR[code]) return CUSTOM_ERR[code];
    if(code <= 0x1c && TOKEN_ERR[code]) return TOKEN_ERR[code];
  }
  if(/insufficient lamports|Insufficient funds for fee|Attempt to debit an account/i.test(m)) return "Not enough XNT in your wallet to cover network fees and account rent. Top up XNT and retry.";
  if(/insufficient funds/i.test(m)) return "Your wallet does not hold enough of the token for this amount.";
  if(/blockhash not found|BlockhashNotFound/i.test(m)) return "The transaction expired before it landed. Please retry.";
  if(/User rejected|rejected the request|declined|denied|cancell?ed/i.test(m)) return "Request rejected in your wallet — the transaction was not sent.";
  if(/not confirmed|TransactionExpired|timed out|timeout/i.test(m)) return "The network did not confirm in time. Please retry.";
  if(/already in use/i.test(m)) return "One of the accounts already exists — retry (this is usually harmless).";
  if(/extension not found/i.test(m)) return "This account was not set up for confidential transfers. Create a fresh confidential account and retry.";
  if(/out of sync|identity/i.test(m)) return m; // already human (written by this app)
  return m.replace(/^Error:\s*/,"");
}
// toast() renders HTML, and error text can originate from the RPC, the server
// or a wallet extension — never let it reach the DOM unescaped.
function humanErr(e){ return esc(humanErrText(e)); }
let CONF_TOKEN = null; // token-2022 program that owns the confidential mints
const BACKING_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"); // real XNT program
// Deployment-specific addresses. These change on every redeploy (new mint,
// new reserve, new config PDA), so they are NOT hardcoded here: they are loaded
// at boot from the server's /api/state (which reads the live on-chain config
// account). Until loaded they default to undefined and actions are blocked.
let XNT_MINT = null;   // backing token mint (active token's backing)
let CXNT_MINT = null;  // confidential (zk-ops token-2022) mint (active token)
let CONFIG = null;     // ConfidentialMintConfig PDA (active token)
let RESERVE = null;    // treasury vault (active token)

// ---- TOKEN REGISTRY (ADDITIVE: default is cXNT) ----
// cXNT is the default and behaves EXACTLY as before. Selecting another token
// only re-points these globals at that token's (backingMint, confMint, config,
// reserve, decimals, backing program). No other code path is changed by default.
let TOKENS = {};
let ACTIVE = "cXNT";
function tok(){ return TOKENS[ACTIVE] || null; }
function tokBackingDecimals(){ const t=tok(); return BigInt(t && t.backingDecimals!=null ? t.backingDecimals : 9); }
function tokConfDecimals(){ const t=tok(); return t && t.mintDecimals!=null ? t.mintDecimals : Number(tokBackingDecimals()); }
function tokBackingProgram(){ const t=tok(); return t && t.backingProgram ? new PublicKey(t.backingProgram) : BACKING_TOKEN; }
function SYM(){ const t=tok(); return t?t.symbol:"cXNT"; }
function BSYM(){ const t=tok(); return t?(t.backingSymbol||"XNT"):"XNT"; }
function isXnt(){ return ACTIVE==="cXNT"; }
// True when the active token is backed by the NATIVE coin (wrapped-native mint).
// The user then wraps/unwraps the coin in their wallet directly: the UI moves it
// through a temporary wrapped-native token account inside the same transaction.
function isNativeBacking(){ return !!XNT_MINT && XNT_MINT.equals(NATIVE_MINT); }
async function nativeBackingAta(){ return getAssociatedTokenAddress(NATIVE_MINT,state.pubKey,false,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID); }
// Lamports kept back for network fees and the temporary accounts' rent.
const NATIVE_FEE_MARGIN=20_000_000n;
// X1 prices a transaction by the compute units it REQUESTS (the default is
// 200k per instruction), so each flow asks only for what it needs. Measured on
// the networks: wrap ~60-105k, unwrap ~160-180k, confidential transfer ~250k.
const CU_WRAP=260_000, CU_UNWRAP=300_000, CU_TRANSFER=400_000, CU_APPLY=40_000, CU_CREATE=120_000, CU_SMALL=60_000;
// Token-2022 encrypts a deposited or transferred amount as a 16-bit low part
// and a 32-bit high part, so ONE wrap or ONE confidential transfer can carry at
// most 2^48 - 1 base units. Balances themselves are 64-bit, and unwrapping has
// no such limit. Larger amounts are simply done in several operations.
const MAX_CT_AMOUNT=(1n<<48n)-1n;
function requireWithinCtLimit(amount,what){
  if(amount>MAX_CT_AMOUNT)throw new Error("A single "+what+" can carry at most "+fmtAmt(MAX_CT_AMOUNT)+". Split this amount into several "+what+"s.");
}
function cuLimit(units){ return ComputeBudgetProgram.setComputeUnitLimit({units}); }
// Proof context-state accounts are single-use. Closing them at the end of the
// transaction that consumed them returns their rent to the wallet.
// ZK ElGamal proof program, instruction 0 = CloseContextState:
//   [context state (w), lamport destination (w), context authority (signer)]
function closeContextIx(contextState){
  return new TransactionInstruction({programId:ZK_PROGRAM,data:Buffer.from([0]),keys:[
    {pubkey:contextState,isSigner:false,isWritable:true},
    {pubkey:state.pubKey,isSigner:false,isWritable:true},
    {pubkey:state.pubKey,isSigner:true,isWritable:false}]});
}
// Namespace prefix for token-scoped localStorage. EMPTY for cXNT so the default
// token keeps byte-identical cache keys to the pre-USDC.x build.
function nsPrefix(){ return isXnt() ? "" : (ACTIVE+"_"); }
// Apply the selected token's addresses into the globals every action reads.
function applyActiveToken(){
  const t=tok(); if(!t) return false;
  CONFIG = new PublicKey(t.config);
  CXNT_MINT = new PublicKey(t.mint);
  XNT_MINT = new PublicKey(t.backingMint);
  RESERVE = new PublicKey(t.reserve);
  return true;
}
// Switch the active token, reset token-scoped runtime state, then refresh.
async function selectToken(sym){
  if(!TOKENS[sym]) return;
  ACTIVE = sym;
  applyActiveToken();
  state.confAcct = null;
  state.confAccounts = [];
  state.elgamalPub = null;
  state.secret = null; state.aeKey = null; state.userPickedAcct = false; state.acctBalances = null;
  try{
    $("stBalance").textContent="…";
    $("stWalletAcct").textContent="conf account: …";
    $("stXnt").textContent=BSYM()+": …";
    renderConfAccounts();
  }catch(_e){}
  try{ updateTokenUI(); }catch(_e){}
  try{ await refreshChain(); }catch(_e){}
}
// Update the token selector + any token-labelled UI elements.
function updateTokenUI(){
  const t=tok(); if(!t) return;
  const sel=$("tokenSelect");
  if(sel){
    const wanted=Object.keys(TOKENS);
    const have=Array.from(sel.options).map(o=>o.value);
    if(wanted.length!==have.length||wanted.some((v,i)=>v!==have[i])){
      sel.innerHTML=wanted.map(sym=>"<option value=\""+sym+"\">"+sym+" ("+(TOKENS[sym].backingSymbol||"")+")"+"</option>").join("");
    }
    sel.value=ACTIVE;
  }
  document.querySelectorAll("[data-token-sym]").forEach(el=>{ el.textContent=t.symbol; });
  document.querySelectorAll("[data-backing-sym]").forEach(el=>{ el.textContent=t.backingSymbol||"XNT"; });
  try{ if(window.__syncTokenButtons) window.__syncTokenButtons(); }catch(_e){}
}

// The registry arrives over HTTP and its fields end up in the DOM and in
// transactions, so accept only plain symbols and real base58 addresses.
const SYMBOL_RE=/^[A-Za-z0-9._-]{1,16}$/;
function sanitizeTokens(raw){
  const out={};
  for(const [key,t] of Object.entries(raw||{})){
    try{
      if(!t||!SYMBOL_RE.test(key)||!SYMBOL_RE.test(String(t.symbol||""))||!SYMBOL_RE.test(String(t.backingSymbol||"")))continue;
      const dec=(v)=>{ const n=Number(v); if(!Number.isInteger(n)||n<0||n>18)throw new Error("bad decimals"); return n; };
      out[key]={
        symbol:String(t.symbol), backingSymbol:String(t.backingSymbol),
        backingMint:new PublicKey(t.backingMint).toBase58(), backingDecimals:dec(t.backingDecimals),
        backingProgram:new PublicKey(t.backingProgram||BACKING_TOKEN).toBase58(),
        mint:new PublicKey(t.mint).toBase58(), mintDecimals:dec(t.mintDecimals),
        reserve:new PublicKey(t.reserve).toBase58(), config:new PublicKey(t.config).toBase58(),
        supplyCap:String(t.supplyCap||"").replace(/[^0-9]/g,""),
      };
    }catch(_e){ console.warn("[conf] ignoring malformed token entry",key); }
  }
  return out;
}

// Boot: fetch authoritative deployment addresses from /api/state (server reads
// the on-chain config account). Resolves true once loaded, false if unavailable.
async function loadDeployment(){
  try{
    const r = await fetch("/api/state");
    const j = await r.json();
    // cluster + program ids (validated: they end up in every transaction)
    if(j.network!=="mainnet"&&j.network!=="testnet")throw new Error("deployment state has no network");
    const rpcUrl=new URL(String(j.rpc));
    if(rpcUrl.protocol!=="https:")throw new Error("deployment RPC must be https");
    NETWORK=j.network; RPC=rpcUrl.origin;
    conn=new Connection(RPC,"confirmed"); rpc=createSolanaRpc(RPC);
    PROGRAM_ID=new PublicKey(j.program);
    CONF_TOKEN=new PublicKey(j.confTokenProgram);
    RECORD_PROGRAM=new PublicKey(j.recordProgram);
    FAUCET_ENABLED=!!j.faucet&&NETWORK!=="mainnet";
    try{
      const nb=$("netBadge"); if(nb){ nb.textContent=NETWORK==="mainnet"?"Mainnet":"Testnet"; nb.className="badge "+NETWORK; }
      const pa=$("programAddr"); if(pa){ pa.textContent=PROGRAM_ID.toBase58(); }
      const rn=$("riskNote"); if(rn&&NETWORK==="testnet"){ rn.textContent="Testnet preview. Tokens here have no value. The software is new and has not yet been independently audited."; }
    }catch(_e){}
    const cfg = j && j.config;
    if(!cfg || !cfg.address){ throw new Error("no config in /api/state"); }
    // Build the token registry from the server (authoritative: cXNT from the
    // on-chain config, cUSDC.x from its deployment file). Fall back to cXNT-only
    // when the server does not expose a tokens map.
    if(j.tokens && Object.keys(j.tokens).length){
      TOKENS=sanitizeTokens(j.tokens);
    }
    if(!Object.keys(TOKENS).length){
      TOKENS=sanitizeTokens({ cXNT:{ symbol:"cXNT", backingSymbol:"XNT", backingMint:cfg.backingMint, backingDecimals:9,
        mint:cfg.mint, mintDecimals:9, reserve:cfg.reserve, config:cfg.address, supplyCap:cfg.supplyCap } });
    }
    if(!TOKENS[ACTIVE]) ACTIVE=Object.keys(TOKENS)[0];
    if(!applyActiveToken()) throw new Error("no token deployment");
    try{ updateTokenUI(); }catch(_e){}
    return true;
  }catch(e){
    console.error("[conf] loadDeployment FAILED:", e && e.message);
    return false;
  }
}
const ZK_PROGRAM = new PublicKey("ZkE1Gama1Proof11111111111111111111111111111");
let RECORD_PROGRAM = null; // SPL record program used to stage proofs
const RECORD_META = 33;
// Actual on-chain decimals of the active confidential (zk-ops token-2022) mint,
// as reported by the server from the mint account. The program requires the
// confidential mint to use the SAME decimals as its backing mint, and the
// token-2022 ConfidentialWithdraw relay rejects a `decimals` field that differs
// from the mint.
function CXNT_MINT_DECIMALS(){ return tokConfDecimals(); }
// format raw to a decimal string WITHOUT trailing-zero clutter, e.g. 200000000 -> "0.2"
function fmtAmt(raw){
  if(raw===null||raw===undefined)return "0";
  const neg=raw<0n; if(neg)raw=-raw;
  const D=tokBackingDecimals();
  const d=10n**D;
  const whole=raw/d, frac=raw%d;
  let s=(whole.toString()+"."+frac.toString().padStart(Number(D),"0")).replace(/\.?0+$/,"");
  if(s==="")s="0";
  return (neg?"-":"")+s;
}

const $ = (id)=>document.getElementById(id);
const toast=(m,t="ok")=>{const el=$("toast");el.className="show "+t;el.innerHTML=m;clearTimeout(el._h);el._h=setTimeout(()=>el.className="",4500);};
const esc=(s)=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

const state = {
  wallet: null, pubKey: null, confAcct: null,
  elgamalPub: null, proofgen: null, sigCache: {},
  // all confidential accounts owned by the connected wallet whose stored
  // ElGamal pubkey matches our current derived key (all usable under the
  // stable sig-cache key). state.confAcct = primary/first; this is the full set.
  confAccounts: [],
};

// ---- browser-safe codecs ----
const B58A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58enc(bytes){const digs=[];let z=0;while(z<bytes.length&&bytes[z]===0)z++;for(let i=z;i<bytes.length;i++){let c=bytes[i];for(let j=0;j<digs.length;j++){const x=digs[j]*256+c;digs[j]=x%58;c=(x/58)|0;}while(c){digs.push(c%58);c=(c/58)|0;}}let s="1".repeat(z);for(let i=digs.length-1;i>=0;i--)s+=B58A[digs[i]];return s;}
function b58dec(s){const bytes=[0];for(let i=0;i<s.length;i++){const c=B58A.indexOf(s[i]);if(c<0)throw new Error("bad b58");let carry=c;for(let j=0;j<bytes.length;j++){const x=bytes[j]*58+carry;bytes[j]=x&0xff;carry=x>>8;}while(carry){bytes.push(carry&0xff);carry>>=8;}}let l=0;while(s[l]==="1")l++;const out=new Uint8Array(bytes.length+l);for(let i=0;i<l;i++)out[i]=0;for(let i=0;i<bytes.length;i++)out[l+bytes.length-1-i]=bytes[i];return out;}
function b64enc(b){let s="";for(let i=0;i<b.length;i+=3){s+=String.fromCharCode(b[i],b[i+1],b[i+2]);}return btoa(s).slice(0,Math.ceil(b.length/3)*4);}
function b64dec(s){const bin=atob(s);const o=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)o[i]=bin.charCodeAt(i);return o;}
function hexenc(b){return Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join("");}
function hexdec(s){const o=new Uint8Array(s.length/2);for(let i=0;i<o.length;i++)o[i]=parseInt(s.substr(i*2,2),16);return o;}
function concat(...arrs){const t=arrs.reduce((n,a)=>n+a.length,0);const o=new Uint8Array(t);let p=0;for(const a of arrs){o.set(a,p);p+=a.length;}return o;}
function u64le(n){const b=new Uint8Array(8);new DataView(b.buffer).setBigUint64(0,BigInt(n),true);return b;}
function toWeb3Ix(ix, mapProgram){
  const prog = (ix.programAddress=== "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")?CONF_TOKEN
    : (ix.programAddress==="recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5"?RECORD_PROGRAM:new PublicKey(ix.programAddress));
  // defensive data conversion: Uint8Array, Buffer, Array, or fallback
  const dataBuf = (() => {
    if (Buffer.isBuffer(ix.data)) return ix.data;
    if (ix.data instanceof Uint8Array) return Buffer.from(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    if (Array.isArray(ix.data)) return Buffer.from(ix.data);
    return Buffer.from(Object.values(ix.data));
  })();
  // defensive role extraction: handles raw numbers, object wrappers, or booleans
  const keys = ix.accounts.map(a => {
    const rawRole = (typeof a.role === 'object' && a.role !== null) ? (a.role.value ?? a.role) : a.role;
    const roleNum = Number(rawRole);
    return {
      pubkey: new PublicKey(a.address),
      isSigner: roleNum === 2 || roleNum === 3 || !!a.isSigner,
      isWritable: roleNum === 1 || roleNum === 3 || !!a.isWritable,
    };
  });
  // DEBUG: log suspiciously small or large data
  console.log("[toWeb3Ix] prog="+prog.toBase58().slice(0,8)+" keys="+keys.length+" dataLen="+dataBuf.length+" dataType="+(typeof ix.data)+" isUint8="+(ix.data instanceof Uint8Array)+" isBuf="+Buffer.isBuffer(ix.data));
  if(dataBuf.length<4||dataBuf.length>2000)console.log("[toWeb3Ix] data first 8:",[...dataBuf.slice(0,8)],"last 8:",[...dataBuf.slice(-8)]);
  return new TransactionInstruction({
    keys,
    programId: prog,
    data: dataBuf,
  });
}

// ---- wasm proofgen ----
async function loadProofgen(){
  if(state.proofgen) return state.proofgen;
  const resp=await fetch("proofgen51.wasm");
  const bytes=await resp.arrayBuffer();
  let instance;
  const imports={env:{__lk_getrandom(ptr,len){const mem=new Uint8Array(instance.exports.memory.buffer);crypto.getRandomValues(mem.subarray(ptr,ptr+len));}}};
  ({instance}=await WebAssembly.instantiate(bytes,imports));
  state.proofgen={exports:instance.exports,memory:()=>new Uint8Array(instance.exports.memory.buffer)};
  return state.proofgen;
}
function pg(){return state.proofgen;}
function pgAlloc(n){return pg().exports.alloc(n);}
function pgFree(p,n){pg().exports.dealloc(p,n);}
function pgMem(){return pg().memory();}
function elgamalSecretFromSig(sigB64){
  const {exports}=pg();const sig=b64dec(sigB64);
  const sp=exports.alloc(64);pgMem().set(sig,sp);
  const out=exports.alloc(32);
  const len=exports.elgamal_secret_from_signature(sp,64,out,32);
  const bytes=new Uint8Array(pgMem().slice(out,out+len));
  exports.dealloc(sp,64);exports.dealloc(out,32);
  if(len<0)throw new Error("elgamal_secret_from_signature failed");
  return bytes;
}
function aeKeyFromSig(sigB64){
  const {exports}=pg();const sig=b64dec(sigB64);
  const sp=exports.alloc(64);pgMem().set(sig,sp);
  const out=exports.alloc(16);
  const len=exports.ae_key_from_signature(sp,64,out,16);
  const bytes=new Uint8Array(pgMem().slice(out,out+len));
  exports.dealloc(sp,64);exports.dealloc(out,16);
  if(len<0)throw new Error("ae_key_from_signature failed");
  return bytes;
}
function pubkeyFromSecret(secret){
  const {exports}=pg();const sp=exports.alloc(32);pgMem().set(secret,sp);
  const out=exports.alloc(64);
  const len=exports.pubkey_from_secret(sp,32,out,64);
  const bytes=new Uint8Array(pgMem().slice(out,out+len));
  exports.dealloc(sp,32);exports.dealloc(out,64);
  if(len<0)throw new Error("pubkey_from_secret failed");
  return bytes;
}
// ---- balance reads ---------------------------------------------------------
// Recovering an amount from an ElGamal ciphertext needs a discrete-log search
// whose cost grows with the amount. So the page never searches when it can
// avoid it: the account also stores the balance AE-encrypted for its owner
// (instant to decrypt), and `elgamal_verify_amount` confirms in one scalar
// multiplication that the ElGamal ciphertext holds exactly that amount. The
// search (`elgamal_decrypt_with_scalar_u64`) is only a fallback for accounts
// whose two copies disagree. Every result is memoised per ciphertext.
const _amountMemo=new Map();
function _memoKey(secret,ctHex){ return hexenc(secret.subarray(0,8))+":"+ctHex; }
function elgamalVerifyAmount(secret,ctHex,amount){
  const {exports}=pg();
  if(typeof exports.elgamal_verify_amount!=="function")return false;
  const amt=new TextEncoder().encode(amount.toString());
  const sp=exports.alloc(32);pgMem().set(secret,sp);
  const cp=exports.alloc(64);pgMem().set(hexdec(ctHex),cp);
  const ap=exports.alloc(amt.length);pgMem().set(amt,ap);
  const r=exports.elgamal_verify_amount(sp,32,cp,64,ap,amt.length);
  exports.dealloc(sp,32);exports.dealloc(cp,64);exports.dealloc(ap,amt.length);
  return r===1;
}
// Record the available balance of one of OUR accounts from its AE copy, if the
// ElGamal ciphertext really holds that amount. Called whenever an account is read.
function primeAvailable(availHex,decHex){
  try{
    if(!state.secret||!state.aeKey||!availHex||availHex.length!==128)return;
    const key=_memoKey(state.secret,availHex);
    if(_amountMemo.has(key))return;
    if(/^0+$/.test(availHex)){ _amountMemo.set(key,0n); return; }
    if(!decHex||decHex.length!==72)return;
    const v=aeDecrypt(state.aeKey,decHex);
    if(elgamalVerifyAmount(state.secret,availHex,v)){ _amountMemo.set(key,v); return; }
    // The AE copy is stale (e.g. a credit landed while a balance update was in
    // flight). The real amount is near it: search the difference, which works
    // for balances of any size.
    const near=elgamalDecryptNear(state.secret,availHex,v);
    if(near!==null)_amountMemo.set(key,near);
  }catch(_e){}
}
function elgamalDecryptNear(secret,ctHex,hint){
  const {exports}=pg();
  if(typeof exports.elgamal_decrypt_near!=="function")return null;
  const h=new TextEncoder().encode(hint.toString());
  const sp=exports.alloc(32);pgMem().set(secret,sp);
  const cp=exports.alloc(64);pgMem().set(hexdec(ctHex),cp);
  const hp=exports.alloc(h.length);pgMem().set(h,hp);
  const out=exports.alloc(64);
  const len=exports.elgamal_decrypt_near(sp,32,cp,64,hp,h.length,out,64);
  const str=(len>0&&len<=64)?new TextDecoder().decode(pgMem().slice(out,out+len)):null;
  exports.dealloc(sp,32);exports.dealloc(cp,64);exports.dealloc(hp,h.length);exports.dealloc(out,64);
  return str?BigInt(str):null;
}
function _elgamalDecryptWith(fnName,secret,ctHex){
  const {exports}=pg();const sp=exports.alloc(32);pgMem().set(secret,sp);
  const cp=exports.alloc(64);pgMem().set(hexdec(ctHex),cp);
  const out=exports.alloc(64);
  const len=exports[fnName](sp,32,cp,64,out,64);
  let str=null;
  if(len>=0 && len<=64){ str=new TextDecoder().decode(pgMem().slice(out,out+len)); }
  exports.dealloc(sp,32);exports.dealloc(cp,64);exports.dealloc(out,64);
  if(!str)throw new Error(fnName+" failed code "+len);
  return BigInt(str);
}
function elgamalDecryptU64(secret,ctHex){
  const key=_memoKey(secret,ctHex);
  if(_amountMemo.has(key))return _amountMemo.get(key);
  const v=_elgamalDecryptWith("elgamal_decrypt_with_scalar_u64",secret,ctHex);
  _amountMemo.set(key,v);
  return v;
}
// same but return the decimal string (or null) instead of throwing
function elgamalDecryptU64Raw(secret,ctHex){
  try{ return elgamalDecryptU64(secret,ctHex).toString(); }catch(e){ return null; }
}
// Small amounts (< 2^32): the zk-sdk's precomputed-table decode, fast.
function elgamalDecryptU32(secret,ctHex){
  const key=_memoKey(secret,ctHex);
  if(_amountMemo.has(key))return _amountMemo.get(key);
  const v=_elgamalDecryptWith("elgamal_decrypt_with_scalar",secret,ctHex);
  _amountMemo.set(key,v);
  return v;
}
function pubkeyProofFromSecret(secret){
  const {exports}=pg();const sp=exports.alloc(32);pgMem().set(secret,sp);
  const out=exports.alloc(4096);
  const len=exports.gen_pubkey_proof(sp,32,out,4096);
  if(len<0||len>4096)throw new Error("gen_pubkey_proof failed (code "+len+")");
  const s=new TextDecoder().decode(pgMem().slice(out,out+len));
  exports.dealloc(sp,32);exports.dealloc(out,4096);
  return s;
}
function genTransferProofFromSig(sigB64,availHex,decHex,amount,destPubHex){
  const {exports}=pg();
  const sig=b64dec(sigB64);const avail=hexdec(availHex);const dec=hexdec(decHex);
  const amt=new TextEncoder().encode(amount.toString());const dest=hexdec(destPubHex);
  const sp=exports.alloc(64);pgMem().set(sig,sp);
  const avp=exports.alloc(64);pgMem().set(avail,avp);
  const dp=exports.alloc(36);pgMem().set(dec,dp);
  const amp=exports.alloc(amt.length);pgMem().set(amt,amp);
  const dsp=exports.alloc(32);pgMem().set(dest,dsp);
  const out=exports.alloc(16384);
  const len=exports.gen_transfer_proof_from_sig(sp,64,avp,64,dp,36,amp,amt.length,dsp,32,out,16384);
  let s=null;
  if(len>=0 && len<=16384){ s=new TextDecoder().decode(pgMem().slice(out,out+len)); }
  exports.dealloc(sp,64);exports.dealloc(avp,64);exports.dealloc(dp,36);exports.dealloc(amp,amt.length);exports.dealloc(dsp,32);exports.dealloc(out,16384);
  if(!s)throw new Error("gen_transfer_proof_from_sig failed (code "+len+")");
  return JSON.parse(s);
}
function genWithdrawProofFromSig(sigB64,availHex,current,amount){
  const {exports}=pg();
  const sig=b64dec(sigB64);const avail=hexdec(availHex);
  const cur=new TextEncoder().encode(current.toString());const amt=new TextEncoder().encode(amount.toString());
  const sp=exports.alloc(64);pgMem().set(sig,sp);
  const avp=exports.alloc(64);pgMem().set(avail,avp);
  const cp=exports.alloc(cur.length);pgMem().set(cur,cp);
  const amp=exports.alloc(amt.length);pgMem().set(amt,amp);
  const out=exports.alloc(16384);
  const len=exports.gen_withdraw_proof_from_sig(sp,64,avp,64,cp,cur.length,amp,amt.length,out,16384);
  let s=null;
  if(len>=0 && len<=16384){ s=new TextDecoder().decode(pgMem().slice(out,out+len)); }
  exports.dealloc(sp,64);exports.dealloc(avp,64);exports.dealloc(cp,cur.length);exports.dealloc(amp,amt.length);exports.dealloc(out,16384);
  if(!s)throw new Error("gen_withdraw_proof_from_sig failed (code "+len+")");
  return JSON.parse(s);
}
// AE encrypt/decrypt
function aeEncrypt(aeKeyHex,amount){
  const {exports}=pg();const ae=hexdec(aeKeyHex);const amt=new TextEncoder().encode(amount.toString());
  const ap=exports.alloc(16);pgMem().set(ae,ap);
  const amp=exports.alloc(amt.length);pgMem().set(amt,amp);
  const out=exports.alloc(64);
  const len=exports.ae_encrypt(ap,16,amp,amt.length,out,64);
  let bytes=null;
  if(len>=0 && len<=64){ bytes=new Uint8Array(pgMem().slice(out,out+len)); }
  exports.dealloc(ap,16);exports.dealloc(amp,amt.length);exports.dealloc(out,64);
  if(!bytes)throw new Error("ae_encrypt failed (code "+len+")");
  return b64enc(bytes);
}
function aeDecrypt(aeKeyHex,ctHex){
  const {exports}=pg();const ae=hexdec(aeKeyHex);const ct=hexdec(ctHex);
  const ap=exports.alloc(16);pgMem().set(ae,ap);
  const cp=exports.alloc(ct.length);pgMem().set(ct,cp);
  const out=exports.alloc(64);
  const len=exports.ae_decrypt_with_key(ap,16,cp,ct.length,out,64);
  let s="0";
  if(len>=0 && len<=64){ s=new TextDecoder().decode(pgMem().slice(out,out+len)); }
  exports.dealloc(ap,16);exports.dealloc(cp,ct.length);exports.dealloc(out,64);
  return BigInt(s||"0");
}

// ---- derivation ----
const DOMAIN=new TextEncoder().encode("solana-conf-bal/v1");
function derivationMessage(ownerB58,mintB58){return concat(DOMAIN,b58dec(ownerB58),b58dec(mintB58));}
async function walletSignMessage(msgBytes){
  if(state.wallet&&typeof state.wallet.signMessage==="function")return state.wallet.signMessage(msgBytes);
  throw new Error("wallet signMessage unsupported");
}

// ---- Serialized wallet signing (prevents extension popup races) ----
// Wallet extensions (X1 / Phantom / Solflare / Backpack) return "User rejected
// the request" when a 2nd signing request arrives while the prior popup is still
// closing. Funnel EVERY sign request (transaction AND message) through a single
// promise-queue with a settle gap so only one popup is ever in flight.
let _signChain=Promise.resolve();
let _lastSignAt=0;
const SIGN_GAP_MS=900;
function _queueSign(fn){
  const run=async()=>{
    const since=Date.now()-_lastSignAt;
    if(since<SIGN_GAP_MS)await new Promise(r=>setTimeout(r,SIGN_GAP_MS-since));
    try{return await fn();}
    finally{_lastSignAt=Date.now();}
  };
  const p=_signChain.then(run,run);
  _signChain=p.catch(()=>{});
  return p;
}
// Wallets differ in what signTransaction resolves to: a Transaction, raw wire
// bytes, or an envelope such as {signedTransaction: <base64|bytes>}. Normalise
// all of them to something with serialize().
function asSignedTx(r){
  if(r&&typeof r.serialize==="function")return r;
  let v=r&&(r.signedTransaction!==undefined?r.signedTransaction:(r.transaction!==undefined?r.transaction:r));
  if(v&&typeof v.serialize==="function")return v;
  let bytes=null;
  if(typeof v==="string")bytes=b64dec(v);
  else if(v instanceof Uint8Array)bytes=v;
  else if(Array.isArray(v))bytes=new Uint8Array(v);
  if(!bytes||!bytes.length)throw new Error("wallet returned an unrecognised signed transaction");
  return {serialize:()=>bytes};
}
function walletSign(tx){return _queueSign(async()=>asSignedTx(await state.wallet.signTransaction(tx)));}
function walletSignMsg(msg){return _queueSign(()=>walletSignMessage(msg));}
function normSig(sig){
  if(sig&&typeof sig==="object"&&!(sig instanceof Uint8Array)&&!Array.isArray(sig)&&sig.signature!=null)sig=sig.signature;
  let u;
  if(typeof sig==="string"){const s=sig.trim();if(/^[A-Za-z0-9+/]+={0,2}$/.test(s)&&s.length%4===0)u=b64dec(s);else if(/^[0-9a-fA-F]+$/.test(s)&&s.length===128)u=hexdec(s);else if(s.length>=80&&s.length<=100)u=b58dec(s);else throw new Error("bad sig enc");}
  else if(sig instanceof Uint8Array)u=sig;
  else if(Array.isArray(sig))u=new Uint8Array(sig);
  else throw new Error("bad sig shape");
  if(!u||u.length!==64)throw new Error("sig must be 64B");
  return u;
}
function pubFromSecrets(){return null;}
// Normalize an on-chain ElGamal pubkey (codec may return string|object|bytes) to lowercase-hex
const pubToHex=(p)=>{
  try{
    if(!p)return null;
    if(typeof p==="string")return hexenc(new PublicKey(p).toBytes());
    if(typeof p.toBytes==="function")return hexenc(p.toBytes());
    if(p.address)return hexenc(new PublicKey(p.address).toBytes());
    if(p.data)return hexenc(new Uint8Array(p.data));
    if(Array.isArray(p))return hexenc(new Uint8Array(p));
    if(p.bytes)return hexenc(new Uint8Array(p.bytes));
    if(typeof p==="object"){
      const flat=Object.values(p).map(v=>typeof v==="number"?v:Array.isArray(v)?v:null).filter(v=>v!==null);
      if(flat.length)return hexenc(new Uint8Array(flat.flat()));
      if(p.x!==undefined&&Array.isArray(p.x))return hexenc(new Uint8Array(p.x));
    }
    return null;
  }catch(_){ return null; }
};

// Before a NEW confidential account is bound to the derived key, make sure the
// wallet reproduces the same signature (standard ed25519 does). If it does not,
// the signature is the only way to keep the key, so it is kept in this browser.
async function confirmStableKey(){
  const key=state.pubKey.toBase58();
  const {LS_KEY,DET_KEY}=sigStoreKeys(key);
  try{ if(localStorage.getItem(LS_KEY)||localStorage.getItem(DET_KEY)==="1")return; }catch(e){}
  const first=state.sigCache[nsPrefix()+key];
  if(!first)return;
  const second=await signDerivation(key);
  if(second===first){ try{localStorage.setItem(DET_KEY,"1");}catch(e){} }
  else{
    console.warn("[conf] this wallet does not sign deterministically — keeping the derivation signature in this browser so your confidential key stays stable.");
    try{localStorage.setItem(LS_KEY,first);}catch(e){}
  }
}

// derive keys using SAME zk-sdk fromSignature (matches wasm secret)
// The signature over the derivation message is the ROOT SECRET of the
// confidential account: the ElGamal and AE keys are derived from it. It is kept
// in memory for the session and re-requested from the wallet after a reload.
//
// Standard ed25519 signing is deterministic, so re-signing yields the same
// signature and the same keys. The first time a wallet is used we verify that
// by asking it to sign twice. Only if a wallet turns out to randomise its
// signatures do we fall back to persisting the signature in localStorage —
// without it such a wallet would derive a different key on every reload and the
// balance could no longer be decrypted.
async function signDerivation(key){
  return b64enc(normSig(await walletSignMsg(derivationMessage(key,CXNT_MINT.toBase58()))));
}
// One signature per browser tab: concurrent callers share a single request, and
// the result is kept for the tab's lifetime (sessionStorage) so a reload does
// not prompt again. It is never written to persistent storage unless the wallet
// has been shown to sign non-deterministically (see confirmStableKey).
const _deriveInflight={};
function sigStoreKeys(key){
  return { LS_KEY:"x1conf_sigcache_"+nsPrefix()+key, DET_KEY:"x1conf_sigdet_"+nsPrefix()+key, SS_KEY:"x1conf_sig_"+NETWORK+"_"+nsPrefix()+key };
}
async function deriveKeys(){
  await loadProofgen();
  const key=state.pubKey.toBase58();
  const cacheId=nsPrefix()+key;
  const {LS_KEY,SS_KEY}=sigStoreKeys(key);
  if(!state.sigCache[cacheId]){
    if(!_deriveInflight[cacheId]){
      _deriveInflight[cacheId]=(async()=>{
        let kept=null;
        try{ kept=localStorage.getItem(LS_KEY)||sessionStorage.getItem(SS_KEY); }catch(e){}
        if(kept)return kept;
        const sig=await signDerivation(key);
        try{ sessionStorage.setItem(SS_KEY,sig); }catch(e){}
        return sig;
      })().finally(()=>{ delete _deriveInflight[cacheId]; });
    }
    state.sigCache[cacheId]=await _deriveInflight[cacheId];
  }
  const sigB64=state.sigCache[cacheId];
  // wasm secret == zk-sdk secret (verified)
  const secret=elgamalSecretFromSig(sigB64);
  // pubkeyFromSecret returns the pubkey as a hex-ASCII STRING (wasm does
  // hex::encode(...).into_bytes()). Decode those ASCII bytes to the 64-char hex
  // so it matches pubToHex(ext.elgamalPubkey) on-chain. Do NOT hexenc() again —
  // that double-encodes and the account-match/stale guards can never pass.
  const elgamalPub=new TextDecoder().decode(pubkeyFromSecret(secret)); // 64-char lowercase hex
  const proofB64=pubkeyProofFromSecret(secret);
  const aeKey=hexenc(aeKeyFromSig(sigB64));
  state.secret=secret; state.aeKey=aeKey;
  return {secret,sigB64,elgamalPub,proofB64,aeKey};
}

// ---- Persistent confidential-account discovery ----
// The confidential account is a random token-2022 account owned by the wallet.
// It is rent-exempt and persists on-chain, but we re-discover it each load via a
// getProgramAccounts scan. To make discovery bulletproof across sessions (and
// immune to testnet RPCs dropping token-2022 queries), we cache the chosen
// account address + its ElGamal pubkey in localStorage keyed by wallet pubkey,
// verify it at load, and only fall back to the scan if the cache is empty/stale.
const CONF_ACCT_LS = "x1conf_acct_";
// Token-scoped so each token keeps its own confidential-account mapping.
// EMPTY prefix for cXNT (byte-identical to the pre-USDC.x build).
function confAcctLS(){ return CONF_ACCT_LS+nsPrefix(); }
async function findMyConfAccount(walletB58, elgamalPubHex){
  // 1) try the persisted address first (fast, no scan)
  let cached=null,tryCached=true;
  try{ cached=JSON.parse(localStorage.getItem(confAcctLS()+walletB58)+"")||null; }catch(_){ tryCached=false; }
  if(cached && cached.acct && cached.elgamalPub && cached.elgamalPub===elgamalPubHex){
    try{
      const ext=await fetchConfToken(cached.acct); // throws if not confidential
      const stored=pubToHex(ext.elgamalPubkey);
      if(stored && stored===elgamalPubHex){
        state.confAcct=new PublicKey(cached.acct);
        $("stWalletAcct").innerText="conf account: "+cached.acct.slice(0,10)+"…";
        return state.confAcct;
      }
    }catch(_){ /* cached addr no longer confidential -> fall through to scan */ }
  }
  // 2) fall back to the live getProgramAccounts scan (owner+mint) and pick the
  //    account whose stored ElGamal pubkey matches our derived key.
  const accts=await getTokenAccountsByOwnerMint(walletB58,CXNT_MINT.toBase58());
  for(const a of accts){
    try{
      const ext=await fetchConfToken(a.pubkey.toBase58()); // throws if not confidential
      const stored=pubToHex(ext.elgamalPubkey);
      if(stored && stored===elgamalPubHex){
        state.confAcct=a.pubkey;
        $("stWalletAcct").innerText="conf account: "+a.pubkey.toBase58().slice(0,10)+"…";
        saveConfAcct(walletB58,a.pubkey.toBase58(),elgamalPubHex);
        return state.confAcct;
      }
    }catch(_){ /* skip non-confidential accounts */ }
  }
  return null;
}
function saveConfAcct(walletB58, acctB58, elgamalPubHex){
  try{ localStorage.setItem(confAcctLS()+walletB58, JSON.stringify({acct:acctB58,elgamalPub:elgamalPubHex})); }catch(_){}
}

// ---- Aggregate confidential-account discovery ----
// Return ALL confidential accounts owned by this wallet that match the current
// derived ElGamal key. The primary (cached) one is put first; the rest follow.
// This makes old/orphaned accounts visible again instead of invisible, and lets
// the UI show every cXNT balance the wallet actually holds across accounts.
async function findAllMyConfAccounts(walletB58, elgamalPubHex){
  const out=[];
  // 1) primary cached account first (fast + preserves current behavior)
  let cached=null;
  try{ cached=JSON.parse(localStorage.getItem(confAcctLS()+walletB58)+"")||null; }catch(_){}
  const seen={};
  const pushIfMatch=async(acctB58)=>{
    if(!acctB58||seen[acctB58])return;
    try{
      const ext=await fetchConfToken(acctB58);
      const stored=pubToHex(ext.elgamalPubkey);
      if(stored && stored===elgamalPubHex){
        seen[acctB58]=true;
        out.push(new PublicKey(acctB58));
      }
    }catch(_){ /* skip non-confidential accounts */ }
  };
  if(cached && cached.acct) await pushIfMatch(cached.acct);
  // 2) live scan for every account we own on the CXNT mint
  try{
    const accts=await getTokenAccountsByOwnerMint(walletB58,CXNT_MINT.toBase58());
    for(const a of accts) await pushIfMatch(a.pubkey.toBase58());
  }catch(_){ /* RPC may strip the scan; cache-first still covers the primary */ }
  return out;
}
// Set the primary + the full list, and refresh any aggregate UI.
function setConfAccounts(list){
  state.confAccounts=list;
  state.confAcct=list.length?list[0]:null;
  if(state.confAcct) saveConfAcct(state.pubKey.toBase58(),state.confAcct.toBase58(),state.elgamalPub||"");
  renderConfAccounts();
  if(state.confAcct){
    $("stWalletAcct").innerHTML="conf account: <code>"+state.confAcct.toBase58().slice(0,10)+"…</code>";
  }
}
// Render the account list into the My Confidential Account card.
function renderConfAccounts(){
  const el=$("vaultDetail"); if(!el)return;
  if(!state.pubKey){ el.innerHTML='<div class="empty">Connect wallet to see accounts</div>'; return; }
  if(!state.confAccounts.length){ el.innerHTML='<div class="empty">No confidential account — click Create</div>'; return; }
  const rows=state.confAccounts.map((a,i)=>{
    const full=a.toBase58();
    return `<div class="acc-row ${i===0?"primary":""}">
      <button class="acc-pick" style="${i===0?"font-weight:600":""}" data-act="selectConfAccount" data-arg="${i}">${i===0?"★":"○"} ${full.slice(0,10)}…${full.slice(-4)}${(state.acctBalances&&state.acctBalances.has(full))?" · "+fmtAmt(state.acctBalances.get(full))+" "+SYM():""}</button>
    </div>`;
  }).join("");
  const recv=receivingAccount();
  el.innerHTML=`<div class="recv"><b>To receive ${esc(SYM())}</b>, share your confidential account address:
      <div class="recv-row"><code>${recv}</code><button class="btn ghost sm" data-act="copyRecvAddr">Copy</button></div></div>
    <div class="empty" style="text-align:left">${
    state.confAccounts.length===1
      ? ""
      : "<b>"+state.confAccounts.length+" confidential accounts</b> — ★ is the one Send and Unwrap use; click another to switch"
  }</div><div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">${state.confAccounts.length>1?rows:""}</div>`;
}
// The address to hand out: stable across sessions (the lowest address among
// the wallet's confidential accounts for this token — for a wallet with a
// single account, that account).
function receivingAccount(){
  if(!state.confAccounts.length)return "";
  return state.confAccounts.map(a=>a.toBase58()).sort()[0];
}
function copyRecvAddr(){
  const addr=receivingAccount(); if(!addr)return;
  navigator.clipboard.writeText(addr).then(()=>toast("Confidential account address copied","ok")).catch(()=>toast("Could not copy — select the address and copy it manually","err"));
}
// Switch the active account (primary) for withdraw. Balance card still shows the
// sum across all accounts; the Withdraw tab targets the selected one.
function selectConfAccount(i){
  if(i<0||i>=state.confAccounts.length)return;
  const first=state.confAccounts[i];
  state.userPickedAcct=true;
  state.confAccounts=[first,...state.confAccounts.filter((_,j)=>j!==i)];
  setConfAccounts(state.confAccounts);
  toast("Active account: "+first.toBase58().slice(0,10)+"…","ok");
}

// ---- wallet connect ----
function detectWallet(){
  // Wallet extensions inject under several names; check the X1 ones first.
  const x1c=[
    window.x1wallet, window.x1?.solana, window.x1,
    window.X1wallet, window.X1?.solana, window.X1,
    window.x1Wallet, window.xone, window.xoneWallet,
    window.xfi?.x1,
  ];
  for(const c of x1c){
    if(c && (typeof c==="object"||typeof c==="function")) return {name:"X1 Wallet",w:c};
  }
  if(window.solana){
    if(window.solana.isX1) return {name:"X1 Wallet",w:window.solana};
    if(window.solana.isPhantom) return {name:"Phantom",w:window.solana};
    return {name:"Solana",w:window.solana};
  }
  if(window.backpack?.solana) return {name:"Backpack",w:window.backpack.solana};
  if(window.backpack) return {name:"Backpack",w:window.backpack};
  if(window.phantom?.solana) return {name:"Phantom",w:window.phantom.solana};
  if(window.solflare?.isSolflare) return {name:"Solflare",w:window.solflare};
  if(window.solflare) return {name:"Solflare",w:window.solflare};
  return null;
}
async function connectWallet(){
  const det=detectWallet();
  if(!det){toast("No X1 Wallet / Backpack / Phantom extension. Install and reload.","err");return;}
  try{
    // Solana-family wallets connect({onlyIfTrusted:false}); fall back to bare if that throws.
    let p;
    try{ p=det.w.connect({onlyIfTrusted:false}); }
    catch(_){ p=det.w.connect(); }
    const resp=await Promise.resolve(p);
    const pk=resp&&resp.publicKey?new PublicKey(resp.publicKey.toString()):(det.w.publicKey?new PublicKey(det.w.publicKey.toString()):null);
    if(!pk)throw new Error("no public key");
    state.wallet=det.w;state.pubKey=pk;
    $("walletText").textContent=det.name+": "+pk.toBase58().slice(0,6)+"…"+pk.toBase58().slice(-4);
    $("walletDot").classList.add("on"); $("connectBtn").style.display="none";
    toast("Connected via <b>"+esc(det.name)+"</b> — "+pk.toBase58().slice(0,8)+"…","ok");
    // Auto-discover any existing confidential account so receive/withdraw work
    // immediately without manually re-running Create (fallback to live scan).
    try{
      const {elgamalPub}=await deriveKeys();
      state.elgamalPub=elgamalPub;
      const found=await findMyConfAccount(pk.toBase58(),elgamalPub);
      if(found) toast("Loaded your confidential account into this session.","ok");
    }catch(_){ /* no account yet — Create will build one */ }
    await refreshChain();
  }catch(e){toast("Connect failed: "+humanErr(e),"err");}
}

// ---- PDAs ----
function deriveVaultPDA(owner,mint){return PublicKey.findProgramAddressSync([Buffer.from("vault"),owner.toBuffer(),mint.toBuffer()],PROGRAM_ID);}
function deriveConfMintPDA(mint){return PublicKey.findProgramAddressSync([Buffer.from("conf-mint"),mint.toBuffer()],PROGRAM_ID);}

// The per-owner vault PDA must be initialized via create_vault before any
// deposit. Idempotent: only signs+submits if the account does not exist yet.
// Discriminator for create_vault: 1d e0 f7 d0 c1 52 36 87
const CREATE_VAULT_DISC = new Uint8Array([0x1d,0xed,0xf7,0xd0,0xc1,0x52,0x36,0x87]);
function vaultCreateIx(){
  const [vaultPda]=deriveVaultPDA(state.pubKey,CXNT_MINT);
  return new TransactionInstruction({
    keys:[
      {pubkey:vaultPda,isSigner:false,isWritable:true},
      {pubkey:state.pubKey,isSigner:true,isWritable:true},
      {pubkey:CXNT_MINT,isSigner:false,isWritable:false},
      {pubkey:state.pubKey,isSigner:true,isWritable:true},
      {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
    ],
    programId:PROGRAM_ID,data:CREATE_VAULT_DISC,
  });
}
// The create_vault instruction if the wallet's vault does not exist yet, else
// null. Callers put it at the front of the transaction that needs the vault.
async function vaultCreateIxIfMissing(){
  const [vaultPda]=deriveVaultPDA(state.pubKey,CXNT_MINT);
  return (await conn.getAccountInfo(vaultPda,"confirmed")) ? null : vaultCreateIx();
}

// ---- chain helpers ----
async function rpcMethod(method,params){
  const r=await fetch(RPC,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});
  const j=await r.json();
  if(j.error)throw new Error(j.error.message);
  return j.result;
}
// The X1 testnet RPC rejects mint-filtering on getTokenAccountsByOwner for
// token-2022 confidential mints ("not a Token mint"). Use getProgramAccounts
// with memcmp on owner (offset 32) + mint (offset 0) against the program that
// owns the mint (legacy for XNT, token-2022 for CXNT).
async function getTokenAccountsByOwnerMint(owner,mint){
  // pick the owning program: token-2022 ("5YJHi…") or legacy token ("Tokenkeg…")
  const prog = mint===XNT_MINT.toBase58() ? tokBackingProgram().toBase58() : CONF_TOKEN.toBase58();
  // Standard indexed lookup first (works wherever the mint's program is the
  // chain's own token program, e.g. mainnet); the program scan is the fallback.
  try{
    const r=await rpcMethod("getTokenAccountsByOwner",[owner,{mint},{encoding:"base64",commitment:"confirmed"}]);
    if(r&&Array.isArray(r.value))return r.value.map(a=>({pubkey:new PublicKey(a.pubkey),account:a.account}));
  }catch(_e){ /* RPC does not index this token program: scan instead */ }
  const ownerBytes = b58dec(owner);
  const mintBytes = b58dec(mint);
  const j=await rpcMethod("getProgramAccounts",[prog,{encoding:"base64",filters:[
    {memcmp:{offset:32,bytes:b58enc(ownerBytes)}},
    {memcmp:{offset:0,bytes:b58enc(mintBytes)}}
  ]}]);
  return j&&Array.isArray(j)?j.map(a=>({pubkey:new PublicKey(a.pubkey),account:a.account})):[];
}
async function fetchConfToken(tokenAcc){
  const tok=await fetchToken(rpc,address(tokenAcc));
  const ex=tok.data.extensions;
  if(ex.__option!=="Some")throw new Error("not a confidential account");
  const exts=ex.value.filter(e=>e.__kind==="ConfidentialTransferAccount");
  if(!exts.length)throw new Error("no confidential extension");
  return exts[0];
}
// read available balance (elgamal ciphertext bytes) + decryptable
async function readConfCiphertexts(tokenAcc){
  const ext=await fetchConfToken(tokenAcc);
  // NEW codec shape (2026): availableBalance/decryptableAvailableBalance are plain
  // 64-byte objects {0:byte,1:byte,...63:byte}, NOT {__option:'Some',value:{...}}.
  // Robustly flatten ANY shape to a hex string.
  const toHex=(v)=>{
    if(!v)return "";
    let a;
    if(v instanceof Uint8Array)a=v;
    else if(Array.isArray(v))a=new Uint8Array(v.flat());
    else if(v.bytes)a=new Uint8Array(v.bytes);
    else if(v.data)a=new Uint8Array(v.data);
    else if(typeof v==="object")a=new Uint8Array(Object.values(v).flat());
    else a=new Uint8Array(0);
    return hexenc(a);
  };
  // legacy optional shape: unwrap {__option:'Some', value}
  const unwrap=(o)=>{
    if(o&&o.__option==="Some"&&o.value)return o.value;
    return o;
  };
  const out={availHex:toHex(unwrap(ext.availableBalance)), decHex:toHex(unwrap(ext.decryptableAvailableBalance))};
  primeAvailable(out.availHex,out.decHex);
  return out;
}

// ---- refresh state ----
async function refreshChain(){
  try{
    if(!CONFIG && !(await loadDeployment())){ throw new Error("deployment addresses not loaded (/api/state)"); }
    const cfg=await conn.getAccountInfo(CONFIG);
    if(cfg){
      // guard: if config account is shorter than expected, don't read past the end
      const needBytes=8+32+32+32+32+8+8+1; // 145 bytes for 4-pubkey layout
      if(cfg.data.length < needBytes){
        console.warn("[refreshChain] Config account too short:",cfg.data.length,"need",needBytes,"— skipping cap/supply parse");
      }else{
        const dv=new DataView(cfg.data.buffer,cfg.data.byteOffset,cfg.data.byteLength);
        // borsh ConfidentialMintConfig (patched 4-pubkey layout):
        //   disc(8) mint(32) backing(32) reserve(32) authority(32) cap(8) supply(8) bump(1)
        const cfgMint=new PublicKey(cfg.data.subarray(8,40));
        const cfgReserve=new PublicKey(cfg.data.subarray(72,104));
        const cfgAuthority=new PublicKey(cfg.data.subarray(104,136));
        const CAP_OFF=8+32+32+32+32; // 136 (after authority)
        const cap=dv.getBigUint64(CAP_OFF,true);const supply=dv.getBigUint64(CAP_OFF+8,true);
        const uncapped=cap===18446744073709551615n;
        $("stCap").innerText=uncapped?"No cap":fmtAmt(cap);
        $("stSupply").innerText=fmtAmt(supply);
        $("stMint").innerText=cfgMint.toBase58(); // real on-chain conf mint, not a hardcoded label
        $("stMint").title=cfgMint.toBase58()+" ("+SYM()+" mint; live from config account)";
        $("swapDetail").innerHTML=
          row("Config",CONFIG.toBase58())+
          row("Backing mint",XNT_MINT.toBase58())+
          row("Reserve",RESERVE.toBase58())+
          row("Supply cap",uncapped?"none — supply is whatever users have wrapped":fmtAmt(cap)+" "+SYM())+
          row("Confidential supply",fmtAmt(supply)+" "+SYM())+
          row("Mint authority","conf-mint PDA (program)")+
          row("Governance authority",cfgAuthority.toBase58().slice(0,8)+"…");
        try{
          const rb=await rpcMethod("getTokenAccountBalance",[cfgReserve.toBase58(),{commitment:"confirmed"}]);
          const amt=rb&&rb.value?BigInt(rb.value.amount):0n;
          $("stReserve").innerText="reserve: "+fmtAmt(amt)+" "+BSYM();
        }catch(e){}
      }
    }
    // --- My balances + confidential account address ---
    try{
      if(state.pubKey){
        console.log("[conf] pubkey",state.pubKey.toBase58(),"| secret set:",!!state.secret,"| elgamalPub set:",!!state.elgamalPub);
        // find the secret/elgamal key first so we can match + decrypt
        if(!state.elgamalPub||!state.secret){ try{ const {elgamalPub}=await deriveKeys(); state.elgamalPub=elgamalPub; }catch(e){ console.error("[conf] deriveKeys FAILED:",e); throw e; } }
        console.log("[conf] after derive, secret set:",!!state.secret,"| elgamalPub:",(state.elgamalPub||"").slice(0,12));
        // aggregate: discover ALL our confidential accounts, not just one
        let all=[];
        try{ all=await findAllMyConfAccounts(state.pubKey.toBase58(), state.elgamalPub); }catch(e){ console.error("[conf] findAll FAILED:",e); }
        console.log("[conf] found accounts:",all.length);
        setConfAccounts(all);
        if(all.length){
          const full=all[0].toBase58();
          $("stWalletAcct").innerHTML=all.length>1
            ? ("<code>"+full.slice(0,14)+"…"+full.slice(-6)+"</code> <small>+"+(all.length-1)+" more</small>")
            : ("conf account: <code title='"+full+"'>"+full.slice(0,14)+"…"+full.slice(-6)+"</code> <small>(click to copy)</small>");
          $("stWalletAcct").style.cursor="pointer";
          $("stWalletAcct").onclick=()=>{navigator.clipboard.writeText(full).then(()=>toast("Copied confidential account","ok"));};
          // Balance = sum of AVAILABLE balances over our accounts. Credits that have
          // arrived but are not applied yet (received transfers, or a wrap whose
          // apply step was skipped) are shown separately as pending.
          try{
            if(state.secret&&state.aeKey){
              let totalRaw=0n, pendingRaw=0n;
              const perAcct=new Map();
              for(const a of all){
                try{
                  const raw=await rawConfAccount(a.toBase58());
                  const v=elgamalDecryptU64Raw(state.secret,raw.availableBalance);
                  if(v!==null){ totalRaw+=BigInt(v); perAcct.set(a.toBase58(),BigInt(v)); }
                  if(raw.pendingCounter!=="0"){ const pnd=pendingTotal(state.secret,raw); if(pnd!==null) pendingRaw+=pnd; }
                }catch(_){ /* unreadable account: skip */ }
              }
              // Unless the user picked an account, act from the one holding the most,
              // so Send / Unwrap do not default to an empty secondary account.
              if(!state.userPickedAcct&&all.length>1){
                const best=[...all].sort((x,y)=>{const bx=perAcct.get(x.toBase58())||0n,by=perAcct.get(y.toBase58())||0n;return by>bx?1:(by<bx?-1:0);});
                if(!best[0].equals(state.confAcct)){ setConfAccounts(best); }
              }
              state.acctBalances=perAcct; renderConfAccounts();
              // Incoming funds are part of the balance: they are added automatically
              // (one approval) the next time the user sends or unwraps.
              $("stBalance").textContent=fmtAmt(totalRaw+pendingRaw)+" "+SYM()+(all.length>1?" ("+all.length+" accts)":"")
                +(pendingRaw>0n?"  · "+fmtAmt(pendingRaw)+" incoming":"");
            }
          }catch(_){ /* keep — */ }
        }else{
          // No confidential account for the ACTIVE token yet: say so, instead of
          // leaving the previous token's numbers on screen.
          $("stBalance").textContent="0 "+SYM();
          $("stWalletAcct").textContent="no "+SYM()+" account yet — click Create";
          $("stWalletAcct").style.cursor="default";
          $("stWalletAcct").onclick=null;
        }
        // show the wallet's real backing-token balance
        try{
          if(state.pubKey){
            let xnt=0n;
            if(isNativeBacking()){
              xnt=BigInt(await conn.getBalance(state.pubKey,"confirmed"));
            }else{
              const ata=await getAssociatedTokenAddress(XNT_MINT, state.pubKey, false, tokBackingProgram(), ASSOCIATED_TOKEN_PROGRAM_ID);
              try{ xnt=BigInt((await conn.getTokenAccountBalance(ata,"confirmed")).value.amount); }catch(_e){ xnt=0n; }
            }
            $("stXnt").textContent=BSYM()+": "+fmtAmt(xnt);
          } else { $("stXnt").textContent=BSYM()+": —"; }
        }catch(_){ $("stXnt").textContent=BSYM()+": —"; }
      }
    }catch(e){ /* wallet not connected or no account yet */ }
  }catch(e){toast("State load failed: "+humanErr(e),"err");}
}
function row(k,v){return `<div class="row"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;}

// ---- CREATE confidential account (wallet signs + feePayer) ----
async function createAccount(){
  try{
    if(!state.pubKey)throw new Error("connect wallet first");
    toast("Deriving confidential keys from my wallet signature (in-browser)…","ok");
    const {secret,elgamalPub,proofB64,aeKey}=await deriveKeys();
    state.elgamalPub=elgamalPub;
    // Reuse an existing confidential account if one matches our derived key
    // (persisted cache first, then a live scan). Only accounts that actually have
    // the ConfidentialTransferAccount extension match — a plain ATA must NOT be
    // picked, or the deposit CPI fails with "Extension not found" (0x30).
    const found=await findMyConfAccount(state.pubKey.toBase58(),elgamalPub);
    if(found){
      toast("Found your confidential account (ElGamal pubkey OK).","ok");
      await refreshChain();
      return;
    }
    // no account matches the derived ElGamal pubkey -> create one. Where the
    // token program is the chain's own Token-2022, it lives at the wallet's
    // associated token address, so others can pay this wallet by its address.
    await confirmStableKey();
    const useAta=CONF_TOKEN.equals(TOKEN_2022_PROGRAM_ID);
    toast("Creating your confidential account — approve "+(useAta?"1 transaction":"2 transactions"),"ok");
    const created=useAta ? await createAtaConfAccount({proofB64,aeKey}) : await createFreshConfAccount({secret,elgamalPub,proofB64,aeKey});
    state.confAcct=created;
    saveConfAcct(state.pubKey.toBase58(),created.toBase58(),elgamalPub);
    $("stWalletAcct").innerText="conf account: "+created.toBase58().slice(0,10)+"…";
    toast("<b>Confidential account created</b> — "+created.toBase58().slice(0,12)+"…","ok");
    await refreshChain();
  }catch(e){toast("createAccount: "+humanErr(e),"err");}
}

// Create (or finish configuring) the wallet's ASSOCIATED token account for the
// active confidential mint, in a single transaction: create-if-missing,
// add the confidential extension, configure it, verify the key proof.
async function createAtaConfAccount({proofB64,aeKey}){
  const ata=await getAssociatedTokenAddress(CXNT_MINT,state.pubKey,false,CONF_TOKEN,ASSOCIATED_TOKEN_PROGRAM_ID);
  const createIx=createAssociatedTokenAccountIdempotentInstruction(state.pubKey,ata,state.pubKey,CXNT_MINT,CONF_TOKEN,ASSOCIATED_TOKEN_PROGRAM_ID);
  const realloc=toWeb3Ix(getReallocateInstruction({token:ata.toBase58(),payer:createNoopSigner(address(state.pubKey.toBase58())),owner:state.pubKey.toBase58(),newExtensionTypes:[ExtensionType.ConfidentialTransferAccount]}));
  const conf=toWeb3Ix(getConfigureConfidentialTransferAccountInstruction({token:ata.toBase58(),mint:CXNT_MINT.toBase58(),authority:state.pubKey.toBase58(),decryptableZeroBalance:b64dec(aeEncrypt(aeKey,0n)),maximumPendingBalanceCreditCounter:1n<<16n,proofInstructionOffset:1}));
  const verify=toWeb3Ix(getVerifyProofInstruction({discriminator:4,proofData:Buffer.from(proofB64,"base64")}));
  const tx=new Transaction().add(cuLimit(CU_CREATE),createIx,realloc,conf,verify);
  const rb=await conn.getLatestBlockhash("confirmed");tx.recentBlockhash=rb.blockhash;tx.feePayer=state.pubKey;
  const s=await walletSign(tx);
  const sig=await conn.sendRawTransaction(s.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
  await conn.confirmTransaction(sig,"confirmed");
  return ata;
}

// Create ONE fresh confidential account for the ACTIVE mint, owned by the
// connected wallet (wallet pays rent). Keys are derived from the wallet
// signature over owner||mint, so a 2nd account shares the same ElGamal key.
async function createFreshConfAccount({secret,elgamalPub,proofB64,aeKey}){
  // tx1: create + init token-2022 account (rent)
  const ata=Keypair.generate();
  const space=getAccountLen([ExtensionType.ConfidentialTransferAccount]);
  const lam=await conn.getMinimumBalanceForRentExemption(space);
  const createIx=SystemProgram.createAccount({fromPubkey:state.pubKey,newAccountPubkey:ata.publicKey,lamports:lam,space,programId:CONF_TOKEN});
  const initIx=new TransactionInstruction({keys:[
    {pubkey:ata.publicKey,isSigner:false,isWritable:true},
    {pubkey:CXNT_MINT,isSigner:false,isWritable:false},
    {pubkey:state.pubKey,isSigner:false,isWritable:false},
    {pubkey:new PublicKey("SysvarRent111111111111111111111111111111111"),isSigner:false,isWritable:false}],
    programId:CONF_TOKEN,data:Buffer.from([1])});
  const tx1=new Transaction().add(cuLimit(CU_SMALL),createIx,initIx);
  const rb1=await conn.getLatestBlockhash("confirmed");tx1.recentBlockhash=rb1.blockhash;tx1.feePayer=state.pubKey;
  tx1.partialSign(ata);
  const s1=await walletSign(tx1);
  const sig1=await conn.sendRawTransaction(s1.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
  await conn.confirmTransaction(sig1,"confirmed");

  // tx2: reallocate + configure + verify pubkey proof (inline)
  const realloc=toWeb3Ix(getReallocateInstruction({token:ata.publicKey.toBase58(),payer:createNoopSigner(address(state.pubKey.toBase58())),owner:state.pubKey.toBase58(),newExtensionTypes:[ExtensionType.ConfidentialTransferAccount]}));
  const zeroCt=b64dec(aeEncrypt(aeKey,0n));
  const conf2=toWeb3Ix(getConfigureConfidentialTransferAccountInstruction({token:ata.publicKey.toBase58(),mint:CXNT_MINT.toBase58(),authority:state.pubKey.toBase58(),decryptableZeroBalance:zeroCt,maximumPendingBalanceCreditCounter:1n<<16n,proofInstructionOffset:1}));
  const verify=toWeb3Ix(getVerifyProofInstruction({discriminator:4,proofData:Buffer.from(proofB64,"base64")}));
  const tx2=new Transaction().add(cuLimit(CU_SMALL),realloc,conf2,verify);
  const rb2=await conn.getLatestBlockhash("confirmed");tx2.recentBlockhash=rb2.blockhash;tx2.feePayer=state.pubKey;
  const s2=await walletSign(tx2);
  const sig2=await conn.sendRawTransaction(s2.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
  await conn.confirmTransaction(sig2,"confirmed");
  return ata.publicKey;
}

// UX helper: create a fresh destination account for the ACTIVE token and fill it
// into the transfer field, so a user can verify transfers without a 2nd wallet.
async function createTestDest(){
  try{
    if(!state.pubKey)throw new Error("connect wallet first");
    toast("Creating a test recipient for "+ACTIVE+" (approve 2 transactions)…","ok");
    const {secret,elgamalPub,proofB64,aeKey}=await deriveKeys();
    state.elgamalPub=elgamalPub;
    await confirmStableKey();
    const pk=await createFreshConfAccount({secret,elgamalPub,proofB64,aeKey});
    state.confAccounts=[pk,...(state.confAccounts||[]).filter(a=>a.toBase58()!==pk.toBase58())];
    renderConfAccounts();
    $("transferDest").value=pk.toBase58();
    toast("<b>Test recipient ready</b> — "+pk.toBase58().slice(0,12)+"… filled in as Recipient (same wallet owns it).","ok");
  }catch(e){toast("createTestDest: "+humanErr(e),"err");}
}

// ---- RECREATE confidential account under current stable key ----
// The old account's on-chain ElGamal pubkey was set under an earlier one-time
// signature (pre-stable-sig-cache), so its ElGamal available_balance can't be
// decrypted with the secret we now derive -> transfer equality proof fails (-13),
// direct ElGamal decrypt fails (-1). The account's ElGamal pubkey is fixed at
// Configure time and cannot be changed in place, so we recreate a fresh
// confidential account under the CURRENT stable key, then re-deposit.
async function recreateConfAccount(){
  try{
    if(!state.pubKey)throw new Error("connect wallet first");
    toast("Recreating confidential account under current stable key…","ok");
    const {elgamalPub,proofB64,aeKey}=await deriveKeys();
    state.elgamalPub=elgamalPub;

    // tx1: create + init a fresh token-2022 account (rent)
    const ata=Keypair.generate();
    const space=getAccountLen([ExtensionType.ConfidentialTransferAccount]);
    const lam=await conn.getMinimumBalanceForRentExemption(space);
    const createIx=SystemProgram.createAccount({fromPubkey:state.pubKey,newAccountPubkey:ata.publicKey,lamports:lam,space,programId:CONF_TOKEN});
    const initIx=new TransactionInstruction({keys:[
      {pubkey:ata.publicKey,isSigner:false,isWritable:true},
      {pubkey:CXNT_MINT,isSigner:false,isWritable:false},
      {pubkey:state.pubKey,isSigner:false,isWritable:false},
      {pubkey:new PublicKey("SysvarRent111111111111111111111111111111111"),isSigner:false,isWritable:false}],
      programId:CONF_TOKEN,data:Buffer.from([1])});
    const tx1=new Transaction().add(cuLimit(CU_SMALL),createIx,initIx);
    const rb1=await conn.getLatestBlockhash("confirmed");tx1.recentBlockhash=rb1.blockhash;tx1.feePayer=state.pubKey;
    tx1.partialSign(ata);
    const s1=await walletSign(tx1);
    const sig1=await conn.sendRawTransaction(s1.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
    await conn.confirmTransaction(sig1,"confirmed");

    // tx2: reallocate + configure (decryptable zero under current AE key) + verify pubkey proof
    const realloc=toWeb3Ix(getReallocateInstruction({token:ata.publicKey.toBase58(),payer:createNoopSigner(address(state.pubKey.toBase58())),owner:state.pubKey.toBase58(),newExtensionTypes:[ExtensionType.ConfidentialTransferAccount]}));
    const zeroCt=b64dec(aeEncrypt(aeKey,0n));
    const conf2=toWeb3Ix(getConfigureConfidentialTransferAccountInstruction({token:ata.publicKey.toBase58(),mint:CXNT_MINT.toBase58(),authority:state.pubKey.toBase58(),decryptableZeroBalance:zeroCt,maximumPendingBalanceCreditCounter:1n<<16n,proofInstructionOffset:1}));
    const verify=toWeb3Ix(getVerifyProofInstruction({discriminator:4,proofData:Buffer.from(proofB64,"base64")}));
    const tx2=new Transaction().add(cuLimit(CU_SMALL),realloc,conf2,verify);
    const rb2=await conn.getLatestBlockhash("confirmed");tx2.recentBlockhash=rb2.blockhash;tx2.feePayer=state.pubKey;
    const s2=await walletSign(tx2);
    const sig2=await conn.sendRawTransaction(s2.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
    await conn.confirmTransaction(sig2,"confirmed");

    state.confAcct=ata.publicKey;
    saveConfAcct(state.pubKey.toBase58(),ata.publicKey.toBase58(),elgamalPub);
    $("stWalletAcct").innerText="conf account: "+ata.publicKey.toBase58().slice(0,10)+"…";
    toast("<b>Fresh confidential account created</b> under current stable key. Re-deposit now (<code>"+ata.publicKey.toBase58().slice(0,12)+"…</code>)","ok");
    await refreshChain();
  }catch(e){toast("recreateConfAccount: "+humanErr(e),"err");}
}

// parse a decimal string (e.g. "0.1") to raw units for a 9-decimal token
function parseAmount9(s){
  const str=String(s??"").trim();
  if(str===""||str===".")throw new Error("Enter an amount first.");
  if(!/^\d*\.?\d*$/.test(str))throw new Error("That is not a valid amount: "+str);
  const [i,f=""]=str.split(".");
  const int=(i===""?"0":i).replace(/^0+(?=\d)/,"");
  const D=Number(tokBackingDecimals());
  const frac=f.padEnd(D,"0").slice(0,D);
  return BigInt(int===""?"0":int)*10n**BigInt(D) + BigInt(frac.padStart(D,"0"));
}

// The connected wallet's backing-token account for the ACTIVE token. If the
// wallet has none, the wallet itself creates its associated token account (it
// pays the rent) — no server involved.
async function ensureOwnBackingAta(){
  const ata=await getAssociatedTokenAddress(XNT_MINT,state.pubKey,false,tokBackingProgram(),ASSOCIATED_TOKEN_PROGRAM_ID);
  if(await conn.getAccountInfo(ata,"confirmed"))return ata;
  const have=await getTokenAccountsByOwnerMint(state.pubKey.toBase58(),XNT_MINT.toBase58());
  if(have.length)return have[0].pubkey;
  {
    toast("Creating your "+BSYM()+" token account (one-time)…","ok");
    const tx=new Transaction().add(cuLimit(CU_SMALL),createAssociatedTokenAccountInstruction(state.pubKey,ata,state.pubKey,XNT_MINT,tokBackingProgram(),ASSOCIATED_TOKEN_PROGRAM_ID));
    const rb=await conn.getLatestBlockhash("confirmed");tx.recentBlockhash=rb.blockhash;tx.feePayer=state.pubKey;
    const s=await walletSign(tx);
    const sig=await conn.sendRawTransaction(s.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
    await conn.confirmTransaction(sig,"confirmed");
  }
  return ata;
}
// Wrap source: the wallet's backing-token account. If it is empty and this
// deployment runs a testnet faucet, ask it once; otherwise say so plainly.
async function ensureXnt(ownerB58){
  const acct=await ensureOwnBackingAta();
  let bal=0n;
  try{ bal=BigInt((await conn.getTokenAccountBalance(acct,"confirmed")).value.amount); }catch(_e){}
  if(bal>0n)return acct;
  let j=null;
  try{
    const r=await fetch("/api/faucet",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({to:ownerB58})});
    j=await r.json();
  }catch(_e){ j=null; }
  if(!j||!j.ok)throw new Error("This wallet holds no "+BSYM()+" to wrap. Fund it with "+BSYM()+" first, then retry.");
  return acct;
}
// Backing-token account for tokens whose backing comes from a separate faucet.
async function ensureBackingAta(){
  // The associated token account is looked up directly (always current); the
  // owner scan is only a fallback for wallets using a non-associated account.
  const ata=await getAssociatedTokenAddress(XNT_MINT,state.pubKey,false,tokBackingProgram(),ASSOCIATED_TOKEN_PROGRAM_ID);
  if(await conn.getAccountInfo(ata,"confirmed"))return ata;
  const have=await getTokenAccountsByOwnerMint(state.pubKey.toBase58(),XNT_MINT.toBase58());
  if(!have.length)throw new Error("Your wallet holds no "+BSYM()+" yet."+(FAUCET_ENABLED?" Click Faucet to get test "+BSYM()+" first.":""));
  return have[0].pubkey;
}
async function deposit(){
  try{
    toast("Wrap started — building transaction…","ok");
    if(!state.wallet||!state.pubKey)throw new Error("connect wallet first");
    if(!state.confAcct)throw new Error("create confidential account first");
    if(!state.elgamalPub){await deriveKeys();}
    const amount=parseAmount9($("depAmount").value);
    if(amount<=0n)throw new Error("Enter an amount first.");
    requireWithinCtLimit(amount,"wrap");
    const [confPda]=deriveConfMintPDA(CXNT_MINT);
    const [vaultPda]=deriveVaultPDA(state.pubKey,CXNT_MINT);
    const vaultIx=await vaultCreateIxIfMissing();
    // cXNT: auto-fund XNT backing via /api/faucet. USDC.x: ensure the wallet's
    // mock-USDC.x ATA exists (funded separately via the Faucet button).
    const native=isNativeBacking();
    let backingSource;
    if(native){
      const have=BigInt(await conn.getBalance(state.pubKey,"confirmed"));
      if(have<amount+NATIVE_FEE_MARGIN)throw new Error("Not enough "+BSYM()+": you have "+fmtAmt(have)+", and wrapping "+fmtAmt(amount)+" needs a little extra for network fees.");
      backingSource=await nativeBackingAta();
    }else{
      backingSource = isXnt() ? await ensureXnt(state.pubKey.toBase58()) : await ensureBackingAta();
      let haveTok=0n;
      try{ haveTok=BigInt((await conn.getTokenAccountBalance(backingSource,"confirmed")).value.amount); }catch(_e){ haveTok=0n; }
      if(haveTok<amount)throw new Error("Not enough "+BSYM()+": your wallet holds "+fmtAmt(haveTok)+" "+BSYM()+" and you tried to wrap "+fmtAmt(amount)+"."+((FAUCET_ENABLED&&!isXnt())?" Click Faucet to get test "+BSYM()+" first.":""));
    }
    // 0.39% protocol fee (wrap only): user is credited net = amount - fee; the fee (in backing)
    // goes to the fee recipient's ATA, which the program enforces. Create that ATA
    // first if missing (must land before the program ix).
    const fee=feeOn(amount);
    const net=amount-fee;
    const feeInfo=await feeAtaCreateIx(XNT_MINT, tokBackingProgram(), state.pubKey);
    const ixData=concat(new Uint8Array([73,19,230,11,25,247,11,181]),u64le(amount));
    const keys=[
      {pubkey:vaultPda,isSigner:false,isWritable:true},
      {pubkey:confPda,isSigner:false,isWritable:true},
      {pubkey:CXNT_MINT,isSigner:false,isWritable:true},
      {pubkey:XNT_MINT,isSigner:false,isWritable:false},
      {pubkey:state.confAcct,isSigner:false,isWritable:true},
      {pubkey:backingSource,isSigner:false,isWritable:true},
      {pubkey:RESERVE,isSigner:false,isWritable:true},
      {pubkey:feeInfo.ata,isSigner:false,isWritable:true},
      {pubkey:state.pubKey,isSigner:true,isWritable:false},
      {pubkey:CONF_TOKEN,isSigner:false,isWritable:false},
      {pubkey:tokBackingProgram(),isSigner:false,isWritable:false},
      {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
    ];
    const ix=new TransactionInstruction({keys,programId:PROGRAM_ID,data:ixData});
    // The wrap credit arrives as a pending balance; the SAME transaction applies
    // it, so one approval leaves the funds spendable. The apply needs the pending
    // counter and the new total, both known in advance: counter + 1, and
    // available + anything already incoming + this wrap's net amount.
    const dk=await deriveKeys();
    state.aeKey=state.aeKey||dk.aeKey;
    const pre=await rawConfAccount(state.confAcct.toBase58());
    const secretNow=elgamalSecretFromSig(dk.sigB64);
    let curAvail=0n;
    try{ curAvail=BigInt(elgamalDecryptU64(secretNow,pre.availableBalance)||"0"); }catch(_e){ curAvail=0n; }
    const preCounter=BigInt(pre.pendingCounter||"0");
    const alreadyIncoming=preCounter===0n?0n:pendingTotal(secretNow,pre);
    const applyIx=alreadyIncoming===null?null:toWeb3Ix(getApplyConfidentialPendingBalanceInstruction({
      token:state.confAcct.toBase58(),
      authority:state.pubKey.toBase58(),
      expectedPendingBalanceCreditCounter:preCounter+1n,
      newDecryptableAvailableBalance:new Uint8Array(b64dec(aeEncrypt(state.aeKey,curAvail+alreadyIncoming+net))),
    }));

    const tx=new Transaction().add(cuLimit(CU_WRAP));
    if(vaultIx) tx.add(vaultIx);
    if(native){
      // Wrap the native coin into a temporary wrapped-native account...
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(state.pubKey,backingSource,state.pubKey,NATIVE_MINT,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID),
        SystemProgram.transfer({fromPubkey:state.pubKey,toPubkey:backingSource,lamports:amount}),
        createSyncNativeInstruction(backingSource,TOKEN_PROGRAM_ID),
      );
    }
    if(feeInfo.ix) tx.add(feeInfo.ix);
    tx.add(ix);
    if(applyIx) tx.add(applyIx);
    // ...and close it again afterwards, so its rent returns to the wallet.
    if(native) tx.add(createCloseAccountInstruction(backingSource,state.pubKey,state.pubKey,[],TOKEN_PROGRAM_ID));
    const rb=await conn.getLatestBlockhash("confirmed");tx.recentBlockhash=rb.blockhash;tx.feePayer=state.pubKey;
    const s=await walletSign(tx);
    const sig=await conn.sendRawTransaction(s.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
    await conn.confirmTransaction(sig,"confirmed");
    const sigLabel=sig.slice(0,14)+"…";

    toast("<b>Deposited "+esc($("depAmount").value)+" "+BSYM()+" → "+fmtAmt(net)+" "+SYM()+"</b> ("+FEE_LABEL+" fee "+fmtAmt(fee)+" "+BSYM()+") — "+sigLabel,"ok");
    await refreshChain();
  }catch(e){toast("Deposit failed: "+humanErr(e),"err");}
}

// ---- APPLY PENDING: settle deposited confidential credits so they're spendable ----
// `auto` = called by Send / Unwrap before they run: incoming funds are applied
// first so the user never has to do it by hand. Errors then propagate to the caller.
async function applyPending(auto){
  auto=auto===true;
  try{
    if(!state.wallet||!state.pubKey)throw new Error("connect wallet first");
    if(!state.confAcct)throw new Error("create confidential account first");
    const {aeKey,sigB64}=await deriveKeys();
    state.aeKey=aeKey;
    const secret=elgamalSecretFromSig(sigB64);
    // Re-scan first: a transfer may have landed in an account this session has not listed yet.
    let accounts=[];
    try{ accounts=await findAllMyConfAccounts(state.pubKey.toBase58(),state.elgamalPub); }catch(_e){}
    for(const known of (state.confAccounts||[])){ if(!accounts.some(a=>a.equals(known)))accounts.push(known); }
    if(!accounts.length)accounts=[state.confAcct];
    let applied=0, lastSig="";
    for(const acct of accounts){
      const raw=await rawConfAccount(acct.toBase58());
      const pending=BigInt(raw.pendingCounter||"0");
      if(pending<=0n)continue;
      if(auto)toast("Receiving incoming "+SYM()+" first — approve to add it to your balance…","ok");
      // Set the AE-decryptable copy to the NEW TOTAL (available + pending), matching
      // what the apply makes the ElGamal available. The pending amount is DECRYPTED
      // from the account — whatever was actually credited (wraps net of the fee,
      // received transfers) — never a number typed into a field.
      let cur=0n;
      try{ cur=elgamalDecryptU64(secret,raw.availableBalance); }catch(_e){ cur=0n; }
      const pendingAmt=pendingTotal(secret,raw);
      if(pendingAmt===null)throw new Error("could not read the pending balance of "+acct.toBase58().slice(0,8)+"… — retry in a moment");
      const applyIx=toWeb3Ix(getApplyConfidentialPendingBalanceInstruction({
        token:acct.toBase58(),
        authority:state.pubKey.toBase58(),
        expectedPendingBalanceCreditCounter:pending,
        newDecryptableAvailableBalance:new Uint8Array(b64dec(aeEncrypt(aeKey,cur+pendingAmt))),
      }));
      const tx=new Transaction().add(cuLimit(CU_APPLY),applyIx);
      const rb=await conn.getLatestBlockhash("confirmed");tx.recentBlockhash=rb.blockhash;tx.feePayer=state.pubKey;
      const s=await walletSign(tx);
      lastSig=await conn.sendRawTransaction(s.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
      await conn.confirmTransaction(lastSig,"confirmed");
      applied++;
    }
    if(!applied){ if(!auto)toast("Nothing incoming to receive.","ok"); return 0; }
    if(!auto)toast("<b>Incoming funds added to your balance</b> — "+lastSig.slice(0,14)+"…","ok");
    await refreshChain();
    return applied;
  }catch(e){ if(auto)throw e; toast("Apply Pending failed: "+humanErr(e),"err"); return 0; }
}

// ---- SPENDING: one wallet approval per action ----
// A send or an unwrap is several transactions (stage proofs, then use them).
// They are all built up front and signed together with signAllTransactions, so
// the wallet shows ONE approval; they are then sent in order. Two things that
// used to be separate steps are folded in:
//   * incoming (pending) funds are applied inside the same batch — the client
//     predicts the resulting ciphertext exactly as the token program computes it;
//   * the identity-handle repair (see below) is chained in front of an unwrap,
//     using the ciphertext the repair transfer will leave behind.
//
// IDENTITY HANDLE: a balance that was only ever wrapped is {amount*G, identity}.
// The proof program rejects an equality proof over a ciphertext with an identity
// handle, so before unwrapping such a balance the account sends itself 1 base
// unit: subtracting a real ciphertext gives the balance a real handle.
function handleIsIdentity(availHex){
  const h=(availHex||"").slice(64,128); // ciphertext = commitment(32B) || handle(32B)
  return h.length===64 && /^0+$/.test(h);
}
function aeHex(aeKey,amount){ return hexenc(b64dec(aeEncrypt(aeKey,amount))); }
// available + pending_lo + pending_hi * 2^16, as the token program will compute it.
function applyPendingCiphertext(availHex,loHex,hiHex){
  const {exports}=pg();
  const put=(hex)=>{const p=exports.alloc(64);pgMem().set(hexdec(hex),p);return p;};
  const a=put(availHex),l=put(loHex),h=put(hiHex),out=exports.alloc(64);
  const n=exports.elgamal_apply_pending(a,64,l,64,h,64,out,64);
  const res=n===64?hexenc(pgMem().slice(out,out+64)):null;
  [a,l,h,out].forEach(p=>exports.dealloc(p,64));
  if(!res)throw new Error("could not combine the incoming balance");
  return res;
}
function buildTx(ixs,blockhash,signers){
  const t=new Transaction().add(...ixs);
  t.recentBlockhash=blockhash; t.feePayer=state.pubKey;
  (signers||[]).forEach(kp=>t.partialSign(kp));
  return t;
}
function txFits(t){
  try{ return t.serialize({requireAllSignatures:false,verifySignatures:false}).length<=1232; }catch(_e){ return false; }
}
// Sign a list of transactions with one wallet approval when the wallet supports
// it, then send them in order. Falls back to one approval per transaction.
async function signAndSendBatch(txs){
  let signed=null;
  if(txs.length>1&&state.wallet&&typeof state.wallet.signAllTransactions==="function"){
    try{
      const r=await _queueSign(()=>state.wallet.signAllTransactions(txs));
      const arr=Array.isArray(r)?r:(r&&(r.signedTransactions||r.transactions));
      if(Array.isArray(arr)&&arr.length===txs.length){
        const out=arr.map(asSignedTx);
        // keep the batch only if every transaction came back fully signed
        if(out.every(x=>{ try{ return Transaction.from(x.serialize()).verifySignatures(); }catch(_e){ return false; } }))signed=out;
      }
    }catch(e){
      if(/reject|denied|declin|cancel/i.test(String((e&&e.message)||e)))throw e;
      signed=null;
    }
  }
  const sigs=[];
  for(let i=0;i<txs.length;i++){
    const s=signed?signed[i]:await walletSign(txs[i]);
    // Each step is confirmed before the next is sent: the next one's preflight
    // simulation must see the accounts and proof bytes this one wrote.
    const sig=await conn.sendRawTransaction(s.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
    await conn.confirmTransaction(sig,"confirmed");
    sigs.push(sig);
  }
  return sigs;
}
// Read the active account and work out what it will hold once any incoming
// funds are applied. Returns the (possibly predicted) available ciphertext, the
// spendable amount, and the apply instruction to put in front of the spend.
async function spendContext(){
  const dk=await deriveKeys();
  state.aeKey=dk.aeKey; state.elgamalPub=dk.elgamalPub;
  const acct=state.confAcct.toBase58();
  const stored=pubToHex((await fetchConfToken(acct)).elgamalPubkey);
  if(stored!==dk.elgamalPub)throw new Error("This confidential account was created under a different key. Open Advanced → Recreate account, then wrap again.");
  const secret=elgamalSecretFromSig(dk.sigB64);
  const raw=await rawConfAccount(acct);
  let cur;
  try{ cur=elgamalDecryptU64(secret,raw.availableBalance); }catch(_e){ throw new Error("Could not read your balance. Refresh and retry."); }
  let availHex=raw.availableBalance, applyIx=null, incoming=0n;
  const counter=BigInt(raw.pendingCounter||"0");
  if(counter>0n){
    const pend=pendingTotal(secret,raw);
    if(pend===null)throw new Error("Could not read your incoming balance. Refresh and retry.");
    incoming=pend;
    availHex=applyPendingCiphertext(raw.availableBalance,raw.pendingBalanceLo,raw.pendingBalanceHi);
    cur+=pend;
    applyIx=toWeb3Ix(getApplyConfidentialPendingBalanceInstruction({
      token:acct,authority:state.pubKey.toBase58(),
      expectedPendingBalanceCreditCounter:counter,
      newDecryptableAvailableBalance:new Uint8Array(b64dec(aeEncrypt(dk.aeKey,cur))),
    }));
    _amountMemo.set(_memoKey(secret,availHex),cur);
  }
  return {dk,secret,acct,availHex,cur,applyIx,incoming};
}
const verifyIx=(discriminator,record,ctx)=>toWeb3Ix(getVerifyProofInstruction({discriminator,proofAccount:record.toBase58(),offset:RECORD_META,contextState:ctx.toBase58(),contextStateAuthority:state.pubKey.toBase58()}));
// Stage + build one confidential transfer out of `acct`. `pre` are instructions
// that must run first (e.g. applying incoming funds). Returns the transactions
// (unsigned) and the proof output.
async function planTransfer({sigB64,aeKey,acct,availHex,cur,amount,destAcct,destPubHex,pre,assume,blockhash}){
  const proofs=genTransferProofFromSig(sigB64,availHex,aeHex(aeKey,cur),amount,destPubHex);
  const staged=await planStaging(
    [33+128,33+264,33+352],
    [{label:"eqRecord",proof:Buffer.from(proofs.equality,"base64")},{label:"valRecord",proof:Buffer.from(proofs.ciphertextValidity,"base64")},{label:"rangeRecord",proof:Buffer.from(proofs.range,"base64")}],
    assume
  );
  const [eqCtx,rangeCtx,valCtx]=staged.contexts;
  const [eqRec,valRec,rpRec]=staged.records;
  const core=[
    verifyIx(3,eqRec,eqCtx),verifyIx(12,valRec,valCtx),verifyIx(7,rpRec,rangeCtx),
    toWeb3Ix(getConfidentialTransferInstruction({
      sourceToken:acct,mint:CXNT_MINT.toBase58(),destinationToken:destAcct,
      equalityRecord:eqCtx.toBase58(),ciphertextValidityRecord:valCtx.toBase58(),rangeRecord:rangeCtx.toBase58(),
      authority:state.pubKey.toBase58(),
      newSourceDecryptableAvailableBalance:new Uint8Array(b64dec(aeEncrypt(aeKey,BigInt(proofs.newAvailableBalance)))),
      transferAmountAuditorCiphertextLo:Buffer.from(proofs.auditorLo,"base64"),
      transferAmountAuditorCiphertextHi:Buffer.from(proofs.auditorHi,"base64"),
      equalityProofInstructionOffset:0,ciphertextValidityProofInstructionOffset:0,rangeProofInstructionOffset:0,
    })),
    closeContextIx(eqCtx),closeContextIx(valCtx),closeContextIx(rangeCtx),
  ];
  const txs=staged.groups.map(g=>groupToTx(g,blockhash));
  const withPre=buildTx([cuLimit(CU_TRANSFER),...(pre||[]),...core],blockhash);
  // `pre` (applying incoming funds) must be in the SAME transaction as the
  // transfer whose proofs assume it: if a new credit lands in between, the whole
  // transaction then fails cleanly instead of leaving the balance copies apart.
  if((pre&&pre.length)&&!txFits(withPre))throw new Error("Could not fit this into one transaction. Click Receive incoming first, then retry.");
  txs.push(withPre);
  return {txs,proofs,staged};
}

// ---- UNWRAP ----
async function withdraw(){
  try{
    if(!state.wallet||!state.pubKey)throw new Error("connect wallet first");
    if(!state.confAcct)throw new Error("create confidential account first");
    let amount=parseAmount9($("wdAmount").value);
    if(amount<=0n)throw new Error("amount must be > 0");
    toast("Preparing your unwrap…","ok");
    const c=await spendContext();
    if(c.cur<amount)throw new Error("Insufficient "+SYM()+" in this account (have "+fmtAmt(c.cur)+", need "+fmtAmt(amount)+").");
    const [confPda]=deriveConfMintPDA(CXNT_MINT);
    const [vaultPda]=deriveVaultPDA(state.pubKey,CXNT_MINT);
    const vaultIx=await vaultCreateIxIfMissing();
    const native=isNativeBacking();
    const backingDest=native ? await nativeBackingAta() : await ensureOwnBackingAta();
    toast("Building zero-knowledge proofs…","ok");
    const rb=await conn.getLatestBlockhash("confirmed");
    const txs=[]; const commits=[];
    let availHex=c.availHex, cur=c.cur, pre=[]; let assume=null;
    if(c.applyIx)pre.push(c.applyIx);

    // Balance repair, chained in front of the unwrap (same approval).
    if(handleIsIdentity(availHex)){
      if(amount>cur-1n)amount=cur-1n; // the 1 unit used by the repair comes back as incoming
      if(amount<=0n)throw new Error("This balance is too small to unwrap.");
      const heal=await planTransfer({sigB64:c.dk.sigB64,aeKey:c.dk.aeKey,acct:c.acct,availHex,cur,amount:1n,destAcct:c.acct,destPubHex:c.dk.elgamalPub,pre,blockhash:rb.blockhash});
      txs.push(...heal.txs); commits.push(heal.staged.commit);
      availHex=heal.proofs.newAvailableCiphertext; cur=BigInt(heal.proofs.newAvailableBalance);
      if(!availHex||handleIsIdentity(availHex))throw new Error("balance repair did not produce a usable ciphertext");
      pre=[]; assume=heal.staged.planned;
    }

    const proof=genWithdrawProofFromSig(c.dk.sigB64,availHex,cur,amount);
    const staged=await planStaging([33+128,33+264],[{label:"eqRecord",proof:Buffer.from(proof.equality,"base64")},{label:"rangeRecord",proof:Buffer.from(proof.range,"base64")}],assume);
    commits.push(staged.commit);
    const [eqCtx,rpCtx]=staged.contexts; const [eqRec,rpRec]=staged.records;
    const relayIx=toWeb3Ix(getConfidentialWithdrawInstruction({
      token:c.acct,mint:CXNT_MINT.toBase58(),equalityRecord:eqCtx.toBase58(),rangeRecord:rpCtx.toBase58(),
      authority:state.pubKey.toBase58(),amount,decimals:CXNT_MINT_DECIMALS(),
      newDecryptableAvailableBalance:new Uint8Array(b64dec(aeEncrypt(c.dk.aeKey,BigInt(proof.newAvailableBalance||"0")))),
      equalityProofInstructionOffset:0,rangeProofInstructionOffset:0,
    }));
    const programIx=new TransactionInstruction({programId:PROGRAM_ID,
      data:concat(new Uint8Array([192,153,197,143,238,85,204,38]),u64le(amount)),
      keys:[
        {pubkey:vaultPda,isSigner:false,isWritable:true},
        {pubkey:confPda,isSigner:false,isWritable:true},
        {pubkey:CXNT_MINT,isSigner:false,isWritable:true},
        {pubkey:XNT_MINT,isSigner:false,isWritable:false},
        {pubkey:state.confAcct,isSigner:false,isWritable:true},
        {pubkey:backingDest,isSigner:false,isWritable:true},
        {pubkey:RESERVE,isSigner:false,isWritable:true},
        {pubkey:state.pubKey,isSigner:true,isWritable:false},
        {pubkey:CONF_TOKEN,isSigner:false,isWritable:false},
        {pubkey:tokBackingProgram(),isSigner:false,isWritable:false},
        {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
      ]});
    // Native-backed: the released backing lands in a temporary wrapped-native
    // account that the same transaction closes, so the wallet receives the coin.
    const lead=[...(vaultIx?[vaultIx]:[]),...pre,...(native?[createAssociatedTokenAccountIdempotentInstruction(state.pubKey,backingDest,state.pubKey,NATIVE_MINT,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID)]:[])];
    const core=[verifyIx(3,eqRec,eqCtx),verifyIx(6,rpRec,rpCtx),relayIx,programIx,closeContextIx(eqCtx),closeContextIx(rpCtx),
      ...(native?[createCloseAccountInstruction(backingDest,state.pubKey,state.pubKey,[],TOKEN_PROGRAM_ID)]:[])];
    const stagingTxs=staged.groups.map(g=>groupToTx(g,rb.blockhash));
    const whole=buildTx([cuLimit(CU_UNWRAP),...lead,...core],rb.blockhash);
    if(!lead.length||txFits(whole))txs.push(...stagingTxs,whole);
    else if(pre.length)throw new Error("Could not fit this into one transaction. Click Receive incoming first, then retry.");
    else txs.push(buildTx([cuLimit(CU_SMALL),...lead],rb.blockhash),...stagingTxs,buildTx([cuLimit(CU_UNWRAP),...core],rb.blockhash));

    toast("Approve in your wallet to unwrap ("+txs.length+" steps, one approval)…","ok");
    const sigs=await signAndSendBatch(txs);
    commits.forEach(f=>f());
    toast("<b>Unwrapped "+fmtAmt(amount)+" "+SYM()+" → "+fmtAmt(amount)+" "+BSYM()+"</b> (no fee) — "+sigs[sigs.length-1].slice(0,14)+"…","ok");
    try{ await refreshChain(); }catch(_e){}
  }catch(e){ console.error("[withdraw] CATCH:", e.message, e.stack); toast("Withdraw failed: "+humanErr(e),"err"); }
}

// ---- UNWRAP EVERYTHING in the active account (incoming funds included) ----
async function withdrawAll(){
  try{
    if(!state.wallet||!state.pubKey)throw new Error("connect wallet first");
    if(!state.confAcct)throw new Error("create confidential account first");
    const c=await spendContext();
    if(c.cur<=0n)throw new Error("No "+SYM()+" available to unwrap.");
    $("wdAmount").value=fmtAmt(c.cur);
    await withdraw();
  }catch(e){toast("Withdraw-All failed: "+humanErr(e),"err");}
}

// ---- Recipient resolution ----
// A sender can enter either the recipient's WALLET address or one of their
// confidential token accounts. A wallet address is resolved to that wallet's
// confidential account for the active token: its associated token account when
// it has one, otherwise the first configured account the wallet owns.
function confExtOf(tok){
  const ex=tok&&tok.data&&tok.data.extensions;
  if(!ex||ex.__option!=="Some")return null;
  return ex.value.find(e=>e.__kind==="ConfidentialTransferAccount")||null;
}
async function resolveRecipient(input){
  let pk;
  try{ pk=new PublicKey(input); }catch(_e){ throw new Error("That is not a valid address."); }
  // 1) the address itself is a token account
  let tok=null;
  try{ tok=await fetchToken(rpc,address(pk.toBase58())); }catch(_e){ tok=null; }
  if(tok){
    const mint=String(tok.data.mint||"");
    if(mint!==CXNT_MINT.toBase58()){
      // MINT GUARD: catch a wrong-token account before any proof or signature.
      const sym=Object.keys(TOKENS).find(k=>TOKENS[k].mint===mint);
      throw new Error("That account belongs to a different token"+(sym?" ("+sym+")":"")+", but you have "+ACTIVE+" selected. Switch the token, or ask the recipient for their confidential "+ACTIVE+" account address.");
    }
    const ext=confExtOf(tok);
    if(!ext)throw new Error("That token account is not set up for confidential "+ACTIVE+".");
    return {account:pk,ext};
  }
  // 2) treat it as a wallet address
  const candidates=[];
  if(CONF_TOKEN.equals(TOKEN_2022_PROGRAM_ID)){
    candidates.push(await getAssociatedTokenAddress(CXNT_MINT,pk,true,CONF_TOKEN,ASSOCIATED_TOKEN_PROGRAM_ID));
  }
  try{
    const owned=await getTokenAccountsByOwnerMint(pk.toBase58(),CXNT_MINT.toBase58());
    owned.map(a=>a.pubkey).sort((x,y)=>x.toBase58()<y.toBase58()?-1:1).forEach(a=>{ if(!candidates.some(c=>c.equals(a)))candidates.push(a); });
  }catch(_e){}
  for(const c of candidates){
    try{
      const t=await fetchToken(rpc,address(c.toBase58()));
      const ext=confExtOf(t);
      if(ext&&String(t.data.mint)===CXNT_MINT.toBase58())return {account:c,ext};
    }catch(_e){ /* not created yet */ }
  }
  throw new Error("That address is not a confidential "+ACTIVE+" account, and the wallet it belongs to has not created one. Ask the recipient for their confidential account address (they create it with Create account).");
}

// ---- CONFIDENTIAL TRANSFER (ZK, proofs in-browser, user wallet signs) ----
async function transfer(){
  try{
    if(!state.wallet||!state.pubKey)throw new Error("connect wallet first");
    if(!state.confAcct)throw new Error("create confidential account first");
    const destStr=$("transferDest").value.trim();
    if(!destStr)throw new Error("Enter the recipient's confidential account address.");
    const amount=parseAmount9($("permAmount").value);
    if(amount<=0n)throw new Error("amount must be > 0");
    requireWithinCtLimit(amount,"transfer");
    const {account:dest,ext:destExt}=await resolveRecipient(destStr);
    toast("Building zero-knowledge proofs in your browser…","ok");
    const c=await spendContext();
    if(c.cur<amount)throw new Error("Not enough "+SYM()+" in this account: you have "+fmtAmt(c.cur)+", need "+fmtAmt(amount)+".");
    const destPubHex=hexenc(new PublicKey(destExt.elgamalPubkey).toBytes());
    const rb=await conn.getLatestBlockhash("confirmed");
    const plan=await planTransfer({sigB64:c.dk.sigB64,aeKey:c.dk.aeKey,acct:c.acct,availHex:c.availHex,cur:c.cur,amount,
      destAcct:dest.toBase58(),destPubHex,pre:c.applyIx?[c.applyIx]:[],blockhash:rb.blockhash});
    toast("Approve in your wallet to send ("+plan.txs.length+" steps, one approval)…","ok");
    const sigs=await signAndSendBatch(plan.txs);
    plan.staged.commit();
    toast("<b>Sent "+fmtAmt(amount)+" "+SYM()+" privately</b> — "+sigs[sigs.length-1].slice(0,14)+"…<br>It shows in the recipient's balance as incoming and is added when they next send or unwrap.","ok");
    try{ await refreshChain(); }catch(_e){}
  }catch(e){ console.error("[transfer] CATCH:", e.message, e.stack); toast("Transfer failed: "+humanErr(e),"err"); }
}

// ---- raw confidential account read (browser, no server) ----
async function rawConfAccount(tokenAcc){
  const tok=await fetchToken(rpc,address(tokenAcc));
  const ex=tok.data.extensions;
  if(ex.__option!=="Some")throw new Error("no extensions");
  const ext=ex.value.find(e=>e.__kind==="ConfidentialTransferAccount");
  if(!ext)throw new Error("not a confidential account");
  const toHex=(v)=>{
    if(!v)return "";
    // v is a Uint8Array or {bytes: [...]}
    let a;
    if(v instanceof Uint8Array)a=v;
    else if(Array.isArray(v))a=new Uint8Array(v);
    else if(v.bytes)a=new Uint8Array(v.bytes);
    else if(v.data)a=new Uint8Array(v.data);
    else if(typeof v==="object")a=new Uint8Array(Object.values(v).flat());
    else a=new Uint8Array(0);
    return hexenc(a);
  };
  const out={
    pendingCounter:(ext.pendingBalanceCreditCounter&&ext.pendingBalanceCreditCounter.value!==undefined?ext.pendingBalanceCreditCounter.value.toString():(ext.pendingBalanceCreditCounter!==undefined?String(ext.pendingBalanceCreditCounter):"0")),
    availableBalance:toHex(ext.availableBalance),
    decryptableAvailableBalance:toHex(ext.decryptableAvailableBalance),
    pendingBalanceLo:toHex(ext.pendingBalanceLow!==undefined?ext.pendingBalanceLow:ext.pendingBalanceLo),
    pendingBalanceHi:toHex(ext.pendingBalanceHigh!==undefined?ext.pendingBalanceHigh:ext.pendingBalanceHi),
  };
  primeAvailable(out.availableBalance,out.decryptableAvailableBalance);
  return out;
}
// Total un-applied pending credits of a confidential account, decrypted with
// the owner's ElGamal secret: lo + (hi << 16), matching token-2022's split.
// Returns null when the pending ciphertexts cannot be read or decrypted.
function pendingTotal(secret,raw){
  try{
    if(!raw||(raw.pendingBalanceLo||"").length!==128||(raw.pendingBalanceHi||"").length!==128)return null;
    const small=(ct)=>{
      if(/^0+$/.test(ct))return 0n;
      try{ return elgamalDecryptU32(secret,ct); }catch(_e){ return elgamalDecryptU64(secret,ct); }
    };
    return small(raw.pendingBalanceLo)+(small(raw.pendingBalanceHi)<<16n);
  }catch(_e){ return null; }
}

// ---- Reusable ZK context + record accounts (cached per user, skip re-creation) ----
// These accounts are rewritable; we reuse them across ops instead of
// Keypair.generate() each time, cutting 2 tx-approvals from every
// withdraw and 2 from every transfer.
const ZK_REUSE_LS="x1conf_zk_reuse_";
// Scoped by network and record program: reusable proof accounts belong to one
// record program on one cluster and are useless (and harmful) anywhere else.
function zkReuseKey(){return ZK_REUSE_LS+NETWORK+"_"+(RECORD_PROGRAM?RECORD_PROGRAM.toBase58().slice(0,8):"")+"_"+nsPrefix()+(state.pubKey?state.pubKey.toBase58():"");}
function loadZkReuse(){
  try{return JSON.parse(localStorage.getItem(zkReuseKey())||"null");}catch(_){return null;}
}
function saveZkReuse(obj){
  try{localStorage.setItem(zkReuseKey(),JSON.stringify(obj));}catch(_){}
}
function pkFromB58(s){try{return new PublicKey(s);}catch(_){return null;}}

// Create fresh context-state accounts for ZK proofs. Returns [eqPlan, rangePlan, valPlan].
// CRITICAL: These accounts are SINGLE-USE — the ZK proof program initializes them
// on first use, so they can NEVER be reused. Always create fresh accounts.
// (Record accounts used for proof data storage CAN be reused; context accounts cannot.)
async function ensureContextAccounts(){
  const needSpaces=[33+128,33+264,33+352]; // eq, range, val
  const kps=needSpaces.map(()=>Keypair.generate());
  const ixs=await Promise.all(needSpaces.map(async (space,i)=>{
    const lam=await conn.getMinimumBalanceForRentExemption(space);
    return SystemProgram.createAccount({fromPubkey:state.pubKey,newAccountPubkey:kps[i].publicKey,lamports:lam,space,programId:ZK_PROGRAM});
  }));
  const tx=new Transaction().add(...ixs);
  const rb=await conn.getLatestBlockhash("confirmed");tx.recentBlockhash=rb.blockhash;tx.feePayer=state.pubKey;
  kps.forEach(kp=>tx.partialSign(kp));
  const s=await walletSign(tx);
  const sig=await conn.sendRawTransaction(s.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
  await conn.confirmTransaction(sig,"confirmed");
  return kps.map(kp=>kp.publicKey); // [eqPlan, rangePlan, valPlan] — always fresh
}

// Ensure reusable record accounts exist. Returns [eqRecord, rangeRecord, valRecord].
// Only creates missing ones; reuses existing accounts from localStorage.
// CRITICAL: validates cached account sizes on-chain — if too small for the
// proof being written, the account is recreated.
async function ensureRecordAccounts(proofs){
  const cached=loadZkReuse();
  const labels=["eqRecord","rangeRecord","valRecord"];
  let created=false;
  // Step 1: map labels → pubkeys from cache (null if missing)
  const out=labels.map((lab,i)=>{
    if(cached && cached[lab]){
      const pk=pkFromB58(cached[lab]);
      if(pk)return pk;
    }
    return null;
  });

  // Step 2: check sizes on-chain for cached accounts
  const sizesNeeded=proofs.map((p,i)=>p.length?RECORD_META+p.length:0);
  const sizeChecks=await Promise.all(out.map(async (pk,i)=>{
    if(!pk)return null;
    try{
      const ai=await conn.getAccountInfo(pk,"confirmed");
      if(!ai)return "missing"; // account closed / doesn't exist
      return ai.data.length;
    }catch(e){return "missing";}
  }));

  // Step 3: handle missing accounts (create) vs too-small accounts (reallocate)
  const missingIdx=[];
  const reallocateIdx=[];
  for(let i=0;i<labels.length;i++){
    if(out[i]===null){ missingIdx.push(i); continue; }
    if(sizeChecks[i]==="missing"){ missingIdx.push(i); continue; }
    if(sizesNeeded[i] && sizeChecks[i] < sizesNeeded[i]){
      console.warn(`[ensureRecordAccounts] ${labels[i]} too small (${sizeChecks[i]} < ${sizesNeeded[i]}), will reallocate`);
      reallocateIdx.push(i);
    }
  }

  // Reallocate existing accounts that are too small (in-place resize)
  if(reallocateIdx.length){
    const reallocIxs=[];
    for(const idx of reallocateIdx){
      const pk=out[idx];
      const newSpace=sizesNeeded[idx];
      const newPayloadLen=newSpace-RECORD_META;
      const lam=await conn.getMinimumBalanceForRentExemption(newSpace);
      const ai=await conn.getAccountInfo(pk,"confirmed");
      const currentBal=ai?.lamports||0;
      if(lam > currentBal){
        const needed=lam-currentBal;
        reallocIxs.push(SystemProgram.transfer({fromPubkey:state.pubKey,toPubkey:pk,lamports:needed}));
      }
      // Reallocate: discriminator 4 + dataLength (payload bytes only)
      const reallocData=Buffer.concat([
        Buffer.from([4]),
        u64leBuf(BigInt(newPayloadLen)),
      ]);
      reallocIxs.push(new TransactionInstruction({
        keys:[
          {pubkey:pk,isSigner:false,isWritable:true},
          {pubkey:state.pubKey,isSigner:true,isWritable:false},
        ],
        programId:RECORD_PROGRAM,
        data:reallocData,
      }));
    }
    const tx=new Transaction().add(...reallocIxs);
    const rb=await conn.getLatestBlockhash("confirmed");tx.recentBlockhash=rb.blockhash;tx.feePayer=state.pubKey;
    const s=await walletSign(tx);
    const sig=await conn.sendRawTransaction(s.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
    await conn.confirmTransaction(sig,"confirmed");
    console.log("[ensureRecordAccounts] reallocated",reallocateIdx.length,"account(s) — sig",sig.slice(0,14));
  }

  // Create missing accounts from scratch
  if(missingIdx.length){
    const kps=missingIdx.map(()=>Keypair.generate());
    const ixs=await Promise.all(missingIdx.map(async (origIdx,i)=>{
      const proof=proofs[origIdx];
      const space=RECORD_META+proof.length;
      const lam=await conn.getMinimumBalanceForRentExemption(space);
      const create=SystemProgram.createAccount({fromPubkey:state.pubKey,newAccountPubkey:kps[i].publicKey,lamports:lam,space,programId:RECORD_PROGRAM});
      const init=toWeb3Ix(getInitializeInstruction({recordAccount:kps[i].publicKey.toBase58(),authority:state.pubKey.toBase58()}));
      return [create,init];
    }));
    const flat=ixs.flat();
    const tx=new Transaction().add(...flat);
    const rb=await conn.getLatestBlockhash("confirmed");tx.recentBlockhash=rb.blockhash;tx.feePayer=state.pubKey;
    kps.forEach(kp=>tx.partialSign(kp));
    const s=await walletSign(tx);
    const sig=await conn.sendRawTransaction(s.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
    await conn.confirmTransaction(sig,"confirmed");
    missingIdx.forEach((origIdx,j)=>{out[origIdx]=kps[j].publicKey;});
    created=true;
  }

  if(created){
    const save=loadZkReuse()||{};
    labels.forEach((lab,i)=>{if(out[i])save[lab]=out[i].toBase58();});
    saveZkReuse(save);
  }
  return out; // [eqRecord, rangeRecord, valRecord]
}

// Write proof data to record accounts. Two small proofs (eq+rp) are batched
// into a SINGLE tx; if total data >900 bytes, each record gets its own tx.
//
// NOTE: We manually build the Record program Write instruction instead of using
// @solana-program/record's getWriteInstruction. The kit-generated function
// requires the authority to be a TransactionSigner object (not a plain pubkey
// string), and throws SolanaError #8500007 when passed a string. Building the
// instruction directly with web3.js TransactionInstruction avoids the kit
// resolver entirely.
function u64leBuf(n){const b=Buffer.alloc(8);new DataView(b.buffer,b.byteOffset,8).setBigUint64(0,BigInt(n),true);return b;}
function u32leBuf(n){const b=Buffer.alloc(4);new DataView(b.buffer,b.byteOffset,4).setUint32(0,Number(n),true);return b;}
async function stageRecordsWrite(records,proofs){
  const sigs=[];
  // batch small proofs together (eq+range = ~680 B), send large ones alone
  let batch=[];
  for(let i=0;i<records.length;i++){
    if(proofs[i].length===0) continue; // skip placeholder (eq,val,rp where one is empty)
    if(batch.length===0){ batch.push(i); continue; }
    // Per-instruction data overhead = 1 (write disc) + 8 (u64 offset) + 4 (u32 len) = 13 bytes.
    // NOTE: previous version double-counted batch[0] via the reduce seed; fixed to start at 0.
    const totalData = batch.reduce((n,j)=>n+13+proofs[j].length, 0);
    if(totalData + 13+proofs[i].length < 900){ batch.push(i); }
    else{
      // flush current batch
      const ixes=batch.map(j=>{
        const proof=proofs[j];
        const data=Buffer.concat([
          Buffer.from([1]),
          // offset MUST be 0: the on-chain Record program already adds its own
          // WRITABLE_START_INDEX (33) to the offset, so a payload written here
          // starts at account byte 33. Passing 33 here double-counts the meta
          // and overruns the account -> "account data too small for instruction".
          u64leBuf(0),
          u32leBuf(proof.length),
          Buffer.from(proof),
        ]);
        return new TransactionInstruction({
          keys:[
            {pubkey:records[j],isSigner:false,isWritable:true},
            {pubkey:state.pubKey,isSigner:true,isWritable:false},
          ],
          programId:RECORD_PROGRAM,
          data,
        });
      });
      const tx=new Transaction().add(...ixes);
      const rb=await conn.getLatestBlockhash("confirmed");tx.recentBlockhash=rb.blockhash;tx.feePayer=state.pubKey;
      const s=await walletSign(tx);
      const sig=await conn.sendRawTransaction(s.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
      await conn.confirmTransaction(sig,"confirmed");
      sigs.push(sig);
      batch=[i];
    }
  }
  if(batch.length){
    const ixes=batch.map(j=>{
      const proof=proofs[j];
      const data=Buffer.concat([
        Buffer.from([1]),
        // offset 0 — see note above (program adds WRITABLE_START_INDEX itself).
        u64leBuf(0),
        u32leBuf(proof.length),
        Buffer.from(proof),
      ]);
      return new TransactionInstruction({
        keys:[
          {pubkey:records[j],isSigner:false,isWritable:true},
          {pubkey:state.pubKey,isSigner:true,isWritable:false},
        ],
        programId:RECORD_PROGRAM,
        data,
      });
    });
    const tx=new Transaction().add(...ixes);
    const rb=await conn.getLatestBlockhash("confirmed");tx.recentBlockhash=rb.blockhash;tx.feePayer=state.pubKey;
    const s=await walletSign(tx);
    const sig=await conn.sendRawTransaction(s.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
    await conn.confirmTransaction(sig,"confirmed");
    sigs.push(sig);
  }
  return sigs;
}

// ---- PROOF STAGING PLAN (nothing is sent here) ----
// Context accounts are single-use (fresh every time). Record accounts hold the
// proof bytes and are reusable. The plan merges (context creates) + (record
// create / grow) + (record writes) into the FEWEST transactions that fit the
// 1232-byte cap. `assume` describes record accounts an EARLIER plan in the same
// batch will already have created, so a chained step can reuse them.
function packEntries(entries){
  const MAX=1216; // headroom under the 1232 runtime cap
  const groups=[]; let cur=[], curSigners=[];
  const fits=(ixs,signers)=>{
    try{
      const tx=new Transaction().add(...ixs);
      tx.recentBlockhash="11111111111111111111111111111111"; tx.feePayer=state.pubKey;
      signers.forEach(kp=>tx.partialSign(kp));
      return tx.serialize({requireAllSignatures:false,verifySignatures:false}).length<=MAX;
    }catch(_){ return false; } // an over-long group throws from the layout encoder
  };
  for(const e of entries){
    if(cur.length>0&&!fits(cur.map(x=>x.ix).concat(e.ix),curSigners.concat(e.signers||[]))){
      groups.push({ixs:cur.map(x=>x.ix),signers:curSigners}); cur=[]; curSigners=[];
    }
    cur.push(e); curSigners=curSigners.concat(e.signers||[]);
  }
  if(cur.length)groups.push({ixs:cur.map(x=>x.ix),signers:curSigners});
  return groups;
}
// Staging needs only a few thousand compute units; ask for a small limit (lower
// fee) whenever the transaction still fits with that instruction.
function groupToTx(g,blockhash){
  const withLimit=buildTx([cuLimit(CU_SMALL),...g.ixs],blockhash,g.signers);
  return txFits(withLimit)?withLimit:buildTx(g.ixs,blockhash,g.signers);
}
async function planStaging(contextSpaces,recordProofs,assume){
  const entries=[];
  const cached=loadZkReuse()||{};
  const ctxKps=contextSpaces.map(()=>Keypair.generate());
  const ctxLamports=await Promise.all(contextSpaces.map(sp=>conn.getMinimumBalanceForRentExemption(sp)));
  contextSpaces.forEach((space,i)=>entries.push({ix:SystemProgram.createAccount({fromPubkey:state.pubKey,newAccountPubkey:ctxKps[i].publicKey,lamports:ctxLamports[i],space,programId:ZK_PROGRAM}),signers:[ctxKps[i]]}));
  const recKeys=[]; const planned={};
  for(const rp of recordProofs){
    const need=RECORD_META+rp.proof.length;
    const known=assume&&assume[rp.label];
    let key=null, len=0, lamports=0;
    if(known&&known.len>=need){ key=known.pk; len=known.len; lamports=Number.MAX_SAFE_INTEGER; }
    else if(!known){
      const pk=pkFromB58(cached[rp.label])||null;
      const info=pk?await conn.getAccountInfo(pk,"confirmed"):null;
      if(info&&info.owner.equals(RECORD_PROGRAM)){ key=pk; len=info.data.length; lamports=info.lamports; }
    }
    if(!key){
      const kp=Keypair.generate(); key=kp.publicKey; len=need;
      const lam=await conn.getMinimumBalanceForRentExemption(need);
      entries.push({ix:SystemProgram.createAccount({fromPubkey:state.pubKey,newAccountPubkey:kp.publicKey,lamports:lam,space:need,programId:RECORD_PROGRAM}),signers:[kp]});
      entries.push({ix:toWeb3Ix(getInitializeInstruction({recordAccount:kp.publicKey.toBase58(),authority:state.pubKey.toBase58()})),signers:[]});
    }else if(len<need){
      const lam=await conn.getMinimumBalanceForRentExemption(need);
      if(lam>lamports)entries.push({ix:SystemProgram.transfer({fromPubkey:state.pubKey,toPubkey:key,lamports:lam-lamports}),signers:[]});
      entries.push({ix:new TransactionInstruction({keys:[{pubkey:key,isSigner:false,isWritable:true},{pubkey:state.pubKey,isSigner:true,isWritable:false}],programId:RECORD_PROGRAM,data:Buffer.concat([Buffer.from([4]),u64leBuf(BigInt(need-RECORD_META))])}),signers:[]});
      len=need;
    }
    recKeys.push(key); planned[rp.label]={pk:key,len};
  }
  // record writes (offset 0; the program adds its own header offset)
  recordProofs.forEach((rp,i)=>{
    const data=Buffer.concat([Buffer.from([1]),u64leBuf(0),u32leBuf(rp.proof.length),Buffer.from(rp.proof)]);
    entries.push({ix:new TransactionInstruction({keys:[{pubkey:recKeys[i],isSigner:false,isWritable:true},{pubkey:state.pubKey,isSigner:true,isWritable:false}],programId:RECORD_PROGRAM,data}),signers:[]});
  });
  const commit=()=>{ const save=loadZkReuse()||{}; recordProofs.forEach((rp,i)=>{ save[rp.label]=recKeys[i].toBase58(); }); saveZkReuse(save); };
  return {contexts:ctxKps.map(k=>k.publicKey),records:recKeys,groups:packEntries(entries),planned,commit};
}

// Legacy single-account wrappers (kept for compatibility, but prefer batch)
async function createContextAccount(space){
  const [eqPlan,rangePlan,valPlan]=await ensureContextAccounts();
  if(space<=33+128)return eqPlan;
  if(space<=33+264)return rangePlan;
  return valPlan;
}
async function stageRecord(proof){
  const [eqRecord,rangeRecord,valRecord]=await ensureRecordAccounts([proof]);
  // pick whichever record matches the proof size (lazy heuristic)
  const rec=[eqRecord,rangeRecord,valRecord].find(r=>r!==null);
  await stageRecordsWrite([rec],[proof]);
  return rec;
}

// Clear the cached ZK context/record accounts (debug/recovery)
function clearZkReuse(){
  try{localStorage.removeItem(zkReuseKey());}catch(_){}
  toast("ZK account cache cleared — next op will recreate accounts","ok");
}

async function loadState(){await refreshChain();toast("State refreshed","ok");}

// ---- USDC.x (testnet mock) Faucet: mint mock USDC.x to the connected wallet ----
async function faucetToken(){
  try{
    if(!state.wallet||!state.pubKey)throw new Error("connect wallet first");
    if(isXnt()){ toast("Switch to cUSDC.x to use its faucet","ok"); return; }
    toast("Requesting mock USDC.x…","ok");
    await ensureOwnBackingAta();
    let j=null;
    try{
      const r=await fetch("/api/faucet-token",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({to:state.pubKey.toBase58(),token:"usdcx"})});
      j=await r.json();
    }catch(_e){ j=null; }
    if(!j)throw new Error("This site has no "+BSYM()+" faucet. Ask the operator to send mock "+BSYM()+" to your wallet.");
    if(!j.ok)throw new Error(j.error||"faucet-token failed");
    toast("<b>Faucet: "+esc(String(j.amount||""))+" mock "+BSYM()+" sent</b> — "+esc(String(j.sig||"").slice(0,14))+"…","ok");
    await refreshChain();
  }catch(e){ toast("USDC.x faucet failed: "+humanErr(e),"err"); }
}

window.connectWallet=connectWallet;
window.createAccount=createAccount;
window.deposit=deposit;
window.withdraw=withdraw;
window.withdrawAll=withdrawAll;
window.transfer=transfer;
window.createTestDest=createTestDest;
window.loadState=loadState;
window.applyPending=applyPending;
window.recreateConfAccount=recreateConfAccount;
window.selectConfAccount=selectConfAccount;
window.clearZkReuse=clearZkReuse;
window.selectToken=selectToken;
window.faucetToken=faucetToken;
// Show/hide the USDC.x-only faucet button for the active token.
window.__syncTokenButtons=function(){ const b=document.getElementById("faucetTokenBtn"); if(b) b.style.display = (FAUCET_ENABLED&&!isXnt())? "" : "none"; };
// Expose internals for automated e2e testing (drives real UI functions). These
// include the derived secrets, so they are only reachable on a local dev host.
if(["localhost","127.0.0.1","[::1]"].includes(location.hostname)){
  window.__app={state,refreshChain,deriveKeys,rawConfAccount,readConfCiphertexts,elgamalDecryptU64,aeDecrypt,elgamalSecretFromSig,handleIsIdentity,spendContext};
  window.__healTest=true;
}

// Buttons are wired with data-act attributes (no inline handlers, so the page
// runs under a `script-src 'self'` Content-Security-Policy).
const ACTIONS={copyRecvAddr,connectWallet,createAccount,deposit,withdraw,withdrawAll,transfer,createTestDest,loadState,applyPending,recreateConfAccount,clearZkReuse,faucetToken};
document.addEventListener("click",(ev)=>{
  const el=ev.target&&ev.target.closest?ev.target.closest("[data-act]"):null;
  if(!el)return;
  const act=el.dataset.act;
  if(act==="selectConfAccount"){ selectConfAccount(Number(el.dataset.arg)); return; }
  if(!Object.prototype.hasOwnProperty.call(ACTIONS,act)||el.classList.contains("busy"))return;
  el.classList.add("busy");
  Promise.resolve().then(()=>ACTIONS[act]()).catch(()=>{}).finally(()=>el.classList.remove("busy"));
});
document.addEventListener("change",(ev)=>{
  if(ev.target&&ev.target.id==="tokenSelect")selectToken(ev.target.value);
});

// Show build version in footer
(function showBuildVersion(){
  const m=document.querySelector('script[type="module"]');
  const v=(m&&m.src.match(/batch-([\d]+)/)||["",""])[1];
  const el=document.getElementById('buildVersion');
  if(el&&v)el.textContent="build: "+v;
})();

// ---- Auto-reconnect: reflect wallet connect/disconnect even without a UI click ----
async function tryAutoConnect(){
  const det=detectWallet();
  if(!det)return;
  try{
    const w=det.w;
    let pk=null;
    try{ pk=w.publicKey?new PublicKey(w.publicKey.toString()):null; }catch(_){}
    if(!pk && typeof w.connect==="function"){
      const resp=await w.connect();
      if(resp&&resp.publicKey) pk=new PublicKey(resp.publicKey.toString());
    }
    if(pk && !(state.pubKey&&state.pubKey.equals(pk))){
      state.wallet=w;state.pubKey=pk;
      $("walletText").textContent=(det.name)+": "+pk.toBase58().slice(0,6)+"…"+pk.toBase58().slice(-4);
      $("walletDot").classList.add("on"); $("connectBtn").style.display="none";
      try{ const {elgamalPub}=await deriveKeys(); state.elgamalPub=elgamalPub; }catch(_){}
      await refreshChain();
      console.log("[conf-auto] connected",pk.toBase58().slice(0,6));
    }
  }catch(_){ /* not connected yet */ }
}
// attach connect/disconnect listeners if the wallet supports them
function attachWalletListeners(){
  const det=detectWallet();if(!det)return;const w=det.w;
  const onConnect=async()=>{ if(state.pubKey) await refreshChain(); };
  const onDisconnect=()=>{ try{ Object.keys(sessionStorage).filter(k=>k.startsWith("x1conf_sig_")).forEach(k=>sessionStorage.removeItem(k)); }catch(_e){} state.wallet=null;state.pubKey=null;state.confAcct=null;state.confAccounts=[];state.secret=null;state.sigCache={}; $("walletText").textContent="Disconnected";$("walletDot").classList.remove("on");$("connectBtn").style.display="";$("stBalance").textContent="—";$("stXnt").textContent=BSYM()+": —";renderConfAccounts(); };
  if(typeof w.on==="function"){ try{ w.on("connect",onConnect);w.on("disconnect",onDisconnect); }catch(_){} }
  if(typeof w.addListener==="function"){ try{ w.addListener("connect",onConnect);w.addListener("disconnect",onDisconnect); }catch(_){} }
}
if(document.readyState==="loading"){ document.addEventListener("DOMContentLoaded",()=>{ loadDeployment().then(()=>{ attachWalletListeners(); tryAutoConnect(); }); }); }
else{ loadDeployment().then(()=>{ attachWalletListeners(); tryAutoConnect(); }); }
