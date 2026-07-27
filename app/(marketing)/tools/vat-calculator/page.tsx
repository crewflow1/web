import { ToolPageShell, toolMetadata } from "@/components/marketing/tool-page";
import { VatCalculator } from "@/components/marketing/calculators/vat-calculator";

export const metadata = toolMetadata("vat-calculator");

export default function Page() {
  return (
    <ToolPageShell slug="vat-calculator">
      <VatCalculator />
    </ToolPageShell>
  );
}
