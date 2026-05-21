import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

export default function StaffLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={8} cols={4} />
    </div>
  );
}
