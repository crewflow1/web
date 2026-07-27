import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

// Instant Suspense fallback for the Toolbox talks route.
export default function ToolboxLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={6} cols={3} />
    </div>
  );
}
