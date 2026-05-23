import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

/**
 * /notifications skeleton — matches the live page shape.
 */
export default function NotificationsLoading() {
  return (
    <div className="space-y-5 p-6">
      <SkeletonHeader />
      <SkeletonTable rows={6} cols={3} />
    </div>
  );
}
