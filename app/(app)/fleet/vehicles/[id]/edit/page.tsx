import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { updateVehicle, removeVehicleProfile } from "../../../actions";
import {
  loadSiteOptions,
  loadSupplierOptions,
  loadVehicleForOrg,
} from "../../../_components/load";
import { VehicleForm } from "../../../_components/vehicle-form";
import { StateForm } from "../../../_components/state-form";
import { Banner, secondaryButtonClass } from "../../../_components/ui";
import { errorMessage } from "../../../_components/messages";

export const dynamic = "force-dynamic";

type SP = Promise<{ error?: string }>;
type Params = Promise<{ id: string }>;

export default async function EditVehiclePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;
  const sp = await searchParams;

  // ACTIVE-ORG PINNED by-id load. A vehicle in the caller's OTHER org resolves
  // to null here and renders as not-found — never as an editable form.
  const vehicle = await loadVehicleForOrg(ctx.org.id, id);
  if (!vehicle) notFound();

  const [suppliers, sites] = await Promise.all([
    loadSupplierOptions(ctx.org.id),
    // Pass the vehicle's CURRENT site so a since-retired one still renders as
    // selected rather than being silently dropped by the next save.
    loadSiteOptions(ctx.org.id, vehicle.homeSiteId),
  ]);
  const err = errorMessage(sp.error);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <nav aria-label="Breadcrumb" className="text-xs text-slate-500">
          <Link href="/fleet/vehicles" className="hover:text-slate-900">
            Vehicles
          </Link>
          <span className="mx-1">/</span>
          <Link href={`/fleet/vehicles/${id}`} className="hover:text-slate-900">
            {vehicle.name}
          </Link>
        </nav>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Edit vehicle</h1>
      </header>

      {err ? <Banner tone="error">{err}</Banner> : null}

      <VehicleForm
        action={updateVehicle}
        vehicle={vehicle}
        suppliers={suppliers}
        sites={sites}
        submitLabel="Save changes"
        cancelHref={`/fleet/vehicles/${id}`}
      />

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Remove from the fleet</h2>
        <p className="mt-1 text-xs text-slate-600">
          Removes the vehicle profile only. The asset, its custody history, inspections, maintenance
          cases and documents all stay in the asset register untouched. To record that it was sold
          or written off, change its status on{" "}
          <Link href={`/assets/${id}`} className="underline hover:text-slate-900">
            the asset record
          </Link>{" "}
          instead.
        </p>
        <StateForm action={removeVehicleProfile} className="mt-3">
          <input type="hidden" name="asset_id" value={id} />
          <button type="submit" className={secondaryButtonClass}>
            Remove vehicle profile
          </button>
        </StateForm>
      </section>
    </div>
  );
}
