import { SkeletonHeader, SkeletonTileRow, SkeletonTable } from "@/components/ui";

export default function RetentionRegisterLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTileRow />
      <SkeletonTable rows={6} cols={5} />
    </div>
  );
}
