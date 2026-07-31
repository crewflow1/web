import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  listRotaJobOptions,
  listWeekRotaEntries,
  type RotaClient,
} from "@/server/services/rota";
import { createRotaEntry, deleteRotaEntry } from "../actions";
import { CreateRotaForm, type RotaPrefill } from "./_create-form";
import { readFailure } from "@/lib/supabase/read-failure";

/**
 * Rota — weekly view, optionally month via ?view=month.
 *
 * Default = current week (Mon–Sun). Navigate via prev/next links that
 * shift the `week` query param by one week.
 *
 * Visible to all members; only admins see the assignment form / delete
 * buttons (RLS enforces; UI gates for clarity).
 */

type SP = Promise<{
  week?: string;
  view?: "week" | "month";
  error?: string;
  saved?: string;
  /** Pre-fill, arriving from a schedule recommendation (/staff/rota/conflicts). */
  assign_user?: string;
  assign_start?: string;
  assign_end?: string;
  assign_job?: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Read the pre-fill off the URL, shape-checked.
 *
 * These params only ever populate form FIELDS an admin could type by hand — the
 * shift itself is still written by `createRotaEntry`, which re-validates every
 * value, re-checks the overlap and re-applies the admin gate against the ACTIVE
 * org. A hand-crafted URL therefore grants nothing; the shape check is here so
 * a junk value renders as an empty field rather than as junk in an input.
 */
function readPrefill(sp: {
  assign_user?: string;
  assign_start?: string;
  assign_end?: string;
  assign_job?: string;
}): RotaPrefill | undefined {
  const user_id = sp.assign_user && UUID.test(sp.assign_user) ? sp.assign_user : undefined;
  const starts_at =
    sp.assign_start && DATETIME_LOCAL.test(sp.assign_start) ? sp.assign_start : undefined;
  const ends_at = sp.assign_end && DATETIME_LOCAL.test(sp.assign_end) ? sp.assign_end : undefined;
  const job_id = sp.assign_job && UUID.test(sp.assign_job) ? sp.assign_job : undefined;
  if (!user_id && !starts_at && !ends_at && !job_id) return undefined;
  return { user_id, starts_at, ends_at, job_id };
}

type RotaRow = {
  id: string;
  user_id: string;
  job_id: string | null;
  starts_at: string;
  ends_at: string;
  notes: string | null;
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function startOfWeek(iso: string | undefined): Date {
  // Pick Monday-of-week for `iso` (or today). UTC for stability.
  const d = iso ? new Date(`${iso}T00:00:00Z`) : new Date();
  const day = d.getUTCDay(); // 0 = Sun
  const offset = day === 0 ? -6 : 1 - day; // shift to Monday
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offset));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shiftWeek(monday: Date, weeks: number): Date {
  return new Date(Date.UTC(
    monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 7 * weeks,
  ));
}

export default async function RotaPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const monday = startOfWeek(sp.week);
  const sunday = new Date(Date.UTC(
    monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6,
  ));
  const startIso = `${isoDate(monday)}T00:00:00Z`;
  const endIso = `${isoDate(sunday)}T23:59:59Z`;

  // (Read deleted upstream — #480's loud-read guard here is obsolete, not lost.)
  // Current user's role — from ctx (own membership in the ACTIVE org); an
  // unfiltered memberships read returns every member's row and `.single()`
  // errors in any org with ≥2 members.
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  // Staff list for the assign form + display labels.
  const { data: members, error: membersError } = await supabase
    .from("memberships")
    .select("user_id, role, user:users ( id, full_name, email )")
    .eq("org_id", ctx.org.id);
  if (membersError) throw readFailure("rota: staff list", membersError);
  const memberById = new Map<string, { name: string; role: string }>();
  for (const m of members ?? []) {
    memberById.set(m.user_id, {
      name: m.user?.full_name ?? m.user?.email ?? "—",
      role: m.role,
    });
  }

  // Jobs picker + weekly rota, both pinned to the active org via the shared
  // reads (server/services/rota.ts) — the same functions the isolation test
  // drives with a dual-org JWT, so an unpinned read goes red there.
  const rotaDb = supabase as unknown as RotaClient;
  const jobs = await listRotaJobOptions(rotaDb, ctx.org.id);
  const entries = (await listWeekRotaEntries(
    rotaDb,
    ctx.org.id,
    startIso,
    endIso,
  )) as RotaRow[];

  // Bucket entries by (user_id, day-of-week 0-6).
  const grid = new Map<string, RotaRow[]>();
  for (const e of entries) {
    const eStart = new Date(e.starts_at);
    const dayIdx =
      Math.floor((eStart.getTime() - monday.getTime()) / 86_400_000);
    if (dayIdx < 0 || dayIdx > 6) continue;
    const key = `${e.user_id}|${dayIdx}`;
    const arr = grid.get(key) ?? [];
    arr.push(e);
    grid.set(key, arr);
  }

  const prevHref = `/staff/rota?week=${isoDate(shiftWeek(monday, -1))}`;
  const nextHref = `/staff/rota?week=${isoDate(shiftWeek(monday, 1))}`;

  const prefill = readPrefill(sp);
  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;
  const savedMessage = sp.saved
    ? sp.saved === "created"
      ? "Shift added."
      : sp.saved === "removed"
        ? "Shift removed."
        : null
    : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Rota</h1>
          <p className="mt-1 text-sm text-slate-600">
            Week of <strong>{isoDate(monday)}</strong> — Mon&nbsp;{isoDate(monday)} to Sun&nbsp;{isoDate(sunday)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/staff/rota/conflicts"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
          >
            Schedule check
          </Link>
          <Link href={prevHref} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-50">
            ← Prev
          </Link>
          <Link href="/staff/rota" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-50">
            This week
          </Link>
          <Link href={nextHref} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-50">
            Next →
          </Link>
        </div>
      </header>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          {savedMessage}
        </div>
      ) : null}

      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Assign shift</h2>
          {prefill ? (
            <p
              role="status"
              className="mt-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900"
            >
              Filled in from a schedule recommendation. Nothing has been saved —
              check it and press <strong>Assign</strong>, or change anything you
              disagree with first.{" "}
              <Link href="/staff/rota/conflicts" className="underline">
                Back to the schedule check
              </Link>
              .
            </p>
          ) : null}
          <CreateRotaForm
            action={createRotaEntry}
            prefill={prefill}
            members={(members ?? []).map((m) => ({
              user_id: m.user_id,
              user: m.user
                ? {
                    full_name: m.user.full_name ?? null,
                    email: m.user.email ?? "",
                  }
                : null,
            }))}
            jobs={(jobs ?? []).map((j) => ({
              id: j.id,
              status: j.status ?? null,
              customer: j.customer ? { name: j.customer.name ?? "" } : null,
            }))}
          />
          <p className="mt-2 text-[11px] text-slate-500">
            Server enforces conflict detection: if the staff member already
            has an overlapping shift on the same day, the assignment is
            refused.
          </p>
        </section>
      ) : null}

      <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Staff</th>
              {DAYS.map((d, i) => {
                const day = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + i));
                return (
                  <th key={d} className="px-3 py-2 text-left">
                    <div>{d}</div>
                    <div className="text-[10px] font-normal text-slate-600">{isoDate(day)}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(members ?? []).length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-4 text-center text-sm text-slate-500">No staff yet — add some on <Link href="/staff" className="underline">/staff</Link>.</td></tr>
            ) : (members ?? []).map((m) => {
              const meta = memberById.get(m.user_id);
              return (
                <tr key={m.user_id}>
                  <td className="px-3 py-2 align-top">
                    <Link href={`/staff/${m.user_id}`} className="font-medium text-slate-900 hover:underline">
                      {meta?.name ?? "—"}
                    </Link>
                    <div className="text-[11px] text-slate-500">{meta?.role}</div>
                  </td>
                  {DAYS.map((_, i) => {
                    const cell = grid.get(`${m.user_id}|${i}`) ?? [];
                    return (
                      <td key={i} className="px-2 py-2 align-top">
                        {cell.length === 0 ? (
                          <span className="text-[11px] text-slate-300">—</span>
                        ) : (
                          <ul className="space-y-1">
                            {cell.map((e) => {
                              const s = new Date(e.starts_at);
                              const en = new Date(e.ends_at);
                              const time = `${String(s.getUTCHours()).padStart(2, "0")}:${String(s.getUTCMinutes()).padStart(2, "0")}-${String(en.getUTCHours()).padStart(2, "0")}:${String(en.getUTCMinutes()).padStart(2, "0")}`;
                              return (
                                <li key={e.id} className="flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px]">
                                  <span className="font-medium text-slate-900">{time}</span>
                                  {e.job_id ? (
                                    <Link href={`/jobs/${e.job_id}`} className="text-slate-600 underline">job</Link>
                                  ) : null}
                                  {isAdmin ? (
                                    <form action={deleteRotaEntry.bind(null, e.id)} className="ml-auto">
                                      <button type="submit" className="text-red-700 hover:underline" title="Remove">×</button>
                                    </form>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
