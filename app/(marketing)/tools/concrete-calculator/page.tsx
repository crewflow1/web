import { ToolPageShell, toolMetadata } from "@/components/marketing/tool-page";
import { ConcreteCalculator } from "@/components/marketing/calculators/concrete-calculator";

export const metadata = toolMetadata("concrete-calculator");

export default function Page() {
  return (
    <ToolPageShell slug="concrete-calculator">
      <ConcreteCalculator />
    </ToolPageShell>
  );
}
