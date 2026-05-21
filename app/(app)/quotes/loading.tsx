import { SkeletonTable, SkeletonHeader } from "@/components/ui/skeleton";

export default function QuotesLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={8} cols={6} />
    </div>
  );
}
