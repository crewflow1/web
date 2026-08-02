"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { formatQuantity } from "@/lib/stock/movements";
import { enableVanStock, issueToVan, returnFromVan } from "../van-actions";

/**
 * VAN STOCK — the client forms. MOBILE FIRST: this is used standing at the back
 * of a van, one-handed.
 *
 * There is NOTHING clever here about the movement itself — loading a van is a
 * transfer depot → van and returning is the reverse, so both post through the
 * shared record_stock_transfer authority. The forms only choose the van, the
 * depot, the item and the quantity.
 *
 * HARD NAVIGATION on success (window.location.assign): the vans routes sit deep
 * enough to hit the Next 15.5 deep-swap commit race — the transfer lands and the
 * URL never moves, so the operator loads it twice. The same guard every other
 * stock form uses.
 */

type VehicleOption = { assetId: string; label: string };
type SiteOpt = { id: string; name: string };
type ItemOpt = { id: string; name: string; unit: string };

function useHardRedirect(state: FormState) {
  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);
}

function Banner({ state }: { state: FormState }) {
  if (!state.error) return null;
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {state.error}
    </p>
  );
}

function Submit({ pending, disabled, children }: { pending: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="w-full rounded-lg bg-slate-900 px-4 py-3 text-base font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
    >
      {pending ? "Saving…" : children}
    </button>
  );
}

/**
 * Enable a fleet vehicle as a stock location. Admin-only (the DB gate is the
 * real one; the page hides this from members).
 */
export function EnableVanForm({ vehicles }: { vehicles: VehicleOption[] }) {
  const [state, action, pending] = useActionState(enableVanStock, INITIAL_FORM_STATE);
  useHardRedirect(state);
  const [assetId, setAssetId] = useState(vehicles[0]?.assetId ?? "");

  if (vehicles.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        Every vehicle in your fleet is already set up for stock. Add a vehicle in Fleet to set up
        another.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <Banner state={state} />
      <div>
        <label htmlFor="vehicle_asset_id" className="block text-sm font-medium text-slate-800">
          Which vehicle?
        </label>
        <select
          id="vehicle_asset_id"
          name="vehicle_asset_id"
          value={assetId}
          onChange={(e) => setAssetId(e.target.value)}
          className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
        >
          {vehicles.map((v) => (
            <option key={v.assetId} value={v.assetId}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="name" className="block text-sm font-medium text-slate-800">
          Name it <span className="text-xs font-normal text-slate-500">Optional</span>
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="off"
          placeholder="Leave blank to use the vehicle's name"
          className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
        />
        <p className="mt-1 text-xs text-slate-500">
          A van becomes a place you can hold stock at, just like a yard or lock-up. It carries no
          value — moving stock onto it adds no cost.
        </p>
      </div>
      <Submit pending={pending} disabled={!assetId}>
        Set up for stock
      </Submit>
    </form>
  );
}

type Tab = "load" | "return";

/**
 * Load stock onto a van from a depot, or return it. One tab strip, one form each
 * — the direction is the only difference and it is the action that is called.
 */
export function MoveVanStockPanel({
  vans,
  depots,
  items,
}: {
  vans: SiteOpt[];
  depots: SiteOpt[];
  items: ItemOpt[];
}) {
  const [tab, setTab] = useState<Tab>("load");

  if (vans.length === 0) {
    return (
      <p className="text-sm text-slate-600">Set a van up for stock first, then you can load it.</p>
    );
  }
  if (depots.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        You have no depots or yards to move stock between the van and. Add one under Sites first.
      </p>
    );
  }
  if (items.length === 0) {
    return <p className="text-sm text-slate-600">Add a stock item first — there is nothing to load.</p>;
  }

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "load", label: "Load onto van" },
    { key: "return", label: "Return to depot" },
  ];

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div role="tablist" aria-label="Move van stock" className="flex gap-1 border-b border-slate-100 p-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-md px-3 py-2.5 text-sm font-semibold ${
              tab === t.key ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-4">
        <MoveForm
          key={tab}
          direction={tab}
          vans={vans}
          depots={depots}
          items={items}
        />
      </div>
    </div>
  );
}

function MoveForm({
  direction,
  vans,
  depots,
  items,
}: {
  direction: Tab;
  vans: SiteOpt[];
  depots: SiteOpt[];
  items: ItemOpt[];
}) {
  const [state, action, pending] = useActionState(
    direction === "load" ? issueToVan : returnFromVan,
    INITIAL_FORM_STATE,
  );
  useHardRedirect(state);
  const [vanId, setVanId] = useState(vans[0]?.id ?? "");
  const [depotId, setDepotId] = useState(depots[0]?.id ?? "");
  const [itemId, setItemId] = useState(items[0]?.id ?? "");
  const [qty, setQty] = useState("");

  const unit = useMemo(() => items.find((i) => i.id === itemId)?.unit ?? "ea", [items, itemId]);
  const entered = Number(qty);
  const valid = Number.isFinite(entered) && entered > 0;

  return (
    <form action={action} className="space-y-4">
      <Banner state={state} />
      <div>
        <label htmlFor="vehicle_site_id" className="block text-sm font-medium text-slate-800">
          Van
        </label>
        <select
          id="vehicle_site_id"
          name="vehicle_site_id"
          value={vanId}
          onChange={(e) => setVanId(e.target.value)}
          className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
        >
          {vans.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="depot_site_id" className="block text-sm font-medium text-slate-800">
          {direction === "load" ? "From depot" : "To depot"}
        </label>
        <select
          id="depot_site_id"
          name="depot_site_id"
          value={depotId}
          onChange={(e) => setDepotId(e.target.value)}
          className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
        >
          {depots.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="stock_item_id" className="block text-sm font-medium text-slate-800">
          Item
        </label>
        <select
          id="stock_item_id"
          name="stock_item_id"
          value={itemId}
          onChange={(e) => setItemId(e.target.value)}
          className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
        >
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="qty" className="block text-sm font-medium text-slate-800">
          How many {unit}?
        </label>
        <input
          id="qty"
          name="qty"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={qty}
          onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ""))}
          className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-3 text-lg tabular-nums focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>
      <div>
        <label htmlFor="notes" className="block text-sm font-medium text-slate-800">
          Note <span className="text-xs font-normal text-slate-500">Optional</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
        />
      </div>
      <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
        Nothing is created or lost — the company still holds the same amount in total. It moves the
        stock and adds no cost.
      </p>
      <Submit pending={pending} disabled={!valid}>
        {direction === "load"
          ? `Load ${valid ? `${formatQuantity(entered)} ${unit}` : "stock"}`
          : `Return ${valid ? `${formatQuantity(entered)} ${unit}` : "stock"}`}
      </Submit>
    </form>
  );
}
