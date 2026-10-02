use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program::{invoke, invoke_signed},
};


declare_id!("X1PRVwe2PgSYyWZH2hBtUqAxnpPtp6s14jAgZCu4iF1");

// ---------------------------------------------------------------------------
// X1 Confidential — production-grade confidential layer.
//
// v2 (REAL, not demo): value only enters against REAL backing under a
// GOVERNED, HARD-CAPPED mint. There is no self-minting, no thin air.
//
//   - Mint authority = a program PDA (never a user wallet).
//     `init_confidential_mint` verifies the authority is the conf-mint PDA,
//     so no single operator can print.
//   - `supply_cap` is recorded at genesis and can only ever be lowered. The
//     program enforces confidential_supply + minted <= supply_cap on every
//     deposit.
//   - `deposit` = wrap: transfer REAL backing from the user's normal account
//     into the program-owned RESERVE, then mint confidential tokens 1:1 (net
//     of the one-time protocol fee, up to cap).
//   - `withdraw` = unwrap: burn confidential tokens (burn-on-unwrap) and
//     return the same amount of backing from RESERVE to the user. No fee.
//   - RESERVE is a program-owned token account; the program releases backing
//     only when confidential supply decreases.
//
// Token programs are NEVER trusted from the caller: the confidential token
// program must be the program that owns the confidential mint, and the backing
// token program must be the program that owns the backing mint and the
// reserve. Every mint/burn CPI is additionally verified against the mint's
// on-chain supply.
// ---------------------------------------------------------------------------

const TI_CONF_EXT: u8 = 27;
const CT_DEPOSIT: u8 = 5;
const CT_TRANSFER: u8 = 7;

/// The native ZK ElGamal proof program; proof context-state accounts relayed
/// into a ConfidentialTransfer must be owned by it.
const ZK_ELGAMAL_PROOF_PROGRAM: Pubkey =
    pubkey!("ZkE1Gama1Proof11111111111111111111111111111");

/// token-2022 `ConfidentialTransfer` instruction data, proofs supplied through
/// context-state accounts:
///   [27, 7] + new_source_decryptable_available_balance(36)
///   + transfer_amount_auditor_ciphertext_lo(64) + _hi(64)
///   + equality / ciphertext-validity / range proof instruction offsets (3 x i8)
const CT_TRANSFER_DATA_LEN: usize = 2 + 36 + 64 + 64 + 3;
/// Accounts of that instruction when all three proof offsets are 0:
///   [source(w), mint, dest(w), eq_ctx, validity_ctx, range_ctx, authority(signer)]
const CT_TRANSFER_ACCOUNTS: usize = 7;

/// Confidential swaps are EXPERIMENTAL and disabled unless the program is built
/// with `--features experimental-swaps`. The escrow design cannot bind the
/// plaintext amount of either leg on-chain, and the taker leg is not enforced
/// by this program, so it is not safe for real value. See
/// `design/CONFIDENTIAL_SWAPS_OPTIONS.md`.
const SWAPS_ENABLED: bool = cfg!(feature = "experimental-swaps");

// ---------------------------------------------------------------------------
// Protocol fee — 0.39% (39 basis points), charged ONCE, on wrap (deposit).
// Unwrap (withdraw) is free, and plain peer-to-peer confidential transfers
// carry no fee either (a `ConfidentialTransfer` is a direct token-2022 call
// with no program in the middle).
//
// Why the fee is on the way IN only: the exit path then depends on nothing but
// the reserve and the caller's own accounts. No fee account is touched on
// unwrap, so no state of a fee account can ever stand between a holder and
// their backing, and a recipient who was paid in confidential tokens can always
// redeem them 1:1.
//
// The fee is paid in the backing token and the backing==supply invariant is
// preserved: deposit forwards the fee out of the reserve and mints the net.
//
// Fee recipient (owner): GACCq8Yd4szdB7mCcaViFNwDEej4crZe43YoSPCzmb8M
// The destination must be that owner's ASSOCIATED TOKEN ACCOUNT (ATA) for the
// backing token, derived on-chain (find_program_address) — so the fee can
// never be redirected to an arbitrary or attacker-controlled wallet. Fees land
// in the recipient's PUBLIC ATA balance (auditable).
// ---------------------------------------------------------------------------
const WRAP_FEE_BPS: u64 = 39; // 0.39% = 39/10_000

/// Wrap fee in raw base units for `amount`, rounded down. A fee that rounds to
/// 0 is allowed (dust moves are fee-free rather than reverting).
fn fee_on(amount: u64) -> Result<u64> {
    Ok(amount.checked_mul(WRAP_FEE_BPS).ok_or(CError::Overflow)? / 10_000)
}

/// The fixed protocol fee recipient (owner of the fee ATAs).
pub fn fee_recipient() -> Pubkey {
    Pubkey::new_from_array([
        0xe1, 0x3a, 0x33, 0x14, 0xe9, 0x3c, 0x6a, 0x03, 0x7e, 0x10, 0xbf, 0x1b,
        0x1a, 0x0b, 0x8c, 0xb3, 0x88, 0x12, 0x5d, 0x19, 0xce, 0x3d, 0x87, 0xf8,
        0xc7, 0x34, 0x00, 0x50, 0xd7, 0xf1, 0x09, 0xc2,
    ])
}

/// Assert `account` is the fee recipient's ASSOCIATED TOKEN ACCOUNT for `mint`,
/// under `token_program`. This makes the fee destination un-spoofable.
fn require_fee_ata(account: &AccountInfo, mint: &Pubkey, token_program: &Pubkey) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(
        &[fee_recipient().as_ref(), token_program.as_ref(), mint.as_ref()],
        &anchor_spl::associated_token::ID,
    );
    require_keys_eq!(*account.key, expected, CError::FeeDestinationMismatch);
    Ok(())
}

/// A private swap order. The maker's confidential tokens are locked in a
/// PROGRAM-OWNED escrow token account (owner = conf-mint PDA) so the program
/// can release them confidentially via invoke_signed. The order stores ONLY
/// ciphertexts/commitments — no plaintext amounts ever hit the chain.
#[account]
pub struct Swap {
    pub maker: Pubkey,
    pub taker: Pubkey,       // zero until locked
    pub mint: Pubkey,         // confidential mint being traded
    pub maker_escrow: Pubkey, // program-owned token account holding maker's locked tokens
    pub maker_amount_ciphertext_lo: [u8; 64], // ElGamal commitment of maker leg
    pub maker_amount_ciphertext_hi: [u8; 64],
    pub taker_amount_ciphertext_lo: [u8; 64],
    pub taker_amount_ciphertext_hi: [u8; 64],
    pub status: u8,           // 0 open, 1 locked, 2 settled, 3 cancelled
    pub seed: [u8; 32],
    pub bump: u8,
}
impl Swap {
    pub const INIT_SPACE: usize = 32 + 32 + 32 + 32 + (64 * 4) + 1 + 32 + 1;
}
#[repr(u8)]
pub enum SwapStatus { Open = 0, Locked = 1, Settled = 2, Cancelled = 3 }

/// Per-mint confidential config + governance.
/// Mint authority is the conf-mint PDA; supply_cap can only be lowered.
#[account]
pub struct ConfidentialMintConfig {
    pub mint: Pubkey,          // the confidential token-2022 mint
    pub backing_mint: Pubkey,  // the REAL token this wraps (e.g. XNT)
    pub reserve: Pubkey,        // program-owned TokenAccount holding backing
    pub authority: Pubkey,      // governance authority (set at init); only it may lower the cap
    pub supply_cap: u64,        // hard cap (raw units), lower-only
    pub confidential_supply: u64, // current minted, outstanding
    pub bump: u8,
}
impl ConfidentialMintConfig {
    // 32*4 (mint/backing_mint/reserve/authority) + 8 + 8 + 1
    pub const INIT_SPACE: usize = (32 * 4) + 8 + 8 + 1;
}

/// Vault keyed by (owner, mint) — coarse audit accounting + nonce.
#[account]
pub struct Vault {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub total_confidential: u64,
    pub nonce: u64,
    pub bump: u8,
}
impl Vault {
    pub const INIT_SPACE: usize = 32 + 32 + 8 + 8 + 1;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitConfidentialMint<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + ConfidentialMintConfig::INIT_SPACE,
        seeds = [b"conf-mint", mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, ConfidentialMintConfig>,
    /// CHECK: token-2022 confidential mint (authority = conf-mint PDA; verified in the handler).
    pub mint: AccountInfo<'info>,
    /// CHECK: the REAL backing mint (XNT / whatever this wraps; verified in the handler).
    pub backing_mint: AccountInfo<'info>,
    /// Program-owned reserve account holding the backing token.
    /// CHECK: backing token account owned by the conf-mint PDA (verified in the handler).
    pub reserve: AccountInfo<'info>,
    /// Must be the program's upgrade authority — registering a confidential
    /// mint is a governance action, not a first-come-first-served one.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key()) @ CError::NotUpgradeAuthority
    )]
    pub program: Program<'info, crate::program::X1Confidential>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(payer.key()) @ CError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
    /// CHECK: the token program that owns the confidential mint (verified in the handler).
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct SetCap<'info> {
    #[account(mut, has_one = mint, has_one = authority, seeds = [b"conf-mint", mint.key().as_ref()], bump)]
    pub config: Account<'info, ConfidentialMintConfig>,
    /// CHECK: token-2022 confidential mint.
    pub mint: AccountInfo<'info>,
    /// Governance signer — enforced by `has_one = authority` to equal the stored
    /// `config.authority` recorded at `init_confidential_mint`. No unprivileged
    /// wallet can lower the cap (governance DoS closed).
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateVault<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", owner.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: token-2022 mint.
    pub mint: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Wrap: transfer REAL backing into RESERVE + mint confidential tokens 1:1.
/// Accounts mirror the token-2022 `Deposit` CPI the program relays.
#[derive(Accounts)]
pub struct ConfidentialDeposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"conf-mint", mint.key().as_ref()],
        bump,
        has_one = backing_mint,
        has_one = reserve
    )]
    pub config: Account<'info, ConfidentialMintConfig>,
    /// CHECK: token-2022 confidential mint.
    #[account(mut)]
    pub mint: AccountInfo<'info>,
    /// The REAL backing mint (e.g. XNT).
    /// CHECK: token account.
    pub backing_mint: AccountInfo<'info>,
    /// The user's token-2022 confidential account on this mint (receives the mint).
    /// CHECK: raw token-2022 account.
    #[account(mut)]
    pub user_conf: AccountInfo<'info>,
    /// User's normal backing-token ATA paying the real deposit.
    /// CHECK: raw token-2022 account.
    #[account(mut)]
    pub backing_source: AccountInfo<'info>,
    /// Program-owned reserve receiving backing.
    /// CHECK: raw token-2022 account.
    #[account(mut)]
    pub reserve: AccountInfo<'info>,
    /// Fee recipient's ASSOCIATED TOKEN ACCOUNT for the backing mint (fee destination).
    /// CHECK: token-2022 ATA of the fixed fee recipient (checked in the handler).
    #[account(mut)]
    pub fee_account: AccountInfo<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// The confidential token-2022 program (zk-ops build) to CPI into.
    /// CHECK: must be the program that owns `mint` (checked in the handler).
    pub conf_token_program: AccountInfo<'info>,
    /// The REAL backing token program (e.g. Tokenkeg for XNT).
    /// CHECK: must be the program that owns `backing_mint` (checked in the handler).
    pub backing_token_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

/// Unwrap: burn confidential tokens + return backing from RESERVE. No fee, and
/// no account other than the reserve and the caller's own.
#[derive(Accounts)]
pub struct ConfidentialWithdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"conf-mint", mint.key().as_ref()],
        bump,
        has_one = backing_mint,
        has_one = reserve
    )]
    pub config: Account<'info, ConfidentialMintConfig>,
    /// CHECK: token-2022 confidential mint.
    #[account(mut)]
    pub mint: AccountInfo<'info>,
    /// The REAL backing mint (e.g. XNT).
    /// CHECK: token account.
    pub backing_mint: AccountInfo<'info>,
    /// The user's token-2022 confidential account (burned from).
    /// CHECK: raw token-2022 account.
    #[account(mut)]
    pub user_conf: AccountInfo<'info>,
    /// User's normal backing-token ATA receiving the returned value.
    /// CHECK: raw token-2022 account.
    #[account(mut)]
    pub backing_dest: AccountInfo<'info>,
    /// The program-owned reserve releasing backing.
    /// CHECK: raw token-2022 account.
    #[account(mut)]
    pub reserve: AccountInfo<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// The confidential token-2022 program (zk-ops build) to CPI into.
    /// CHECK: must be the program that owns `mint` (checked in the handler).
    pub conf_token_program: AccountInfo<'info>,
    /// The REAL backing token program (e.g. Tokenkeg for XNT).
    /// CHECK: must be the program that owns `backing_mint` (checked in the handler).
    pub backing_token_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Raw token-layout readers. These work on plain byte slices so they can be
// unit-tested on the host; the AccountInfo wrappers below only borrow the data.
//
//   Mint:    mint_authority COption<Pubkey> (0..36) supply u64 (36..44)
//            decimals u8 (44) is_initialized (45) freeze_authority COption (46..82)
//   Account: mint (0..32) owner (32..64) amount u64 (64..72) ...
// ---------------------------------------------------------------------------
const MINT_BASE_LEN: usize = 82;
const ACCOUNT_BASE_LEN: usize = 165;

fn read_pubkey(d: &[u8], at: usize) -> Option<Pubkey> {
    let bytes: [u8; 32] = d.get(at..at + 32)?.try_into().ok()?;
    Some(Pubkey::new_from_array(bytes))
}

fn read_u64(d: &[u8], at: usize) -> Option<u64> {
    let bytes: [u8; 8] = d.get(at..at + 8)?.try_into().ok()?;
    Some(u64::from_le_bytes(bytes))
}

fn read_coption_tag(d: &[u8], at: usize) -> Option<u32> {
    let bytes: [u8; 4] = d.get(at..at + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(bytes))
}

/// `Some(authority)` if the mint has a mint authority, `None` otherwise.
fn mint_authority_from(d: &[u8]) -> Option<Pubkey> {
    if d.len() < MINT_BASE_LEN || read_coption_tag(d, 0)? != 1 {
        return None;
    }
    read_pubkey(d, 4)
}

fn mint_supply_from(d: &[u8]) -> Option<u64> {
    if d.len() < MINT_BASE_LEN {
        return None;
    }
    read_u64(d, 36)
}

fn mint_decimals_from(d: &[u8]) -> Option<u8> {
    if d.len() < MINT_BASE_LEN {
        return None;
    }
    d.get(44).copied()
}

fn mint_has_freeze_authority_from(d: &[u8]) -> Option<bool> {
    if d.len() < MINT_BASE_LEN {
        return None;
    }
    Some(read_coption_tag(d, 46)? != 0)
}

fn token_account_mint_from(d: &[u8]) -> Option<Pubkey> {
    if d.len() < ACCOUNT_BASE_LEN {
        return None;
    }
    read_pubkey(d, 0)
}

fn token_account_owner_from(d: &[u8]) -> Option<Pubkey> {
    if d.len() < ACCOUNT_BASE_LEN {
        return None;
    }
    read_pubkey(d, 32)
}

fn token_account_amount_from(d: &[u8]) -> Option<u64> {
    if d.len() < ACCOUNT_BASE_LEN {
        return None;
    }
    read_u64(d, 64)
}

/// True if `info` is a token account whose token OWNER field equals `owner`.
/// The caller must separately assert which token program owns `info`.
fn is_token_account_owner(info: &AccountInfo, owner: &Pubkey) -> bool {
    token_account_owner_from(&info.data.borrow()) == Some(*owner)
}

/// True if `info` is a token account for `mint`.
fn is_token_account_for_mint(info: &AccountInfo, mint: &Pubkey) -> bool {
    token_account_mint_from(&info.data.borrow()) == Some(*mint)
}

/// Assert an AccountInfo is owned by the given program.
fn is_owned_by(info: &AccountInfo, program: &Pubkey) -> bool {
    info.owner == program
}

fn mint_supply(info: &AccountInfo) -> Result<u64> {
    mint_supply_from(&info.data.borrow()).ok_or_else(|| error!(CError::InvalidTokenAccount))
}

fn mint_decimals(info: &AccountInfo) -> Result<u8> {
    mint_decimals_from(&info.data.borrow()).ok_or_else(|| error!(CError::InvalidTokenAccount))
}

fn token_account_amount(info: &AccountInfo) -> Result<u64> {
    token_account_amount_from(&info.data.borrow()).ok_or_else(|| error!(CError::InvalidTokenAccount))
}

/// The confidential token program is whatever program OWNS the confidential
/// mint — never a caller-chosen program. Without this, a caller could point the
/// Mint/Burn CPIs at a program that does nothing and still move the reserve.
fn require_conf_token_program(mint: &AccountInfo, conf_token_program: &AccountInfo) -> Result<()> {
    require!(conf_token_program.executable, CError::TokenProgramMismatch);
    require_keys_eq!(*mint.owner, *conf_token_program.key, CError::TokenProgramMismatch);
    Ok(())
}

/// The backing token program is whatever program OWNS the backing mint.
fn require_backing_token_program(
    backing_mint: &AccountInfo,
    backing_token_program: &AccountInfo,
) -> Result<()> {
    require!(backing_token_program.executable, CError::TokenProgramMismatch);
    require_keys_eq!(*backing_mint.owner, *backing_token_program.key, CError::TokenProgramMismatch);
    Ok(())
}

/// After any wrap/unwrap the reserve must still cover every outstanding
/// confidential token.
fn require_reserve_covers_supply(reserve: &AccountInfo, confidential_supply: u64) -> Result<()> {
    require!(
        token_account_amount(reserve)? >= confidential_supply,
        CError::ReserveInvariantViolated
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Confidential-transfer relay (swap escrow legs only).
//
// The zk proofs for a ConfidentialTransfer can only be produced client-side,
// so the client supplies the instruction's opaque payload (the new decryptable
// balance + auditor ciphertexts). Everything else is fixed by the program:
//   * the target program is the confidential mint's owner — never caller-chosen;
//   * the payload must be exactly a `ConfidentialTransfer` (27, 7) of the
//     expected length with all proof offsets 0, so the PDA signature can never
//     be used for any other instruction;
//   * the accounts must be exactly [source, mint, dest, eq_ctx, validity_ctx,
//     range_ctx, authority] with source/mint/dest/authority equal to the
//     accounts the program validated, and the proof contexts owned by the ZK
//     ElGamal proof program.
// ---------------------------------------------------------------------------

/// True if `data` is a context-state-proof `ConfidentialTransfer` payload.
fn is_conf_transfer_data(data: &[u8]) -> bool {
    data.len() == CT_TRANSFER_DATA_LEN
        && data[0] == TI_CONF_EXT
        && data[1] == CT_TRANSFER
        && data[CT_TRANSFER_DATA_LEN - 3..] == [0u8, 0u8, 0u8]
}

fn relay_confidential_transfer<'info>(
    token_program: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    data: Vec<u8>,
    source: &Pubkey,
    dest: &Pubkey,
    authority: &Pubkey,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<()> {
    require_conf_token_program(mint, token_program)?;
    require!(accounts.len() == CT_TRANSFER_ACCOUNTS, CError::MissingCpiAccounts);
    require!(is_conf_transfer_data(&data), CError::InvalidRelayInstruction);

    require_keys_eq!(*accounts[0].key, *source, CError::InvalidRelayInstruction);
    require_keys_eq!(*accounts[1].key, *mint.key, CError::InvalidRelayInstruction);
    require_keys_eq!(*accounts[2].key, *dest, CError::InvalidRelayInstruction);
    require_keys_eq!(*accounts[6].key, *authority, CError::InvalidRelayInstruction);
    require_keys_neq!(*source, *dest, CError::InvalidRelayInstruction);
    for ctx_account in &accounts[3..6] {
        require!(
            is_owned_by(ctx_account, &ZK_ELGAMAL_PROOF_PROGRAM),
            CError::InvalidRelayInstruction
        );
    }
    for token_account in [&accounts[0], &accounts[2]] {
        require!(
            is_owned_by(token_account, token_program.key)
                && is_token_account_for_mint(token_account, mint.key),
            CError::InvalidTokenAccount
        );
    }

    let cpi_ix = SolanaInstruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*accounts[0].key, false),
            AccountMeta::new_readonly(*accounts[1].key, false),
            AccountMeta::new(*accounts[2].key, false),
            AccountMeta::new_readonly(*accounts[3].key, false),
            AccountMeta::new_readonly(*accounts[4].key, false),
            AccountMeta::new_readonly(*accounts[5].key, false),
            AccountMeta::new_readonly(*accounts[6].key, true),
        ],
        data,
    };
    let infos: Vec<AccountInfo> = accounts.to_vec();
    match signer_seeds {
        Some(seeds) => invoke_signed(&cpi_ix, &infos, seeds),
        None => invoke(&cpi_ix, &infos),
    }?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Swap accounts (experimental — see SWAPS_ENABLED)
// ---------------------------------------------------------------------------

/// Open a confidential swap: lock maker's confidential tokens into a
/// PROGRAM-OWNED escrow (owned by the conf-mint PDA). Only ciphertexts of the
/// offered/exchanged amounts are recorded — never plaintext.
#[derive(Accounts)]
#[instruction(seed: [u8; 32], maker_amount_ciphertext_lo: [u8;64], maker_amount_ciphertext_hi: [u8;64], taker_amount_ciphertext_lo: [u8;64], taker_amount_ciphertext_hi: [u8;64])]
pub struct OpenSwap<'info> {
    #[account(
        init,
        payer = maker,
        space = 8 + Swap::INIT_SPACE,
        seeds = [b"swap", maker.key().as_ref(), mint.key().as_ref(), seed.as_ref()],
        bump
    )]
    pub swap: Account<'info, Swap>,
    #[account(
        mut,
        seeds = [b"conf-mint", mint.key().as_ref()],
        bump,
        has_one = mint
    )]
    pub config: Account<'info, ConfidentialMintConfig>,
    /// CHECK: confidential mint.
    pub mint: AccountInfo<'info>,
    /// Maker's confidential token account (source of the locked tokens).
    /// CHECK: token-2022 account, owner must sign the transfer into escrow.
    #[account(mut)]
    pub maker_source: AccountInfo<'info>,
    /// Program-owned escrow token account receiving the locked confidential
    /// tokens (owner = conf-mint PDA).
    /// CHECK: token-2022 account (verified in the handler).
    #[account(mut)]
    pub escrow: AccountInfo<'info>,
    #[account(mut)]
    pub maker: Signer<'info>,
    /// CHECK: must be the program that owns `mint` (checked in the handler).
    pub conf_token_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

/// Settle a confidential swap by relaying the maker-leg (escrow -> taker_dest)
/// and the fee-leg (escrow -> fee account) with authority = the conf-mint PDA.
#[derive(Accounts)]
pub struct SettleSwap<'info> {
    #[account(
        mut,
        seeds = [b"swap", swap.maker.as_ref(), mint.key().as_ref(), swap.seed.as_ref()],
        bump,
        constraint = swap.maker_escrow == escrow.key(),
        constraint = swap.mint == mint.key()
    )]
    pub swap: Account<'info, Swap>,
    #[account(
        mut,
        seeds = [b"conf-mint", mint.key().as_ref()],
        bump,
        has_one = mint
    )]
    pub config: Account<'info, ConfidentialMintConfig>,
    /// CHECK: confidential mint.
    pub mint: AccountInfo<'info>,
    /// The program-owned escrow (maker's locked tokens).
    /// CHECK: token-2022 account, owner = conf-mint PDA.
    #[account(mut)]
    pub escrow: AccountInfo<'info>,
    /// Taker's confidential account (receives the escrow leg).
    /// CHECK: token-2022 account (verified in the handler).
    #[account(mut)]
    pub taker_dest: AccountInfo<'info>,
    #[account(mut)]
    pub taker: Signer<'info>,
    /// Fee recipient's ATA for the confidential mint (fee leg destination).
    /// CHECK: token-2022 ATA of the fixed fee recipient (checked in the handler).
    #[account(mut)]
    pub fee_escrow: AccountInfo<'info>,
    /// CHECK: must be the program that owns `mint` (checked in the handler).
    pub conf_token_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

/// Cancel an open swap: release the maker's locked confidential tokens from the
/// escrow back to the maker. Only before the swap is locked.
#[derive(Accounts)]
pub struct CancelSwap<'info> {
    #[account(
        mut,
        has_one = maker,
        seeds = [b"swap", maker.key().as_ref(), mint.key().as_ref(), swap.seed.as_ref()],
        bump,
        constraint = swap.maker_escrow == escrow.key(),
        constraint = swap.mint == mint.key()
    )]
    pub swap: Account<'info, Swap>,
    #[account(
        mut,
        seeds = [b"conf-mint", mint.key().as_ref()],
        bump,
        has_one = mint
    )]
    pub config: Account<'info, ConfidentialMintConfig>,
    /// CHECK: confidential mint.
    pub mint: AccountInfo<'info>,
    /// Program-owned escrow holding maker's locked tokens.
    /// CHECK: token-2022 account, owner = conf-mint PDA.
    #[account(mut)]
    pub escrow: AccountInfo<'info>,
    /// Maker's confidential account receiving them back.
    /// CHECK: token-2022 account (verified in the handler).
    #[account(mut)]
    pub maker_dest: AccountInfo<'info>,
    #[account(mut)]
    pub maker: Signer<'info>,
    /// CHECK: must be the program that owns `mint` (checked in the handler).
    pub conf_token_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

#[program]
pub mod x1_confidential {
    use super::*;

    /// Register a confidential mint under this program. Only the program's
    /// upgrade authority may do this (enforced by the `program_data`
    /// constraint), and it becomes the cap governance authority.
    ///
    /// The confidential mint MUST have the conf-mint PDA as its mint authority,
    /// no freeze authority, zero supply, and the same decimals as the backing
    /// mint (tokens are minted 1:1 in raw units, so differing decimals would
    /// misprice the wrapped token in every wallet and explorer). The reserve
    /// MUST be a backing-mint token account owned by the conf-mint PDA.
    pub fn init_confidential_mint(
        ctx: Context<InitConfidentialMint>,
        supply_cap: u64,
    ) -> Result<()> {
        require!(supply_cap > 0, CError::InvalidCap);
        let config_key = ctx.accounts.config.key();
        let mint = &ctx.accounts.mint;
        let backing_mint = &ctx.accounts.backing_mint;
        let reserve = &ctx.accounts.reserve;

        require_keys_neq!(*mint.key, *backing_mint.key, CError::InvalidTokenAccount);
        require_conf_token_program(mint, &ctx.accounts.token_program)?;

        // Confidential mint: frozen to the conf-mint PDA, unfreezable, empty.
        {
            let d = mint.data.borrow();
            require!(
                mint_authority_from(&d) == Some(config_key),
                CError::MintAuthorityNotPda
            );
            require!(
                mint_has_freeze_authority_from(&d) == Some(false),
                CError::FreezeAuthorityPresent
            );
            require!(mint_supply_from(&d) == Some(0), CError::MintSupplyNotZero);
        }
        require!(
            mint_decimals(mint)? == mint_decimals(backing_mint)?,
            CError::DecimalsMismatch
        );

        // Reserve: a token account of the backing mint, under the backing
        // mint's own token program, owned by the conf-mint PDA.
        require!(
            is_owned_by(reserve, backing_mint.owner),
            CError::InvalidTokenAccount
        );
        require!(
            is_token_account_for_mint(reserve, backing_mint.key),
            CError::ReserveNotProgramOwned
        );
        require!(
            is_token_account_owner(reserve, &config_key),
            CError::ReserveNotProgramOwned
        );

        let cfg = &mut ctx.accounts.config;
        cfg.mint = mint.key();
        cfg.backing_mint = backing_mint.key();
        cfg.reserve = reserve.key();
        cfg.authority = ctx.accounts.payer.key(); // governance authority recorded at genesis
        cfg.supply_cap = supply_cap;
        cfg.confidential_supply = 0; // invariant: minted-outstanding starts at zero at genesis
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    /// Governance can only ever LOWER the cap. It can never raise it, and it
    /// can never set it to zero or below the supply already outstanding.
    pub fn set_cap(ctx: Context<SetCap>, new_cap: u64) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require!(new_cap > 0, CError::InvalidCap);
        require!(new_cap <= cfg.supply_cap, CError::CapCantIncrease);
        require!(new_cap >= cfg.confidential_supply, CError::CapBelowSupply);
        cfg.supply_cap = new_cap;
        Ok(())
    }

    pub fn create_vault(ctx: Context<CreateVault>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.owner = ctx.accounts.owner.key();
        v.mint = ctx.accounts.mint.key();
        v.total_confidential = 0;
        v.nonce = 0;
        v.bump = ctx.bumps.vault;
        Ok(())
    }

    /// Wrap: transfer real backing into RESERVE, then mint confidential 1:1.
    /// Steps (all inside one transaction):
    ///   1. backing token Transfer from user ATA -> RESERVE (user signs).
    ///   2. forward the 0.39% fee from RESERVE to the fee recipient's ATA.
    ///   3. MintTo net to the user's confidential account (conf-mint PDA signs),
    ///      verified against the mint's on-chain supply.
    ///   4. relay token-2022 confidential `Deposit` so the minted amount becomes
    ///      an encrypted pending balance.
    ///   5. enforce confidential_supply + net <= supply_cap.
    /// No confidential token is ever created without a real backing transfer.
    pub fn confidential_deposit(ctx: Context<ConfidentialDeposit>, amount: u64) -> Result<()> {
        require!(amount > 0, CError::ZeroAmount);

        // Token programs are derived from the mints, never trusted from the caller.
        require_conf_token_program(&ctx.accounts.mint, &ctx.accounts.conf_token_program)?;
        require_backing_token_program(&ctx.accounts.backing_mint, &ctx.accounts.backing_token_program)?;

        // Guard the fee destination + backing accounts.
        require_fee_ata(&ctx.accounts.fee_account, &ctx.accounts.backing_mint.key(), ctx.accounts.backing_token_program.key)?;
        require!(
            is_owned_by(&ctx.accounts.backing_source, ctx.accounts.backing_token_program.key)
                && is_owned_by(&ctx.accounts.reserve, ctx.accounts.backing_token_program.key)
                && is_owned_by(&ctx.accounts.fee_account, ctx.accounts.backing_token_program.key)
                && is_owned_by(&ctx.accounts.user_conf, ctx.accounts.conf_token_program.key),
            CError::InvalidTokenAccount
        );

        // 0.39% protocol fee (rounded down); user is credited net = amount - fee.
        let fee = fee_on(amount)?;
        let net = amount.checked_sub(fee).ok_or(CError::Overflow)?;
        let reserve_before = token_account_amount(&ctx.accounts.reserve)?;

        // (1) move REAL backing into the reserve (token Transfer CPI, user signs)
        //    Transfer data = [3] + amount(u64 LE); accounts [from(w), to(w), owner(signer)]
        let mut tdata = Vec::with_capacity(9);
        tdata.push(3u8); // token instruction Transfer
        tdata.extend_from_slice(&amount.to_le_bytes());
        let tix = SolanaInstruction {
            program_id: ctx.accounts.backing_token_program.key(),
            accounts: vec![
                AccountMeta::new(ctx.accounts.backing_source.key(), false),
                AccountMeta::new(ctx.accounts.reserve.key(), false),
                AccountMeta::new_readonly(ctx.accounts.owner.key(), true),
            ],
            data: tdata,
        };
        invoke(
            &tix,
            &[
                ctx.accounts.backing_source.to_account_info(),
                ctx.accounts.reserve.to_account_info(),
                ctx.accounts.owner.to_account_info(),
            ],
        )?;
        // The reserve must really have received `amount` (rejects fee-on-transfer
        // style backing tokens and any no-op transfer).
        require!(
            token_account_amount(&ctx.accounts.reserve)?
                == reserve_before.checked_add(amount).ok_or(CError::Overflow)?,
            CError::ReserveInvariantViolated
        );

        // (2) 0.39% fee: reserve -> fee recipient's ATA (conf-mint PDA signs). The
        // destination is pinned by `require_fee_ata`, so the fee can never be
        // redirected. The reserve keeps exactly `net`, matching what is minted.
        let bump = ctx.bumps.config;
        if fee > 0 {
            let mut fdata = Vec::with_capacity(9);
            fdata.push(3u8);
            fdata.extend_from_slice(&fee.to_le_bytes());
            let fix = SolanaInstruction {
                program_id: ctx.accounts.backing_token_program.key(),
                accounts: vec![
                    AccountMeta::new(ctx.accounts.reserve.key(), false),
                    AccountMeta::new(ctx.accounts.fee_account.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.config.key(), true),
                ],
                data: fdata,
            };
            invoke_signed(
                &fix,
                &[
                    ctx.accounts.reserve.to_account_info(),
                    ctx.accounts.fee_account.to_account_info(),
                    ctx.accounts.config.to_account_info(),
                ],
                &[&[b"conf-mint", ctx.accounts.mint.key().as_ref(), &[bump]]],
            )?;
        }

        // (3) the conf-mint PDA (mint authority) mints confidential tokens to the user's conf account.
        // token-2022 MintTo: instruction index 7, data = amount(u64 LE) only.
        let supply_before = mint_supply(&ctx.accounts.mint)?;
        let mut mint_data = Vec::with_capacity(9);
        mint_data.push(7u8); // token::instruction::MintTo
        mint_data.extend_from_slice(&net.to_le_bytes());
        let mint_ix = SolanaInstruction {
            program_id: ctx.accounts.conf_token_program.key(),
            accounts: vec![
                AccountMeta::new(ctx.accounts.mint.key(), false),
                AccountMeta::new(ctx.accounts.user_conf.key(), false),
                AccountMeta::new_readonly(ctx.accounts.config.key(), true), // mint authority (conf-mint PDA)
            ],
            data: mint_data,
        };
        invoke_signed(
            &mint_ix,
            &[
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.user_conf.to_account_info(),
                ctx.accounts.config.to_account_info(),
            ],
            &[&[b"conf-mint", ctx.accounts.mint.key().as_ref(), &[bump]]],
        )?;
        require!(
            mint_supply(&ctx.accounts.mint)?
                == supply_before.checked_add(net).ok_or(CError::Overflow)?,
            CError::MintNotVerified
        );

        // (4) relay token-2022 Confidential Deposit CPI — the USER (account owner) signs.
        // Converts the newly-minted public balance into an encrypted pending balance.
        let mut data = Vec::with_capacity(11);
        data.push(TI_CONF_EXT);
        data.push(CT_DEPOSIT);
        data.extend_from_slice(&net.to_le_bytes());
        data.push(mint_decimals(&ctx.accounts.mint)?); // read from the mint (no hardcode)
        let ixs = vec![
            AccountMeta::new(ctx.accounts.user_conf.key(), false),
            AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.owner.key(), true), // account OWNER signs
        ];
        let cpi_ix = SolanaInstruction {
            program_id: ctx.accounts.conf_token_program.key(),
            accounts: ixs,
            data,
        };
        invoke(
            &cpi_ix,
            &[
                ctx.accounts.user_conf.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.owner.to_account_info(),
            ],
        )?;

        // (5) enforce hard cap on the NET minted amount
        let cfg = &mut ctx.accounts.config;
        let new_supply = cfg
            .confidential_supply
            .checked_add(net)
            .ok_or(CError::Overflow)?;
        require!(new_supply <= cfg.supply_cap, CError::CapExceeded);
        cfg.confidential_supply = new_supply;
        require_reserve_covers_supply(&ctx.accounts.reserve, new_supply)?;

        let vault = &mut ctx.accounts.vault;
        vault.total_confidential = vault
            .total_confidential
            .checked_add(net)
            .ok_or(CError::Overflow)?;
        vault.nonce = vault.nonce.checked_add(1).ok_or(CError::Overflow)?;
        Ok(())
    }

    /// Unwrap: burn confidential tokens + return the SAME amount of REAL
    /// backing from RESERVE. Burn-on-unwrap, no fee. Never creates value.
    pub fn confidential_withdraw(ctx: Context<ConfidentialWithdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, CError::ZeroAmount);

        // Token programs are derived from the mints, never trusted from the
        // caller. This is what makes the Burn below an actual burn: it can only
        // ever be sent to the program that owns the confidential mint.
        require_conf_token_program(&ctx.accounts.mint, &ctx.accounts.conf_token_program)?;
        require_backing_token_program(&ctx.accounts.backing_mint, &ctx.accounts.backing_token_program)?;

        require!(
            is_owned_by(&ctx.accounts.backing_dest, ctx.accounts.backing_token_program.key)
                && is_owned_by(&ctx.accounts.reserve, ctx.accounts.backing_token_program.key)
                && is_owned_by(&ctx.accounts.user_conf, ctx.accounts.conf_token_program.key),
            CError::InvalidTokenAccount
        );
        // The backing release must land in the caller's OWN account, and never
        // back in the reserve itself.
        require_keys_neq!(ctx.accounts.backing_dest.key(), ctx.accounts.reserve.key(), CError::DestOwnerMismatch);
        require!(
            is_token_account_owner(&ctx.accounts.backing_dest, ctx.accounts.owner.key),
            CError::DestOwnerMismatch
        );
        // The global outstanding-supply cap: a caller can never release more
        // backing than the total minted minus already withdrawn.
        require!(
            amount <= ctx.accounts.config.confidential_supply,
            CError::InsufficientVaultBalance
        );

        // The reserve backing release is gated by an ATOMIC on-chain token-2022
        // Burn CPI of `amount` from the CALLER's own confidential account
        // (user_conf), BEFORE any backing leaves the reserve. token-2022's Burn
        // requires `amount` to sit in the plaintext `base.amount` of user_conf
        // and the token account OWNER (the caller signer) to authorize.
        //
        // To burn a confidential balance, the client first relays token-2022's
        // confidential `Withdraw` (27,6) in the SAME transaction, which converts
        // the encrypted available balance to plaintext `base.amount`.
        //
        // The burn is then VERIFIED: the mint's supply must have dropped by
        // exactly `amount`. Together with the token-program check above, a
        // caller can never release backing without destroying confidential tokens.
        let bump = ctx.bumps.config;
        let supply_before = mint_supply(&ctx.accounts.mint)?;
        let mut bdata = Vec::with_capacity(9);
        bdata.push(8u8); // TokenInstruction::Burn
        bdata.extend_from_slice(&amount.to_le_bytes());
        // The source token account must NOT be marked a signer in the CPI: Burn
        // is authorized by the account OWNER (readonly-signer below).
        let burn_ix = SolanaInstruction {
            program_id: ctx.accounts.conf_token_program.key(),
            accounts: vec![
                AccountMeta::new(ctx.accounts.user_conf.key(), false), // writable source, NOT signer
                AccountMeta::new(ctx.accounts.mint.key(), false), // writable: Burn decrements mint supply
                AccountMeta::new_readonly(ctx.accounts.owner.key(), true), // account OWNER signs
            ],
            data: bdata,
        };
        invoke(
            &burn_ix,
            &[
                ctx.accounts.user_conf.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.owner.to_account_info(),
            ],
        )?;
        require!(
            supply_before.checked_sub(mint_supply(&ctx.accounts.mint)?) == Some(amount),
            CError::BurnNotVerified
        );

        // release backing from RESERVE (token Transfer CPI, conf-mint PDA signs)
        // AFTER the verified on-chain Burn. The user receives the full `amount`.
        let reserve_before = token_account_amount(&ctx.accounts.reserve)?;
        let mut tdata = Vec::with_capacity(9);
        tdata.push(3u8); // token instruction Transfer
        tdata.extend_from_slice(&amount.to_le_bytes());
        let tix = SolanaInstruction {
            program_id: ctx.accounts.backing_token_program.key(),
            accounts: vec![
                AccountMeta::new(ctx.accounts.reserve.key(), false),
                AccountMeta::new(ctx.accounts.backing_dest.key(), false),
                AccountMeta::new_readonly(ctx.accounts.config.key(), true), // conf-mint PDA
            ],
            data: tdata,
        };
        invoke_signed(
            &tix,
            &[
                ctx.accounts.reserve.to_account_info(),
                ctx.accounts.backing_dest.to_account_info(),
                ctx.accounts.config.to_account_info(),
            ],
            &[&[b"conf-mint", ctx.accounts.mint.key().as_ref(), &[bump]]],
        )?;
        // Exactly `amount` left the reserve — no more.
        require!(
            reserve_before.checked_sub(token_account_amount(&ctx.accounts.reserve)?) == Some(amount),
            CError::ReserveInvariantViolated
        );

        // accounting
        let cfg = &mut ctx.accounts.config;
        cfg.confidential_supply = cfg
            .confidential_supply
            .checked_sub(amount)
            .ok_or(CError::Overflow)?;
        require_reserve_covers_supply(&ctx.accounts.reserve, cfg.confidential_supply)?;

        // The per-wallet vault ledger is a coarse audit counter only bumped on
        // deposit/withdraw (never on P2P ConfidentialTransfer), so a transfer
        // recipient can hold < this amount in their ledger even though they
        // physically own the tokens. Floor it at 0 instead of overflowing — the
        // real over-release guards are the verified burn and the global
        // confidential_supply. This ledger is informational/audit only.
        let vault = &mut ctx.accounts.vault;
        vault.total_confidential = vault.total_confidential.saturating_sub(amount);
        vault.nonce = vault.nonce.checked_add(1).ok_or(CError::Overflow)?;
        Ok(())
    }

    /// Open a confidential swap (EXPERIMENTAL — only with the
    /// `experimental-swaps` feature). The maker's confidential tokens are
    /// moved into a program-owned escrow (owner = conf-mint PDA); only the
    /// commitments of the offered amounts are recorded, never plaintext.
    pub fn open_swap<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenSwap<'info>>,
        seed: [u8; 32],
        maker_amount_ciphertext_lo: [u8; 64],
        maker_amount_ciphertext_hi: [u8; 64],
        taker_amount_ciphertext_lo: [u8; 64],
        taker_amount_ciphertext_hi: [u8; 64],
        // payload of the maker -> escrow ConfidentialTransfer (authority = maker)
        lock_leg_data: Vec<u8>,
    ) -> Result<()> {
        require!(SWAPS_ENABLED, CError::SwapsDisabled);

        // The escrow must be a token account of this mint, under the mint's own
        // token program, owned by the conf-mint PDA — and not the maker's source.
        let config_key = ctx.accounts.config.key();
        require_conf_token_program(&ctx.accounts.mint, &ctx.accounts.conf_token_program)?;
        require!(
            is_owned_by(&ctx.accounts.escrow, ctx.accounts.conf_token_program.key)
                && is_token_account_for_mint(&ctx.accounts.escrow, ctx.accounts.mint.key),
            CError::InvalidTokenAccount
        );
        require!(
            is_token_account_owner(&ctx.accounts.escrow, &config_key),
            CError::DestOwnerMismatch
        );
        require!(
            is_token_account_owner(&ctx.accounts.maker_source, ctx.accounts.maker.key),
            CError::AuthMismatch
        );

        // maker -> escrow, authority = maker (the maker signs the outer tx).
        relay_confidential_transfer(
            &ctx.accounts.conf_token_program,
            &ctx.accounts.mint,
            ctx.remaining_accounts,
            lock_leg_data,
            ctx.accounts.maker_source.key,
            ctx.accounts.escrow.key,
            ctx.accounts.maker.key,
            None,
        )?;

        let s = &mut ctx.accounts.swap;
        s.maker = ctx.accounts.maker.key();
        s.taker = Pubkey::default();
        s.mint = ctx.accounts.mint.key();
        s.maker_escrow = ctx.accounts.escrow.key();
        s.maker_amount_ciphertext_lo = maker_amount_ciphertext_lo;
        s.maker_amount_ciphertext_hi = maker_amount_ciphertext_hi;
        s.taker_amount_ciphertext_lo = taker_amount_ciphertext_lo;
        s.taker_amount_ciphertext_hi = taker_amount_ciphertext_hi;
        s.status = SwapStatus::Open as u8;
        s.seed = seed;
        s.bump = ctx.bumps.swap;
        Ok(())
    }

    /// Settle an open swap. The program relays the maker-leg (escrow ->
    /// taker_dest) and the fee-leg (escrow -> fee account) with the conf-mint
    /// PDA as authority.
    ///
    /// KNOWN LIMITATION (why swaps are experimental): token-2022 validates the
    /// zk proofs, but this program cannot read the plaintext amount of either
    /// leg, and the taker's payment leg is a separate instruction this program
    /// does not enforce. Source, mint, destination, authority, target program
    /// and instruction type ARE all fixed on-chain.
    pub fn settle_swap<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleSwap<'info>>,
        // payload of the maker leg (escrow -> taker_dest)
        maker_leg_data: Vec<u8>,
        // payload of the fee leg (escrow -> fee recipient's account)
        fee_leg_data: Vec<u8>,
    ) -> Result<()> {
        let s = &ctx.accounts.swap;
        require!(s.status == SwapStatus::Open as u8, CError::WrongSwapState);
        require!(s.taker == Pubkey::default(), CError::SwapAlreadyLocked);

        require_conf_token_program(&ctx.accounts.mint, &ctx.accounts.conf_token_program)?;
        // Fee destination must be the fee recipient's ATA for the conf mint.
        require_fee_ata(&ctx.accounts.fee_escrow, &ctx.accounts.mint.key(), ctx.accounts.conf_token_program.key)?;
        // The maker-leg must land in the taker's OWN account.
        require!(
            is_owned_by(&ctx.accounts.taker_dest, ctx.accounts.conf_token_program.key),
            CError::InvalidTokenAccount
        );
        require!(
            is_token_account_owner(&ctx.accounts.taker_dest, ctx.accounts.taker.key),
            CError::DestOwnerMismatch
        );

        let config_key = ctx.accounts.config.key();
        let bump_conf = ctx.bumps.config;
        let mint_key = ctx.accounts.mint.key();
        let seed_bytes = [b"conf-mint".as_slice(), mint_key.as_ref(), &[bump_conf]];
        let signer = &[&seed_bytes[..]];

        // remaining_accounts carries BOTH legs, maker-leg first (7 accounts:
        // escrow, mint, taker_dest, eq-ctx, val-ctx, range-ctx, authority),
        // fee-leg second (7 accounts: escrow, mint, fee account, eq/val/range
        // ctx, authority).
        let ra = ctx.remaining_accounts;
        require!(ra.len() == 2 * CT_TRANSFER_ACCOUNTS, CError::MissingCpiAccounts);
        let (maker_accounts, fee_accounts) = ra.split_at(CT_TRANSFER_ACCOUNTS);

        relay_confidential_transfer(
            &ctx.accounts.conf_token_program,
            &ctx.accounts.mint,
            maker_accounts,
            maker_leg_data,
            ctx.accounts.escrow.key,
            ctx.accounts.taker_dest.key,
            &config_key,
            Some(signer),
        )?;
        relay_confidential_transfer(
            &ctx.accounts.conf_token_program,
            &ctx.accounts.mint,
            fee_accounts,
            fee_leg_data,
            ctx.accounts.escrow.key,
            ctx.accounts.fee_escrow.key,
            &config_key,
            Some(signer),
        )?;

        let s = &mut ctx.accounts.swap;
        s.taker = ctx.accounts.taker.key();
        s.status = SwapStatus::Settled as u8;
        Ok(())
    }

    /// Cancel an open swap: release the maker's locked tokens from the escrow
    /// back to the maker's own confidential account.
    pub fn cancel_swap<'info>(
        ctx: Context<'_, '_, 'info, 'info, CancelSwap<'info>>,
        // payload of escrow -> maker_dest, authority = conf-mint PDA
        cancel_leg_data: Vec<u8>,
    ) -> Result<()> {
        let s = &ctx.accounts.swap;
        require!(s.status == SwapStatus::Open as u8, CError::WrongSwapState);
        require!(s.maker == ctx.accounts.maker.key(), CError::AuthMismatch);

        require_conf_token_program(&ctx.accounts.mint, &ctx.accounts.conf_token_program)?;
        // Maker's release must land in the maker's OWN confidential account.
        require!(
            is_owned_by(&ctx.accounts.maker_dest, ctx.accounts.conf_token_program.key),
            CError::InvalidTokenAccount
        );
        require!(
            is_token_account_owner(&ctx.accounts.maker_dest, ctx.accounts.maker.key),
            CError::DestOwnerMismatch
        );

        let config_key = ctx.accounts.config.key();
        let bump_conf = ctx.bumps.config;
        let mint_key = ctx.accounts.mint.key();
        let seed_bytes = [b"conf-mint".as_slice(), mint_key.as_ref(), &[bump_conf]];
        let signer = &[&seed_bytes[..]];

        relay_confidential_transfer(
            &ctx.accounts.conf_token_program,
            &ctx.accounts.mint,
            ctx.remaining_accounts,
            cancel_leg_data,
            ctx.accounts.escrow.key,
            ctx.accounts.maker_dest.key,
            &config_key,
            Some(signer),
        )?;

        let s = &mut ctx.accounts.swap;
        s.status = SwapStatus::Cancelled as u8;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum CError {
    #[msg("Amount too large — the calculation overflowed. Try a smaller amount.")]
    Overflow,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("The supply cap must be greater than zero.")]
    InvalidCap,
    #[msg("The supply cap can never be increased — it may only be lowered.")]
    CapCantIncrease,
    #[msg("This deposit would exceed the confidential supply cap. Try a smaller amount.")]
    CapExceeded,
    #[msg("The confidential vault does not hold enough balance for this withdrawal.")]
    InsufficientVaultBalance,
    #[msg("You are not authorized to perform this action (authority mismatch).")]
    AuthMismatch,
    #[msg("This swap is not in a state that allows this action.")]
    WrongSwapState,
    #[msg("This swap has already been taken — it can no longer be settled by another party.")]
    SwapAlreadyLocked,
    #[msg("Internal error: required CPI accounts are missing from the transaction.")]
    MissingCpiAccounts,
    #[msg("The destination account is not owned by the required party — refusing to send funds there.")]
    DestOwnerMismatch,
    #[msg("Protocol fee must be paid to the program's designated fee account — refusing to redirect it.")]
    FeeDestinationMismatch,
    #[msg("An account is not owned by the expected token program — refusing to use it.")]
    InvalidTokenAccount,
    #[msg("The confidential mint's authority is not the conf-mint PDA — this mint was not set up correctly.")]
    MintAuthorityNotPda,
    #[msg("The reserve is not a backing-token account owned by the conf-mint PDA — refusing to use it.")]
    ReserveNotProgramOwned,
    #[msg("The token program supplied does not own this mint — refusing to use it.")]
    TokenProgramMismatch,
    #[msg("The confidential tokens were not burned — refusing to release backing.")]
    BurnNotVerified,
    #[msg("The confidential tokens were not minted as expected — aborting the deposit.")]
    MintNotVerified,
    #[msg("The reserve no longer covers the outstanding confidential supply — aborting.")]
    ReserveInvariantViolated,
    #[msg("The supply cap cannot be lowered below the supply already outstanding.")]
    CapBelowSupply,
    #[msg("Only the program's upgrade authority can register a confidential mint.")]
    NotUpgradeAuthority,
    #[msg("The confidential mint must have the same decimals as its backing mint.")]
    DecimalsMismatch,
    #[msg("The confidential mint must not have a freeze authority.")]
    FreezeAuthorityPresent,
    #[msg("The confidential mint must have zero supply when it is registered.")]
    MintSupplyNotZero,
    #[msg("The relayed instruction is not the expected confidential transfer — refusing to sign it.")]
    InvalidRelayInstruction,
    #[msg("Confidential swaps are disabled in this build.")]
    SwapsDisabled,
}

// ---------------------------------------------------------------------------
// Tests (host target)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn mint_bytes(authority: Option<Pubkey>, supply: u64, decimals: u8, freeze: Option<Pubkey>) -> Vec<u8> {
        let mut d = vec![0u8; MINT_BASE_LEN];
        if let Some(a) = authority {
            d[0..4].copy_from_slice(&1u32.to_le_bytes());
            d[4..36].copy_from_slice(a.as_ref());
        }
        d[36..44].copy_from_slice(&supply.to_le_bytes());
        d[44] = decimals;
        d[45] = 1;
        if let Some(f) = freeze {
            d[46..50].copy_from_slice(&1u32.to_le_bytes());
            d[50..82].copy_from_slice(f.as_ref());
        }
        d
    }

    fn token_account_bytes(mint: Pubkey, owner: Pubkey, amount: u64) -> Vec<u8> {
        let mut d = vec![0u8; ACCOUNT_BASE_LEN];
        d[0..32].copy_from_slice(mint.as_ref());
        d[32..64].copy_from_slice(owner.as_ref());
        d[64..72].copy_from_slice(&amount.to_le_bytes());
        d
    }

    fn transfer_data() -> Vec<u8> {
        let mut d = vec![0xabu8; CT_TRANSFER_DATA_LEN];
        d[0] = TI_CONF_EXT;
        d[1] = CT_TRANSFER;
        let n = d.len();
        d[n - 3..].copy_from_slice(&[0, 0, 0]);
        d
    }

    #[test]
    fn fee_is_bps_with_floor() {
        // 0.39% = 39/10_000, rounded down.
        assert_eq!(WRAP_FEE_BPS, 39);
        assert_eq!(fee_on(0).unwrap(), 0);
        assert_eq!(fee_on(1).unwrap(), 0);
        assert_eq!(fee_on(256).unwrap(), 0);
        assert_eq!(fee_on(257).unwrap(), 1);
        assert_eq!(fee_on(10_000).unwrap(), 39);
        assert_eq!(fee_on(1_000_000).unwrap(), 3_900);
        assert_eq!(fee_on(1_000_000_000).unwrap(), 3_900_000);
        // fee never exceeds the amount
        for a in [1u64, 1_000, 1_000_000, u64::MAX / WRAP_FEE_BPS] {
            assert!(fee_on(a).unwrap() <= a);
        }
    }

    #[test]
    fn fee_overflow_is_an_error_not_a_wrap() {
        assert!(fee_on(u64::MAX).is_err());
        assert!(fee_on(u64::MAX / WRAP_FEE_BPS + 1).is_err());
    }

    #[test]
    fn fee_recipient_matches_declared() {
        assert_eq!(
            fee_recipient().to_string(),
            "GACCq8Yd4szdB7mCcaViFNwDEej4crZe43YoSPCzmb8M"
        );
    }

    #[test]
    fn mint_layout_readers() {
        let pda = Pubkey::new_unique();
        let d = mint_bytes(Some(pda), 1_234, 9, None);
        assert_eq!(mint_authority_from(&d), Some(pda));
        assert_eq!(mint_supply_from(&d), Some(1_234));
        assert_eq!(mint_decimals_from(&d), Some(9));
        assert_eq!(mint_has_freeze_authority_from(&d), Some(false));

        let frozen = mint_bytes(Some(pda), 0, 6, Some(Pubkey::new_unique()));
        assert_eq!(mint_has_freeze_authority_from(&frozen), Some(true));

        // no mint authority, and short buffers, never read as a match
        assert_eq!(mint_authority_from(&mint_bytes(None, 0, 9, None)), None);
        assert_eq!(mint_authority_from(&d[..40]), None);
        assert_eq!(mint_supply_from(&d[..40]), None);
        assert_eq!(mint_decimals_from(&[]), None);
        assert_eq!(mint_has_freeze_authority_from(&d[..60]), None);
    }

    #[test]
    fn token_account_layout_readers() {
        let (mint, owner) = (Pubkey::new_unique(), Pubkey::new_unique());
        let d = token_account_bytes(mint, owner, 77);
        assert_eq!(token_account_mint_from(&d), Some(mint));
        assert_eq!(token_account_owner_from(&d), Some(owner));
        assert_eq!(token_account_amount_from(&d), Some(77));
        // a 64-byte blob that merely has the right bytes at 32..64 is not a token account
        assert_eq!(token_account_owner_from(&d[..64]), None);
        assert_eq!(token_account_amount_from(&d[..100]), None);
    }

    #[test]
    fn relay_accepts_only_context_state_confidential_transfer() {
        assert!(is_conf_transfer_data(&transfer_data()));

        // wrong length
        let mut short = transfer_data();
        short.pop();
        assert!(!is_conf_transfer_data(&short));
        let mut long = transfer_data();
        long.push(0);
        assert!(!is_conf_transfer_data(&long));
        assert!(!is_conf_transfer_data(&[]));

        // any other token instruction (Transfer=3, MintTo=7, Burn=8, SetAuthority=6)
        for ix in [3u8, 6, 7, 8] {
            let mut d = transfer_data();
            d[0] = ix;
            assert!(!is_conf_transfer_data(&d));
        }
        // any other confidential-extension sub-instruction (Deposit=5, Withdraw=6)
        for sub in [5u8, 6, 8] {
            let mut d = transfer_data();
            d[1] = sub;
            assert!(!is_conf_transfer_data(&d));
        }
        // non-zero proof offsets would pull in the instructions sysvar
        for i in 1..=3 {
            let mut d = transfer_data();
            let n = d.len();
            d[n - i] = 1;
            assert!(!is_conf_transfer_data(&d));
        }
    }

    #[test]
    fn swaps_are_off_by_default() {
        assert_eq!(SWAPS_ENABLED, cfg!(feature = "experimental-swaps"));
    }

    #[test]
    fn account_sizes_are_stable() {
        assert_eq!(ConfidentialMintConfig::INIT_SPACE, 145);
        assert_eq!(Vault::INIT_SPACE, 81);
        assert_eq!(Swap::INIT_SPACE, 418);
    }
}
