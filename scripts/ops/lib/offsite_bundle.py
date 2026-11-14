#!/usr/bin/env python3
"""offsite_bundle.py — manifest / checksum / comparison helper shared by
scripts/ops/offsite-backup.sh (capture) and scripts/ops/restore-verify.sh (proof).

Standard library only. PRIVACY CONTRACT: this tool prints catalogue identifiers
(schema / table / constraint names), counts and PASS/FAIL verdicts — never row
contents and never Storage object keys (file names can embed customer names).
With --redact it additionally withholds every row/object COUNT, because the
workflow that calls it runs in a PUBLIC repository whose logs are world-readable.

Exit codes: 0 = ok / all checks passed, 1 = a check failed, 2 = usage / IO error.
"""
import argparse
import hashlib
import json
import os
import sys
import tarfile

FORMAT = "crewflow-offsite/1"
SUMS = "SHA256SUMS"
MANIFEST = "MANIFEST.json"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def walk(root):
    """Sorted POSIX-style relative paths of every regular file under root."""
    out = []
    for base, _dirs, names in os.walk(root):
        for name in names:
            full = os.path.join(base, name)
            if os.path.isfile(full) and not os.path.islink(full):
                out.append(os.path.relpath(full, root).replace(os.sep, "/"))
    return sorted(out)


def load(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


class Report:
    """Collects PASS/FAIL lines; prints them; knows whether anything failed."""

    def __init__(self):
        self.failed = 0
        self.passed = 0

    def ok(self, name, detail=""):
        self.passed += 1
        print("PASS  %-34s %s" % (name, detail))

    def fail(self, name, detail=""):
        self.failed += 1
        print("FAIL  %-34s %s" % (name, detail))

    def check(self, cond, name, ok_detail="", fail_detail=""):
        if cond:
            self.ok(name, ok_detail)
        else:
            self.fail(name, fail_detail)
        return cond


def obj_key(o):
    return "%s/%s" % (o["bucket"], o["name"])


# --------------------------------------------------------------------------- #
# capture side
# --------------------------------------------------------------------------- #
def cmd_build_manifest(a):
    facts = load(a.facts)
    post = load(a.post_objects) if a.post_objects else facts["storage_objects"]
    bundle = a.bundle
    storage_root = os.path.join(bundle, "storage")
    on_disk = {}
    if os.path.isdir(storage_root):
        for rel in walk(storage_root):
            full = os.path.join(storage_root, rel)
            on_disk[rel] = {"bytes": os.path.getsize(full), "sha256": sha256_file(full)}

    pre = {obj_key(o): o.get("size") for o in facts["storage_objects"]}
    aft = {obj_key(o): o.get("size") for o in post}

    # An object present in the DB BOTH at the dump snapshot and after the copy
    # finished existed for the whole window: it MUST have been captured, at the
    # size the DB records. Objects seen on only one side were created/deleted
    # while the backup ran — tolerated, recorded, never silently dropped.
    problems = []
    for key in sorted(set(pre) & set(aft)):
        if key not in on_disk:
            problems.append("missing")
        elif pre[key] is not None and pre[key] == aft[key] and on_disk[key]["bytes"] != pre[key]:
            problems.append("size")
    deleted_during = sorted(k for k in pre if k not in aft and k not in on_disk)
    extra = sorted(k for k in on_disk if k not in pre)

    dump = os.path.join(bundle, "db", "db.dump")
    manifest = {
        "format": FORMAT,
        "created_at": a.created_at,
        "stamp": a.stamp,
        "runner": a.runner,
        "pg_image": a.pg_image,
        "facts": {k: v for k, v in facts.items() if k != "storage_objects"},
        "db": {
            "file": "db/db.dump",
            "bytes": os.path.getsize(dump),
            "sha256": sha256_file(dump),
            "toc_entries": a.toc_entries,
            "pg_dump_format": "custom",
        },
        "storage": {
            "object_count": len(on_disk),
            "total_bytes": sum(v["bytes"] for v in on_disk.values()),
            "db_rows_at_snapshot": len(pre),
            "objects": [
                {"key": k, "bytes": v["bytes"], "sha256": v["sha256"], "in_db_snapshot": k in pre}
                for k, v in sorted(on_disk.items())
            ],
            "deleted_during_backup": deleted_during,
            "created_during_backup": extra,
        },
    }
    with open(os.path.join(bundle, MANIFEST), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1, sort_keys=True)
        fh.write("\n")

    summary = {
        "tables": len(facts["table_counts"]),
        "schemas": facts["schemas"],
        "migration_tip": facts["migration_tip"],
        "storage_objects": len(on_disk),
        "storage_missing": problems.count("missing"),
        "storage_size_mismatch": problems.count("size"),
        "storage_deleted_during_backup": len(deleted_during),
        "storage_created_during_backup": len(extra),
    }
    print(json.dumps(summary, sort_keys=True))
    return 1 if problems else 0


def cmd_write_sums(a):
    lines = []
    for rel in walk(a.bundle):
        if rel == SUMS:
            continue
        lines.append("%s  %s\n" % (sha256_file(os.path.join(a.bundle, rel)), rel))
    with open(os.path.join(a.bundle, SUMS), "w", encoding="utf-8") as fh:
        fh.writelines(lines)
    print(len(lines))
    return 0


def cmd_sidecar(a):
    """Small NON-SENSITIVE JSON uploaded next to the artefact (and mirrored in
    the heartbeat row). No table names, no row counts, no object keys."""
    m = load(os.path.join(a.bundle, MANIFEST))
    doc = {
        "format": FORMAT,
        "artefact": os.path.basename(a.artefact),
        "encrypted_bytes": os.path.getsize(a.artefact),
        "encrypted_sha256": sha256_file(a.artefact),
        "plaintext_tar_sha256": a.tar_sha256,
        "created_at": m["created_at"],
        "runner": m["runner"],
        "migration_tip": m["facts"]["migration_tip"],
        "pg_server_version": m["facts"]["server_version"],
        "pg_image": m["pg_image"],
        "encryption": "age (X25519 recipients; the runner holds no identity)",
        "recipient_fingerprints": a.recipient_fp,
    }
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write("\n")
    print(doc["encrypted_sha256"])
    return 0


# --------------------------------------------------------------------------- #
# proof side
# --------------------------------------------------------------------------- #
def cmd_safe_extract(a):
    """Extract a bundle tar, refusing anything that could escape the target
    directory (absolute paths, '..', links, devices). Prints the bundle root."""
    dest = os.path.realpath(a.dest)
    roots = set()
    try:
        with tarfile.open(a.tar, "r:") as tf:
            for member in tf:
                name = member.name
                if not (member.isfile() or member.isdir()):
                    print("unsafe tar member type", file=sys.stderr)
                    return 1
                target = os.path.realpath(os.path.join(dest, name))
                if name.startswith("/") or not (target == dest or target.startswith(dest + os.sep)):
                    print("unsafe tar member path", file=sys.stderr)
                    return 1
                roots.add(name.split("/", 1)[0])
                tf.extract(member, dest, set_attrs=False)
    except (tarfile.TarError, EOFError, OSError) as exc:
        print("tar extraction failed: %s" % type(exc).__name__, file=sys.stderr)
        return 1
    if len(roots) != 1:
        print("expected exactly one top-level directory in the bundle", file=sys.stderr)
        return 1
    print(os.path.join(dest, roots.pop()))
    return 0


def cmd_verify_bundle(a):
    r = Report()
    bundle = a.bundle
    try:
        m = load(os.path.join(bundle, MANIFEST))
    except (OSError, ValueError):
        r.fail("manifest readable", "MANIFEST.json missing or not valid JSON")
        return 1
    r.check(m.get("format") == FORMAT, "manifest format", FORMAT, "unexpected format %r" % m.get("format"))

    listed = {}
    try:
        with open(os.path.join(bundle, SUMS), "r", encoding="utf-8") as fh:
            for line in fh:
                digest, rel = line.rstrip("\n").split("  ", 1)
                listed[rel] = digest
    except (OSError, ValueError):
        r.fail("checksum file readable", "SHA256SUMS missing or malformed")
        return 1
    present = [p for p in walk(bundle) if p != SUMS]
    missing = sorted(set(listed) - set(present))
    unlisted = sorted(set(present) - set(listed))
    bad = sorted(p for p in present if p in listed and sha256_file(os.path.join(bundle, p)) != listed[p])
    r.check(not missing, "bundle files present", "%d listed" % len(listed), "%d listed file(s) missing" % len(missing))
    r.check(not unlisted, "no unlisted files", "", "%d file(s) not in SHA256SUMS" % len(unlisted))
    r.check(not bad, "bundle checksums (sha256)", "%d file(s) verified" % (len(present) - len(bad)),
            "%d file(s) fail their checksum" % len(bad))

    dump = os.path.join(bundle, m["db"]["file"])
    r.check(os.path.isfile(dump) and os.path.getsize(dump) == m["db"]["bytes"]
            and sha256_file(dump) == m["db"]["sha256"],
            "db dump matches manifest", "", "size or sha256 differs from MANIFEST.json")

    objs = m["storage"]["objects"]
    wrong = 0
    for o in objs:
        full = os.path.join(bundle, "storage", o["key"])
        if not os.path.isfile(full) or os.path.getsize(full) != o["bytes"] or sha256_file(full) != o["sha256"]:
            wrong += 1
    disk = walk(os.path.join(bundle, "storage")) if os.path.isdir(os.path.join(bundle, "storage")) else []
    n = "withheld" if a.redact else str(len(objs))
    r.check(len(disk) == len(objs) == m["storage"]["object_count"], "storage object count",
            "matches manifest (%s)" % n, "files on disk != manifest object_count")
    r.check(wrong == 0, "storage object checksums", "every object matches its sha256 + size",
            "%s object(s) missing or altered" % ("some" if a.redact else wrong))
    return 1 if r.failed else 0


def cmd_prep_sql(a):
    """SQL that makes a clean throwaway database able to receive the dump:
    roles the dump's ownership/ACLs reference, the extensions the schema depends
    on, and any publication. Identifiers come from the manifest and are quoted."""
    m = load(os.path.join(a.bundle, MANIFEST))
    f = m["facts"]

    def qi(s):
        return '"' + str(s).replace('"', '""') + '"'

    def ql(s):
        return "'" + str(s).replace("'", "''") + "'"

    out = ["\\set ON_ERROR_STOP on", "set client_min_messages = warning;"]
    for role in f.get("roles") or []:
        out.append(
            "do $do$ begin if not exists (select 1 from pg_roles where rolname = %s) "
            "then create role %s nologin; end if; end $do$;" % (ql(role), qi(role))
        )
    for ext in f.get("extensions") or []:
        if ext["name"] == "plpgsql":
            continue
        out.append("create schema if not exists %s;" % qi(ext["schema"]))
        out.append("create extension if not exists %s with schema %s;" % (qi(ext["name"]), qi(ext["schema"])))
    for pub in f.get("publications") or []:
        out.append(
            "do $do$ begin if not exists (select 1 from pg_publication where pubname = %s) "
            "then create publication %s; end if; end $do$;" % (ql(pub), qi(pub))
        )
    print("\n".join(out))
    return 0


def cmd_compare(a):
    m = load(os.path.join(a.bundle, MANIFEST))
    src = m["facts"]
    got = load(a.restored)
    r = Report()
    red = a.redact

    r.check(got["server_version_num"] // 10000 == src["server_version_num"] // 10000,
            "postgres major version", "restored on PG %s (source PG %s)" % (got["server_version"], src["server_version"]),
            "restored on PG %s but source was PG %s" % (got["server_version"], src["server_version"]))
    r.check(got["migration_tip"] == src["migration_tip"], "migration tip",
            str(src["migration_tip"]), "expected %s got %s" % (src["migration_tip"], got["migration_tip"]))
    r.check(got["migration_count"] == src["migration_count"], "migration count",
            str(src["migration_count"]), "expected %s got %s" % (src["migration_count"], got["migration_count"]))
    r.check(got["schemas"] == src["schemas"], "schemas restored", ",".join(src["schemas"]),
            "expected %s got %s" % (src["schemas"], got["schemas"]))

    so, go = src["object_counts"], got["object_counts"]
    diffs = sorted(k for k in set(so) | set(go) if so.get(k, 0) != go.get(k, 0))
    r.check(not diffs, "schema object counts",
            "%d counters identical (tables, indexes, constraints, policies, triggers, functions, grants ...)" % len(so),
            "%d counter(s) differ" % len(diffs))
    for k in diffs[:40]:
        print("        %-48s expected %s restored %s" % (k, so.get(k, 0), go.get(k, 0)))

    invalid = sum(v for k, v in go.items() if k.endswith(".indexes_invalid"))
    r.check(invalid == 0, "indexes valid", "0 invalid indexes", "%d invalid index(es)" % invalid)

    st, gt = src["table_counts"], got["table_counts"]
    tdiff = sorted(k for k in set(st) | set(gt) if st.get(k) != gt.get(k))
    total = "withheld" if red else str(sum(st.values()))
    r.check(not tdiff, "per-table row counts",
            "%d tables identical (rows: %s)" % (len(st), total),
            "%d of %d table(s) differ" % (len(tdiff), len(st)))
    for k in tdiff[:40]:
        if red:
            print("        %s" % k)
        else:
            print("        %-48s expected %s restored %s" % (k, st.get(k), gt.get(k)))

    # Storage payload <-> restored storage.objects rows.
    rows = {obj_key(o): o.get("size") for o in got["storage_objects"]}
    files = {o["key"]: o["bytes"] for o in m["storage"]["objects"]}
    tolerated = set(m["storage"].get("deleted_during_backup") or [])
    orphan_rows = [k for k in rows if k not in files and k not in tolerated]
    wrong_size = [k for k in rows if k in files and rows[k] is not None and rows[k] != files[k]]
    expected_in_db = [o["key"] for o in m["storage"]["objects"] if o.get("in_db_snapshot")]
    no_row = [k for k in expected_in_db if k not in rows]
    n = "withheld" if red else str(len(rows))
    r.check(not orphan_rows and not wrong_size and not no_row, "storage rows <-> payload",
            "every restored storage.objects row has its file, sizes agree (rows: %s)" % n,
            "%s row(s) without a file, %s size mismatch(es), %s file(s) without a row"
            % (("some",) * 3 if red else (len(orphan_rows), len(wrong_size), len(no_row))))
    return 1 if r.failed else 0


def cmd_field(a):
    """Print one top-level-or-dotted field of a JSON file (helper for bash)."""
    cur = load(a.file)
    for part in a.path.split("."):
        cur = cur[part]
    print(cur if not isinstance(cur, (dict, list)) else json.dumps(cur))
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("build-manifest")
    s.add_argument("--bundle", required=True)
    s.add_argument("--facts", required=True)
    s.add_argument("--post-objects")
    s.add_argument("--stamp", required=True)
    s.add_argument("--created-at", required=True)
    s.add_argument("--runner", required=True)
    s.add_argument("--pg-image", required=True)
    s.add_argument("--toc-entries", type=int, default=0)
    s.set_defaults(fn=cmd_build_manifest)

    s = sub.add_parser("write-sums")
    s.add_argument("--bundle", required=True)
    s.set_defaults(fn=cmd_write_sums)

    s = sub.add_parser("sidecar")
    s.add_argument("--bundle", required=True)
    s.add_argument("--artefact", required=True)
    s.add_argument("--tar-sha256", required=True)
    s.add_argument("--recipient-fp", action="append", default=[])
    s.add_argument("--out", required=True)
    s.set_defaults(fn=cmd_sidecar)

    s = sub.add_parser("safe-extract")
    s.add_argument("--tar", required=True)
    s.add_argument("--dest", required=True)
    s.set_defaults(fn=cmd_safe_extract)

    s = sub.add_parser("verify-bundle")
    s.add_argument("--bundle", required=True)
    s.add_argument("--redact", action="store_true")
    s.set_defaults(fn=cmd_verify_bundle)

    s = sub.add_parser("prep-sql")
    s.add_argument("--bundle", required=True)
    s.set_defaults(fn=cmd_prep_sql)

    s = sub.add_parser("compare")
    s.add_argument("--bundle", required=True)
    s.add_argument("--restored", required=True)
    s.add_argument("--redact", action="store_true")
    s.set_defaults(fn=cmd_compare)

    s = sub.add_parser("field")
    s.add_argument("--file", required=True)
    s.add_argument("--path", required=True)
    s.set_defaults(fn=cmd_field)

    a = p.parse_args()
    try:
        return a.fn(a)
    except (OSError, KeyError, ValueError) as exc:
        # Type only: an exception message could echo a path or a value.
        print("offsite_bundle: %s failed (%s)" % (a.cmd, type(exc).__name__), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
