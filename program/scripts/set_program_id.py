#!/usr/bin/env python3
"""Point the source tree at a new program id.

Usage (from the repository root or anywhere):

    python3 program/scripts/set_program_id.py <NEW_PROGRAM_ID>

Rewrites the program id in the code that is compiled or served:
lib.rs (declare_id!), Anchor.toml, the IDL + TS types, the web UI source and
the server default. Historical documents are left untouched on purpose.

After running it you MUST rebuild:

    cd program && cargo build-sbf --tools-version v1.53
    cd ../ui && node build.js
"""
import pathlib
import re
import sys

BASE58 = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
ROOT = pathlib.Path(__file__).resolve().parents[2]

FILES = [
    "program/programs/x1_confidential/src/lib.rs",
    "program/Anchor.toml",
    "program/target/idl/x1_confidential.json",
    "program/target/types/x1_confidential.ts",
    "program/client/x1c.ts",
    "program/client/x1c_swap.ts",
    "ui/public/app.js",
    "ui/server.js",
]


def current_id() -> str:
    src = (ROOT / FILES[0]).read_text()
    match = re.search(r'declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)', src)
    if not match:
        sys.exit("could not find declare_id! in lib.rs")
    return match.group(1)


def main() -> None:
    if len(sys.argv) != 2 or not BASE58.match(sys.argv[1]):
        sys.exit(__doc__)
    new = sys.argv[1]
    old = current_id()
    if old == new:
        print("program id is already", new)
        return
    for rel in FILES:
        path = ROOT / rel
        text = path.read_text()
        count = text.count(old)
        if count:
            path.write_text(text.replace(old, new))
        print(f"{count:3d} replaced  {rel}")
    print(f"\nprogram id: {old} -> {new}")
    print("Now rebuild: cargo build-sbf --tools-version v1.53, then node ui/build.js")


if __name__ == "__main__":
    main()
