#!/bin/bash
# Publish the built mainnet site to this server's web root (served by nginx).
#
#   DEPLOYER=<keypair> ../program/scripts/launch_mainnet.sh site   # builds vercel-dist/x1privacy
#   ./deploy-site.sh
#
# Only static files are copied. There is no backend and no key on the web root.
set -euo pipefail
cd "$(dirname "$0")"
SRC=vercel-dist/x1privacy
DEST=${DEST:-/var/www/x1privacy}
python3 - "$SRC/state.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
assert j.get("network") == "mainnet", "the build in vercel-dist/x1privacy is not a mainnet build"
assert j.get("faucet") is False, "a mainnet build must not enable a faucet"
blob = json.dumps(j)
assert "ecret" not in blob and "_kp" not in blob, "state contains key material"
PY
FILES="index.html app.bundle.js proofgen51.wasm state.json whitepaper.pdf integration.md idl.json stats.html stats.js"
# written into the web root by the statistics indexer (ui/indexer/index-stats.mjs), not by this script
KEEP="stats.json"
mkdir -p "$DEST"
# publish exactly these files; anything else in the web root is removed
find "$DEST" -mindepth 1 -maxdepth 1 $(printf -- "! -name %s " $FILES $KEEP) -exec rm -rf {} +
for f in $FILES; do cp "$SRC/$f" "$DEST/$f.new" && mv -f "$DEST/$f.new" "$DEST/$f"; done
chmod -R a+rX "$DEST"
echo "published to $DEST:"; ls -la "$DEST"
grep -o 'app.bundle.js?v=[a-z0-9-]*' "$DEST/index.html"
