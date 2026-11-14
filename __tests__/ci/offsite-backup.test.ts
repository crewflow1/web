import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Independent off-site backup — existence + safety pin.
 *
 * Why this file exists: the backup runner is configuration that fails by DOING
 * NOTHING (delete the file, drop the schedule) or — worse, because this
 * repository is PUBLIC — by quietly LEAKING (print a count, attach an artifact,
 * interpolate a secret into a script). Neither failure shows up in any other
 * test. Same doctrine as outage-monitor.test.ts: source assertions over the
 * workflow + the scripts it runs, plus the real `--check-config` gate executed
 * with a controlled environment.
 */

const ROOT = resolve(__dirname, "..", "..");
const WF_PATH = resolve(ROOT, ".github/workflows/offsite-backup.yml");
const ENGINE = resolve(ROOT, "scripts/ops/offsite-backup.sh");
const VERIFY = resolve(ROOT, "scripts/ops/restore-verify.sh");
const LIB = resolve(ROOT, "scripts/ops/lib");

const SECRET_NAMES = [
  "OFFSITE_BACKUP_AGE_RECIPIENTS",
  "OFFSITE_BACKUP_B2_APPLICATION_KEY",
  "OFFSITE_BACKUP_B2_BUCKET",
  "OFFSITE_BACKUP_B2_KEY_ID",
  "OFFSITE_BACKUP_DB_URL",
  "OFFSITE_BACKUP_HEALTHCHECK_URL",
  "OFFSITE_BACKUP_S3_ACCESS_KEY_ID",
  "OFFSITE_BACKUP_S3_ENDPOINT",
  "OFFSITE_BACKUP_S3_REGION",
  "OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY",
];

/** Run the engine's config gate with ONLY the given CF_OFFSITE_* variables. */
function checkConfig(vars: Record<string, string>) {
  const res = spawnSync("bash", [ENGINE, "--check-config"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...vars },
    encoding: "utf8",
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}`.trim() };
}

const FULL = {
  CF_OFFSITE_DB_URL: "x",
  CF_OFFSITE_S3_ENDPOINT: "x",
  CF_OFFSITE_S3_REGION: "x",
  CF_OFFSITE_S3_ACCESS_KEY_ID: "x",
  CF_OFFSITE_S3_SECRET_ACCESS_KEY: "x",
  CF_OFFSITE_AGE_RECIPIENTS: "x",
  CF_OFFSITE_B2_KEY_ID: "x",
  CF_OFFSITE_B2_APPLICATION_KEY: "x",
  CF_OFFSITE_B2_BUCKET: "x",
};

describe("offsite-backup workflow — exists, scheduled, inert until configured", () => {
  it("the workflow file exists", () => {
    expect(existsSync(WF_PATH)).toBe(true);
  });

  const WF = readFileSync(WF_PATH, "utf8");
  const TRIGGERS = WF.slice(WF.indexOf("\non:"), WF.indexOf("\npermissions:"));

  it("runs daily and can be dispatched manually — and by nothing else", () => {
    expect(TRIGGERS).toMatch(/schedule:/);
    expect(TRIGGERS).toMatch(/cron: "23 2 \* \* \*"/);
    expect(TRIGGERS).toMatch(/workflow_dispatch:/);
    // A PR/fork must never be able to run a job that holds production secrets.
    expect(TRIGGERS).not.toMatch(/pull_request/);
    expect(TRIGGERS).not.toMatch(/\bpush:/);
    expect(TRIGGERS).not.toMatch(/workflow_run|issue_comment|repository_dispatch/);
  });

  it("does nothing, successfully, when no secret is set (the inert gate)", () => {
    expect(WF).toMatch(/offsite-backup\.sh --check-config/);
    expect(WF).toMatch(/NOT_CONFIGURED\)[\s\S]*?configured=false[\s\S]*?exit 0/);
    expect(WF).toMatch(/::notice title=Off-site backup not configured::/);
    // Every working step is conditional on the gate.
    const gated = WF.match(/if: steps\.gate\.outputs\.configured == 'true'/g) ?? [];
    expect(gated.length).toBeGreaterThanOrEqual(3);
  });

  it("the real gate: none set → NOT_CONFIGURED/0, partial → names missing/2, all set → CONFIGURED/0", () => {
    expect(checkConfig({})).toEqual({ status: 0, out: "NOT_CONFIGURED" });

    const partial = checkConfig({ CF_OFFSITE_DB_URL: "postgresql://secret-value" });
    expect(partial.status).toBe(2);
    expect(partial.out).toMatch(/^PARTIALLY_CONFIGURED missing:/);
    expect(partial.out).toContain("CF_OFFSITE_AGE_RECIPIENTS");
    expect(partial.out).toContain("CF_OFFSITE_B2_BUCKET");
    // Names only — a configured value is never echoed back.
    expect(partial.out).not.toContain("secret-value");

    expect(checkConfig(FULL)).toEqual({ status: 0, out: "CONFIGURED" });
  });

  it("is least-privilege and never runs on a fork", () => {
    expect(WF).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(WF).not.toMatch(/contents: write|id-token:|pull-requests: write|deployments: write/);
    const guards = WF.match(/github\.repository == 'crewflow1\/web'/g) ?? [];
    expect(guards.length).toBe(2); // backup job + keepalive job
    // Secrets live in a branch-restricted environment.
    expect(WF).toMatch(/environment: offsite-backup/);
    // The job that holds secrets cannot touch workflows; the keepalive job holds no secrets.
    const keepalive = WF.slice(WF.indexOf("\n  keepalive:"));
    expect(keepalive).toMatch(/actions: write/);
    expect(keepalive).not.toMatch(/secrets\./);
  });

  it("pins every action by commit SHA and the Postgres image by digest", () => {
    const uses = WF.match(/^\s*-?\s*uses: .+$/gm) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}(\s+#.*)?$/);
    // Only first-party checkout — no third-party action sees plaintext or secrets.
    expect(uses.every((u) => /uses: actions\/checkout@/.test(u))).toBe(true);
    expect(WF).toMatch(/CF_PG_IMAGE: "ghcr\.io\/supabase\/postgres@sha256:[0-9a-f]{64}"/);
    expect(WF).toMatch(/runs-on: ubuntu-24\.04/);
    expect(WF).not.toMatch(/ubuntu-latest/);
  });
});

describe("offsite-backup — nothing sensitive can reach a PUBLIC log", () => {
  const WF = readFileSync(WF_PATH, "utf8");

  it("uploads no workflow artifact and uses no cache", () => {
    expect(WF).not.toMatch(/upload-artifact|actions\/cache|\bcache:/);
  });

  it("keeps count redaction ON and the debug-log escape hatch OFF", () => {
    expect(WF).toMatch(/CF_OFFSITE_REDACT: "1"/);
    expect(WF).not.toMatch(/CF_OFFSITE_REDACT: "0"/);
    expect(WF).not.toMatch(/CF_OFFSITE_DEBUG_LOG_DIR/);
  });

  it("references exactly the documented secrets, and only as env mappings", () => {
    const names = [...new Set((WF.match(/secrets\.([A-Z0-9_]+)/g) ?? []).map((s) => s.slice(8)))].sort();
    expect(names).toEqual(SECRET_NAMES);
    // `${{ secrets.X }}` must only ever be the VALUE of an env key — never inside
    // a `run:` script (expression interpolation into a shell is injectable and
    // defeats log masking for derived strings).
    for (const line of WF.split("\n").filter((l) => /\$\{\{\s*secrets\./.test(l))) {
      expect(line).toMatch(/^\s+[A-Z0-9_]+: \$\{\{ secrets\.[A-Z0-9_]+ \}\}$/);
    }
  });

  it("the public failure issue is generic and deduplicated", () => {
    expect(WF).toMatch(/gh issue list[^\n]*--state open[^\n]*--label backup-failure/);
    expect(WF).toMatch(/gh issue create/);
    expect(WF).toMatch(/gh issue close/);
    expect(WF).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
  });

  it("no script ever enables shell tracing (which would print credentials)", () => {
    for (const f of [ENGINE, VERIFY, resolve(LIB, "offsite-pgdump.sh")]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/^\s*set\s+-[a-zA-Z]*x/m);
      expect(src).not.toMatch(/xtrace/);
    }
    expect(WF).not.toMatch(/set -[a-zA-Z]*x/);
  });
});

describe("offsite-backup engine — shape of the guarantees", () => {
  const SRC = readFileSync(ENGINE, "utf8");
  const RV = readFileSync(VERIFY, "utf8");
  const CAPTURE = readFileSync(resolve(LIB, "offsite-capture.psql"), "utf8");

  it("the scripts parse", () => {
    for (const f of [ENGINE, VERIFY, resolve(ROOT, "scripts/ops/offsite-backup-e2e-local.sh")]) {
      expect(spawnSync("bash", ["-n", f]).status).toBe(0);
    }
    expect(spawnSync("sh", ["-n", resolve(LIB, "offsite-pgdump.sh")]).status).toBe(0);
  });

  it("captures the dump and its manifest in ONE read-only snapshot", () => {
    expect(CAPTURE).toMatch(/begin transaction isolation level repeatable read read only;/);
    expect(CAPTURE).toMatch(/pg_export_snapshot\(\)/);
    expect(readFileSync(resolve(LIB, "offsite-pgdump.sh"), "utf8")).toMatch(/--snapshot="\$CF_SNAPSHOT"/);
  });

  it("can only encrypt: public recipients, private keys refused", () => {
    expect(SRC).toMatch(/AGE-SECRET-KEY-\*\) abort/);
    expect(SRC).toMatch(/\^age1\[0-9a-z\]\{58\}\$/);
    // No decrypt of a real artefact anywhere in the engine: the only --decrypt is
    // the throwaway-key tool self-test.
    const decrypts = SRC.match(/age --decrypt[^\n]*/g) ?? [];
    expect(decrypts.length).toBe(1);
    expect(decrypts[0]).toContain("selftest.key");
  });

  it("is append-only off-site: it never deletes, syncs or purges the destination", () => {
    expect(SRC).not.toMatch(/rclone\s+(delete|deletefile|purge|rmdir|rmdirs|sync|move|moveto|cleanup)\b/);
    expect(SRC).toMatch(/--no-check-dest --no-traverse/);
  });

  it("records success only after upload AND restore verification, tagged per runner", () => {
    expect(SRC.indexOf('UPLOAD_STATUS="uploaded"')).toBeLessThan(SRC.indexOf('STATUS="success"'));
    expect(SRC.indexOf("restore-verify.sh")).toBeLessThan(SRC.indexOf('STATUS="success"'));
    expect(SRC).toMatch(/RUNNER_TAG="\$\{CF_OFFSITE_RUNNER_TAG:-github-actions\}"/);
    expect(SRC).toMatch(/insert into public\.ops_backup_runs/);
  });

  it("always destroys the plaintext work dir, and restore-verify its container", () => {
    expect(SRC).toMatch(/trap cleanup EXIT/);
    expect(SRC).toMatch(/rm -rf "\$WORK"/);
    expect(RV).toMatch(/docker rm -f -v "\$CONTAINER"/);
    expect(RV).toMatch(/--network none/);
  });
});
