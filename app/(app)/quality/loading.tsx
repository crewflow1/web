import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

// Instant Suspense fallback so navigating to Works quality shows a skeleton
// rather than freezing on the previous route until the register read resolves.
export default function QualityLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={6} cols={3} />
    </div>
  );
}
