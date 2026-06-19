import Link from "next/link";
import { pill } from "@/components/ui/tokens";
import {
  listOnboardingForHq,
  listImportsForOrg,
  type OnboardingRow,
  type OnboardingImportRow,
} from "@/server/services/hq-onboarding-snapshot";
import {
  AnimatedNumber,
  Button,
  ButtonLink,
  GlowHeader,
  Meter,
  Panel,
  Select,
  StatTile,
  Surface,
} from "@/components/ui";

/**
 * Onboarding & migration — HQ-4.
 *
 * Cross-tenant view of every customer's onboarding progress: migration
 * %, stage, ETA, imports in flight, files uploaded, rows succeeded vs
 * failed, last activity. Click <strong>Open</strong> on any row to
 * see the per-customer import detail (file list per import + status).
 *
 * Editing the percentages / stage / ETA happens in the Customers OS
 * detail page (HQ-3); this view is intentionally read-only for triage
 * — opens out to /admin/customers/<id> for the controls.
 */

type SP = Promise<{
  q?: string;
  status?: string;
  stalled?: string;
  sort?: string;
  org?: string;
}>;

export default async function HqOnboardingPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const rows = await listOnboardingForHq();

  const q = (sp.q ?? "").trim().toLowerCase();
  const statusFilter = (sp.status ?? "").trim();
  const stalledOnly = sp.stalled === "1";
  const sort = sp.sort ?? "stalled";
  const openOrg = sp.org ?? null;

  const filtered = rows
    .filter((r) =>
      !q
        ? true
        : r.org_name.toLowerCase().includes(q) ||
          (r.owner_email ?? "").toLowerCase().includes(q),
    )
    .filter((r) => (statusFilter ? r.status === statusFilter : true))
    .filter((r) =>
      stalledOnly
        ? r.migration_percent < 100 && (r.imports_in_progress > 0 || r.rows_failed > 0)
        : true,
    );

  const sorted = [...filtered].sort((a, b) => {
    if (sort === "newest")
      return new Date(b.last_import_at ?? 0).getTime() -
        new Date(a.last_import_at ?? 0).getTime();
    if (sort === "name") return a.org_name.localeCompare(b.org_name);
    if (sort === "percent_asc") return a.migration_percent - b.migration_percent;
    if (sort === "errors") return b.rows_failed - a.rows_failed;
    // "stalled" default — sort by least progress + most files first
    return (
      a.migration_percent - b.migration_percent ||
      b.files_count - a.files_count
    );
  });

  // KPIs across the filtered set.
  const totals = sorted.reduce(
    (acc, r) => {
      acc.files += r.files_count;
      acc.rowsImported += r.rows_imported;
      acc.rowsFailed += r.rows_failed;
      acc.inProgress += r.imports_in_progress;
      return acc;
    },
    { files: 0, rowsImported: 0, rowsFailed: 0, inProgress: 0 },
  );

  // Drill-down only for the open row.
  const openImports: OnboardingImportRow[] = openOrg
    ? await listImportsForOrg(openOrg)
    : [];

  return (
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ"
        title="Onboarding & migration"
        subtitle={
          <>
            Where every customer is in their migration. Edit migration %,
            stage, and ETA in <strong>/admin/customers/&lt;id&gt;</strong>;
            this view is for triage — sorted to put stalled customers first.
          </>
        }
      />

      <div className="space-y-6 p-5 sm:p-7">
        {/* KPI tiles */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Customers (filtered)" value={<AnimatedNumber value={sorted.length} />} />
          <StatTile label="Imports in flight" value={<AnimatedNumber value={totals.inProgress} />} />
          <StatTile label="Files uploaded" value={<AnimatedNumber value={totals.files} />} />
          <StatTile
            label="Failed rows"
            value={<AnimatedNumber value={totals.rowsFailed} />}
            accent={totals.rowsFailed > 0 ? "rose" : "slate"}
          />
        </section>

        <Filters
          q={q}
          status={statusFilter}
          stalled={stalledOnly}
          sort={sort}
          count={filtered.length}
        />

        <Panel bodyClassName="-mx-5 -mb-5">
          {sorted.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-slate-500">
              No customers match the current filters.
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {sorted.map((r) => (
                <OnboardingRowView
                  key={r.org_id}
                  row={r}
                  open={openOrg === r.org_id}
                  imports={openOrg === r.org_id ? openImports : []}
                  qs={buildQs(sp)}
                />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </Surface>
  );
}

function OnboardingRowView({
  row,
  open,
  imports,
  qs,
}: {
  row: OnboardingRow;
  open: boolean;
  imports: OnboardingImportRow[];
  qs: URLSearchParams;
}) {
  const expandQs = new URLSearchParams(qs);
  expandQs.set("org", row.org_id);
  const collapseQs = new URLSearchParams(qs);
  collapseQs.delete("org");

  const stalled =
    row.migration_percent < 100 && row.imports_in_progress > 0;
  const danger = row.rows_failed > 0 || row.imports_rolled_back > 0;

  return (
    <li className="px-5 py-3 transition-colors hover:bg-slate-900/50">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link
            href={`/admin/customers/${row.org_id}`}
            className="text-sm font-semibold text-white transition-colors hover:text-slate-300"
          >
            {row.org_name}
          </Link>
          <p className="truncate text-[11px] text-slate-500">
            {row.owner_email ?? "—"}
            {row.migration_stage ? ` · ${row.migration_stage}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {danger ? (
            <span className={`rounded-full px-2 py-0.5 ${pill("rose")}`}>
              {row.rows_failed > 0 ? `${row.rows_failed} failed rows` : null}
              {row.rows_failed > 0 && row.imports_rolled_back > 0 ? " · " : ""}
              {row.imports_rolled_back > 0
                ? `${row.imports_rolled_back} rolled back`
                : null}
            </span>
          ) : null}
          {stalled ? (
            <span className={`rounded-full px-2 py-0.5 ${pill("amber")}`}>
              {row.imports_in_progress} in flight
            </span>
          ) : null}
          {row.migration_percent === 100 ? (
            <span className={`rounded-full px-2 py-0.5 ${pill("emerald")}`}>
              Migration complete
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-2">
        <ProgressBar
          percent={row.migration_percent}
          label={`Migration · ${row.migration_percent}%`}
        />
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-6">
        <Field label="Onboarding" value={`${row.onboarding_percent}%`} />
        <Field label="Files" value={String(row.files_count)} />
        <Field
          label="Rows imported"
          value={row.rows_imported.toLocaleString("en-GB")}
        />
        <Field
          label="Rows failed"
          value={row.rows_failed.toLocaleString("en-GB")}
          tone={row.rows_failed > 0 ? "danger" : undefined}
        />
        <Field label="ETA" value={row.migration_eta ?? "—"} />
        <Field
          label="Last upload"
          value={row.last_import_at ? row.last_import_at.slice(0, 10) : "—"}
        />
      </dl>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Link
          href={`/admin/customers/${row.org_id}`}
          className="text-xs font-medium text-indigo-300 transition-colors hover:text-indigo-200"
        >
          Edit progress →
        </Link>
        {open ? (
          <Link
            href={`/admin/onboarding?${collapseQs.toString()}`}
            className="text-xs font-medium text-slate-400 transition-colors hover:text-slate-200"
            scroll={false}
          >
            Collapse
          </Link>
        ) : (
          <ButtonLink
            href={`/admin/onboarding?${expandQs.toString()}`}
            variant="glass"
            size="sm"
            scroll={false}
          >
            Open files
          </ButtonLink>
        )}
      </div>

      {open ? <ImportsDetail imports={imports} /> : null}
    </li>
  );
}

function ImportsDetail({ imports }: { imports: OnboardingImportRow[] }) {
  if (imports.length === 0) {
    return (
      <p className="mt-3 rounded-xl border border-dashed border-slate-800 bg-slate-900/60 px-3 py-4 text-center text-xs text-slate-500">
        No imports started yet. The customer can start one at{" "}
        <code className="rounded bg-slate-800/80 px-1 font-mono text-[0.9em] text-slate-300 ring-1 ring-inset ring-slate-700">/imports</code> on their workspace.
      </p>
    );
  }
  return (
    <ul className="mt-3 space-y-2">
      {imports.map((imp) => (
        <li
          key={imp.id}
          className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-100">{imp.name}</p>
              <p className="text-[11px] text-slate-500">
                {imp.created_at.slice(0, 16).replace("T", " ")}
                {imp.committed_at
                  ? ` · committed ${imp.committed_at.slice(0, 10)}`
                  : imp.rolled_back_at
                    ? ` · rolled back ${imp.rolled_back_at.slice(0, 10)}`
                    : ""}
              </p>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${importPill(imp.status, imp.committed_at, imp.rolled_back_at)}`}
            >
              {imp.rolled_back_at
                ? "rolled back"
                : imp.committed_at
                  ? "committed"
                  : imp.status}
            </span>
          </div>
          {imp.files.length > 0 ? (
            <ul className="mt-2 space-y-1 text-[11px] text-slate-300">
              {imp.files.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-950 px-2 py-1"
                >
                  <span className="truncate font-medium">{f.filename}</span>
                  <span className="shrink-0 text-slate-500">
                    {f.row_count != null
                      ? `${f.row_count.toLocaleString("en-GB")} rows`
                      : "—"}
                    {f.mime_type ? ` · ${f.mime_type}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function importPill(
  status: string,
  committed: string | null,
  rolledBack: string | null,
): string {
  if (rolledBack) return pill("rose");
  if (committed) return pill("emerald");
  if (status === "failed") return pill("rose");
  if (status === "detected" || status === "uploaded") {
    return pill("amber");
  }
  return pill("quiet");
}

function ProgressBar({
  percent,
  label,
}: {
  percent: number;
  label: string;
}) {
  const safe = Math.max(0, Math.min(100, percent));
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span>{label}</span>
      </div>
      <div className="mt-0.5">
        <Meter value={safe} accent={safe === 100 ? "emerald" : "indigo"} />
      </div>
    </div>
  );
}

function Filters({
  q,
  status,
  stalled,
  sort,
  count,
}: {
  q: string;
  status: string;
  stalled: boolean;
  sort: string;
  count: number;
}) {
  return (
    <form
      method="GET"
      action="/admin/onboarding"
      className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 px-4 py-3"
    >
      <label className="min-w-[200px] flex-1 text-[11px] font-medium text-slate-400">
        Search
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Company, owner email…"
          className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
        />
      </label>
      <label className="text-[11px] font-medium text-slate-400">
        Status
        <Select name="status" defaultValue={status} className="mt-1">
          <option value="">All</option>
          <option value="pending">Pending</option>
          <option value="trial">Trial</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="cancelled">Cancelled</option>
        </Select>
      </label>
      <label className="flex items-center gap-1.5 text-[11px] font-medium text-slate-300">
        <input
          type="checkbox"
          name="stalled"
          value="1"
          defaultChecked={stalled}
        />
        Stalled only
      </label>
      <label className="text-[11px] font-medium text-slate-400">
        Sort
        <Select name="sort" defaultValue={sort} className="mt-1">
          <option value="stalled">Stalled first (lowest %)</option>
          <option value="errors">Most failed rows ↓</option>
          <option value="percent_asc">Migration % ↑</option>
          <option value="newest">Most recent upload</option>
          <option value="name">Name A→Z</option>
        </Select>
      </label>
      <Button type="submit" variant="accent" size="sm">
        Apply
      </Button>
      <p className="text-[11px] text-slate-500">{count} customers</p>
    </form>
  );
}

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "danger";
}) {
  const cls = tone === "danger" ? "text-rose-300" : "text-slate-100";
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className={`font-medium ${cls}`}>{value}</dd>
    </div>
  );
}

function buildQs(sp: {
  q?: string;
  status?: string;
  stalled?: string;
  sort?: string;
}): URLSearchParams {
  const out = new URLSearchParams();
  if (sp.q) out.set("q", sp.q);
  if (sp.status) out.set("status", sp.status);
  if (sp.stalled) out.set("stalled", sp.stalled);
  if (sp.sort) out.set("sort", sp.sort);
  return out;
}
