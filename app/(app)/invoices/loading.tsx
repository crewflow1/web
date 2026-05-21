import { SkeletonTable, SkeletonHeader } from "@/components/ui/skeleton";

export default function InvoicesLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={8} cols={7} />
    </div>
  );
}
