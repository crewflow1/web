import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

export default function SiteComplianceDetailLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={4} cols={4} />
      <SkeletonTable rows={4} cols={4} />
    </div>
  );
}
