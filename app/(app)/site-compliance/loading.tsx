import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

export default function SiteComplianceLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={6} cols={4} />
    </div>
  );
}
