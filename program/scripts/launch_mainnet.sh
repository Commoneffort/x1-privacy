#!/bin/bash
# X1 Privacy — mainnet launch, one stage at a time.
#
#   ./program/scripts/launch_mainnet.sh <stage>
#
# Stages, in order (each is safe to re-run; each prints what it did):
#   check     nothing is sent: verifies keys, balances, token-program support and the build
#   record    deploys the SPL record program (official spl-record 0.3.0, built from source)
#   program   deploys the X1 Privacy program at the address of its program keypair
#   mints     registers cXNT (native XNT) and cUSDC.x (real USDC.x), both uncapped
#   smoke     wraps 0.01 XNT, repairs, unwraps 0.005 XNT through the live program
#   site      builds the mainnet website bundle (no faucet) into ui/vercel-dist/x1privacy
#
# Required environment:
#   DEPLOYER   path to the mainnet deployer keypair (upgrade authority + cap governance)
# The deployer needs about 3.5 XNT: ~2.9 program rent, ~0.2 record program rent,
# the rest for mint/reserve rent, fees and the smoke test.
set -euo pipefail

STAGE=${1:-}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PROG=$ROOT/program
RPC=https://rpc.mainnet.x1.xyz
TOKEN2022=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb        # the chain's own Token-2022
NATIVE_MINT=So11111111111111111111111111111111111111112       # wrapped native XNT
USDCX_MINT=B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq       # real USDC.x on X1 mainnet
UNCAPPED=18446744073709551615                                  # u64::MAX — supply follows what users wrap
STATE_DIR=$PROG/client/mainnet
PROGRAM_KP=$PROG/target/deploy/x1_confidential-keypair.json
PROGRAM_SO=$PROG/target/deploy/x1_confidential.so
RECORD_DIR=$ROOT/deps/src/spl-record-0.3.0
RECORD_KP=$RECORD_DIR/target/deploy/spl_record-keypair.json
RECORD_SO=$RECORD_DIR/target/deploy/spl_record.so
TS_OPTS='{"module":"commonjs","esModuleInterop":true,"skipLibCheck":true,"target":"es2020","resolveJsonModule":true}'

[ -n "${DEPLOYER:-}" ] && [ -f "$DEPLOYER" ] || { echo "set DEPLOYER to the mainnet deployer keypair file"; exit 1; }
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KP")
RECORD_ID=$(solana-keygen pubkey "$RECORD_KP")
DEPLOYER_PUB=$(solana-keygen pubkey "$DEPLOYER")
mkdir -p "$STATE_DIR"

export CONF_RPC=$RPC TOKEN2022_PROGRAM=$TOKEN2022 RECORD_PROGRAM=$RECORD_ID PROGRAM_ID FUNDER_KEYPAIR=$DEPLOYER
ts() { (cd "$PROG" && npx ts-node --compiler-options "$TS_OPTS" "$@" 2>&1 | grep -vE "punycode|trace-deprecation|bigint: Failed"); }

case "$STAGE" in
check)
  echo "program id : $PROGRAM_ID"
  echo "record id  : $RECORD_ID"
  echo "deployer   : $DEPLOYER_PUB  ($(solana balance "$DEPLOYER_PUB" --url $RPC))"
  grep -q "declare_id!(\"$PROGRAM_ID\")" "$PROG/programs/x1_confidential/src/lib.rs" \
    || { echo "FAIL: lib.rs declare_id! does not match the program keypair — run scripts/set_program_id.py and rebuild"; exit 1; }
  python3 - "$PROGRAM_SO" "$PROGRAM_ID" <<'PY'
import sys
AL = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = 0
for c in sys.argv[2]:
    n = n * 58 + AL.index(c)
assert n.to_bytes(32, "big") in open(sys.argv[1], "rb").read(), "FAIL: the built .so was not compiled for this program id — rebuild"
print("build      : .so embeds the program id")
PY
  echo "sha256     : $(sha256sum "$PROGRAM_SO" | cut -d' ' -f1)"
  (cd "$PROG" && cargo test --locked -p x1_confidential 2>&1 | grep "test result" | head -1)
  echo "token-2022 confidential support on mainnet (simulation only):"
  PROBE_PAYER=${PROBE_PAYER:-$DEPLOYER_PUB} ts tests/ct_support_probe.ts   # any funded address works; nothing is signed
  echo "fee recipient hard-coded in the program: $(grep -o 'Fee recipient (owner): [1-9A-HJ-NP-Za-km-z]*' "$PROG/programs/x1_confidential/src/lib.rs")"
  echo "CONFIRM you control that wallet before deploying."
  ;;
record)
  solana program show "$RECORD_ID" --url $RPC >/dev/null 2>&1 && { echo "record program already deployed: $RECORD_ID"; exit 0; }
  solana program deploy "$RECORD_SO" --program-id "$RECORD_KP" --keypair "$DEPLOYER" --url $RPC
  ;;
program)
  solana program deploy "$PROGRAM_SO" --program-id "$PROGRAM_KP" --keypair "$DEPLOYER" --url $RPC
  solana program show "$PROGRAM_ID" --url $RPC
  solana program dump "$PROGRAM_ID" /tmp/x1privacy-onchain.so --url $RPC >/dev/null
  cmp <(head -c "$(stat -c %s "$PROGRAM_SO")" /tmp/x1privacy-onchain.so) "$PROGRAM_SO" && echo "on-chain bytes == local build"
  ;;
mints)
  if [ ! -f "$STATE_DIR/x1c_state.json" ]; then
    X1C_STATE=$STATE_DIR/x1c_state.json ts client/x1c.ts init-mint $UNCAPPED $NATIVE_MINT
  else echo "cXNT already registered: $STATE_DIR/x1c_state.json"; fi
  if [ ! -f "$STATE_DIR/x1c_usdcx_state.json" ]; then
    X1C_STATE=$STATE_DIR/x1c_usdcx_cli.json ts client/x1c.ts init-mint $UNCAPPED $USDCX_MINT
    python3 - "$STATE_DIR" <<'PY'
import json, sys
d = sys.argv[1]
s = json.load(open(d + "/x1c_usdcx_cli.json"))
json.dump({"symbol": "cUSDC.x", "name": "Confidential USDC.x", "backingMint": s["backingMint"], "mint": s["mint"],
           "reserve": s["reserve"], "supplyCap": s["supplyCap"], "config": s["config"]},
          open(d + "/x1c_usdcx_state.json", "w"), indent=2)
PY
  else echo "cUSDC.x already registered: $STATE_DIR/x1c_usdcx_state.json"; fi
  cat "$STATE_DIR/x1c_state.json" "$STATE_DIR/x1c_usdcx_state.json"
  ;;
smoke)
  X1C_STATE=$STATE_DIR/x1c_state.json ts client/x1c.ts create-vault || true
  X1C_STATE=$STATE_DIR/x1c_state.json ts tests/native_unwrap_smoke.ts 10000000 5000000
  ;;
site)
  cd "$ROOT/ui"
  node build.js
  PORT=8911 HTTPS_PORT=8914 NETWORK=mainnet RECORD_PROGRAM=$RECORD_ID PROGRAM_ID=$PROGRAM_ID \
    X1C_STATE=$STATE_DIR/x1c_state.json X1C_USDCX_STATE=$STATE_DIR/x1c_usdcx_state.json X1C_MOCK_USDCX=/nonexistent \
    node server.js > /tmp/x1privacy-mainnet-server.log 2>&1 &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null' EXIT
  for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8911/api/state >/dev/null 2>&1 && break; sleep 0.5; done
  NETWORK=mainnet OUT=x1privacy STATE_URL=http://127.0.0.1:8911/api/state ./build-vercel.sh
  echo "now: cd ui/vercel-dist/x1privacy && VERCEL_TOKEN=... npx vercel deploy --prod --yes"
  ;;
*)
  sed -n '2,20p' "$0"; exit 1 ;;
esac
