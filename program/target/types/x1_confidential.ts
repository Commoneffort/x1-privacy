/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/x1_confidential.json`.
 */
export type X1Confidential = {
  "address": "X1PRVwe2PgSYyWZH2hBtUqAxnpPtp6s14jAgZCu4iF1",
  "metadata": {
    "name": "x1Confidential",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "cancelSwap",
      "docs": [
        "Cancel an open swap: release the maker's locked tokens from the escrow",
        "back to the maker. Only before the swap is locked."
      ],
      "discriminator": [
        88,
        174,
        98,
        148,
        24,
        252,
        93,
        89
      ],
      "accounts": [
        {
          "name": "swap",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  119,
                  97,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "swap.seed",
                "account": "swap"
              }
            ]
          }
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  45,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "escrow",
          "docs": [
            "Program-owned escrow holding maker's locked tokens."
          ],
          "writable": true
        },
        {
          "name": "makerDest",
          "docs": [
            "Maker's confidential account receiving them back."
          ],
          "writable": true
        },
        {
          "name": "maker",
          "writable": true,
          "signer": true,
          "relations": [
            "swap"
          ]
        },
        {
          "name": "confTokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "cancelLegData",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "confidentialDeposit",
      "docs": [
        "Wrap: transfer real backing into RESERVE, then mint confidential 1:1,",
        "net of the one-time 0.39% protocol fee. No confidential token is ever",
        "created without a real backing transfer."
      ],
      "discriminator": [
        73,
        19,
        230,
        11,
        25,
        247,
        11,
        181
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  45,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "backingMint",
          "docs": [
            "The REAL backing mint (e.g. XNT)."
          ],
          "relations": [
            "config"
          ]
        },
        {
          "name": "userConf",
          "docs": [
            "The user's token-2022 confidential account on this mint (receives the mint)."
          ],
          "writable": true
        },
        {
          "name": "backingSource",
          "docs": [
            "User's normal backing-token ATA paying the real deposit."
          ],
          "writable": true
        },
        {
          "name": "reserve",
          "docs": [
            "Program-owned reserve receiving backing."
          ],
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "feeAccount",
          "docs": [
            "Fee recipient's ASSOCIATED TOKEN ACCOUNT for the backing mint (fee destination)."
          ],
          "writable": true
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "confTokenProgram",
          "docs": [
            "The confidential token-2022 program (zk-ops build) to CPI into."
          ]
        },
        {
          "name": "backingTokenProgram",
          "docs": [
            "The REAL backing token program (e.g. Tokenkeg for XNT)."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "confidentialWithdraw",
      "docs": [
        "Unwrap: burn confidential tokens + return the SAME amount of REAL",
        "backing from RESERVE. Burn-on-unwrap, no fee. Never creates value."
      ],
      "discriminator": [
        192,
        153,
        197,
        143,
        238,
        85,
        204,
        38
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  45,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "backingMint",
          "docs": [
            "The REAL backing mint (e.g. XNT)."
          ],
          "relations": [
            "config"
          ]
        },
        {
          "name": "userConf",
          "docs": [
            "The user's token-2022 confidential account (burned from)."
          ],
          "writable": true
        },
        {
          "name": "backingDest",
          "docs": [
            "User's normal backing-token ATA receiving the returned value."
          ],
          "writable": true
        },
        {
          "name": "reserve",
          "docs": [
            "The program-owned reserve releasing backing."
          ],
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "confTokenProgram",
          "docs": [
            "The confidential token-2022 program (zk-ops build) to CPI into."
          ]
        },
        {
          "name": "backingTokenProgram",
          "docs": [
            "The REAL backing token program (e.g. Tokenkeg for XNT)."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "createVault",
      "discriminator": [
        29,
        237,
        247,
        208,
        193,
        82,
        54,
        135
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initConfidentialMint",
      "docs": [
        "Register a confidential mint under this program. Only the program's",
        "upgrade authority may do this, and it becomes the cap governance authority.",
        "The confidential mint MUST have the conf-mint PDA as its mint authority, no",
        "freeze authority, zero supply, and the same decimals as the backing mint.",
        "The reserve MUST be a backing-mint token account owned by the conf-mint PDA."
      ],
      "discriminator": [
        246,
        68,
        6,
        8,
        228,
        97,
        47,
        68
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  45,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "backingMint"
        },
        {
          "name": "reserve",
          "docs": [
            "Program-owned reserve account holding the backing token."
          ]
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true,
          "docs": [
            "Must be the program's upgrade authority — registering a confidential",
            "mint is a governance action, not a first-come-first-served one."
          ]
        },
        {
          "name": "program",
          "address": "X1PRVwe2PgSYyWZH2hBtUqAxnpPtp6s14jAgZCu4iF1"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "supplyCap",
          "type": "u64"
        }
      ]
    },
    {
      "name": "openSwap",
      "docs": [
        "Open a confidential swap. The maker's confidential tokens are moved into",
        "a program-owned escrow (owner = conf-mint PDA); only the commitments of",
        "the offered amounts are recorded, never plaintext."
      ],
      "discriminator": [
        109,
        109,
        21,
        132,
        201,
        76,
        67,
        113
      ],
      "accounts": [
        {
          "name": "swap",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  119,
                  97,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "arg",
                "path": "seed"
              }
            ]
          }
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  45,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "makerSource",
          "docs": [
            "Maker's confidential token account (source of the locked tokens)."
          ],
          "writable": true
        },
        {
          "name": "escrow",
          "docs": [
            "Program-owned escrow token account receiving the locked confidential",
            "tokens (owner = conf-mint PDA)."
          ],
          "writable": true
        },
        {
          "name": "maker",
          "writable": true,
          "signer": true
        },
        {
          "name": "confTokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "seed",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "makerAmountCiphertextLo",
          "type": {
            "array": [
              "u8",
              64
            ]
          }
        },
        {
          "name": "makerAmountCiphertextHi",
          "type": {
            "array": [
              "u8",
              64
            ]
          }
        },
        {
          "name": "takerAmountCiphertextLo",
          "type": {
            "array": [
              "u8",
              64
            ]
          }
        },
        {
          "name": "takerAmountCiphertextHi",
          "type": {
            "array": [
              "u8",
              64
            ]
          }
        },
        {
          "name": "lockLegData",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "setCap",
      "docs": [
        "Governance can only ever LOWER the cap. It can never raise it, and it",
        "can never set it to zero or below the supply already outstanding."
      ],
      "discriminator": [
        209,
        207,
        121,
        129,
        115,
        39,
        220,
        4
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  45,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "authority",
          "docs": [
            "Governance signer — enforced by `has_one = authority` to equal the stored",
            "`config.authority` recorded at `init_confidential_mint`. No unprivileged",
            "wallet can lower the cap (governance DoS closed)."
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newCap",
          "type": "u64"
        }
      ]
    },
    {
      "name": "settleSwap",
      "docs": [
        "Settle an open swap atomically. The program relays the maker-leg",
        "(escrow -> taker_dest) with the conf-mint PDA as authority (invoke_signed).",
        "The taker-leg (taker_source -> maker_dest) is a SEPARATE token-2022",
        "ConfidentialTransfer signed by the taker directly, added as a second",
        "instruction in the SAME transaction for atomicity."
      ],
      "discriminator": [
        3,
        130,
        133,
        180,
        251,
        87,
        242,
        250
      ],
      "accounts": [
        {
          "name": "swap",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  119,
                  97,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "swap.maker",
                "account": "swap"
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "swap.seed",
                "account": "swap"
              }
            ]
          }
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  45,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "escrow",
          "docs": [
            "The program-owned escrow (maker's locked tokens)."
          ],
          "writable": true
        },
        {
          "name": "takerDest",
          "docs": [
            "Taker's confidential account (receives the escrow leg)."
          ],
          "writable": true
        },
        {
          "name": "taker",
          "writable": true,
          "signer": true
        },
        {
          "name": "feeEscrow",
          "docs": [
            "Fee recipient's ATA for the confidential mint (fee leg destination)."
          ],
          "writable": true
        },
        {
          "name": "confTokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "makerLegData",
          "type": "bytes"
        },
        {
          "name": "feeLegData",
          "type": "bytes"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "confidentialMintConfig",
      "discriminator": [
        45,
        249,
        165,
        90,
        224,
        225,
        4,
        68
      ]
    },
    {
      "name": "swap",
      "discriminator": [
        53,
        206,
        146,
        152,
        44,
        97,
        120,
        177
      ]
    },
    {
      "name": "vault",
      "discriminator": [
        211,
        8,
        232,
        43,
        2,
        152,
        117,
        119
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "overflow",
      "msg": "Amount too large — the calculation overflowed. Try a smaller amount."
    },
    {
      "code": 6001,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero."
    },
    {
      "code": 6002,
      "name": "invalidCap",
      "msg": "The supply cap must be greater than zero."
    },
    {
      "code": 6003,
      "name": "capCantIncrease",
      "msg": "The supply cap can never be increased — it may only be lowered."
    },
    {
      "code": 6004,
      "name": "capExceeded",
      "msg": "This deposit would exceed the confidential supply cap. Try a smaller amount."
    },
    {
      "code": 6005,
      "name": "insufficientVaultBalance",
      "msg": "The confidential vault does not hold enough balance for this withdrawal."
    },
    {
      "code": 6006,
      "name": "authMismatch",
      "msg": "You are not authorized to perform this action (authority mismatch)."
    },
    {
      "code": 6007,
      "name": "wrongSwapState",
      "msg": "This swap is not in a state that allows this action."
    },
    {
      "code": 6008,
      "name": "swapAlreadyLocked",
      "msg": "This swap has already been taken — it can no longer be settled by another party."
    },
    {
      "code": 6009,
      "name": "missingCpiAccounts",
      "msg": "Internal error: required CPI accounts are missing from the transaction."
    },
    {
      "code": 6010,
      "name": "destOwnerMismatch",
      "msg": "The destination account is not owned by the required party — refusing to send funds there."
    },
    {
      "code": 6011,
      "name": "feeDestinationMismatch",
      "msg": "Protocol fee must be paid to the program's designated fee account — refusing to redirect it."
    },
    {
      "code": 6012,
      "name": "invalidTokenAccount",
      "msg": "An account is not owned by the expected token program — refusing to use it."
    },
    {
      "code": 6013,
      "name": "mintAuthorityNotPda",
      "msg": "The confidential mint's authority is not the conf-mint PDA — this mint was not set up correctly."
    },
    {
      "code": 6014,
      "name": "reserveNotProgramOwned",
      "msg": "The reserve is not a backing-token account owned by the conf-mint PDA — refusing to use it."
    },
    {
      "code": 6015,
      "name": "tokenProgramMismatch",
      "msg": "The token program supplied does not own this mint — refusing to use it."
    },
    {
      "code": 6016,
      "name": "burnNotVerified",
      "msg": "The confidential tokens were not burned — refusing to release backing."
    },
    {
      "code": 6017,
      "name": "mintNotVerified",
      "msg": "The confidential tokens were not minted as expected — aborting the deposit."
    },
    {
      "code": 6018,
      "name": "reserveInvariantViolated",
      "msg": "The reserve no longer covers the outstanding confidential supply — aborting."
    },
    {
      "code": 6019,
      "name": "capBelowSupply",
      "msg": "The supply cap cannot be lowered below the supply already outstanding."
    },
    {
      "code": 6020,
      "name": "notUpgradeAuthority",
      "msg": "Only the program's upgrade authority can register a confidential mint."
    },
    {
      "code": 6021,
      "name": "decimalsMismatch",
      "msg": "The confidential mint must have the same decimals as its backing mint."
    },
    {
      "code": 6022,
      "name": "freezeAuthorityPresent",
      "msg": "The confidential mint must not have a freeze authority."
    },
    {
      "code": 6023,
      "name": "mintSupplyNotZero",
      "msg": "The confidential mint must have zero supply when it is registered."
    },
    {
      "code": 6024,
      "name": "invalidRelayInstruction",
      "msg": "The relayed instruction is not the expected confidential transfer — refusing to sign it."
    },
    {
      "code": 6025,
      "name": "swapsDisabled",
      "msg": "Confidential swaps are disabled in this build."
    }
  ],
  "types": [
    {
      "name": "confidentialMintConfig",
      "docs": [
        "Per-mint confidential config + governance.",
        "Mint authority is the conf-mint PDA; supply_cap is immutable after genesis."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "backingMint",
            "type": "pubkey"
          },
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "supplyCap",
            "type": "u64"
          },
          {
            "name": "confidentialSupply",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "swap",
      "docs": [
        "A private swap order. The maker's confidential tokens are locked in a",
        "PROGRAM-OWNED escrow token account (owner = conf-mint PDA) so the program",
        "can release them confidentially via invoke_signed. The order stores ONLY",
        "ciphertexts/commitments — no plaintext amounts ever hit the chain."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "taker",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "makerEscrow",
            "type": "pubkey"
          },
          {
            "name": "makerAmountCiphertextLo",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "makerAmountCiphertextHi",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "takerAmountCiphertextLo",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "takerAmountCiphertextHi",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "seed",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vault",
      "docs": [
        "Vault keyed by (owner, mint) — coarse audit accounting + nonce."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "totalConfidential",
            "type": "u64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
