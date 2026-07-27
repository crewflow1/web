import { SkeletonDetail, SkeletonHeader } from "@/components/ui/skeleton";

// Instant Suspense fallback so opening a supplier's CIS profile shows a
// skeleton rather than holding on the previous route.
export default function SupplierCisLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <SkeletonHeader />
      <SkeletonDetail cards={3} />
    </div>
  );
}
