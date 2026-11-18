/**
 * run-existing-erase.ts — invoke the EXISTING org-erasure service (unchanged)
 * against one SYNTHETIC local org, exactly as the gated route would after its
 * three locks pass. LOCAL ONLY (refuses a non-loopback Supabase URL).
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx run-existing-erase.ts <org-id> <org-slug>
 */
import { eraseOrg } from "@/server/services/gdpr-erase";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) {
  throw new Error("refusing: not a local Supabase target");
}
const [orgId, confirm] = process.argv.slice(2);
if (!orgId || !confirm) throw new Error("usage: <org-id> <org-slug>");

eraseOrg({ orgId, confirm, requestedBy: null }).then(
  (summary) => console.log(JSON.stringify(summary)),
  (e) => {
    console.error("ERASE FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
