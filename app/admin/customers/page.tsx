import { ComingSoonStub } from "../_coming-soon";

export default function HqCustomersPage() {
  return (
    <ComingSoonStub
      title="Customers database"
      sprint="HQ-3"
      body="Per-customer MRR, health score, migration %, last-login, payment status + Open / Suspend / Message / Impersonate / Cancel actions land in HQ-3 (impersonation is high-risk and gets its own focused PR with audit logging). The legacy organisations view shows the same rows today with the actions we have so far."
      primaryHref="/admin/organizations"
      primaryLabel="Open legacy customers view"
    />
  );
}
