import { SkeletonHeader, SkeletonTable } from "@/components/ui/skeleton";

// L4: instant Suspense fallback so navigating to Expenses shows a skeleton
// rather than freezing on the previous route until the server data resolves.
export default function ExpensesLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTable rows={10} cols={5} />
    </div>
  );
}
