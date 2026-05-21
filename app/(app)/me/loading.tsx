import { Skeleton, SkeletonHeader } from "@/components/ui/skeleton";

export default function MeLoading() {
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <SkeletonHeader />
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-2 h-10 w-44" />
        <Skeleton className="mt-3 h-3 w-56" />
        <Skeleton className="mt-5 h-12 w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}
