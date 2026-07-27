import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

// Instant Suspense fallback for the Assets route.
export default function AssetsLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={8} cols={3} />
    </div>
  );
}
