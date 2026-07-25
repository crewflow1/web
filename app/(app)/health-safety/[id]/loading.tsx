import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

// Suspense fallback for a RAMS detail — the heaviest H&S read path — so navigating
// to it on a flaky field link shows a skeleton instead of freezing the prior route.
export default function RiskAssessmentDetailLoading() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={5} cols={2} />
    </div>
  );
}
