import { Skeleton, SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

export default function PaymentsLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-9 w-full" />
        <Skeleton className="mt-2 h-3 w-72" />
      </div>
      <SkeletonTable rows={6} cols={5} />
    </div>
  );
}
