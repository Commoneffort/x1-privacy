//! proofgen51: generate zk proofs for confidential transfer/withdraw using
//! solana-zk-sdk 5.0.1 — the EXACT version agave 4.0.3 (X1 testnet validator)
//! embeds. This is the version-matched proof generator.
//!
//! Subcommands:
//!   echo <secret_hex> | proofgen51 pubkey
//!       -> 96-byte PubkeyValidityProofData (base64)
//!   proofgen51 transfer <secret_hex> <aes_hex> <avail_bal_hex> <decryptable_hex> <amount> <dest_pub_hex> [auditor_pub_hex]
//!       -> JSON: {equality, ciphertextValidity, range, auditorLo, auditorHi, newAvailableBalance}
//!   proofgen51 withdraw <secret_hex> <avail_bal_hex> <current_balance> <withdraw_amount>
//!       -> JSON: {equality, range, newAvailableBalance, amount}
//!   proofgen51 selftest
//!       -> generate + self-verify pubkey proof (sanity check)
//!
//! All proof bytes are base64. Ciphertext/pubkey hex are raw 32/64-byte forms.

use solana_zk_sdk::{
    encryption::{
        auth_encryption::{AeCiphertext, AeKey},
        elgamal::{ElGamal, ElGamalCiphertext, ElGamalKeypair, ElGamalPubkey, ElGamalSecretKey},
        grouped_elgamal::GroupedElGamal,
        pedersen::{Pedersen, PedersenOpening},
    },
    zk_elgamal_proof_program::proof_data::{
        pubkey_validity::PubkeyValidityProofData,
        BatchedGroupedCiphertext3HandlesValidityProofData, BatchedRangeProofU128Data,
        BatchedRangeProofU64Data, CiphertextCommitmentEqualityProofData, ZkProofData,
    },
};
use std::io::{self, Read};
use base64::Engine;
use curve25519_dalek::scalar::Scalar;

const TRANSFER_AMOUNT_LO_BITS: usize = 16;
const TRANSFER_AMOUNT_HI_BITS: usize = 32;
const REMAINING_BALANCE_BIT_LENGTH: usize = 64;
const RANGE_PROOF_PADDING_BIT_LENGTH: usize = 16;

fn read_stdin() -> String {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("read stdin");
    input.trim().to_string()
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    hex::decode(hex).expect("valid hex")
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: proofgen51 <pubkey|transfer|withdraw|selftest> ...");
        std::process::exit(1);
    }
    match args[1].as_str() {
        "pubkey" => {
            let secret_hex = read_stdin();
            let secret_bytes = hex_to_bytes(&secret_hex);
            assert_eq!(secret_bytes.len(), 32, "secret key must be 32 bytes");
            let secret = ElGamalSecretKey::try_from(secret_bytes.as_slice()).expect("valid secret");
            let keypair = ElGamalKeypair::new(secret);
            let proof = PubkeyValidityProofData::new(&keypair).expect("gen proof");
            let bytes = bytemuck::bytes_of(&proof);
            println!("{}", b64(bytes));
        }
        "transfer" => {
            // args: transfer <secret_hex> <aes_hex> <avail_bal_hex> <decryptable_hex> <amount> <dest_pub_hex> [auditor_pub_hex]
            if args.len() < 8 {
                eprintln!("usage: proofgen51 transfer <secret_hex> <aes_hex> <avail_bal_hex> <decryptable_hex> <amount> <dest_pub_hex> [auditor_pub_hex]");
                std::process::exit(1);
            }
            let secret = ElGamalSecretKey::try_from(hex_to_bytes(&args[2]).as_slice()).expect("secret");
            let keypair = ElGamalKeypair::new(secret);
            let aes = AeKey::try_from(hex_to_bytes(&args[3]).as_slice()).expect("aes");
            let avail_bal = ElGamalCiphertext::from_bytes(&hex_to_bytes(&args[4])).expect("avail bal");
            let decryptable = AeCiphertext::from_bytes(&hex_to_bytes(&args[5])).expect("decryptable");
            let amount: u64 = args[6].parse().expect("amount");
            let dest_pub = ElGamalPubkey::try_from(hex_to_bytes(&args[7]).as_slice()).expect("dest pub");
            let auditor_pub = if args.len() > 8 {
                Some(ElGamalPubkey::try_from(hex_to_bytes(&args[8]).as_slice()).expect("auditor pub"))
            } else {
                None
            };
            let default_auditor = ElGamalPubkey::default();
            let auditor = auditor_pub.as_ref().unwrap_or(&default_auditor);

            // Split amount into lo/hi
            let (amount_lo, amount_hi) = try_split_u64(amount, TRANSFER_AMOUNT_LO_BITS).expect("split");

            // Encrypt lo/hi as grouped 3-handle ciphertexts
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

            // Decrypt current available balance
            let current_decrypted = decryptable.decrypt(&aes).expect("decrypt current");
            let new_decrypted = current_decrypted.checked_sub(amount).expect("enough funds");

            // New Pedersen commitment for remaining balance
            let (new_balance_commitment, new_source_opening) = Pedersen::new(new_decrypted);

            // Compute remaining balance ciphertext homomorphically
            let transfer_amount_source_lo = grouped_lo.to_elgamal_ciphertext(0).expect("extract lo");
            let transfer_amount_source_hi = grouped_hi.to_elgamal_ciphertext(0).expect("extract hi");
            let new_balance_ciphertext = &avail_bal
                - &try_combine_lo_hi_ciphertexts(
                    &transfer_amount_source_lo,
                    &transfer_amount_source_hi,
                    TRANSFER_AMOUNT_LO_BITS,
                )
                .expect("combine");

            // Equality proof
            let equality_proof_data = CiphertextCommitmentEqualityProofData::new(
                &keypair,
                &new_balance_ciphertext,
                &new_balance_commitment,
                &new_source_opening,
                new_decrypted,
            )
            .expect("equality proof");

            // Ciphertext validity proof
            let ciphertext_validity_proof_data = BatchedGroupedCiphertext3HandlesValidityProofData::new(
                keypair.pubkey(),
                &dest_pub,
                auditor,
                &grouped_lo,
                &grouped_hi,
                amount_lo,
                amount_hi,
                &opening_lo,
                &opening_hi,
            )
            .expect("validity proof");

            // Extract auditor ciphertexts
            let auditor_lo = ciphertext_validity_proof_data
                .context_data()
                .grouped_ciphertext_lo
                .try_extract_ciphertext(2)
                .expect("auditor lo");
            let auditor_hi = ciphertext_validity_proof_data
                .context_data()
                .grouped_ciphertext_hi
                .try_extract_ciphertext(2)
                .expect("auditor hi");

            // Range proof
            let (padding_commitment, padding_opening) = Pedersen::new(0_u64);
            let range_proof_data = BatchedRangeProofU128Data::new(
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
            )
            .expect("range proof");

            let equality = bytemuck::bytes_of(&equality_proof_data);
            let validity = bytemuck::bytes_of(&ciphertext_validity_proof_data);
            let range = bytemuck::bytes_of(&range_proof_data);
            let out = serde_json::json!({
                "equality": b64(equality),
                "ciphertextValidity": b64(validity),
                "range": b64(range),
                "auditorLo": b64(bytemuck::bytes_of(&auditor_lo)),
                "auditorHi": b64(bytemuck::bytes_of(&auditor_hi)),
                "newAvailableBalance": new_decrypted.to_string(),
            });
            println!("{}", out);
        }
        "withdraw" => {
            // args: withdraw <secret_hex> <avail_bal_hex> <current_balance> <withdraw_amount>
            if args.len() < 6 {
                eprintln!("usage: proofgen51 withdraw <secret_hex> <avail_bal_hex> <current_balance> <withdraw_amount>");
                std::process::exit(1);
            }
            let secret = ElGamalSecretKey::try_from(hex_to_bytes(&args[2]).as_slice()).expect("secret");
            let keypair = ElGamalKeypair::new(secret);
            let avail_bal = ElGamalCiphertext::from_bytes(&hex_to_bytes(&args[3])).expect("avail bal");
            let current_balance: u64 = args[4].parse().expect("current balance");
            let withdraw_amount: u64 = args[5].parse().expect("withdraw amount");

            let remaining_balance = current_balance.checked_sub(withdraw_amount).expect("enough");
            let (remaining_commitment, remaining_opening) = Pedersen::new(remaining_balance);
            let remaining_ciphertext = &avail_bal - &ElGamal::encode(withdraw_amount);

            let equality_proof_data = CiphertextCommitmentEqualityProofData::new(
                &keypair,
                &remaining_ciphertext,
                &remaining_commitment,
                &remaining_opening,
                remaining_balance,
            )
            .expect("equality proof");

            let range_proof_data = BatchedRangeProofU64Data::new(
                vec![&remaining_commitment],
                vec![remaining_balance],
                vec![REMAINING_BALANCE_BIT_LENGTH],
                vec![&remaining_opening],
            )
            .expect("range proof");

            let equality = bytemuck::bytes_of(&equality_proof_data);
            let range = bytemuck::bytes_of(&range_proof_data);
            let out = serde_json::json!({
                "equality": b64(equality),
                "range": b64(range),
                "newAvailableBalance": remaining_balance.to_string(),
                "amount": withdraw_amount.to_string(),
            });
            println!("{}", out);
        }
        "selftest" => {
            let keypair = ElGamalKeypair::new_rand();
            let proof = PubkeyValidityProofData::new(&keypair).expect("gen proof");
            match proof.verify_proof() {
                Ok(()) => println!("SELF-VERIFY: OK"),
                Err(e) => println!("SELF-VERIFY: FAILED: {:?}", e),
            }
        }
        _ => {
            eprintln!("unknown subcommand: {}", args[1]);
            std::process::exit(1);
        }
    }
}
