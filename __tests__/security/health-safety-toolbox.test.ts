import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Toolbox Talks — security source-contracts. Runtime behaviour is proven against
 * real Postgres in __tests__/integration/health-safety/toolbox-talks + the RLS
 * isolation suite; these lock the load-bearing rules AT THE SOURCE so a later edit
 * that quietly weakens an invariant fails CI. Mirrors health-safety.test.ts.
 */

const root = join(__dirname, "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/20261025000000_health_safety_toolbox_talks.sql"), "utf8");
const ackMigration = readFileSync(join(root, "supabase/migrations/20261026000000_toolbox_talk_acknowledgements.sql"), "utf8");
const revMigration = readFileSync(join(root, "supabase/migrations/20261027000000_toolbox_talk_revision_snapshot.sql"), "utf8");
const attMigration = readFileSync(join(root, "supabase/migrations/20261028000000_toolbox_talk_attachment_freeze.sql"), "utf8");
const attachPanel = readFileSync(join(root, "components/attachments/AttachmentsPanel.tsx"), "utf8");
const hsSnapshot = readFileSync(join(root, "server/services/health-safety-snapshot.ts"), "utf8");
const hsSignals = readFileSync(join(root, "lib/health-safety/signals.ts"), "utf8");
const jobSafety = readFileSync(join(root, "app/(app)/jobs/[id]/_job-safety.tsx"), "utf8");
const actions = readFileSync(join(root, "app/(app)/toolbox/actions.ts"), "utf8");
const options = readFileSync(join(root, "app/(app)/toolbox/_form-options.ts"), "utf8");
const snapshotLib = readFileSync(join(root, "lib/toolbox-talks/snapshot.ts"), "utf8");
const domainLib = readFileSync(join(root, "lib/health-safety/toolbox-talks.ts"), "utf8");
const ackLib = readFileSync(join(root, "lib/health-safety/acknowledgements.ts"), "utf8");
const signoffActions = readFileSync(join(root, "app/(app)/health-safety/signoff-actions.ts"), "utf8");
const signoffData = readFileSync(join(root, "app/(app)/health-safety/_signoff-data.ts"), "utf8");
const detailPage = readFileSync(join(root, "app/(app)/toolbox/[id]/page.tsx"), "utf8");
const pdfRoute = readFileSync(join(root, "app/api/health-safety/toolbox-talks/[id]/pdf/route.ts"), "utf8");
const pdfLib = readFileSync(join(root, "lib/pdf/toolbox-talk-pdf.tsx"), "utf8");

describe("toolbox migration — evidence lifecycle is DB-enforced (20261025)", () => {
  it("[born-draft] no INSERT can mint an issued talk — the trigger fires on INSERT too", () => {
    expect(migration).toMatch(/tg_tt_a_lifecycle/);
    expect(migration).toMatch(/before insert or update on public\.toolbox_talks/);
    expect(migration).toMatch(/a toolbox talk is created as a draft/);
  });

  it("[issue-gate] delivering (draft->issued) needs a topic + key points, only for JWT callers", () => {
    expect(migration).toMatch(/a toolbox talk needs a topic and key points before it can be delivered/);
    // gate + provenance pin apply only to real callers; the trusted service role keeps explicit values
    expect(migration).toMatch(/auth\.uid\(\) is not null/);
  });

  it("[provenance] issue pins issued_by = auth.uid() and issued_at = now() server-side", () => {
    expect(migration).toMatch(/new\.issued_by := auth\.uid\(\)/);
    expect(migration).toMatch(/new\.issued_at := now\(\)/);
  });

  it("[immutable] an issued talk is frozen: content/links/lineage/provenance + write-once snapshot", () => {
    expect(migration).toMatch(/tg_tt_m_immutable/);
    expect(migration).toMatch(/a % toolbox talk is immutable; raise a new revision instead/);
    expect(migration).toMatch(/the toolbox talk evidence snapshot is frozen once set/);
    // forward-only status: issued -> superseded|withdrawn only
    expect(migration).toMatch(/invalid toolbox talk status transition/);
  });

  it("[reference] a draft carries no reference; a non-draft must (CHECK), unique per org", () => {
    expect(migration).toMatch(/\(status = 'draft'\) = \(reference is null\)/);
    expect(migration).toMatch(/toolbox_talks_org_reference_key unique \(org_id, reference\)/);
    expect(migration).toMatch(/status = 'draft' or issued_at is not null/); // issued_stamp
  });

  it("[one-current] exactly one issued + one draft per revision series (partial unique indexes)", () => {
    expect(migration).toMatch(/toolbox_talks_one_current_idx[\s\S]*?root_toolbox_talk_id\) where status = 'issued'/);
    expect(migration).toMatch(/toolbox_talks_one_draft_idx[\s\S]*?root_toolbox_talk_id\) where status = 'draft'/);
    expect(migration).toMatch(/\(root_toolbox_talk_id, revision_number\)/);
  });

  it("[lineage] revision integrity: self-root on insert, same-org/same-series, never self-supersede", () => {
    expect(migration).toMatch(/tg_tt_revision_integrity/);
    expect(migration).toMatch(/new\.root_toolbox_talk_id := new\.id/);
    expect(migration).toMatch(/a toolbox talk cannot supersede itself/);
    expect(migration).toMatch(/must be another revision of the same series/);
  });

  it("[links] job/RAMS/permit links are validated same-org via a trigger (not a cascade FK)", () => {
    expect(migration).toMatch(/tg_tt_validate_links/);
    expect(migration).toMatch(/is not in this organisation/);
    // bare FK + ON DELETE SET NULL (evidence survives the linked doc's deletion)
    expect(migration).toMatch(/references public\.risk_assessments\(id\)\s+on delete set null/);
    expect(migration).toMatch(/references public\.permits_to_work\(id\)\s+on delete set null/);
  });

  it("[delete-guard] issued evidence is non-deletable via a TRIGGER (role-independent), draft-only RLS", () => {
    expect(migration).toMatch(/tg_tt_block_delete_when_issued/);
    expect(migration).toMatch(/before delete on public\.toolbox_talks/);
    expect(migration).toMatch(/a delivered toolbox talk is H&S evidence and cannot be deleted/);
    // org teardown (cascade) is still allowed — the org row is gone by then
    expect(migration).toMatch(/exists \(select 1 from public\.organizations where id = old\.org_id\)/);
    // JWT-path defence-in-depth: admin + draft only
    expect(migration).toMatch(/toolbox_talks_delete[\s\S]*?is_org_admin\(org_id\) and status = 'draft'/);
  });

  it("[numbering] next_tbt_number gates the caller to their own org (no cross-org count oracle)", () => {
    expect(migration).toMatch(/function public\.next_tbt_number/);
    expect(migration).toMatch(/not a member of organisation/);
    expect(migration).toMatch(/target_org not in \(select public\.current_org_ids\(\)\)/);
    // TBT-NNNN, and revisions (-R0n) never advance the sequence
    expect(migration).toMatch(/'TBT-' \|\| lpad/);
    expect(migration).toMatch(/reference ~ '\^TBT-\\d\+'/);
  });

  it("[atomic revision] issue_toolbox_talk_revision is SECURITY INVOKER, row-locked, supersede+promote", () => {
    expect(migration).toMatch(/function public\.issue_toolbox_talk_revision/);
    expect(migration).toMatch(/security invoker/);
    expect(migration).toMatch(/for update/);
    expect(migration).toMatch(/set status = 'superseded'\s*\n?\s*where root_toolbox_talk_id = v_root and status = 'issued'/);
  });

  it("every SECURITY DEFINER in the migration pins search_path (no mutable-path escalation)", () => {
    const defs = migration.match(/security definer/g) ?? [];
    const pins = migration.match(/set search_path = public/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    expect(pins.length).toBeGreaterThanOrEqual(defs.length);
  });
});

describe("toolbox server actions — RLS-scoped, never service-role, count-checked", () => {
  it("all writes go through the tenant (user-JWT) client; the service-role client is never used", () => {
    expect(actions).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(actions).not.toMatch(/serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
    expect(options).not.toMatch(/serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
  });

  it("every mutation is requireOrgContext-gated, org-scoped, and count-checked (no false success)", () => {
    expect(actions).toMatch(/requireOrgContext\(\)/);
    expect(actions).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
    expect(actions).toMatch(/if \(!count\)/);
  });

  it("issuing re-checks readiness (canIssue) and allocates via next_tbt_number", () => {
    expect(actions).toMatch(/canIssue\(/);
    expect(actions).toMatch(/next_tbt_number/);
  });

  it("edit + issue are guarded to the draft state (.eq status draft) so an issued write is an honest 404", () => {
    // update + issue both pin status='draft'; a delivered talk can never be re-written by the action
    const draftPins = actions.match(/\.eq\("status", "draft"\)/g) ?? [];
    expect(draftPins.length).toBeGreaterThanOrEqual(3); // update, issue, delete
  });

  it("delete is admin-gated AND draft-only (the DB delete-guard backstops issued evidence)", () => {
    expect(actions).toMatch(/membership\.role !== "owner" && ctx\.membership\.role !== "admin"/);
    expect(actions).toMatch(/deleteToolboxTalk[\s\S]*?\.eq\("status", "draft"\)/);
  });
});

describe("toolbox evidence snapshot — worker-safe by construction (no commercial/PII leak)", () => {
  it("the snapshot source references no cost/rate/margin/price/commercial FIELD", () => {
    // field-shaped tokens only (mirrors the RAMS-PDF convention) so prose like the
    // module's own "no path for cost/rate/margin to enter" doc-comment is not a hit.
    // The runtime snapshot.test.ts scans the BUILT object for the broader word set.
    expect(snapshotLib).not.toMatch(/profit|unit_price|day_rate|_cost|cost_|net_amount|vat_|_margin|margin_|markup|_rate\b/i);
  });

  it("the allowlist carries NO raw foreign keys (job_id / org_id / user_id) — only denormalised strings", () => {
    // links are frozen as reference STRINGS (rams_reference, permit_reference), never live ids
    expect(snapshotLib).toMatch(/TOOLBOX_TALK_SNAPSHOT_KEYS/);
    expect(snapshotLib).not.toMatch(/"job_id"|"org_id"|"user_id"|"customer_id"/);
    expect(snapshotLib).toMatch(/rams_reference/);
    expect(snapshotLib).toMatch(/permit_reference/);
  });

  it("the builder takes only worker-safe inputs — there is no ...spread of an arbitrary row", () => {
    expect(snapshotLib).toMatch(/export function buildToolboxTalkSnapshot/);
    expect(snapshotLib).not.toMatch(/\.\.\.(row|talk|input\b)/); // no wholesale row spread into the snapshot
  });
});

describe("toolbox pure domain — mirrors the DB lifecycle (single source of truth for the UI)", () => {
  it("the four statuses + the issue-gate + transition matrix live in the pure lib", () => {
    expect(domainLib).toMatch(/TOOLBOX_TALK_STATUSES = \["draft", "issued", "superseded", "withdrawn"\]/);
    expect(domainLib).toMatch(/export function canIssue/);
    expect(domainLib).toMatch(/export function canTransition/);
    // "issued" presents as "Delivered" — construction-natural, but the DB status is unchanged
    expect(domainLib).toMatch(/issued: \{ label: "Delivered"/);
  });
});

// ===========================================================================
// M2 — acknowledgement engine integration (20261026)
// ===========================================================================
describe("toolbox M2 — reuses safety_acknowledgements, gates to the issued talk", () => {
  it("EXTENDS the shared engine — there is no toolbox_acknowledgements table", () => {
    expect(ackMigration).toMatch(/safety_acknowledgements/);
    expect(ackMigration).not.toMatch(/create table[\s\S]*?toolbox_acknowledgements/i);
  });

  it("widens the subject_type CHECK to admit 'toolbox_talk' (drop + re-add idiom)", () => {
    expect(ackMigration).toMatch(/drop constraint if exists safety_acknowledgements_subject_type_check/);
    expect(ackMigration).toMatch(/check \(subject_type in \('risk_assessment', 'permit_to_work', 'toolbox_talk'\)\)/);
  });

  it("the validator resolves a toolbox talk's org/reference/status and gates to ISSUED only", () => {
    expect(ackMigration).toMatch(/new\.subject_type = 'toolbox_talk'/);
    expect(ackMigration).toMatch(/from public\.toolbox_talks where id = new\.subject_id/);
    // only a delivered (issued) talk is acknowledgeable — superseded/withdrawn/draft are not
    expect(ackMigration).toMatch(/cannot acknowledge a % toolbox talk/);
    // org_id is still authoritatively derived from the subject (inherited, anti-spoof)
    expect(ackMigration).toMatch(/new\.org_id := s_org/);
  });

  it("the shared ack action routes a toolbox acknowledgement back to /toolbox (tenant-client)", () => {
    expect(signoffActions).toMatch(/subjectType === "toolbox_talk"/);
    expect(signoffActions).toMatch(/`\/toolbox\/\$\{subjectId\}`/);
    expect(signoffActions).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
  });

  it("the pure ack lib knows toolbox_talk + a revisable-subject config (no hardcoded literals downstream)", () => {
    expect(ackLib).toMatch(/ACK_SUBJECT_TYPES = \["risk_assessment", "permit_to_work", "toolbox_talk"\]/);
    expect(ackLib).toMatch(/TOOLBOX_REVISABLE/);
    expect(ackLib).toMatch(/rootColumn/);
  });

  it("priorRevisionSignoff is generic — it uses the subject config, not RAMS literals", () => {
    // the three former RAMS literals are now driven by the RevisableSubject config
    expect(signoffData).toMatch(/subject: RevisableSubject/);
    expect(signoffData).toMatch(/\.from\(subject\.table\)/);
    expect(signoffData).toMatch(/\.eq\(subject\.rootColumn, rootId\)/);
    expect(signoffData).toMatch(/\.eq\("subject_type", subject\.subjectType\)/);
  });

  it("the toolbox detail page shows Tier-A acks ONLY for an issued talk, and never counts Tier-B", () => {
    // SignoffPanel (authenticated Tier A) is gated behind isIssued
    expect(detailPage).toMatch(/isIssued \? \(\s*<SignoffPanel/);
    expect(detailPage).toMatch(/subjectType="toolbox_talk"/);
    // Tier B recorded attendance is a separate, explicitly-not-counted section
    expect(detailPage).toMatch(/Recorded attendance/);
    expect(detailPage).toMatch(/[Nn]ot counted as an authenticated acknowledgement/);
  });
});

// ===========================================================================
// M3 — revision + re-acknowledgement (20261027)
// ===========================================================================
describe("toolbox M3 — atomic revision issue freezes a fresh snapshot, zero ack carry-forward", () => {
  it("the revision-issue RPC is atomic (supersede + promote) AND sets the snapshot in one txn", () => {
    // widened to take the snapshot so a promoted revision can never exist as issued
    // evidence with a null snapshot (the old 1-arg signature is dropped)
    expect(revMigration).toMatch(/drop function if exists public\.issue_toolbox_talk_revision\(uuid\)/);
    expect(revMigration).toMatch(/function public\.issue_toolbox_talk_revision\(p_id uuid, p_snapshot jsonb\)/);
    expect(revMigration).toMatch(/security invoker/); // RLS + triggers still gate the caller
    expect(revMigration).toMatch(/for update/); // row lock → one issue wins a race
    expect(revMigration).toMatch(/set status = 'superseded'\s*\n?\s*where root_toolbox_talk_id = v_root and status = 'issued'/);
    expect(revMigration).toMatch(/snapshot = p_snapshot/);
    // reference is computed server-side (authoritative) — the caller cannot forge it
    expect(revMigration).toMatch(/v_newref := v_base \|\| '-R' \|\| lpad/);
  });

  it("createToolboxTalkRevision only revises an ISSUED talk, born a fresh draft (no ack copy)", () => {
    expect(actions).toMatch(/export async function createToolboxTalkRevision/);
    expect(actions).toMatch(/only_issued_can_be_revised/);
    expect(actions).toMatch(/revision_number: \(src\.revision_number \?\? 1\) \+ 1/);
    expect(actions).toMatch(/supersedes_id: src\.id/);
    // a revision is a new row; the action NEVER touches safety_acknowledgements
    // (zero carry-forward is structural — each revision is its own ack subject_version)
    expect(actions).not.toMatch(/safety_acknowledgements/);
  });

  it("issueToolboxTalkRevision delivers via the atomic RPC (not a bare status flip)", () => {
    expect(actions).toMatch(/export async function issueToolboxTalkRevision/);
    expect(actions).toMatch(/issue_toolbox_talk_revision/);
    expect(actions).toMatch(/canIssue\(/); // re-gate before issue
    expect(actions).toMatch(/assembleSnapshot\(/); // the same frozen-evidence builder as rev 1
  });

  it("the detail page delivers a revision draft through the revision action, not the first-issue path", () => {
    expect(detailPage).toMatch(/isRevisionDraft \? issueToolboxTalkRevision : issueToolboxTalk/);
    // a re-brief creates a deliberate revision; the current version is linkable from history
    expect(detailPage).toMatch(/Create revision/);
  });
});

// ===========================================================================
// M4 — evidence PDF (route + component)
// ===========================================================================
describe("toolbox M4 — evidence PDF: auth-gated, RLS-scoped, snapshot-rendered, no leak", () => {
  it("the PDF route requires org context + uses the tenant client (never service-role)", () => {
    expect(pdfRoute).toMatch(/requireOrgContext\(\)/);
    expect(pdfRoute).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(pdfRoute).not.toMatch(/serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
  });
  it("a draft (or a talk with no frozen snapshot) yields NO evidence PDF (409)", () => {
    expect(pdfRoute).toMatch(/status === "draft" \|\| !talk\.snapshot/);
    expect(pdfRoute).toMatch(/status: 409/);
  });
  it("the document body is the FROZEN snapshot; only the ack roster is pulled live", () => {
    expect(pdfRoute).toMatch(/talk\.snapshot as ToolboxTalkSnapshot/);
    expect(pdfRoute).toMatch(/snap\.key_points/);
    expect(pdfRoute).toMatch(/listAcknowledgements\("toolbox_talk"/); // live sign-offs, like RAMS/permit
  });
  it("the evidence is private-cached + labelled with the SUBJECT's own org (not the active org)", () => {
    expect(pdfRoute).toMatch(/private, no-store/);
    expect(pdfRoute).toMatch(/\.eq\("id", talk\.org_id\)/);
  });
  it("the PDF component leaks no cost/rate/price FIELD + keeps the Tier A/B honesty split", () => {
    // field-shaped tokens (the RAMS/permit-PDF convention) so @react-pdf's CSS
    // `marginTop` etc. is not a false hit; the unit test also scans the input keys.
    expect(pdfLib).not.toMatch(/profit|unit_price|day_rate|_cost|cost_|net_amount|vat_|markup|supplier/i);
    expect(pdfLib).toMatch(/CrewFlow-authenticated acknowledgements/);
    expect(pdfLib).toMatch(/Recorded attendees/);
    expect(pdfLib).toMatch(/not platform-authenticated/);
  });
});

// ===========================================================================
// M5 — evidence/attachment immutability hardening (20261028)
// ===========================================================================
describe("toolbox M5 — signed-sheet evidence is append-only once delivered", () => {
  it("a TRIGGER freezes attachments of a delivered talk (role-independent, before delete+update)", () => {
    expect(attMigration).toMatch(/tg_tenant_attachment_freeze_delivered_toolbox/);
    expect(attMigration).toMatch(/before delete or update on public\.tenant_attachments/);
    expect(attMigration).toMatch(/evidence attached to a delivered toolbox talk is frozen/);
    expect(attMigration).toMatch(/security definer set search_path = public/);
  });

  it("the freeze governs ONLY toolbox talks, spares drafts, and allows org-teardown cascade", () => {
    expect(attMigration).toMatch(/old\.target_table <> 'toolbox_talks'/); // other targets untouched
    expect(attMigration).toMatch(/v_status is null or v_status = 'draft'/); // drafts + gone talks are mutable
    expect(attMigration).toMatch(/not exists \(select 1 from public\.organizations where id = old\.org_id\)/); // cascade
  });

  it("the attachments panel hides Delete when the evidence is frozen (append-only affordance)", () => {
    expect(attachPanel).toMatch(/frozen\?: boolean/);
    expect(attachPanel).toMatch(/!frozen && \(ctx\.membership\.role === "owner"/);
    expect(attachPanel).toMatch(/files can be added but not removed/);
  });

  it("the toolbox detail page freezes attachments the moment a talk leaves draft", () => {
    expect(detailPage).toMatch(/frozen=\{talk\.status !== "draft"\}/);
  });
});

// ===========================================================================
// M6 — operational intelligence (dashboard signal + job hub)
// ===========================================================================
describe("toolbox M6 — actionable awaiting-ack signal, RLS-scoped, no N+1", () => {
  it("the dashboard snapshot computes awaiting-ack on the tenant client (never service-role)", () => {
    expect(hsSnapshot).toMatch(/server-only/);
    expect(hsSnapshot).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(hsSnapshot).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
  });
  it("awaiting-ack is bounded + batched (no N+1): one talk read, then batched rota + acks diffed in JS", () => {
    expect(hsSnapshot).toMatch(/toolboxAwaitingAckCount/);
    expect(hsSnapshot).toMatch(/\.limit\(500\)/); // bounded current-talk read
    expect(hsSnapshot).toMatch(/\.in\("job_id", jobIds\)/); // batched rota
    expect(hsSnapshot).toMatch(/\.in\("subject_id", talkIds\)/); // batched acks
    // reuses the unit-tested summariseSignoff → no-crew is not_tracked (never flagged),
    // identical honesty semantics to the SignoffPanel (no invented requirement)
    expect(hsSnapshot).toMatch(/summariseSignoff/);
  });
  it("the signal is a warn-tone exception linking to /toolbox, only when count > 0", () => {
    expect(hsSignals).toMatch(/toolbox-awaiting-ack/);
    expect(hsSignals).toMatch(/awaiting operative acknowledgement/);
    expect(hsSignals).toMatch(/href: "\/toolbox"/);
    expect(hsSignals).toMatch(/if \(s\.toolboxAwaitingAck > 0\)/);
  });
  it("the job safety hub reads the job's toolbox talks on the tenant client", () => {
    expect(jobSafety).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(jobSafety).toMatch(/\.from\("toolbox_talks"\)/);
    expect(jobSafety).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
  });
});
