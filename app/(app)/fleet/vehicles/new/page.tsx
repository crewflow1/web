import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { createVehicle } from "../../actions";
import { loadSupplierOptions } from "../../_components/load";
import { VehicleForm } from "../../_components/vehicle-form";
import { Banner } from "../../_components/ui";
import { errorMessage } from "../../_components/messages";

export const dynamic = "force-dynamic";

type SP = Promise<{ error?: string }>;

export default async function NewVehiclePage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const suppliers = await loadSupplierOptions(ctx.org.id);
  const err = errorMessage(sp.error);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <nav aria-label="Breadcrumb" className="text-xs text-slate-500">
          <Link href="/fleet" className="hover:text-slate-900">
            Fleet
          </Link>
          <span className="mx-1">/</span>
          <Link href="/fleet/vehicles" className="hover:text-slate-900">
            Vehicles
          </Link>
        </nav>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Add a vehicle</h1>
        <p className="mt-1 text-sm text-slate-600">
          This creates the asset too — one record, shared by the fleet board, the asset register,
          the custody log and inspections. Only the name is required; everything else can follow.
        </p>
      </header>

      {err ? <Banner tone="error">{err}</Banner> : null}

      <VehicleForm
        action={createVehicle}
        suppliers={suppliers}
        submitLabel="Add vehicle"
        cancelHref="/fleet/vehicles"
      />
    </div>
  );
}
