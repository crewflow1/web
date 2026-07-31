import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

// The comparison measures every supplier in one pass, so it is the slowest read
// in the domain — a skeleton beats holding on the previous route.
export default function CompareSuppliersLoading() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={8} cols={6} />
    </div>
  );
}
