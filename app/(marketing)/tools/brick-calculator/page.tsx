import { ToolPageShell, toolMetadata } from "@/components/marketing/tool-page";
import { BrickCalculator } from "@/components/marketing/calculators/brick-calculator";

export const metadata = toolMetadata("brick-calculator");

export default function Page() {
  return (
    <ToolPageShell slug="brick-calculator">
      <BrickCalculator />
    </ToolPageShell>
  );
}
