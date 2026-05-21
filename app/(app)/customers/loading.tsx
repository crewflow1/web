import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

export default function CustomersLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={10} cols={4} />
    </div>
  );
}
