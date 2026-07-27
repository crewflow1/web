import { ToolPageShell, toolMetadata } from "@/components/marketing/tool-page";
import { MarkupCalculator } from "@/components/marketing/calculators/markup-calculator";

export const metadata = toolMetadata("markup-calculator");

export default function Page() {
  return (
    <ToolPageShell slug="markup-calculator">
      <MarkupCalculator />
    </ToolPageShell>
  );
}
