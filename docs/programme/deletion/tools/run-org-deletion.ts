/**
 * run-org-deletion.ts — drive the NEW company-deletion flow end to end against
 * one SYNTHETIC local org: request (as the owner, with the company name), skip
 * the cooling-off, run the engine, print the outcome. LOCAL ONLY.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx run-org-deletion.ts <org-id> <owner-user-id> <company-name>
 */
import { createClient } from "@supabase/supabase-js";
import { requestOrgDeletion, runDeletionRequest } from "@/server/services/privacy-deletion";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) {
  throw new Error("refusing: not a local Supabase target");
}
const [argOrg, argOwner, argName] = process.argv.slice(2);
if (!argOrg || !argOwner || !argName) throw new Error("usage: <org-id> <owner-user-id> <company-name>");
const orgId: string = argOrg;
const ownerId: string = argOwner;
const name: string = argName;

async function main() {
  const created = await requestOrgDeletion({ orgId, actorUserId: ownerId, confirmName: name });
  console.log("request:", JSON.stringify(created));
  if (!created.ok) process.exit(1);
  // Synthetic fixture: end the cooling-off now instead of waiting 7 days.
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
    auth: { persistSession: false },
  });
  const { error } = await admin
    .from("privacy_deletion_requests" as never)
    .update({ scheduled_for: new Date(Date.now() - 1000).toISOString() } as never)
    .eq("id", created.requestId);
  if (error) throw new Error(error.message);
  // No Stripe in the local stack. A STUB stands in (SIMULATED): it reports each
  // fuzz-seeded subscription id as active and records the cancel call.
  const cancelled: string[] = [];
  const stripe = {
    subscriptions: {
      retrieve: async () => ({ status: "active" }),
      cancel: async (id: string) => {
        cancelled.push(id);
        return { status: "canceled" };
      },
    },
  };
  const run = await runDeletionRequest(created.requestId, { stripe });
  console.log("stripe stub cancel calls:", cancelled.length);
  console.log("run:", JSON.stringify(run));
  const { data } = await admin
    .from("privacy_deletion_requests" as never)
    .select("status, steps, counts, work, last_error_code, retention_until")
    .eq("id", created.requestId)
    .single();
  console.log("ledger:", JSON.stringify(data));
}
main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
