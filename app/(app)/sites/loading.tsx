import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

// Instant Suspense fallback so navigating to Sites shows a skeleton rather than
// freezing on the previous route until the server data resolves.
export default function SitesLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={6} cols={4} />
    </div>
  );
}
