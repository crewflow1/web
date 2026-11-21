#!/usr/bin/env python3
"""
Shingle-based copied-code detector.

Question answered: does any multi-line block of CrewFlow's own source also appear verbatim
(modulo whitespace) in a third-party source tree? Used against the inspect-only research clones
(policy: never copied into the product) but works for any directory.

Method: normalise each source line (strip, collapse whitespace), drop short/boilerplate lines
(imports, braces, comments-only <20 chars), then hash every window of K consecutive kept lines
(default K=8). CrewFlow windows form the index; each third-party file is streamed and every
matching window is recorded. Output = pairs (third-party file, crewflow file, #matching windows).
A hit is a LEAD, not a verdict: boilerplate (framework config, generated types) can match.

Usage: python3 -I scripts/compliance/copy-detect.py --self <repo root> --other <dir> [--k 8] [--out hits.json]
"""
import argparse, hashlib, json, os, re, sys
from collections import defaultdict

EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".css", ".sql"}
SKIP_DIRS = {"node_modules", ".git", ".next", "dist", "build", ".scratch", "compliance", "coverage", "__snapshots__"}
SELF_DIRS = ["app", "lib", "server", "components", "scripts", "sdks", "e2e", "__tests__", "middleware.ts", "instrumentation.ts", "tailwind.config.ts", "next.config.ts"]
BORING = re.compile(r"^(import |export \* |export \{|\} from|from |//|/\*|\*|\*/|\}|\)|\]|\{|\[|<\/|'use |\"use )")
WS = re.compile(r"\s+")


def kept_lines(path):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            data = fh.read()
    except OSError:
        return []
    if len(data) > 400_000:
        return []
    out = []
    for ln in data.splitlines():
        s = WS.sub(" ", ln.strip())
        if len(s) < 25 or BORING.match(s):
            continue
        out.append(s)
    return out


def windows(lines, k):
    for i in range(0, max(0, len(lines) - k + 1)):
        yield hashlib.blake2b("\n".join(lines[i:i + k]).encode(), digest_size=10).digest()


def walk(base):
    if os.path.isfile(base):
        yield base
        return
    for dp, dns, fns in os.walk(base):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for f in fns:
            if os.path.splitext(f)[1] in EXTS:
                yield os.path.join(dp, f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--self", dest="self_root", required=True)
    ap.add_argument("--other", required=True)
    ap.add_argument("--k", type=int, default=8)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    index = defaultdict(set)  # hash -> {crewflow files}
    nself = 0
    for d in SELF_DIRS:
        for p in walk(os.path.join(a.self_root, d)):
            nself += 1
            rel = os.path.relpath(p, a.self_root)
            for h in set(windows(kept_lines(p), a.k)):
                index[h].add(rel)
    print(f"indexed {nself} CrewFlow files, {len(index)} windows", file=sys.stderr)

    hits = defaultdict(int)
    nother = 0
    for p in walk(a.other):
        nother += 1
        for h in set(windows(kept_lines(p), a.k)):
            for rel in index.get(h, ()):
                hits[(p, rel)] += 1
    print(f"scanned {nother} third-party files; {len(hits)} file pairs with >=1 shared window", file=sys.stderr)
    res = sorted(({"other": o, "crewflow": c, "windows": n} for (o, c), n in hits.items()), key=lambda r: -r["windows"])
    if a.out:
        with open(a.out, "w") as fh:
            json.dump(res, fh, indent=1)
    for r in res[:40]:
        print(r["windows"], r["other"], "<->", r["crewflow"])


if __name__ == "__main__":
    main()
