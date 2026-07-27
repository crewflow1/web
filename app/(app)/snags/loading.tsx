import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

// Instant Suspense fallback so navigating to Snagging shows a skeleton rather
// than freezing on the previous route until the server data resolves.
export default function SnagsLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={6} cols={3} />
    </div>
  );
}
