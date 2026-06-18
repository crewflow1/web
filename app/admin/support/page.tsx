import Link from "next/link";
import { listSupportTicketsForHq } from "@/server/services/hq-support-snapshot";
import {
  SUPPORT_STATUS_LABEL,
  SUPPORT_PRIORITY_LABEL,
  SUPPORT_CATEGORY_LABEL,
  SUPPORT_STATUSES,
  SUPPORT_PRIORITIES,
  SUPPORT_CATEGORIES,
  SUPPORT_SORTS,
  SUPPORT_SORT_LABELS,
  SUPPORT_ACTIVE_STATUSES,
  filterTickets,
  sortTickets,
  type SupportStatus,
  type SupportPriority,
  type SupportCategory,
  type SupportSort,
} from "@/lib/hq/support";
import {
  Alert,
  AnimatedNumber,
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  GlowHeader,
  Input,
  Panel,
  Select,
  StatTile,
  Surface,
  type Accent,
} from "@/components/ui";

/**
 * HQ Support queue — /admin/support (HQ-7).
 *
 * Cross-tenant. Service-role read (bypasses RLS). The list shows
 * every ticket across every org, with filters + sort. Click a
 * row to open /admin/support/<id> for the full thread + status
 * controls + internal-notes view.
 */

/** Dark-surface accent for each ticket status pill. */
const STATUS_ACCENT: Record<SupportStatus, Accent> = {
  open: "amber",
  in_progress: "sky",
  waiting_on_customer: "indigo",
  resolved: "emerald",
  closed: "slate",
};

/** Dark-surface accent for each ticket priority pill. */
const PRIORITY_ACCENT: Record<SupportPriority, Accent> = {
  low: "slate",
  normal: "sky",
  high: "amber",
  urgent: "rose",
};

type SP = Promise<{
  q?: string;
  status?: string;
  priority?: string;
  category?: string;
  sort?: string;
  saved?: string;
  error?: string;
}>;

export const dynamic = "force-dynamic";

export default async function HqSupportListPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const status =
    (sp.status as SupportStatus | "all" | "active" | undefined) ?? "active";
  const priority =
    (sp.priority as SupportPriority | "all" | undefined) ?? "all";
  const category =
    (sp.category as SupportCategory | "all" | undefined) ?? "all";
  const sort = (SUPPORT_SORTS.includes(sp.sort as SupportSort)
    ? sp.sort
    : "needs_attention") as SupportSort;

  const all = await listSupportTicketsForHq();
  const filtered = filterTickets(all, { q, status, priority, category });
  const sorted = sortTickets(filtered, sort);

  // KPI tiles use the FULL ticket set, not the filtered view, so the
  // operator sees system-wide truth.
  const active = all.filter((t) =>
    SUPPORT_ACTIVE_STATUSES.includes(t.status as SupportStatus),
  );
  const urgent = active.filter((t) => t.priority === "urgent").length;
  const oweCustomer = active.filter(
    (t) => t.last_reply_kind === "customer",
  ).length;
  const resolved7d = all.filter((t) => {
    if (!t.resolved_at) return false;
    const days =
      (Date.now() - new Date(t.resolved_at).getTime()) / 86_400_000;
    return days <= 7;
  }).length;

  const banner = (() => {
    if (sp.saved)
      return { tone: "ok" as const, msg: `Saved (${sp.saved}).` };
    if (sp.error)
      return { tone: "err" as const, msg: `Error: ${sp.error}` };
    return null;
  })();

  return (
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ"
        title="All customer tickets"
        subtitle={
          <>
            {
              "Cross-tenant ticket queue. Sort defaults to “needs attention”: active tickets where the customer was last to reply, oldest first."
            }
          </>
        }
        actions={
          <ButtonLink href="/admin/overview" variant="glass" size="sm">
            ← HQ overview
          </ButtonLink>
        }
      />

      <div className="space-y-6 p-5 sm:p-7">
        {banner ? (
          <Alert tone={banner.tone === "ok" ? "success" : "danger"}>
            {banner.msg}
          </Alert>
        ) : null}

        {/* KPI tiles */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile
            label="Active"
            value={<AnimatedNumber value={active.length} />}
            accent="amber"
          />
          <StatTile
            label="Urgent active"
            value={<AnimatedNumber value={urgent} />}
            accent="rose"
          />
          <StatTile
            label="Awaiting CrewFlow"
            value={<AnimatedNumber value={oweCustomer} />}
            accent="indigo"
          />
          <StatTile
            label="Resolved this week"
            value={<AnimatedNumber value={resolved7d} />}
            accent="emerald"
          />
        </section>

        {/* Filter bar */}
        <Panel>
          <form
            method="get"
            action="/admin/support"
            className="flex flex-wrap items-end gap-2"
          >
            <Field label="Search" className="w-64">
              <Input
                type="text"
                name="q"
                defaultValue={q}
                placeholder="subject, customer, #number"
              />
            </Field>
            <Field label="Status">
              <Select name="status" defaultValue={status}>
                <option value="all">All</option>
                <option value="active">Active (default)</option>
                {SUPPORT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {SUPPORT_STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority">
              <Select name="priority" defaultValue={priority}>
                <option value="all">All</option>
                {SUPPORT_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {SUPPORT_PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Category">
              <Select name="category" defaultValue={category}>
                <option value="all">All</option>
                {SUPPORT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {SUPPORT_CATEGORY_LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sort">
              <Select name="sort" defaultValue={sort}>
                {SUPPORT_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {SUPPORT_SORT_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" variant="accent" size="sm">
              Apply
            </Button>
            <ButtonLink href="/admin/support" variant="glass" size="sm">
              Reset
            </ButtonLink>
          </form>
        </Panel>

        {/* List */}
        {sorted.length === 0 ? (
          <EmptyState
            title="No tickets match these filters."
            description="Adjust the filters above or reset to see the full queue."
          />
        ) : (
          <ul className="divide-y divide-slate-800 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
            {sorted.map((t) => (
              <li key={t.id} className="px-4 py-3 hover:bg-slate-900/50">
                <Link
                  href={`/admin/support/${t.id}`}
                  className="flex flex-wrap items-baseline justify-between gap-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                        #{t.ticket_number}
                      </span>
                      <span className="text-sm font-semibold text-white">
                        {t.subject}
                      </span>
                      {t.has_internal_notes ? (
                        <Badge accent="amber">internal notes</Badge>
                      ) : null}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="font-medium text-slate-300">
                        {t.org_name ?? t.org_id.slice(0, 8)}
                      </span>
                      <Badge accent={STATUS_ACCENT[t.status as SupportStatus]}>
                        {SUPPORT_STATUS_LABEL[t.status as SupportStatus] ?? t.status}
                      </Badge>
                      <Badge accent={PRIORITY_ACCENT[t.priority as SupportPriority]}>
                        {SUPPORT_PRIORITY_LABEL[t.priority as SupportPriority] ?? t.priority}
                      </Badge>
                      <span className="text-slate-500">
                        {SUPPORT_CATEGORY_LABEL[t.category as SupportCategory] ?? t.category}
                      </span>
                    </p>
                    {t.last_reply_preview ? (
                      <p className="mt-1 line-clamp-2 text-xs text-slate-400">
                        {t.last_reply_preview}
                      </p>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-slate-500">
                    {t.last_reply_at
                      ? `${t.last_reply_kind === "customer" ? "Customer replied" : "We replied"} ${t.last_reply_at.slice(0, 10)}`
                      : `Created ${t.created_at.slice(0, 10)}`}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Surface>
  );
}
