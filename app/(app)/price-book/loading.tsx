import { SkeletonTable, SkeletonHeader } from "@/components/ui/skeleton";

export default function PricingLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={8} cols={5} />
    </div>
  );
}
