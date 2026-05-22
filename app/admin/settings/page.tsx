import { ComingSoonStub } from "../_coming-soon";

export default function HqSettingsPage() {
  return (
    <ComingSoonStub
      title="Settings"
      sprint="HQ-6"
      body="Read-only reflection of the env config that runs HQ — admin email allowlist · notification settings · support inbox · billing defaults. The values themselves continue to live in Vercel env vars (CREWFLOW_SUPERADMIN_EMAILS etc.); HQ-6 surfaces them so you can verify config without leaving the panel."
    />
  );
}
