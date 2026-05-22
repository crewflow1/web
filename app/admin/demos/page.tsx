import { ComingSoonStub } from "../_coming-soon";

export default function HqDemosPage() {
  return (
    <ComingSoonStub
      title="Demos CRM"
      sprint="HQ-2"
      body="The full kanban pipeline (NEW → CONTACTED → BOOKED → DEMO DONE → WON → LOST → PAYMENT SENT → PAYMENT RECEIVED → ACTIVE) lands in HQ-2 with Call / Email / WhatsApp / Schedule / Send-setup-payment buttons per row. Until then, use the legacy combined view — every demo request landing on hello@crewflow.uk shows up there with Approve / Reject."
      primaryHref="/admin/organizations"
      primaryLabel="Open legacy demos view"
    />
  );
}
