import { ComingSoonStub } from "../_coming-soon";

export default function HqHealthPage() {
  return (
    <ComingSoonStub
      title="Customer health"
      sprint="HQ-6"
      body="0–100 health score banded LOW · MEDIUM · HIGH risk, computed from logins · usage · invoices · jobs · support · inactivity. Inputs are already in the DB; the score + risk-banding UI lands in HQ-6 once the customers DB (HQ-3) and support queue (HQ-5) are in place."
    />
  );
}
