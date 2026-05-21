import { Skeleton, SkeletonHeader } from "@/components/ui/skeleton";

export default function TaxLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <Skeleton className="h-10 w-full" />
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <Skeleton className="h-4 w-40" />
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
