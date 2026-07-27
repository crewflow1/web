import { afterAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import { verifyApprovedFulfilment } from "@/server/services/receptionist-verification";
import { recoverVerifiedFulfilment } from "@/server/services/receptionist-recovery";
import { resolveConversationCompletion } from "@/server/services/receptionist-resolution";
import { governConversationLifecycle } from "@/server/services/receptionist-lifecycle";
import { orchestrateConversationLifecycle } from "@/server/services/receptionist-orchestration";
import { coordinateConversationLifecycle } from "@/server/services/receptionist-coordination";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import { claimConversationWork } from "@/server/services/receptionist-claim";
import { reassignConversationWork } from "@/server/services/receptionist-reassignment";
import { getOwnership } from "@/server/services/receptionist-ownership-read-model";
import { listOrgOperators } from "@/server/services/receptionist-operators";
import {
  projectReassignmentView,
  describeReassignmentOutcome,
} from "@/lib/receptionist/conversation-reassignment-view";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation Work REASSIGNMENT SURFACE — real-Postgres proof of the AI Receptionist Programme R54 (CONVERSATION WORK
 * REASSIGNMENT SURFACE): the single authorised operator-facing UI for TRANSFERRING ownership of a Conversation Worklist
 * item to another authorised operator. The unit tier pins the surface's PURE CORE (the projection + the outcome fold)
 * against hand-built records; this tier proves the BEHAVIOUR the mocks can't — that the surface's THREE server READ
 * seams and its ONE runtime WRITE seam compose correctly over a live database, exactly as the page + action drive them:
 *
 *   • THE OPERATOR ROSTER IS A REAL, ORG-SCOPED READ — `listOrgOperators` reads the org's `memberships` (joined to their
 *     `users`) and returns the destination candidates. Proven over live Postgres against seeded organisations, auth
 *     users and memberships, NOT a mock.
 *   • THE SURFACE PROJECTS THE TRANSFER THE RUNTIME THEN RECORDS — for a really-claimed coordination, the Ownership Read
 *     Model names the current owner, the roster supplies the candidates, and the pure projection offers exactly the
 *     transfer the R52 runtime then accepts (from the recorded owner, to a rostered candidate). After the transfer the
 *     read model FOLDS it: the item is re-projected with the NEW owner and the old owner now a candidate. The whole
 *     read → project → record → re-read loop the page + action perform, end to end.
 *   • THE ACTION'S HUMANISER IS FAITHFUL TO THE RUNTIME — `describeReassignmentOutcome(result.resolution)` (the exact
 *     composition the server action performs) maps the live runtime resolution to the surface's result: `reassigned` →
 *     success, and a stale transfer refused by the runtime's ownership guard → `not_owned` → warning.
 *   • ORGANISATION ISOLATION IS STRUCTURAL AT THE SURFACE — the roster names ONLY the viewing org's operators (never
 *     another org's), and the Ownership Read Model resolves a foreign org's coordination as UNOWNED, so the surface
 *     projected under the wrong org offers no owner, no candidates and no transfer.
 *   • A SOLE OPERATOR OFFERS NO TRANSFER — an owned item in an org with only one authorised operator projects empty
 *     candidates and `canReassign = false`: a transfer must have somewhere to go.
 *
 * The surface introduces NO new write path: every transfer here rides the R52 runtime `reassignConversationWork`; this
 * suite reaches the reassignment ledger only THROUGH that runtime and the read models, never with a direct write.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. The append-only receptionist ledgers cannot be deleted and are intentionally left behind
 * (harmless in the ephemeral CI database); the seeded organisations (cascading their memberships) are dropped in
 * afterAll, and the minted operator auth users (cascading their `public.users` mirror) are removed. Each assertion uses
 * freshly seeded organisations + operators, addressing rows by per-call ids so it sees only its own writes.
 */

// organizations / users / memberships are core tables; the receptionist read models + the R52 runtime are reached
// through their services. This suite touches tables directly ONLY to seed + tear down the org / operator roster, cast to
// the minimal surface it exercises (the same `as unknown as` convention the R14 review-inbox suite uses).
type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
interface Selectable<T> extends Thenable<T[]> {
  eq(column: string, value: unknown): Selectable<T>;
  single(): Thenable<T>;
}
interface Insertable extends Thenable<null> {
  select(columns?: string): Selectable<Record<string, unknown>>;
}
interface Mutable extends Thenable<null> {
  eq(column: string, value: unknown): Mutable;
}
interface Table {
  insert(row: Record<string, unknown>): Insertable;
  delete(): Mutable;
}
interface Client {
  from(table: string): Table;
}
const svc = (): Client => serviceClient() as unknown as Client;

const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

/** An authorised operator — the real `users.id` + `users.email` the roster resolves, plus the display name it labels. */
type Operator = OperatorIdentity & { name: string };

const createdOrgs: string[] = [];
const createdUsers: string[] = [];

/** Stand up a real organisation the surface's reads + memberships can be scoped to, tracked for teardown. */
async function freshOrg(): Promise<string> {
  const slug = `it-r54-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await svc()
    .from("organizations")
    .insert({ name: "R54 Reassignment Surface Org", slug })
    .select("id")
    .single();
  expect(res.error, res.error?.message).toBeNull();
  const id = String((res.data as { id: string }).id);
  createdOrgs.push(id);
  return id;
}

/** Mint an auth user + mirror it into `public.users` (satisfying the id → auth.users FK) so it is a real operator the
 *  roster can resolve — with a display name so the surface's candidate label is deterministic. */
async function freshOperator(fullName: string): Promise<Operator> {
  const email = `it-r54-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@probe.crewflow.test`;
  const created = await serviceClient().auth.admin.createUser({
    email,
    password: `Pw!${Math.random().toString(36).slice(2)}${Date.now()}`,
    email_confirm: true,
  });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id;
  if (!id) throw new Error("could not mint the operator auth user");
  const mirrored = await svc()
    .from("users")
    .insert({ id, email, full_name: fullName })
    .select("id")
    .single();
  expect(mirrored.error, mirrored.error?.message).toBeNull();
  createdUsers.push(id);
  return { id, email, name: fullName };
}

/** Enrol an operator into an organisation — the membership the roster reads back as an authorised destination. */
async function addMembership(orgId: string, userId: string): Promise<void> {
  const res = await svc().from("memberships").insert({ org_id: orgId, user_id: userId });
  expect(res.error, res.error?.message).toBeNull();
}

/**
 * Resolve a REAL `approve_booking` decision through the pure cores, so the recorded flags match the deterministic fold
 * of the eligibility they are recorded with — the same genuine composition the R52 pipeline suite seeds with.
 */
function authorise(verdict: GuardrailVerdict, live: boolean): ApproveBookingAuthorisation {
  const action = {
    kind: "prepare_booking",
    job_type: JOB,
    postcode: POSTCODE,
    phone_number: PHONE,
  } as const;
  const execution = resolveExecution(action, verdict, { liveExecutionEnabled: live });
  const a = resolveAuthorisation(execution);
  if (!isAuthorisationDecided(a)) throw new Error("test setup: expected a decided authorisation");
  return a;
}

/** Drive the full R29→R34 chain for a held reply so R34 has RECORDED a lifecycle to route. */
async function governThroughStack(opts: { orgId: string; reviewAuditId: string }): Promise<void> {
  const seeded = await recordConversationAuthorisation({
    org_id: opts.orgId,
    conversation_id: crypto.randomUUID(),
    customer_ref: CALLER,
    correlation_id: crypto.randomUUID(),
    review_audit_id: opts.reviewAuditId,
    decision: authorise("allow", true),
  });
  expect(seeded?.state).toBe("pending");

  const fulfilled = await fulfilApprovedBooking({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  expect(fulfilled, "R30 performed the approved booking").not.toBeNull();

  await verifyApprovedFulfilment({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  await recoverVerifiedFulfilment({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  await resolveConversationCompletion({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  const governed = await governConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  expect(governed, "the resolved conversation's lifecycle was governed").not.toBeNull();
}

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded item R46 claims and R54 reassigns. */
async function seedCoordination(opts: {
  orgId: string;
  reviewAuditId: string;
}): Promise<{ coordinationId: string }> {
  await governThroughStack(opts);
  await orchestrateConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  const coordinated = await coordinateConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  expect(coordinated, "the orchestrated conversation's response was coordinated").not.toBeNull();
  if (!coordinated) throw new Error("test setup: expected a coordination to be filed");
  return { coordinationId: coordinated.coordination_id };
}

/** Seed a coordination AND record the given operator's claim on it — the owned item the surface reassigns. */
async function seedClaimed(orgId: string, operator: OperatorIdentity): Promise<{ coordinationId: string }> {
  const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });
  const claimed = await claimConversationWork({
    org_id: orgId,
    coordination_id: coordinationId,
    operator,
  });
  expect(claimed.resolution).toBe("claimed");
  if (claimed.resolution !== "claimed") throw new Error("test setup: expected a recorded claim");
  return { coordinationId };
}

describeIntegration(
  "Conversation Work Reassignment SURFACE pipeline · roster + ownership read model + R52 runtime (R54)",
  () => {
    afterAll(async () => {
      for (const id of createdOrgs) {
        await svc().from("organizations").delete().eq("id", id);
      }
      for (const id of createdUsers) {
        await serviceClient().auth.admin.deleteUser(id);
      }
    });

    it("projects the transfer the runtime then records: owner A + roster → candidate B → reassign → the read model folds B as owner", async () => {
      const orgId = await freshOrg();
      const operatorA = await freshOperator("Ada Owner");
      const operatorB = await freshOperator("Ben Candidate");
      await addMembership(orgId, operatorA.id);
      await addMembership(orgId, operatorB.id);
      const { coordinationId } = await seedClaimed(orgId, operatorA); // A holds it

      // THE SURFACE'S READS — the current owner (Ownership Read Model) and the destination roster (org memberships).
      const ownership = await getOwnership({ org_id: orgId, coordination_id: coordinationId });
      expect(ownership.owned).toBe(true);
      expect(ownership.owner?.operatorId).toBe(operatorA.id);

      const operators = await listOrgOperators({ org_id: orgId });
      const rosterIds = operators.map((o) => o.operatorId);
      expect(rosterIds).toContain(operatorA.id);
      expect(rosterIds).toContain(operatorB.id);

      // THE PURE PROJECTION — for the owner A viewing, the item is theirs ("You"), and the only candidate is B (A, the
      // current owner, is NEVER offered as a destination). A transfer is offered.
      const view = projectReassignmentView({
        coordinationId,
        ownership,
        operators,
        viewerOperatorId: operatorA.id,
      });
      expect(view.owned).toBe(true);
      expect(view.viewerHoldsOwnership).toBe(true);
      expect(view.currentOwnerId).toBe(operatorA.id);
      expect(view.currentOwnerLabel).toBe("You");
      expect(view.canReassign).toBe(true);
      const candidateIds = view.candidates.map((c) => c.operatorId);
      expect(candidateIds).toContain(operatorB.id);
      expect(candidateIds).not.toContain(operatorA.id);
      const candB = view.candidates.find((c) => c.operatorId === operatorB.id);
      expect(candB?.label, "the candidate carries B's live display name").toBe(operatorB.name);

      // THE ONE WRITE — recorded through the R52 runtime exactly as the server action composes it: the source is the
      // RECORDED owner (not a client value), the target the chosen rostered candidate.
      const chosen = view.candidates.find((c) => c.operatorId === operatorB.id)!;
      const result = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: { id: ownership.owner!.operatorId, email: ownership.owner!.operatorEmail },
        to_operator: { id: chosen.operatorId, email: chosen.operatorEmail },
        conversation_id: ownership.conversationId,
      });
      expect(result.resolution).toBe("reassigned");

      // THE ACTION'S HUMANISER — the exact `describeReassignmentOutcome(result.resolution)` the action returns.
      const outcome = describeReassignmentOutcome(result.resolution);
      expect(outcome.ok).toBe(true);
      expect(outcome.tone).toBe("success");

      // THE REFRESHED READ — the read model FOLDS the transfer: the item is still owned, its CURRENT owner is now B, the
      // original claimant A preserved. This is what the refreshed surface re-reads.
      const after = await getOwnership({ org_id: orgId, coordination_id: coordinationId });
      expect(after.owned).toBe(true);
      expect(after.owner?.operatorId).toBe(operatorB.id);
      expect(after.reassigned).toBe(true);
      expect(after.claimant?.operatorId).toBe(operatorA.id);

      // THE RE-PROJECTION — the SAME viewer A no longer holds the item; B is the current owner (labelled by email, since
      // the viewer is not the owner), and A is now a candidate (the transfer could move back).
      const afterView = projectReassignmentView({
        coordinationId,
        ownership: after,
        operators,
        viewerOperatorId: operatorA.id,
      });
      expect(afterView.viewerHoldsOwnership).toBe(false);
      expect(afterView.currentOwnerId).toBe(operatorB.id);
      expect(afterView.currentOwnerLabel).toBe(operatorB.email);
      const afterCandidateIds = afterView.candidates.map((c) => c.operatorId);
      expect(afterCandidateIds).toContain(operatorA.id);
      expect(afterCandidateIds).not.toContain(operatorB.id);
      expect(afterView.canReassign).toBe(true);
    });

    it("preserves ORGANISATION ISOLATION — the roster names only the viewing org, and a foreign org's coordination reads UNOWNED, so the surface offers no transfer", async () => {
      const orgA = await freshOrg();
      const orgB = await freshOrg();
      const operatorA = await freshOperator("Ada OrgA");
      const operatorB = await freshOperator("Ben OrgA");
      const operatorC = await freshOperator("Cara OrgB");
      await addMembership(orgA, operatorA.id);
      await addMembership(orgA, operatorB.id);
      await addMembership(orgB, operatorC.id);
      const { coordinationId } = await seedClaimed(orgA, operatorA); // claimed under org A

      // THE ROSTER IS ORG-SCOPED — org B's roster names ONLY org B's operator, never org A's. Confined by construction.
      const rosterB = await listOrgOperators({ org_id: orgB });
      const rosterBIds = rosterB.map((o) => o.operatorId);
      expect(rosterBIds).toContain(operatorC.id);
      expect(rosterBIds).not.toContain(operatorA.id);
      expect(rosterBIds).not.toContain(operatorB.id);

      // OWNERSHIP IS ORG-SCOPED — org B naming org A's coordination resolves to UNOWNED (structural isolation).
      const crossOwnership = await getOwnership({ org_id: orgB, coordination_id: coordinationId });
      expect(crossOwnership.owned).toBe(false);

      // SO THE SURFACE UNDER ORG B OFFERS NOTHING — no owner, no candidates, no transfer of org A's item.
      const crossView = projectReassignmentView({
        coordinationId,
        ownership: crossOwnership,
        operators: rosterB,
        viewerOperatorId: operatorC.id,
      });
      expect(crossView.owned).toBe(false);
      expect(crossView.canReassign).toBe(false);
      expect(crossView.candidates).toEqual([]);
      expect(crossView.currentOwnerId).toBeNull();
    });

    it("offers NO transfer when the owner is the org's SOLE operator — a transfer must have somewhere to go", async () => {
      const orgId = await freshOrg();
      const solo = await freshOperator("Solo Operator");
      await addMembership(orgId, solo.id);
      const { coordinationId } = await seedClaimed(orgId, solo);

      const ownership = await getOwnership({ org_id: orgId, coordination_id: coordinationId });
      const operators = await listOrgOperators({ org_id: orgId });
      expect(operators.map((o) => o.operatorId)).toEqual([solo.id]); // exactly the one member

      const view = projectReassignmentView({
        coordinationId,
        ownership,
        operators,
        viewerOperatorId: solo.id,
      });
      expect(view.owned).toBe(true);
      expect(view.candidates).toEqual([]);
      expect(view.canReassign).toBe(false);
    });

    it("humanises a STALE transfer as a warning — after A→B, a transfer FROM the superseded owner A is refused (not_owned)", async () => {
      const orgId = await freshOrg();
      const operatorA = await freshOperator("Ada First");
      const operatorB = await freshOperator("Ben Next");
      const operatorC = await freshOperator("Cara Third");
      await addMembership(orgId, operatorA.id);
      await addMembership(orgId, operatorB.id);
      await addMembership(orgId, operatorC.id);
      const { coordinationId } = await seedClaimed(orgId, operatorA); // A holds it

      // A hands it to B — ownership genuinely moves.
      const first = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: operatorA,
        to_operator: operatorB,
      });
      expect(first.resolution).toBe("reassigned");

      // A is no longer the owner — a STALE transfer naming A as the source is refused by the runtime's ownership guard,
      // which the surface humanises as a warning ("ownership changed — refresh and try again"). The action reads the
      // current owner precisely to avoid this, but the runtime guard is the authoritative backstop.
      const stale = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: operatorA,
        to_operator: operatorC,
      });
      expect(stale.resolution).toBe("not_owned");
      const staleView = describeReassignmentOutcome(stale.resolution);
      expect(staleView.ok).toBe(false);
      expect(staleView.tone).toBe("warning");
    });
  },
);
