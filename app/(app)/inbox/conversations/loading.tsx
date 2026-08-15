import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

// Instant Suspense fallback so navigating to Conversations shows a skeleton
// rather than freezing on the previous route until the server data resolves.
export default function ConversationsLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={6} cols={3} />
    </div>
  );
}
