import { ComingSoonStub } from "../_coming-soon";

export default function HqImpersonationPage() {
  return (
    <ComingSoonStub
      title="Impersonation log"
      sprint="HQ-3"
      body="Audit log of every impersonation session: who · which company · reason · duration · timestamp. Impersonation itself is built in HQ-3 (service-role token, 1-hour TTL, every session writes an immutable activity_log row). High-risk; will get its own focused PR with CEO sign-off."
    />
  );
}
