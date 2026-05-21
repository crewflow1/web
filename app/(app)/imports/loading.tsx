import { Skeleton, SkeletonHeader } from "@/components/ui/skeleton";

export default function ImportsLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-10 w-full" />
        <Skeleton className="mt-2 h-3 w-72" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
