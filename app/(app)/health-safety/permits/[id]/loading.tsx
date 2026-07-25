import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

// Suspense fallback for a permit detail so a flaky field link shows a skeleton
// rather than freezing the previous route until the server data resolves.
export default function PermitDetailLoading() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={5} cols={2} />
    </div>
  );
}
