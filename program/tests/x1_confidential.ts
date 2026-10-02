import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { X1Confidential } from "../target/types/x1_confidential";
import { assert } from "chai";

describe("x1_confidential", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.X1Confidential as Program<X1Confidential>;

  it("has the expected instruction set", () => {
    const names = Object.keys(program.methods);
    // Live instruction set (verified 2026-09-29 against source + deployed binary).
    for (const n of ["initConfidentialMint", "setCap", "createVault",
      "confidentialDeposit", "confidentialWithdraw", "openSwap", "settleSwap",
      "cancelSwap"]) {
      assert.include(names, n, `expected instruction ${n}`);
    }
  });
});
