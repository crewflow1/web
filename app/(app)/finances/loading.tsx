import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

export default function FinancesLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={10} cols={5} />
    </div>
  );
}
