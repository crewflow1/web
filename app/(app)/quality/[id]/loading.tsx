import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

// Suspense fallback for an ITP detail — the heaviest read path in this domain
// (plan + items + every sign-off) and the one most often opened on a phone on a
// flaky site connection, so it shows a skeleton instead of freezing the prior route.
export default function InspectionPlanDetailLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={5} cols={2} />
    </div>
  );
}
