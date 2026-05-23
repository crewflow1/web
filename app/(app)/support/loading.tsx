import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

/**
 * /support skeleton — matches the live page shape (header + list).
 */
export default function SupportLoading() {
  return (
    <div className="space-y-5 p-6">
      <SkeletonHeader />
      <SkeletonTable rows={5} cols={4} />
    </div>
  );
}
