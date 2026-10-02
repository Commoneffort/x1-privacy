//! X1 Privacy proof module.
//!
//! Client-side cryptography for confidential balances, built on solana-zk-sdk
//! 5.0.1 (the version the X1 validator's ZK ElGamal proof program embeds). It
//! compiles to `wasm32-unknown-unknown` with a minimal C ABI and no JS glue, so
//! a browser or wallet can derive keys, read balances and generate every proof
//! locally — no key ever leaves the user's device. The same code builds as a
//! native CLI (`src/main.rs`) for scripts and tests.
//!
//! Randomness: transfer and balance ciphertexts use fresh randomness for every
//! operation, drawn from the host through `__lk_getrandom` (a thin wrapper over
//! `crypto.getRandomValues` in the browser; the OS generator on native builds).
//! The only deterministic nonce is the one in the public-key validity proof,
//! which is derived from the secret (as in RFC 6979-style signing): that proof
//! is for one fixed statement per key, so reusing its nonce reveals nothing.
//!
//! Buffers are passed as (pointer, length) pairs allocated with `alloc` /
//! `dealloc`; functions return the number of bytes written, or a negative code.

use solana_zk_sdk::{
    encryption::{
        auth_encryption::{AeCiphertext, AeKey},
        elgamal::{ElGamal, ElGamalCiphertext, ElGamalKeypair, ElGamalPubkey, ElGamalSecretKey},
        grouped_elgamal::GroupedElGamal,
        pedersen::{Pedersen, PedersenOpening, H},
    },
    transcript::TranscriptProtocol,
    zk_elgamal_proof_program::proof_data::{
        pubkey_validity::PubkeyValidityProofData, BatchedGroupedCiphertext3HandlesValidityProofData,
        BatchedRangeProofU128Data, BatchedRangeProofU64Data, CiphertextCommitmentEqualityProofData,
        ZkProofData,
    },
};
use base64::Engine;
use curve25519_dalek::{
    constants::RISTRETTO_BASEPOINT_POINT as G,
    ristretto::RistrettoPoint,
    scalar::Scalar,
    traits::{Identity, IsIdentity},
};
use merlin::Transcript;
use sha3::{Digest, Sha3_512};
use hmac::{Hmac, Mac};
use sha2::Sha512;
use std::alloc::{alloc as std_alloc, dealloc as std_dealloc, Layout};
use std::collections::HashMap;
use std::slice;
use std::sync::{Once, OnceLock};

/// Canonical confidential-balances HKDF derivation (matches token-2022's
/// ConfidentialKeys / zk-sdk `derive_confidential_keys_from_ikm`). See the
/// zk-sdk `derivation.rs`: prk = HKDF-SHA512-Extract(salt="solana-conf-bal/v1",
/// ikm=signature), ae = Expand(prk,"ae",16), elgamal = from_bytes_mod_order_wide(
/// Expand(prk,"elgamal",64)).
const HKDF_SALT: &[u8] = b"solana-conf-bal/v1";
const AE_HKDF_INFO: &[u8] = b"ae";
const ELGAMAL_HKDF_INFO: &[u8] = b"elgamal";

type HmacSha512 = Hmac<Sha512>;

/// HKDF-Expand (RFC 5869) over the given PRK + info.
fn hkdf_expand(prk: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut t: Vec<u8> = Vec::new();
    let mut counter: u8 = 1;
    while out.len() < len {
        let mut mac = <HmacSha512 as Mac>::new_from_slice(prk).expect("hmac");
        mac.update(&t);
        mac.update(info);
        mac.update(&[counter]);
        t = mac.finalize().into_bytes().to_vec();
        out.extend_from_slice(&t);
        counter += 1;
    }
    out.truncate(len);
    out
}

/// Derive the 16-byte AE key and 32-byte ElGamal secret scalar from a 64-byte
/// ed25519 signature over `signerMessage(owner||mint)`. This is the exact
/// token-2022 canonical derivation (zk-sdk `ConfidentialKeys.fromSignature`).
fn derive_keys_from_signature(sig: &[u8]) -> ([u8; 16], [u8; 32]) {
    debug_assert_eq!(sig.len(), 64);
    // HKDF-Extract(salt=salt, ikm=sig) => prk
    let mut extract = <HmacSha512 as Mac>::new_from_slice(HKDF_SALT).expect("hmac");
    extract.update(sig);
    let prk = extract.finalize().into_bytes();
    // AE key (16 bytes)
    let ae_bytes = hkdf_expand(&prk, AE_HKDF_INFO, 16);
    let mut ae = [0u8; 16];
    ae.copy_from_slice(&ae_bytes);
    // ElGamal secret (64-byte wide -> reduced mod order)
    let wide = hkdf_expand(&prk, ELGAMAL_HKDF_INFO, 64);
    let wide_arr: [u8; 64] = wide.as_slice().try_into().expect("wide");
    let scalar = Scalar::from_bytes_mod_order_wide(&wide_arr);
    (ae, scalar.to_bytes())
}

// ---------------------------------------------------------------------------
// Custom getrandom backend (avoids wasm-bindgen glue entirely).
//
// The zk-sdk range/equality proofs call `Scalar::random(&mut OsRng)`, which on
// wasm32-unknown-unknown routes through getrandom's `js` feature → wasm-bindgen
// → `crypto.getRandomValues`. The UI's Proxy shim returns no-op functions for
// every import, so that path panics with "Web Crypto API is unavailable".
//
// Instead we register a CUSTOM getrandom that calls a single imported extern
// `__lk_getrandom(ptr, len)` which the browser provides as a thin wrapper over
// `crypto.getRandomValues`. This keeps real cryptographic randomness (the
// proofs stay sound) with zero wasm-bindgen glue.
// ---------------------------------------------------------------------------
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn __lk_getrandom(ptr: *mut u8, len: usize);
}

#[cfg(target_arch = "wasm32")]
fn lk_getrandom(dest: &mut [u8]) -> Result<(), getrandom::Error> {
    unsafe { __lk_getrandom(dest.as_mut_ptr(), dest.len()) }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
getrandom::register_custom_getrandom!(lk_getrandom);

// Panic hook: capture the panic message into a static buffer so the browser
// can read it (wasm32-unknown-unknown aborts on panic by default, which shows
// up as a bare "unreachable" trap with no diagnostics).
static mut PANIC_BUF: [u8; 2048] = [0u8; 2048];
static mut PANIC_LEN: usize = 0;
static PANIC_ONCE: Once = Once::new();

#[no_mangle]
pub extern "C" fn install_panic_hook() {
    PANIC_ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            let msg = format!("{}", info);
            let bytes = msg.as_bytes();
            let n = bytes.len().min(2047);
            unsafe {
                PANIC_BUF[..n].copy_from_slice(&bytes[..n]);
                PANIC_LEN = n;
            }
        }));
    });
}

#[no_mangle]
pub extern "C" fn last_panic(ptr: *mut u8, cap: usize) -> i32 {
    unsafe {
        let n = PANIC_LEN.min(cap);
        if n > 0 && !ptr.is_null() {
            std::ptr::copy_nonoverlapping(PANIC_BUF.as_ptr(), ptr, n);
        }
        n as i32
    }
}

const TRANSFER_AMOUNT_LO_BITS: usize = 16;
const TRANSFER_AMOUNT_HI_BITS: usize = 32;
const REMAINING_BALANCE_BIT_LENGTH: usize = 64;
const RANGE_PROOF_PADDING_BIT_LENGTH: usize = 16;

// Transfer-amount Pedersen openings MUST be fresh randomness for every proof.
// They were previously derived from the key alone, which reused the same
// opening across transfers and made transfer amounts recoverable from chain
// data. `PedersenOpening::new_rand()` draws from the registered getrandom
// backend (crypto.getRandomValues in the browser, the OS on native).

fn try_split_u64(amount: u64, bit_length: usize) -> Option<(u64, u64)> {
    match bit_length {
        0 => Some((0, amount)),
        1..=63 => {
            let bit_length_complement = u64::BITS.checked_sub(bit_length as u32).unwrap();
            let lo = amount
                .checked_shl(bit_length_complement)?
                .checked_shr(bit_length_complement)?;
            let hi = amount.checked_shr(bit_length as u32)?;
            Some((lo, hi))
        }
        64 => Some((amount, 0)),
        _ => None,
    }
}

fn try_combine_lo_hi_ciphertexts(
    ciphertext_lo: &ElGamalCiphertext,
    ciphertext_hi: &ElGamalCiphertext,
    bit_length: usize,
) -> Option<ElGamalCiphertext> {
    let two_power = 1_u64.checked_shl(bit_length as u32)?;
    Some(ciphertext_lo + ciphertext_hi * Scalar::from(two_power))
}

/// Simple allocator for JS <-> WASM buffer passing.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let layout = Layout::from_size_align(len.max(1), 1).unwrap();
    unsafe { std_alloc(layout) }
}

/// Upper bound for the wide-range (fallback) discrete-log decode: 2^40 raw units.
/// Normal balance reads do NOT use it — the UI reads the AE-encrypted
/// decryptable balance and confirms it with `elgamal_verify_amount`, which is a
/// single scalar multiplication regardless of the amount.
const BSGS_MAX_AMOUNT: u64 = 1u64 << 40;

/// Number of baby steps (table size).
const BSGS_BABY_STEPS: u64 = 1u64 << 19; // 524,288

/// Baby-step table: compressed(j*G) -> j for j in [0, B). Building it costs
/// ~half a million point compressions, so it is built ONCE and reused; it used
/// to be rebuilt on every decrypt, which made every balance read take seconds.
fn baby_table() -> &'static HashMap<[u8; 32], u32> {
    static TABLE: OnceLock<HashMap<[u8; 32], u32>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut baby = HashMap::with_capacity(BSGS_BABY_STEPS as usize);
        let mut p = RistrettoPoint::identity();
        for j in 0..BSGS_BABY_STEPS {
            baby.insert(p.compress().to_bytes(), j as u32);
            p += G;
        }
        baby
    })
}

/// Wide-range discrete log via baby-step giant-step.
///
/// Finds x in [0, BSGS_MAX_AMOUNT] such that `target == x * G` (G the
/// Ristretto basepoint). Unlike the zk-sdk's `DiscreteLog::decode_u32`, this
/// recovers amounts larger than u32::MAX. Returns None if no such x exists
/// within the bound. Cost grows with the amount (amount / 2^19 steps).
fn bsgs_decode_u64(target: &RistrettoPoint) -> Option<u64> {
    let baby = baby_table();
    let big_step = Scalar::from(BSGS_BABY_STEPS) * G; // B * G
    // Giant steps: check target - i*(B*G) against the baby table.
    let num_giant = BSGS_MAX_AMOUNT / BSGS_BABY_STEPS + 2;
    let mut q = *target; // target - i*B*G, starting i=0
    for i in 0..num_giant {
        let key = q.compress().to_bytes();
        if let Some(&lo) = baby.get(&key) {
            let amount = i.wrapping_mul(BSGS_BABY_STEPS).wrapping_add(lo as u64);
            if amount <= BSGS_MAX_AMOUNT {
                return Some(amount);
            }
        }
        q -= big_step;
    }
    None
}

/// Decrypt an ElGamal ciphertext whose amount is known to be CLOSE to `hint`
/// (within the discrete-log search bound, in either direction). Used when an
/// account's AE-encrypted balance copy is slightly stale: the search runs over
/// the difference, so it works for balances of any size.
///   elgamal_decrypt_near(sec_ptr, 32, ct_ptr, 64, hint_ptr, hint_len, out_ptr, out_cap) -> i32
/// hint and output are decimal strings. Returns -1 if no amount is found.
#[no_mangle]
pub extern "C" fn elgamal_decrypt_near(
    sec_ptr: *const u8, sec_len: usize,
    ct_ptr: *const u8, ct_len: usize,
    hint_ptr: *const u8, hint_len: usize,
    out_ptr: *mut u8, out_cap: usize,
) -> i32 {
    if sec_ptr.is_null() || sec_len != 32 || ct_ptr.is_null() || ct_len != 64 || hint_ptr.is_null() || hint_len == 0 {
        return -1;
    }
    let keypair = match keypair_from_scalar32(unsafe { slice::from_raw_parts(sec_ptr, sec_len) }) {
        Some(k) => k,
        None => return -1,
    };
    let ct = match ElGamalCiphertext::from_bytes(unsafe { slice::from_raw_parts(ct_ptr, ct_len) }) {
        Some(c) => c,
        None => return -1,
    };
    let hint: u64 = match std::str::from_utf8(unsafe { slice::from_raw_parts(hint_ptr, hint_len) }) {
        Ok(s) => match s.trim().parse() { Ok(a) => a, Err(_) => return -1 },
        Err(_) => return -1,
    };
    let target = ct.decrypt(keypair.secret()).target;
    let hint_point = Scalar::from(hint) * G;
    // amount = hint + d
    if let Some(d) = bsgs_decode_u64(&(target - hint_point)) {
        if let Some(a) = hint.checked_add(d) {
            return write_out(out_ptr, out_cap, a.to_string().as_bytes());
        }
    }
    // amount = hint - d
    if let Some(d) = bsgs_decode_u64(&(hint_point - target)) {
        if let Some(a) = hint.checked_sub(d) {
            return write_out(out_ptr, out_cap, a.to_string().as_bytes());
        }
    }
    -1
}

/// The available-balance ciphertext an account will hold after
/// `ApplyPendingBalance`: available + pending_lo + pending_hi * 2^16 — the same
/// homomorphic sum the token program computes. No key is involved.
///   elgamal_apply_pending(avail_ptr, 64, lo_ptr, 64, hi_ptr, 64, out_ptr, out_cap) -> i32 (64 bytes)
#[no_mangle]
pub extern "C" fn elgamal_apply_pending(
    avail_ptr: *const u8, avail_len: usize,
    lo_ptr: *const u8, lo_len: usize,
    hi_ptr: *const u8, hi_len: usize,
    out_ptr: *mut u8, out_cap: usize,
) -> i32 {
    if avail_ptr.is_null() || lo_ptr.is_null() || hi_ptr.is_null()
        || avail_len != 64 || lo_len != 64 || hi_len != 64 {
        return -1;
    }
    let parse = |p: *const u8| ElGamalCiphertext::from_bytes(unsafe { slice::from_raw_parts(p, 64) });
    let (avail, lo, hi) = match (parse(avail_ptr), parse(lo_ptr), parse(hi_ptr)) {
        (Some(a), Some(l), Some(h)) => (a, l, h),
        _ => return -1,
    };
    let pending = match try_combine_lo_hi_ciphertexts(&lo, &hi, TRANSFER_AMOUNT_LO_BITS) {
        Some(c) => c,
        None => return -1,
    };
    write_out(out_ptr, out_cap, &(&avail + &pending).to_bytes())
}

/// Check that an ElGamal ciphertext decrypts to a KNOWN amount under a 32-byte
/// secret scalar. One scalar multiplication — constant cost for any amount.
///   elgamal_verify_amount(sec_ptr, 32, ct_ptr, 64, amount_ptr, amount_len) -> i32
/// amount is a decimal string. Returns 1 if it matches, 0 if not, -1 on bad input.
#[no_mangle]
pub extern "C" fn elgamal_verify_amount(
    sec_ptr: *const u8,
    sec_len: usize,
    ct_ptr: *const u8,
    ct_len: usize,
    amount_ptr: *const u8,
    amount_len: usize,
) -> i32 {
    if sec_ptr.is_null() || sec_len != 32 || ct_ptr.is_null() || ct_len != 64
        || amount_ptr.is_null() || amount_len == 0 {
        return -1;
    }
    let keypair = match keypair_from_scalar32(unsafe { slice::from_raw_parts(sec_ptr, sec_len) }) {
        Some(k) => k,
        None => return -1,
    };
    let ct = match ElGamalCiphertext::from_bytes(unsafe { slice::from_raw_parts(ct_ptr, ct_len) }) {
        Some(c) => c,
        None => return -1,
    };
    let amount: u64 = match std::str::from_utf8(unsafe { slice::from_raw_parts(amount_ptr, amount_len) }) {
        Ok(s) => match s.trim().parse() { Ok(a) => a, Err(_) => return -1 },
        Err(_) => return -1,
    };
    let dlog = ct.decrypt(keypair.secret());
    if dlog.target == Scalar::from(amount) * G { 1 } else { 0 }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let layout = Layout::from_size_align(len.max(1), 1).unwrap();
    unsafe { std_dealloc(ptr, layout) }
}

fn write_out(out_ptr: *mut u8, out_cap: usize, data: &[u8]) -> i32 {
    if out_ptr.is_null() || data.len() > out_cap {
        return -1;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(data.as_ptr(), out_ptr, data.len());
    }
    data.len() as i32
}

/// Derive the 32-byte ElGamal pubkey from a 32-byte secret seed (hex output).
/// The seed is hashed (Sha3-512) to a valid curve25519 scalar via from_seed,
/// so any 32 random bytes from the browser produce a valid key.
#[no_mangle]
pub extern "C" fn pubkey_from_secret(
    secret_ptr: *const u8,
    secret_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    if secret_ptr.is_null() || secret_len != 32 {
        return -1;
    }
    let secret_bytes = unsafe { slice::from_raw_parts(secret_ptr, secret_len) };
    // IMPORTANT: build the keypair from the RAW 32-byte secret scalar via
    // from(scalar), NOT from_seed (which hashes the seed). Account creation must
    // match the transfer proof path (keypair_from_scalar32 -> from(scalar)) so
    // the stored on-chain pubkey equals the pubkey the transfer proof commits.
    // Otherwise token-2022 rejects with 0x1a ElGamalPublicKeyMismatch.
    let keypair = match keypair_from_scalar32(secret_bytes) {
        Some(k) => k,
        None => return -1,
    };
    let pubkey: [u8; 32] = keypair.pubkey().into();
    write_out(out_ptr, out_cap, &hex::encode(pubkey).into_bytes())
}

/// Generate a 96-byte PubkeyValidityProofData for a 32-byte secret seed (base64 out).
///
/// Reimplements PubkeyValidityProofData::new with a DETERMINISTIC nonce
/// (y = hash(secret || "x1-privacy-pubkey-nonce-v1")) instead of OsRng, so the WASM
/// needs no JS runtime glue. The proof is byte-identical in structure to the
/// canonical one and verifies on-chain with the same zk-ops program.
#[no_mangle]
pub extern "C" fn gen_pubkey_proof(
    secret_ptr: *const u8,
    secret_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    if secret_ptr.is_null() || secret_len != 32 {
        return -1;
    }
    let secret_bytes = unsafe { slice::from_raw_parts(secret_ptr, secret_len) };
    // Same from(scalar) construction as account creation + transfer proof, so the
    // pubkey-validity proof certifies the SAME key the account is created with
    // and the transfer spends from.
    let arr: [u8; 32] = match secret_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return -1,
    };
    let s = match Scalar::from_canonical_bytes(arr).into_option() {
        Some(sc) => sc,
        None => return -1,
    };
    if s == Scalar::ZERO {
        return -1;
    }
    let s_inv = s.invert();
    let secret = ElGamalSecretKey::from(s);
    let keypair = ElGamalKeypair::new(secret);
    let pubkey = keypair.pubkey();

    // Deterministic nonce: y = hash(secret || domain-sep) as a scalar.
    let mut hasher = Sha3_512::new();
    hasher.update(secret_bytes);
    hasher.update(b"x1-privacy-pubkey-nonce-v1");
    let y = Scalar::from_hash(hasher);

    // Y = y * H (the Pedersen base point).
    let Y = (&y * &(*H)).compress();

    // Build the transcript exactly as the canonical proof does.
    let mut transcript = Transcript::new_zk_elgamal_transcript(b"pubkey-validity-instruction");
    transcript.append_message(b"pubkey", &pubkey.to_bytes());
    transcript.pubkey_proof_domain_separator();
    transcript.append_point(b"Y", &Y);
    let c = transcript.challenge_scalar(b"c");

    // z = c * s_inv + y
    let z = &(&c * &s_inv) + &y;

    // Assemble the 96-byte PubkeyValidityProofData (Pod, repr C):
    //   [0..32]  context.pubkey (PodElGamalPubkey)
    //   [32..64] proof.Y (CompressedRistretto)
    //   [64..96] proof.z (Scalar)
    let mut data = [0u8; 96];
    data[..32].copy_from_slice(&<[u8; 32]>::from(pubkey));
    data[32..64].copy_from_slice(Y.as_bytes());
    data[64..96].copy_from_slice(z.as_bytes());
    let proof: &PubkeyValidityProofData = bytemuck::from_bytes(&data);
    let bytes = bytemuck::bytes_of(proof);
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    write_out(out_ptr, out_cap, b64.as_bytes())
}

/// Decrypt an ElGamal ciphertext with a secret seed (hex out).
///
///   decrypt(secret_ptr, secret_len, ciphertext_ptr, ciphertext_len, out_ptr, out_cap) -> i32
///
/// ciphertext is the 64-byte ElGamalCiphertext (commitment 32B + handle 32B).
/// Returns the decrypted u64 amount as a decimal string.
#[no_mangle]
pub extern "C" fn decrypt(
    secret_ptr: *const u8,
    secret_len: usize,
    ciphertext_ptr: *const u8,
    ciphertext_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    if secret_ptr.is_null() || secret_len != 32 || ciphertext_ptr.is_null() || ciphertext_len != 64 {
        return -1;
    }
    let secret_bytes = unsafe { slice::from_raw_parts(secret_ptr, secret_len) };
    let secret = match ElGamalSecretKey::from_seed(secret_bytes) {
        Ok(s) => s,
        Err(_) => return -1,
    };
    let ct_bytes = unsafe { slice::from_raw_parts(ciphertext_ptr, ciphertext_len) };
    let ct = match ElGamalCiphertext::from_bytes(ct_bytes) {
        Some(c) => c,
        None => return -1,
    };
    let amount = match ct.decrypt_u32(&secret) {
        Some(a) => a,
        None => return -1,
    };
    write_out(out_ptr, out_cap, amount.to_string().as_bytes())
}

/// Decrypt a 36-byte AE ciphertext (decryptable available balance) with a
/// 32-byte secret seed. Returns the decrypted u64 amount as a decimal string.
///   ae_decrypt(secret_ptr, secret_len, ct_ptr, ct_len, out_ptr, out_cap) -> i32
#[no_mangle]
pub extern "C" fn ae_decrypt(
    secret_ptr: *const u8,
    secret_len: usize,
    ct_ptr: *const u8,
    ct_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    if secret_ptr.is_null() || secret_len != 32 || ct_ptr.is_null() || ct_len != 36 {
        return -1;
    }
    let secret_bytes = unsafe { slice::from_raw_parts(secret_ptr, secret_len) };
    // AE key from seed = Sha3_512(seed)[..16].
    let mut hasher = Sha3_512::new();
    hasher.update(secret_bytes);
    let result = hasher.finalize();
    let ae_bytes: [u8; 16] = result[..16].try_into().unwrap();
    let ae = match AeKey::try_from(&ae_bytes[..]) {
        Ok(a) => a,
        Err(_) => return -1,
    };
    let ct_bytes = unsafe { slice::from_raw_parts(ct_ptr, ct_len) };
    let ct = match AeCiphertext::from_bytes(ct_bytes) {
        Some(c) => c,
        None => return -1,
    };
    let amount = match ae.decrypt(&ct) {
        Some(a) => a,
        None => return -1,
    };
    write_out(out_ptr, out_cap, amount.to_string().as_bytes())
}

/// Derive the 32-byte AE key from a 32-byte secret seed (raw bytes out).
/// The AE key is used to encrypt/decrypt the decryptable available balance.
#[no_mangle]
pub extern "C" fn ae_key_from_secret(
    secret_ptr: *const u8,
    secret_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    if secret_ptr.is_null() || secret_len != 32 {
        return -1;
    }
    let secret_bytes = unsafe { slice::from_raw_parts(secret_ptr, secret_len) };
    // AE key from seed = Sha3_512(seed)[..16] (matches AeKey::from_seed; AE_KEY_LEN=16).
    let mut hasher = Sha3_512::new();
    hasher.update(secret_bytes);
    let result = hasher.finalize();
    let bytes: [u8; 16] = result[..16].try_into().unwrap();
    write_out(out_ptr, out_cap, &bytes)
}

/// AE-encrypt a u64 amount with a 32-byte AE key (raw bytes out).
///   ae_encrypt(ae_ptr, ae_len, amount_ptr, amount_len, out_ptr, out_cap) -> i32
/// amount is a decimal string. Returns the 36-byte AeCiphertext.
#[no_mangle]
pub extern "C" fn ae_encrypt(
    ae_ptr: *const u8,
    ae_len: usize,
    amount_ptr: *const u8,
    amount_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    if ae_ptr.is_null() || ae_len != 16 || amount_ptr.is_null() || amount_len == 0 {
        return -1;
    }
    let ae_bytes = unsafe { slice::from_raw_parts(ae_ptr, ae_len) };
    let ae = match AeKey::try_from(ae_bytes) {
        Ok(a) => a,
        Err(_) => return -1,
    };
    let amount_str = unsafe { slice::from_raw_parts(amount_ptr, amount_len) };
    let amount: u64 = match std::str::from_utf8(amount_str) {
        Ok(s) => match s.trim().parse() { Ok(a) => a, Err(_) => return -1 },
        Err(_) => return -1,
    };
    // AeKey::encrypt draws a fresh random 12-byte nonce for every ciphertext, so
    // two encryptions of the same balance are unlinkable.
    // AeCiphertext layout: nonce(12) || ciphertext(24) = 36 bytes.
    let out = ae.encrypt(amount).to_bytes();
    write_out(out_ptr, out_cap, &out)
}

/// Generate the two zk proofs for a confidential->public withdraw, entirely
/// client-side so the secret key never leaves the browser.
///
///   gen_withdraw_proof(secret_ptr, secret_len, avail_ptr, avail_len,
///                      current_ptr, current_len, amount_ptr, amount_len,
///                      out_ptr, out_cap) -> i32
///
/// secret  = 32-byte ElGamal secret seed (raw)
/// avail   = 64-byte available-balance ElGamal ciphertext (raw)
/// current = decimal string of the current decryptable balance
/// amount  = decimal string of the u64 amount to withdraw
///
/// Returns a JSON string (base64 proof bytes):
///   {equality, range, newAvailableBalance, amount}
#[no_mangle]
pub extern "C" fn gen_withdraw_proof(
    secret_ptr: *const u8, secret_len: usize,
    avail_ptr: *const u8, avail_len: usize,
    current_ptr: *const u8, current_len: usize,
    amount_ptr: *const u8, amount_len: usize,
    out_ptr: *mut u8, out_cap: usize,
) -> i32 {
    if secret_ptr.is_null() || secret_len != 32
        || avail_ptr.is_null() || avail_len != 64
        || current_ptr.is_null() || current_len == 0
        || amount_ptr.is_null() || amount_len == 0 {
        return -1;
    }
    let secret_bytes = unsafe { slice::from_raw_parts(secret_ptr, secret_len) };
    let avail_bytes = unsafe { slice::from_raw_parts(avail_ptr, avail_len) };
    let current_str = unsafe { slice::from_raw_parts(current_ptr, current_len) };
    let amount_str = unsafe { slice::from_raw_parts(amount_ptr, amount_len) };

    let secret = match ElGamalSecretKey::from_seed(secret_bytes) {
        Ok(s) => s,
        Err(_) => return -1,
    };
    let keypair = ElGamalKeypair::new(secret);
    let avail_bal = match ElGamalCiphertext::from_bytes(avail_bytes) {
        Some(c) => c,
        None => return -1,
    };
    let current_balance: u64 = match std::str::from_utf8(current_str) {
        Ok(s) => match s.trim().parse() { Ok(a) => a, Err(_) => return -1 },
        Err(_) => return -1,
    };
    let withdraw_amount: u64 = match std::str::from_utf8(amount_str) {
        Ok(s) => match s.trim().parse() { Ok(a) => a, Err(_) => return -1 },
        Err(_) => return -1,
    };

    let remaining_balance = match current_balance.checked_sub(withdraw_amount) {
        Some(b) => b,
        None => return -1,
    };
    let (remaining_commitment, remaining_opening) = Pedersen::new(remaining_balance);
    let remaining_ciphertext = &avail_bal - &ElGamal::encode(withdraw_amount);

    let equality_proof_data = match CiphertextCommitmentEqualityProofData::new(
        &keypair,
        &remaining_ciphertext,
        &remaining_commitment,
        &remaining_opening,
        remaining_balance,
    ) {
        Ok(p) => p,
        Err(_) => return -1,
    };

    let range_proof_data = match BatchedRangeProofU64Data::new(
        vec![&remaining_commitment],
        vec![remaining_balance],
        vec![REMAINING_BALANCE_BIT_LENGTH],
        vec![&remaining_opening],
    ) {
        Ok(p) => p,
        Err(_) => return -1,
    };

    let equality = bytemuck::bytes_of(&equality_proof_data);
    let range = bytemuck::bytes_of(&range_proof_data);
    let out = serde_json::json!({
        "equality": base64::engine::general_purpose::STANDARD.encode(equality),
        "range": base64::engine::general_purpose::STANDARD.encode(range),
        "newAvailableBalance": remaining_balance.to_string(),
        "amount": withdraw_amount.to_string(),
    });
    write_out(out_ptr, out_cap, out.to_string().as_bytes())
}

/// Generate the three zk proofs for a confidential->confidential transfer,
/// entirely client-side so the secret key never leaves the browser.
///
///   gen_transfer_proof(secret_ptr, secret_len, aes_ptr, aes_len,
///                      avail_ptr, avail_len, dec_ptr, dec_len,
///                      amount_ptr, amount_len, dest_ptr, dest_len,
///                      out_ptr, out_cap) -> i32
///
/// secret  = 32-byte ElGamal secret seed (raw)
/// aes     = 32-byte AE key (raw)
/// avail   = 64-byte available-balance ElGamal ciphertext (raw)
/// dec     = 36-byte decryptable-available-balance AE ciphertext (raw)
/// amount  = decimal string of the u64 amount to transfer
/// dest    = 32-byte destination ElGamal pubkey (raw)
///
/// Returns a JSON string (base64 proof bytes):
///   {equality, ciphertextValidity, range, auditorLo, auditorHi, newAvailableBalance}
#[no_mangle]
pub extern "C" fn gen_transfer_proof(
    secret_ptr: *const u8, secret_len: usize,
    aes_ptr: *const u8, aes_len: usize,
    avail_ptr: *const u8, avail_len: usize,
    dec_ptr: *const u8, dec_len: usize,
    amount_ptr: *const u8, amount_len: usize,
    dest_ptr: *const u8, dest_len: usize,
    out_ptr: *mut u8, out_cap: usize,
) -> i32 {
    if secret_ptr.is_null() || secret_len != 32
        || aes_ptr.is_null() || aes_len != 16
        || avail_ptr.is_null() || avail_len != 64
        || dec_ptr.is_null() || dec_len != 36
        || amount_ptr.is_null() || amount_len == 0
        || dest_ptr.is_null() || dest_len != 32 {
        return -1;
    }
    let secret_bytes = unsafe { slice::from_raw_parts(secret_ptr, secret_len) };
    let aes_bytes = unsafe { slice::from_raw_parts(aes_ptr, aes_len) };
    let avail_bytes = unsafe { slice::from_raw_parts(avail_ptr, avail_len) };
    let dec_bytes = unsafe { slice::from_raw_parts(dec_ptr, dec_len) };
    let amount_str = unsafe { slice::from_raw_parts(amount_ptr, amount_len) };
    let dest_bytes = unsafe { slice::from_raw_parts(dest_ptr, dest_len) };

    let secret = match ElGamalSecretKey::from_seed(secret_bytes) {
        Ok(s) => s,
        Err(_) => return -1,
    };
    let keypair = ElGamalKeypair::new(secret);
    let aes = match AeKey::try_from(aes_bytes) {
        Ok(a) => a,
        Err(_) => return -1,
    };
    let avail_bal = match ElGamalCiphertext::from_bytes(avail_bytes) {
        Some(c) => c,
        None => return -1,
    };
    let decryptable = match AeCiphertext::from_bytes(dec_bytes) {
        Some(c) => c,
        None => return -1,
    };
    let amount: u64 = match std::str::from_utf8(amount_str) {
        Ok(s) => match s.trim().parse() { Ok(a) => a, Err(_) => return -1 },
        Err(_) => return -1,
    };
    let dest_pub = match ElGamalPubkey::try_from(dest_bytes) {
        Ok(p) => p,
        Err(_) => return -1,
    };
    let default_auditor = ElGamalPubkey::default();
    let auditor = &default_auditor;

    let (amount_lo, amount_hi) = match try_split_u64(amount, TRANSFER_AMOUNT_LO_BITS) {
        Some(x) => x,
        None => return -1,
    };

    let opening_lo = PedersenOpening::new_rand();
    let grouped_lo = GroupedElGamal::<3>::encrypt_with(
        [keypair.pubkey(), &dest_pub, auditor],
        amount_lo,
        &opening_lo,
    );
    let opening_hi = PedersenOpening::new_rand();
    let grouped_hi = GroupedElGamal::<3>::encrypt_with(
        [keypair.pubkey(), &dest_pub, auditor],
        amount_hi,
        &opening_hi,
    );

    let current_decrypted = match decryptable.decrypt(&aes) {
        Some(d) => d,
        None => return -1,
    };
    let new_decrypted = match current_decrypted.checked_sub(amount) {
        Some(d) => d,
        None => return -1,
    };

    let (new_balance_commitment, new_source_opening) = Pedersen::new(new_decrypted);

    let transfer_amount_source_lo = match grouped_lo.to_elgamal_ciphertext(0) {
        Ok(c) => c,
        Err(_) => return -1,
    };
    let transfer_amount_source_hi = match grouped_hi.to_elgamal_ciphertext(0) {
        Ok(c) => c,
        Err(_) => return -1,
    };
    let new_balance_ciphertext = match try_combine_lo_hi_ciphertexts(
        &transfer_amount_source_lo,
        &transfer_amount_source_hi,
        TRANSFER_AMOUNT_LO_BITS,
    ) {
        Some(c) => &avail_bal - &c,
        None => return -1,
    };

    let equality_proof_data = match CiphertextCommitmentEqualityProofData::new(
        &keypair,
        &new_balance_ciphertext,
        &new_balance_commitment,
        &new_source_opening,
        new_decrypted,
    ) {
        Ok(p) => p,
        Err(_) => return -1,
    };

    let ciphertext_validity_proof_data = match BatchedGroupedCiphertext3HandlesValidityProofData::new(
        keypair.pubkey(),
        &dest_pub,
        auditor,
        &grouped_lo,
        &grouped_hi,
        amount_lo,
        amount_hi,
        &opening_lo,
        &opening_hi,
    ) {
        Ok(p) => p,
        Err(_) => return -1,
    };

    let auditor_lo = match ciphertext_validity_proof_data
        .context_data()
        .grouped_ciphertext_lo
        .try_extract_ciphertext(2)
    {
        Ok(c) => c,
        Err(_) => return -1,
    };
    let auditor_hi = match ciphertext_validity_proof_data
        .context_data()
        .grouped_ciphertext_hi
        .try_extract_ciphertext(2)
    {
        Ok(c) => c,
        Err(_) => return -1,
    };

    let (padding_commitment, padding_opening) = Pedersen::new(0_u64);
    let range_proof_data = match BatchedRangeProofU128Data::new(
        vec![
            &new_balance_commitment,
            &grouped_lo.commitment,
            &grouped_hi.commitment,
            &padding_commitment,
        ],
        vec![new_decrypted, amount_lo, amount_hi, 0],
        vec![
            REMAINING_BALANCE_BIT_LENGTH,
            TRANSFER_AMOUNT_LO_BITS,
            TRANSFER_AMOUNT_HI_BITS,
            RANGE_PROOF_PADDING_BIT_LENGTH,
        ],
        vec![
            &new_source_opening,
            &opening_lo,
            &opening_hi,
            &padding_opening,
        ],
    ) {
        Ok(p) => p,
        Err(_) => return -1,
    };

    let equality = bytemuck::bytes_of(&equality_proof_data);
    let validity = bytemuck::bytes_of(&ciphertext_validity_proof_data);
    let range = bytemuck::bytes_of(&range_proof_data);
    let out = serde_json::json!({
        "equality": base64::engine::general_purpose::STANDARD.encode(equality),
        "ciphertextValidity": base64::engine::general_purpose::STANDARD.encode(validity),
        "range": base64::engine::general_purpose::STANDARD.encode(range),
        "auditorLo": base64::engine::general_purpose::STANDARD.encode(bytemuck::bytes_of(&auditor_lo)),
        "auditorHi": base64::engine::general_purpose::STANDARD.encode(bytemuck::bytes_of(&auditor_hi)),
        "newAvailableBalance": new_decrypted.to_string(),
        // the sender's available-balance ciphertext after this transfer, so a
        // client can build the NEXT proof before this one has landed
        "newAvailableCiphertext": hex::encode(new_balance_ciphertext.to_bytes()),
    });
    write_out(out_ptr, out_cap, out.to_string().as_bytes())
}

// ===========================================================================
// DETERMINISTIC WALLET-SIGNATURE KEY DERIVATION + PROOFS
//
// These functions use the canonical token-2022 ConfidentialKeys.fromSignature
// derivation (zk-sdk `derive_confidential_keys_from_ikm`: HKDF-SHA512 chain,
// salt = "solana-conf-bal/v1", info = "ae"/"elgamal"), implemented exactly as
// the zk-sdk's `derivation.rs`. The AE key and ElGamal secret are ALWAYS
// recoverable from the wallet signature and never stranded. See the server's
// conf_account.ts `deriveFromSig` — it uses the same @solana/zk-sdk derivation,
// so these MUST match byte-for-byte.
// ===========================================================================

/// Export the 16-byte AE key derived from a 64-byte ed25519 signature.
///   ae_key_from_signature(sig_ptr, sig_len, out_ptr, out_cap) -> i32
#[no_mangle]
pub extern "C" fn ae_key_from_signature(
    sig_ptr: *const u8,
    sig_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    if sig_ptr.is_null() || sig_len != 64 || out_cap < 16 {
        return -1;
    }
    let sig = unsafe { slice::from_raw_parts(sig_ptr, sig_len) };
    let (ae, _elg) = derive_keys_from_signature(sig);
    write_out(out_ptr, out_cap, &ae)
}

/// Export the 32-byte ElGamal secret scalar derived from a 64-byte ed25519
/// signature.
///   elgamal_secret_from_signature(sig_ptr, sig_len, out_ptr, out_cap) -> i32
#[no_mangle]
pub extern "C" fn elgamal_secret_from_signature(
    sig_ptr: *const u8,
    sig_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    if sig_ptr.is_null() || sig_len != 64 || out_cap < 32 {
        return -1;
    }
    let sig = unsafe { slice::from_raw_parts(sig_ptr, sig_len) };
    let (_ae, elg) = derive_keys_from_signature(sig);
    write_out(out_ptr, out_cap, &elg)
}

/// Build a keypair from a canonical 32-byte ElGamal secret scalar (NOT a seed).
/// Uses `ElGamalSecretKey::from(scalar)` so proofs use the SAME secret the
/// signature-derived account was created with, avoiding the double-hash
/// discrepancy of feeding the secret into `from_seed`.
fn keypair_from_scalar32(bytes: &[u8]) -> Option<ElGamalKeypair> {
    let arr: [u8; 32] = bytes.try_into().ok()?;
    let scalar = Scalar::from_canonical_bytes(arr).into_option()?;
    let secret = ElGamalSecretKey::from(scalar);
    Some(ElGamalKeypair::new(secret))
}

/// Generate the two withdraw zk proofs using the wallet-signature-derived
/// ElGamal secret. Same logic as `gen_withdraw_proof` but the keypair is built
/// from the canonical signature-derived scalar so the proofs are valid for the
/// deterministic (signature-derived) on-chain account.
///   gen_withdraw_proof_from_sig(sig_ptr, sig_len, avail_ptr, avail_len,
///                               current_ptr, current_len, amount_ptr, amount_len,
///                               out_ptr, out_cap) -> i32
#[no_mangle]
pub extern "C" fn gen_withdraw_proof_from_sig(
    sig_ptr: *const u8, sig_len: usize,
    avail_ptr: *const u8, avail_len: usize,
    current_ptr: *const u8, current_len: usize,
    amount_ptr: *const u8, amount_len: usize,
    out_ptr: *mut u8, out_cap: usize,
) -> i32 {
    if sig_ptr.is_null() || sig_len != 64
        || avail_ptr.is_null() || avail_len != 64
        || current_ptr.is_null() || current_len == 0
        || amount_ptr.is_null() || amount_len == 0 {
        return -1;
    }
    let sig = unsafe { slice::from_raw_parts(sig_ptr, sig_len) };
    let (_ae, elg) = derive_keys_from_signature(sig);
    let keypair = match keypair_from_scalar32(&elg) {
        Some(k) => k,
        None => return -1,
    };

    let avail_bytes = unsafe { slice::from_raw_parts(avail_ptr, avail_len) };
    let current_str = unsafe { slice::from_raw_parts(current_ptr, current_len) };
    let amount_str = unsafe { slice::from_raw_parts(amount_ptr, amount_len) };

    let avail_bal = match ElGamalCiphertext::from_bytes(avail_bytes) {
        Some(c) => c,
        None => return -1,
    };
    let current_balance: u64 = match std::str::from_utf8(current_str) {
        Ok(s) => match s.trim().parse() { Ok(a) => a, Err(_) => return -1 },
        Err(_) => return -1,
    };
    let withdraw_amount: u64 = match std::str::from_utf8(amount_str) {
        Ok(s) => match s.trim().parse() { Ok(a) => a, Err(_) => return -1 },
        Err(_) => return -1,
    };

    let remaining_balance = match current_balance.checked_sub(withdraw_amount) {
        Some(b) => b,
        None => return -1,
    };
    let (remaining_commitment, remaining_opening) = Pedersen::new(remaining_balance);
    let remaining_ciphertext = &avail_bal - &ElGamal::encode(withdraw_amount);

    let equality_proof_data = match CiphertextCommitmentEqualityProofData::new(
        &keypair,
        &remaining_ciphertext,
        &remaining_commitment,
        &remaining_opening,
        remaining_balance,
    ) {
        Ok(p) => p,
        Err(_) => return -1,
    };

    let range_proof_data = match BatchedRangeProofU64Data::new(
        vec![&remaining_commitment],
        vec![remaining_balance],
        vec![REMAINING_BALANCE_BIT_LENGTH],
        vec![&remaining_opening],
    ) {
        Ok(p) => p,
        Err(_) => return -1,
    };

    let equality = bytemuck::bytes_of(&equality_proof_data);
    let range = bytemuck::bytes_of(&range_proof_data);
    let out = serde_json::json!({
        "equality": base64::engine::general_purpose::STANDARD.encode(equality),
        "range": base64::engine::general_purpose::STANDARD.encode(range),
        "newAvailableBalance": remaining_balance.to_string(),
        "amount": withdraw_amount.to_string(),
    });
    write_out(out_ptr, out_cap, out.to_string().as_bytes())
}

/// Generate the three transfer zk proofs using the wallet-signature-derived
/// ElGamal secret and AE key. Same logic as `gen_transfer_proof` but keypair
/// and AE key are derived canonically from the signature (which is exactly the
/// secret the on-chain account was created with).
///   gen_transfer_proof_from_sig(sig_ptr, sig_len, avail_ptr, avail_len,
///                               dec_ptr, dec_len, amount_ptr, amount_len,
///                               dest_ptr, dest_len, out_ptr, out_cap) -> i32
#[no_mangle]
pub extern "C" fn gen_transfer_proof_from_sig(
    sig_ptr: *const u8, sig_len: usize,
    avail_ptr: *const u8, avail_len: usize,
    dec_ptr: *const u8, dec_len: usize,
    amount_ptr: *const u8, amount_len: usize,
    dest_ptr: *const u8, dest_len: usize,
    out_ptr: *mut u8, out_cap: usize,
) -> i32 {
    if sig_ptr.is_null() || sig_len != 64
        || avail_ptr.is_null() || avail_len != 64
        || dec_ptr.is_null() || dec_len != 36
        || amount_ptr.is_null() || amount_len == 0
        || dest_ptr.is_null() || dest_len != 32 {
        return -1; // ARG
    }
    let sig = unsafe { slice::from_raw_parts(sig_ptr, sig_len) };
    let (ae_bytes, elg) = derive_keys_from_signature(sig);
    let keypair = match keypair_from_scalar32(&elg) {
        Some(k) => k,
        None => return -2, // KEYPAIR_FROM_SCALAR
    };
    let aes = match AeKey::try_from(&ae_bytes[..]) {
        Ok(a) => a,
        Err(_) => return -3, // AEKEY_PARSE
    };

    let avail_bytes = unsafe { slice::from_raw_parts(avail_ptr, avail_len) };
    let dec_bytes = unsafe { slice::from_raw_parts(dec_ptr, dec_len) };
    let amount_str = unsafe { slice::from_raw_parts(amount_ptr, amount_len) };
    let dest_bytes = unsafe { slice::from_raw_parts(dest_ptr, dest_len) };

    let avail_bal = match ElGamalCiphertext::from_bytes(avail_bytes) {
        Some(c) => c,
        None => return -4, // ELGAMAL_CT_PARSE
    };
    let decryptable = match AeCiphertext::from_bytes(dec_bytes) {
        Some(c) => c,
        None => return -5, // AE_CT_PARSE
    };
    let amount: u64 = match std::str::from_utf8(amount_str) {
        Ok(s) => match s.trim().parse() { Ok(a) => a, Err(_) => return -6 }, // AMOUNT_PARSE
        Err(_) => return -6, // AMOUNT_UTF8
    };
    let dest_pub = match ElGamalPubkey::try_from(dest_bytes) {
        Ok(p) => p,
        Err(_) => return -7, // DEST_PUBKEY
    };
    let default_auditor = ElGamalPubkey::default();
    let auditor = &default_auditor;

    let (amount_lo, amount_hi) = match try_split_u64(amount, TRANSFER_AMOUNT_LO_BITS) {
        Some(x) => x,
        None => return -8, // SPLIT_U64
    };

    let opening_lo = PedersenOpening::new_rand();
    let grouped_lo = GroupedElGamal::<3>::encrypt_with(
        [keypair.pubkey(), &dest_pub, auditor],
        amount_lo,
        &opening_lo,
    );
    let opening_hi = PedersenOpening::new_rand();
    let grouped_hi = GroupedElGamal::<3>::encrypt_with(
        [keypair.pubkey(), &dest_pub, auditor],
        amount_hi,
        &opening_hi,
    );

    let current_decrypted = match decryptable.decrypt(&aes) {
        Some(d) => d,
        None => return -9, // DECRYPT_FAIL
    };
    let new_decrypted = match current_decrypted.checked_sub(amount) {
        Some(d) => d,
        None => return -12, // INSUFFICIENT_BALANCE
    };

    let (new_balance_commitment, new_source_opening) = Pedersen::new(new_decrypted);

    let transfer_amount_source_lo = match grouped_lo.to_elgamal_ciphertext(0) {
        Ok(c) => c,
        Err(_) => return -10, // TO_ELGAMAL_LO
    };
    let transfer_amount_source_hi = match grouped_hi.to_elgamal_ciphertext(0) {
        Ok(c) => c,
        Err(_) => return -11, // TO_ELGAMAL_HI
    };
    let new_balance_ciphertext = match try_combine_lo_hi_ciphertexts(
        &transfer_amount_source_lo,
        &transfer_amount_source_hi,
        TRANSFER_AMOUNT_LO_BITS,
    ) {
        Some(c) => &avail_bal - &c,
        None => return -1,
    };

    let equality_proof_data = match CiphertextCommitmentEqualityProofData::new(
        &keypair,
        &new_balance_ciphertext,
        &new_balance_commitment,
        &new_source_opening,
        new_decrypted,
    ) {
        Ok(p) => p,
        Err(_) => return -13, // EQUALITY_PROOF
    };

    let ciphertext_validity_proof_data = match BatchedGroupedCiphertext3HandlesValidityProofData::new(
        keypair.pubkey(),
        &dest_pub,
        auditor,
        &grouped_lo,
        &grouped_hi,
        amount_lo,
        amount_hi,
        &opening_lo,
        &opening_hi,
    ) {
        Ok(p) => p,
        Err(_) => return -1,
    };

    let auditor_lo = match ciphertext_validity_proof_data
        .context_data()
        .grouped_ciphertext_lo
        .try_extract_ciphertext(2)
    {
        Ok(c) => c,
        Err(_) => return -1,
    };
    let auditor_hi = match ciphertext_validity_proof_data
        .context_data()
        .grouped_ciphertext_hi
        .try_extract_ciphertext(2)
    {
        Ok(c) => c,
        Err(_) => return -1,
    };

    let (padding_commitment, padding_opening) = Pedersen::new(0_u64);
    let range_proof_data = match BatchedRangeProofU128Data::new(
        vec![
            &new_balance_commitment,
            &grouped_lo.commitment,
            &grouped_hi.commitment,
            &padding_commitment,
        ],
        vec![new_decrypted, amount_lo, amount_hi, 0],
        vec![
            REMAINING_BALANCE_BIT_LENGTH,
            TRANSFER_AMOUNT_LO_BITS,
            TRANSFER_AMOUNT_HI_BITS,
            RANGE_PROOF_PADDING_BIT_LENGTH,
        ],
        vec![
            &new_source_opening,
            &opening_lo,
            &opening_hi,
            &padding_opening,
        ],
    ) {
        Ok(p) => p,
        Err(_) => return -1,
    };

    let equality = bytemuck::bytes_of(&equality_proof_data);
    let validity = bytemuck::bytes_of(&ciphertext_validity_proof_data);
    let range = bytemuck::bytes_of(&range_proof_data);
    let out = serde_json::json!({
        "equality": base64::engine::general_purpose::STANDARD.encode(equality),
        "ciphertextValidity": base64::engine::general_purpose::STANDARD.encode(validity),
        "range": base64::engine::general_purpose::STANDARD.encode(range),
        "auditorLo": base64::engine::general_purpose::STANDARD.encode(bytemuck::bytes_of(&auditor_lo)),
        "auditorHi": base64::engine::general_purpose::STANDARD.encode(bytemuck::bytes_of(&auditor_hi)),
        "newAvailableBalance": new_decrypted.to_string(),
        // the sender's available-balance ciphertext after this transfer, so a
        // client can build the NEXT proof before this one has landed
        "newAvailableCiphertext": hex::encode(new_balance_ciphertext.to_bytes()),
    });
    write_out(out_ptr, out_cap, out.to_string().as_bytes())
}

/// Decrypt a 36-byte AE ciphertext with a raw 16-byte AE key. This lets the
/// browser independently verify the balance using only the signature-derived
/// AE key (e.g. to double-check the top-bar balance against `mode=balance`).
///   ae_decrypt_with_key(ae_ptr, ae_len, ct_ptr, ct_len, out_ptr, out_cap) -> i32
#[no_mangle]
pub extern "C" fn ae_decrypt_with_key(
    ae_ptr: *const u8,
    ae_len: usize,
    ct_ptr: *const u8,
    ct_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    if ae_ptr.is_null() || ae_len != 16 || ct_ptr.is_null() || ct_len != 36 {
        return -1;
    }
    let ae_bytes = unsafe { slice::from_raw_parts(ae_ptr, ae_len) };
    let ae = match AeKey::try_from(ae_bytes) {
        Ok(a) => a,
        Err(_) => return -1,
    };
    let ct_bytes = unsafe { slice::from_raw_parts(ct_ptr, ct_len) };
    let ct = match AeCiphertext::from_bytes(ct_bytes) {
        Some(c) => c,
        None => return -1,
    };
    let amount = match ae.decrypt(&ct) {
        Some(a) => a,
        None => return -1,
    };
    write_out(out_ptr, out_cap, amount.to_string().as_bytes())
}

/// Decrypt a 64-byte ElGamal ciphertext with a raw 32-byte canonical ElGamal
/// scalar secret (from `elgamal_secret_from_signature`). This mirrors the
/// server's mode=balance ElGamal decrypt path for pending balances, and lets
/// the browser compute `newDecryptable = cur + pending` for the apply flow
/// using only the wallet signature.
///   elgamal_decrypt_with_scalar(sec_ptr, 32, ct_ptr, 64, out_ptr, out_cap) -> i32
/// Returns the decrypted u64 amount as a decimal string.
#[no_mangle]
pub extern "C" fn elgamal_decrypt_with_scalar(
    sec_ptr: *const u8,
    sec_len: usize,
    ct_ptr: *const u8,
    ct_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    if sec_ptr.is_null() || sec_len != 32 || ct_ptr.is_null() || ct_len != 64 {
        return -1;
    }
    let scalar_bytes = unsafe { slice::from_raw_parts(sec_ptr, sec_len) };
    let arr: [u8; 32] = match scalar_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return -1,
    };
    let scalar = match Scalar::from_canonical_bytes(arr).into_option() {
        Some(s) => s,
        None => return -1,
    };
    let secret = ElGamalSecretKey::from(scalar);
    let ct_bytes = unsafe { slice::from_raw_parts(ct_ptr, ct_len) };
    let ct = match ElGamalCiphertext::from_bytes(ct_bytes) {
        Some(c) => c,
        None => return -1,
    };
    let amount = match secret.decrypt_u32(&ct) {
        Some(a) => a,
        None => return -1,
    };
    write_out(out_ptr, out_cap, amount.to_string().as_bytes())
}

/// Decrypt a 64-byte ElGamal ciphertext with a raw 32-byte canonical ElGamal
/// scalar secret, recovering amounts up to BSGS_MAX_AMOUNT (u64-range).
///
/// This is the fix for the cXNT mint (12 decimals, 102B raw supply): the
/// underlying `secret.decrypt_u32` only recovers amounts ≤ u32::MAX
/// (4,294,967,295 raw), so a 100+ cXNT balance (~1e11 raw) decrypts to None and
/// the old export returned -1. Here we decrypt to the DiscreteLog point and
/// run our own wider-range BSGS decode that handles up to 2^37 raw. The existing
/// `elgamal_decrypt_with_scalar` (decrypt_u32) is left untouched for the small
/// -balance paths that depend on its exact behavior.
///   elgamal_decrypt_with_scalar_u64(sec_ptr, 32, ct_ptr, 64, out_ptr, out_cap) -> i32
/// Returns the decrypted u64 amount as a decimal string.
#[no_mangle]
pub extern "C" fn elgamal_decrypt_with_scalar_u64(
    sec_ptr: *const u8,
    sec_len: usize,
    ct_ptr: *const u8,
    ct_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    if sec_ptr.is_null() || sec_len != 32 || ct_ptr.is_null() || ct_len != 64 {
        return -1;
    }
    let scalar_bytes = unsafe { slice::from_raw_parts(sec_ptr, sec_len) };
    let arr: [u8; 32] = match scalar_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return -1,
    };
    let scalar = match Scalar::from_canonical_bytes(arr).into_option() {
        Some(s) => s,
        None => return -1,
    };
    let secret = ElGamalSecretKey::from(scalar);
    let ct_bytes = unsafe { slice::from_raw_parts(ct_ptr, ct_len) };
    let ct = match ElGamalCiphertext::from_bytes(ct_bytes) {
        Some(c) => c,
        None => return -1,
    };
    // ElGamalCiphertext::decrypt -> DiscreteLog (a point on the curve).
    let dlog = ct.decrypt(&secret);
    let amount = match bsgs_decode_u64(&dlog.target) {
        Some(a) => a,
        None => return -1,
    };
    write_out(out_ptr, out_cap, amount.to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bsgs_roundtrip(amount: u64) {
        let target = Scalar::from(amount) * G;
        let got = bsgs_decode_u64(&target).expect("decode should find the amount");
        assert_eq!(got, amount, "bsgs decode mismatch for amount {amount}");
    }

    #[test]
    fn bsgs_decode_edge_cases() {
        bsgs_roundtrip(0);
        bsgs_roundtrip(1);
        bsgs_roundtrip(2);
        // just above a baby-step boundary
        bsgs_roundtrip(BSGS_BABY_STEPS + 7);
    }

    #[test]
    fn bsgs_decode_u32_boundary_and_above() {
        // exact u32::MAX works under the old decrypt_u32 too
        bsgs_roundtrip(u32::MAX as u64);
        // just above u32::MAX — the cXNT failing case (100+ cXNT = ~1e11 raw)
        bsgs_roundtrip((u32::MAX as u64) + 1);
        // realistic large cXNT balance: ~102 cXNT at 12 decimals = 1.02e11 raw
        bsgs_roundtrip(102_000_000_000u64);
        // near the BSGS bound
        bsgs_roundtrip(BSGS_MAX_AMOUNT);
    }

    #[test]
    fn elgamal_u64_decrypt_above_u32_max() {
        // Encrypt a > u32::MAX amount and verify the full export decrypts it back.
        let secret_scalar = Scalar::from(42u64);
        let secret = ElGamalSecretKey::from(secret_scalar);
        let public = ElGamalPubkey::new(&secret);
        let amount: u64 = 60_000_000_000u64; // > u32::MAX, realistic cXNT "100+"
        let ct = public.encrypt(amount);
        let sec_bytes: [u8; 32] = secret_scalar.to_bytes();
        let ct_bytes = ct.to_bytes();
        let mut out = [0u8; 64];
        let n = elgamal_decrypt_with_scalar_u64(
            sec_bytes.as_ptr(),
            sec_bytes.len(),
            ct_bytes.as_ptr(),
            ct_bytes.len(),
            out.as_mut_ptr(),
            out.len(),
        );
        assert!(n > 0, "elgamal_decrypt_with_scalar_u64 should succeed");
        let dec = String::from_utf8(out[..n as usize].to_vec()).unwrap();
        assert_eq!(dec, amount.to_string(), "decrypted string mismatch");
    }

    #[test]
    fn elgamal_u64_decrypt_small_and_zero() {
        let secret_scalar = Scalar::from(7u64);
        let secret = ElGamalSecretKey::from(secret_scalar);
        let public = ElGamalPubkey::new(&secret);
        for amount in [0u64, 1, 4_294_967_295, 1_000_000_000] {
            let ct = public.encrypt(amount);
            let sec_bytes: [u8; 32] = secret_scalar.to_bytes();
            let ct_bytes = ct.to_bytes();
            let mut out = [0u8; 64];
            let n = elgamal_decrypt_with_scalar_u64(
                sec_bytes.as_ptr(),
                sec_bytes.len(),
                ct_bytes.as_ptr(),
                ct_bytes.len(),
                out.as_mut_ptr(),
                out.len(),
            );
            assert!(n > 0, "decrypt failed for {amount}");
            let dec = String::from_utf8(out[..n as usize].to_vec()).unwrap();
            assert_eq!(dec, amount.to_string());
        }
    }

    // ---- regression tests: per-proof randomness -----------------------------

    fn transfer_proof_json(sig: &[u8; 64], avail: &[u8; 64], dec: &[u8; 36], amount: &str, dest: &[u8; 32]) -> serde_json::Value {
        let mut out = vec![0u8; 16384];
        let n = gen_transfer_proof_from_sig(
            sig.as_ptr(), sig.len(),
            avail.as_ptr(), avail.len(),
            dec.as_ptr(), dec.len(),
            amount.as_ptr(), amount.len(),
            dest.as_ptr(), dest.len(),
            out.as_mut_ptr(), out.len(),
        );
        assert!(n > 0, "gen_transfer_proof_from_sig failed with code {n}");
        serde_json::from_slice(&out[..n as usize]).expect("json")
    }

    fn b64_field(v: &serde_json::Value, key: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(v[key].as_str().expect("field"))
            .expect("base64")
    }

    /// Two transfers from the same account must NOT share Pedersen openings:
    /// with a reused opening, the difference of two amount commitments is
    /// (a1 - a2) * G and the amounts can be recovered from chain data.
    #[test]
    fn transfer_openings_are_fresh_per_proof() {
        let sig = [9u8; 64];
        let (ae_bytes, elg) = derive_keys_from_signature(&sig);
        let keypair = keypair_from_scalar32(&elg).expect("keypair");
        let aes = AeKey::try_from(&ae_bytes[..]).expect("ae key");
        let balance = 1_000_000u64;
        let avail = keypair.pubkey().encrypt(balance).to_bytes();
        let dec = aes.encrypt(balance).to_bytes();
        let dest: [u8; 32] = ElGamalKeypair::new_rand().pubkey().into();

        let a = transfer_proof_json(&sig, &avail, &dec, "10", &dest);
        let b = transfer_proof_json(&sig, &avail, &dec, "10", &dest);

        let (va, vb) = (b64_field(&a, "ciphertextValidity"), b64_field(&b, "ciphertextValidity"));
        let pa: &BatchedGroupedCiphertext3HandlesValidityProofData = bytemuck::from_bytes(&va);
        let pb: &BatchedGroupedCiphertext3HandlesValidityProofData = bytemuck::from_bytes(&vb);
        // Same amount, same keys — the amount ciphertexts must still differ.
        assert_ne!(
            bytemuck::bytes_of(&pa.context_data().grouped_ciphertext_lo),
            bytemuck::bytes_of(&pb.context_data().grouped_ciphertext_lo),
            "lo amount ciphertext repeated across proofs (opening reuse)"
        );
        assert_ne!(
            bytemuck::bytes_of(&pa.context_data().grouped_ciphertext_hi),
            bytemuck::bytes_of(&pb.context_data().grouped_ciphertext_hi),
            "hi amount ciphertext repeated across proofs (opening reuse)"
        );
        assert_ne!(b64_field(&a, "auditorLo"), b64_field(&b, "auditorLo"));

        // ...and every proof still verifies.
        for v in [&a, &b] {
            let val = b64_field(v, "ciphertextValidity");
            let val: &BatchedGroupedCiphertext3HandlesValidityProofData = bytemuck::from_bytes(&val);
            val.verify_proof().expect("validity proof verifies");
            let eq = b64_field(v, "equality");
            let eq: &CiphertextCommitmentEqualityProofData = bytemuck::from_bytes(&eq);
            eq.verify_proof().expect("equality proof verifies");
            let rp = b64_field(v, "range");
            let rp: &BatchedRangeProofU128Data = bytemuck::from_bytes(&rp);
            rp.verify_proof().expect("range proof verifies");
            assert_eq!(v["newAvailableBalance"], "999990");
        }
    }

    /// Encrypting the same balance twice must give different ciphertexts (random
    /// nonce) that both decrypt to the balance.
    #[test]
    fn ae_encrypt_is_randomised_and_roundtrips() {
        let key = [3u8; 16];
        let amount = b"123456789";
        let mut seen = Vec::new();
        for _ in 0..3 {
            let mut ct = [0u8; 64];
            let n = ae_encrypt(key.as_ptr(), key.len(), amount.as_ptr(), amount.len(), ct.as_mut_ptr(), ct.len());
            assert_eq!(n, 36, "ae_encrypt should return a 36-byte ciphertext");
            let mut out = [0u8; 64];
            let m = ae_decrypt_with_key(key.as_ptr(), key.len(), ct.as_ptr(), 36, out.as_mut_ptr(), out.len());
            assert!(m > 0, "ae_decrypt_with_key failed");
            assert_eq!(&out[..m as usize], amount);
            seen.push(ct[..36].to_vec());
        }
        assert_ne!(seen[0], seen[1]);
        assert_ne!(seen[1], seen[2]);
        assert_ne!(seen[0], seen[2]);
    }

    #[test]
    fn verify_amount_matches_only_the_real_balance() {
        let secret_scalar = Scalar::from(1234567u64);
        let secret = ElGamalSecretKey::from(secret_scalar);
        let public = ElGamalPubkey::new(&secret);
        let sec: [u8; 32] = secret_scalar.to_bytes();
        // far above the BSGS bound: verification cost does not depend on the amount
        for amount in [0u64, 1, 4_990_000, 5_000_000_000_000_000u64] {
            let ct = public.encrypt(amount).to_bytes();
            let check = |v: u64| {
                let a = v.to_string();
                elgamal_verify_amount(sec.as_ptr(), 32, ct.as_ptr(), 64, a.as_ptr(), a.len())
            };
            assert_eq!(check(amount), 1);
            assert_eq!(check(amount + 1), 0);
        }
        // wrap-only balances have an identity handle: commitment = amount*G
        let mut wrap_only = [0u8; 64];
        wrap_only[..32].copy_from_slice((Scalar::from(777u64) * G).compress().as_bytes());
        assert_eq!(elgamal_verify_amount(sec.as_ptr(), 32, wrap_only.as_ptr(), 64, "777".as_ptr(), 3), 1);
        assert_eq!(elgamal_verify_amount(sec.as_ptr(), 32, wrap_only.as_ptr(), 64, "778".as_ptr(), 3), 0);
    }

    /// A client may chain proofs before the earlier transactions land. The
    /// ciphertexts it predicts must be exactly what the chain will compute.
    #[test]
    fn predicted_ciphertexts_match_the_chain_arithmetic() {
        let sig = [5u8; 64];
        let (ae_bytes, elg) = derive_keys_from_signature(&sig);
        let keypair = keypair_from_scalar32(&elg).expect("keypair");
        let aes = AeKey::try_from(&ae_bytes[..]).expect("ae key");

        // apply: available + lo + hi * 2^16
        let avail = keypair.pubkey().encrypt(1_000u64);
        let lo = keypair.pubkey().encrypt(7u64);
        let hi = keypair.pubkey().encrypt(3u64);
        let (a, l, h) = (avail.to_bytes(), lo.to_bytes(), hi.to_bytes());
        let mut out = [0u8; 64];
        assert_eq!(elgamal_apply_pending(a.as_ptr(), 64, l.as_ptr(), 64, h.as_ptr(), 64, out.as_mut_ptr(), 64), 64);
        let applied = ElGamalCiphertext::from_bytes(&out).unwrap();
        assert_eq!(applied, avail + lo + hi * Scalar::from(1u64 << 16));
        let balance = 1_000u64 + 7 + (3u64 << 16);
        let total = balance.to_string();
        assert_eq!(elgamal_verify_amount(elg.as_ptr(), 32, out.as_ptr(), 64, total.as_ptr(), total.len()), 1);

        // transfer: the returned ciphertext is the new available balance, and a
        // withdraw proof built on it verifies
        let dec = aes.encrypt(balance).to_bytes();
        let dest: [u8; 32] = keypair.pubkey().into();
        let v = transfer_proof_json(&sig, &out, &dec, "1", &dest);
        let next = hex::decode(v["newAvailableCiphertext"].as_str().unwrap()).unwrap();
        let remain = (balance - 1).to_string();
        assert_eq!(v["newAvailableBalance"], remain.as_str());
        assert_eq!(elgamal_verify_amount(elg.as_ptr(), 32, next.as_ptr(), 64, remain.as_ptr(), remain.len()), 1);
        let mut wout = vec![0u8; 16384];
        let n = gen_withdraw_proof_from_sig(sig.as_ptr(), 64, next.as_ptr(), 64, remain.as_ptr(), remain.len(), "500".as_ptr(), 3, wout.as_mut_ptr(), wout.len());
        assert!(n > 0, "withdraw proof on the predicted ciphertext failed: {n}");
        let w: serde_json::Value = serde_json::from_slice(&wout[..n as usize]).unwrap();
        let eq = b64_field(&w, "equality");
        let eq: &CiphertextCommitmentEqualityProofData = bytemuck::from_bytes(&eq);
        eq.verify_proof().expect("equality proof on the predicted ciphertext verifies");
    }

    #[test]
    fn decrypt_near_recovers_large_balances_from_a_stale_hint() {
        let secret_scalar = Scalar::from(987_654_321u64);
        let public = ElGamalPubkey::new(&ElGamalSecretKey::from(secret_scalar));
        let sec: [u8; 32] = secret_scalar.to_bytes();
        let near = |amount: u64, hint: u64| -> Option<String> {
            let ct = public.encrypt(amount).to_bytes();
            let h = hint.to_string();
            let mut out = [0u8; 64];
            let n = elgamal_decrypt_near(sec.as_ptr(), 32, ct.as_ptr(), 64, h.as_ptr(), h.len(), out.as_mut_ptr(), 64);
            if n > 0 { Some(String::from_utf8(out[..n as usize].to_vec()).unwrap()) } else { None }
        };
        // far above the plain search bound; the hint is off by a late credit / debit
        let big = 5_000_000_000_000_000u64;
        assert_eq!(near(big, big).as_deref(), Some("5000000000000000"));
        assert_eq!(near(big + 123_456_789, big).as_deref(), Some("5000000123456789"));
        assert_eq!(near(big - 42, big).as_deref(), Some("4999999999999958"));
        assert_eq!(near(7, 0).as_deref(), Some("7"));
    }
}
