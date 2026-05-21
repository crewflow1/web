import { Skeleton, SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

export default function PayrollLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-3 h-8 w-full" />
          <Skeleton className="mt-2 h-8 w-full" />
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-3 h-8 w-full" />
          <Skeleton className="mt-2 h-8 w-full" />
        </div>
      </div>
      <SkeletonTable rows={6} cols={5} />
    </div>
  );
}
