import { SkeletonDetail, SkeletonHeader } from "@/components/ui/skeleton";

// Instant Suspense fallback: the performance record runs six reads, so without
// this the route holds on the previous page long enough to look broken.
export default function SupplierPerformanceLoading() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <SkeletonHeader />
      <SkeletonDetail cards={4} />
    </div>
  );
}
