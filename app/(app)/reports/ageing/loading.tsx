import { SkeletonHeader, SkeletonTileRow, SkeletonTable } from "@/components/ui";

export default function AgeingReportLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTileRow />
      <SkeletonTable rows={5} cols={7} />
      <SkeletonTable rows={5} cols={7} />
    </div>
  );
}
