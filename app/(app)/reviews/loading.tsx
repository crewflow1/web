import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

// L4: instant Suspense fallback so navigating to Reviews shows a skeleton
// rather than freezing on the previous route until the server data resolves.
export default function ReviewsLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={8} cols={4} />
    </div>
  );
}
