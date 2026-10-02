#!/bin/bash
# Assemble a static Vercel site from the built UI.
#
#   node build.js
#   NETWORK=testnet OUT=x1privacy-testnet ./build-vercel.sh
#   NETWORK=mainnet OUT=x1privacy         ./build-vercel.sh
#   cd vercel-dist/$OUT && VERCEL_TOKEN=... npx vercel deploy --prod --yes
#
# Needs the local server running for the SAME network (it provides the public
# deployment state): STATE_URL defaults to http://127.0.0.1:8910/api/state.
# A mainnet build ships no faucet function and no server-side key.
set -euo pipefail
cd "$(dirname "$0")"
NETWORK=${NETWORK:-testnet}
OUT=vercel-dist/${OUT:-x1privacy}
STATE_URL=${STATE_URL:-http://127.0.0.1:8910/api/state}
mkdir -p "$OUT"
rm -rf "$OUT/api" "$OUT/package.json"
cp public/index.html public/app.bundle.js public/proofgen51.wasm "$OUT"/
for f in whitepaper.pdf integration.md idl.json stats.html stats.js; do [ -f "public/$f" ] && cp "public/$f" "$OUT"/; done
curl -fsS "$STATE_URL" > "$OUT/state.json"
python3 - "$OUT" "$NETWORK" <<'PY'
import json, sys
out, network = sys.argv[1], sys.argv[2]
j = json.load(open(out + "/state.json"))
assert not j.get("error"), j.get("error")
assert j.get("network") == network, f"server is running for {j.get('network')}, not {network}"
blob = json.dumps(j)
assert "ecret" not in blob and "_kp" not in blob, "state contains key material"
if network == "mainnet":
    j["faucet"] = False
    assert j.get("recordProgram"), "mainnet state has no record program"
json.dump(j, open(out + "/state.json", "w"), indent=1)
rpc = j["rpc"].rstrip("/")
ws = rpc.replace("https://", "wss://", 1)
csp = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; font-src 'self'; connect-src 'self' %s %s; object-src 'none'; base-uri 'none'; "
       "frame-ancestors 'none'; form-action 'none'") % (rpc, ws)
conf = {
    "cleanUrls": False,
    "rewrites": [{"source": "/api/state", "destination": "/state.json"}],
    "headers": [
        # every page except the PDF (browser PDF viewers need their own policy)
        {"source": "/((?!whitepaper\\.pdf).*)", "headers": [
            {"key": "Content-Security-Policy", "value": csp},
            {"key": "X-Content-Type-Options", "value": "nosniff"},
            {"key": "X-Frame-Options", "value": "DENY"},
            {"key": "Referrer-Policy", "value": "no-referrer"}]},
        {"source": "/state.json", "headers": [{"key": "Cache-Control", "value": "no-store"}]},
    ],
}
if network != "mainnet":
    conf["functions"] = {"api/*.js": {"maxDuration": 30}}
json.dump(conf, open(out + "/vercel.json", "w"), indent=2)
print("network:", network, "| tokens:", ", ".join(j["tokens"]), "| faucet:", j.get("faucet"))
PY
if [ "$NETWORK" != "mainnet" ]; then
  # Testnet only: the mock-token faucet, bundled into one self-contained file
  # (state.json is inlined), so Vercel installs nothing.
  mkdir -p "$OUT/api"
  cp vercel/package.json "$OUT"/
  cp "$OUT/state.json" vercel/state.json
  node_modules/.bin/esbuild vercel/api/faucet-token.cjs --bundle --platform=node --target=node20 --format=cjs \
    --external:bufferutil --external:utf-8-validate --log-level=warning --outfile="$OUT/api/faucet-token.js"
fi
echo "assembled $OUT"
