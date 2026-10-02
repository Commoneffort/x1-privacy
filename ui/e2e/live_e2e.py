import base64, json, os, sys, time
from playwright.sync_api import sync_playwright
from solders.keypair import Keypair

URL = os.environ.get("E2E_URL", "https://x1privacy.xyz/")
kp = Keypair.from_bytes(bytes(json.load(open(os.path.expanduser(os.environ["E2E_WALLET"])))))
PUB = str(kp.pubkey())
STEPS = sys.argv[1:] or ["connect", "create"]

def shortvec(buf, off):
    n = shift = 0; i = off
    while True:
        b = buf[i]; i += 1; n |= (b & 0x7f) << shift
        if not b & 0x80: break
        shift += 7
    return n, i - off

def sign_wire(b64):
    wire = bytearray(base64.b64decode(b64))
    nsig, size = shortvec(wire, 0)
    msg = bytes(wire[size + nsig * 64:])
    _, ksz = shortvec(msg, 3)
    keys = [msg[3 + ksz + i * 32: 3 + ksz + (i + 1) * 32] for i in range(nsig)]
    idx = keys.index(bytes(kp.pubkey()))
    wire[size + idx * 64: size + (idx + 1) * 64] = bytes(kp.sign_message(msg))
    return base64.b64encode(bytes(wire)).decode()

def sign_msg(b64):
    return base64.b64encode(bytes(kp.sign_message(base64.b64decode(b64)))).decode()

MODE = os.environ.get("E2E_WALLET_MODE", "object")   # how signTransaction answers
INIT = """(function(){
  window.__PUB="%s";
  const b64=(u)=>btoa(String.fromCharCode(...u)), un=(s)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  window.x1wallet={ isX1:true, publicKey:{toString:()=>window.__PUB,toBase58:()=>window.__PUB},
    connect:async()=>({publicKey:{toString:()=>window.__PUB}}),
    signTransaction:async(tx)=>{
      const bytes=tx.serialize({requireAllSignatures:false,verifySignatures:false});
      const out=await window.__signWire(b64(bytes));
      if("%s"==="b64") return {signedTransaction:out};
      const u=un(out); return { serialize:()=>u };
    },
    signMessage:async(m)=>{ window.__msgSigns=(window.__msgSigns||0)+1; return un(await window.__signMsg(b64(m))); } };
  window.__txApprovals=0;
  const one=window.x1wallet.signTransaction;
  window.x1wallet.signTransaction=async(tx)=>{ window.__txApprovals++; return one(tx); };
  if("%s"!=="noall") window.x1wallet.signAllTransactions=async(txs)=>{ window.__txApprovals++; const out=[]; for(const t of txs) out.push(await one(t)); return out; };
})();""" % (PUB, MODE, os.environ.get("E2E_SIGNALL","all"))

with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--no-sandbox"] + os.environ.get("E2E_CHROME_ARGS", "").split())
    p = b.new_page(viewport={"width": 1280, "height": 900})
    logs = []
    p.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    p.on("pageerror", lambda e: logs.append("PAGEERROR: " + str(e)))
    p.on("requestfailed", lambda r: logs.append("REQFAILED: " + r.url[:90] + " " + str(r.failure)))
    p.expose_function("__signWire", sign_wire)
    p.expose_function("__signMsg", sign_msg)
    p.add_init_script(INIT)
    p.goto(URL, wait_until="load", timeout=60000)
    p.wait_for_timeout(5000)
    toast = lambda: p.evaluate("document.getElementById('toast').innerText")
    def click(act, wait_ms, done=None):
        t0 = time.time()
        p.click(f'[data-act="{act}"]')
        end = time.time() + wait_ms / 1000
        seen = []
        while time.time() < end:
            t = toast()
            if t and (not seen or seen[-1] != t): seen.append(t)
            if done and any(d in t for d in done): break
            p.wait_for_timeout(700)
        ap = p.evaluate("[window.__txApprovals||0, window.__msgSigns||0]")
        print(f"== {act} ({time.time()-t0:.1f}s) [tx approvals so far: {ap[0]}, message signatures: {ap[1]}]: toasts:"); [print("   ", s) for s in seen]
    for step in STEPS:
        if step == "connect":
            # the page auto-connects to an already-authorised wallet and then hides the button
            if p.is_visible('[data-act="connectWallet"]'): click("connectWallet", 25000, ["Connected", "failed", "Loaded"])
            p.wait_for_timeout(6000); print("== connected:", p.evaluate("document.getElementById('walletText').textContent"), "| message signatures on load:", p.evaluate("window.__msgSigns||0"))
        elif step == "create": click("createAccount", 90000, ["created", "Found your", "createAccount:"]); p.wait_for_timeout(5000)
        elif step.startswith("wrap:"):
            p.fill("#depAmount", step.split(":")[1]); click("deposit", 120000, ["Deposited", "failed"]); p.wait_for_timeout(5000)
        elif step.startswith("unwrap:"):
            p.fill("#wdAmount", step.split(":")[1]); click("withdraw", 240000, ["Unwrapped", "failed"]); p.wait_for_timeout(5000)
        elif step.startswith("token:"):
            p.select_option("#tokenSelect", step.split(":")[1]); p.wait_for_timeout(8000); print("== token ->", step.split(":")[1])
        elif step.startswith("dest:"): p.fill("#transferDest", step.split(":",1)[1]); print("== recipient set to", step.split(":",1)[1][:10])
        elif step == "testdest": click("createTestDest", 90000, ["Test recipient ready", "createTestDest:"]); p.wait_for_timeout(4000)
        elif step.startswith("transfer:"):
            p.fill("#permAmount", step.split(":")[1]); click("transfer", 240000, ["Sent ", "failed"]); p.wait_for_timeout(5000)
        elif step == "apply": click("applyPending", 60000, ["Incoming funds added", "Nothing incoming", "failed"]); p.wait_for_timeout(5000)
        elif step.startswith("shot:"): p.screenshot(path=step.split(":",1)[1], full_page=True); print("== screenshot", step.split(":",1)[1])
        elif step == "balance": print("== balance:", p.evaluate("document.getElementById('stBalance').textContent"))
        elif step == "faucet": click("faucetToken", 60000, ["Faucet:", "failed"]); p.wait_for_timeout(4000)
    print("wallet:", p.evaluate("document.getElementById('walletText').textContent"), "| balance:", p.evaluate("document.getElementById('stBalance').textContent"),
          "|", p.evaluate("document.getElementById('stXnt').textContent"), "| acct:", p.evaluate("document.getElementById('stWalletAcct').innerText"))
    bad = [l for l in logs if any(k in l for k in ("PAGEERROR", "REQFAILED", "[error]", "Content Security", "CATCH", "FAILED", "Refused"))]
    print("--- problems in console (%d of %d lines):" % (len(bad), len(logs))); [print("  ", l[:400]) for l in bad[:25]]
    if os.environ.get("E2E_VERBOSE"): [print("  ", l[:300]) for l in logs[-60:]]
    b.close()
