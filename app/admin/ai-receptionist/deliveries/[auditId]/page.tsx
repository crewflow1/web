import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireHqPage } from "@/server/auth/hq";
import {
  LIFECYCLE_STAGE_LABELS,
  LIFECYCLE_STAGE_STYLES,
  VERDICT_LABELS,
  VERDICT_STYLES,
  deriveLifecycleStage,
  formatLifecycleTimestamp,
  type LifecycleRow,
} from "@/lib/ai-receptionist/lifecycle";

/**
 * /admin/ai-receptionist/deliveries/[auditId] — the full lifecycle of ONE receptionist
 * reply (Directive #018, R9). READ-ONLY: every value is read from the `ai_reply_lifecycle`
 * view; this page writes nothing, sends nothing, reaches no provider.
 *
 * One audit yields one view row per transport attempt (and a single row — with null
 * transport — when the reply was held or blocked and never carried out). This page renders
 * the reply once, then each transport attempt with its latest delivery receipt, and a
 * step timeline (produced → attempted → last receipt) so the operator can see WHEN each
 * lifecycle step happened and WHAT caused any failure.
 */

const VIEW_COLUMNS =
  "audit_id, org_id, employee_slug, channel, enquiry_id, lead_id, customer_ref, " +
  "correlation_id, draft, verdict, allowed, categories, enforcement_reason, safe_text, " +
  "audit_at, transport_id, transport_status, transport_provider, provider_message_id, " +
  "transport_failure_reason, to_ref, attempt, cost_usd, latency_ms, dedup_key, " +
  "transport_at, receipt_id, delivery_status, delivery_terminal, " +
  "delivery_provider_status, delivery_error_code, receipt_at, receipt_count";

type OrgLite = { id: string; name: string | null; slug: string | null };

export default async function HqReceptionistDeliveryDetailPage({
  params,
}: {
  params: Promise<{ auditId: string }>;
}) {
  await requireHqPage();

  const { auditId } = await params;
  const supabase = createAdminClient();

  const result = await supabase
    .from("ai_reply_lifecycle" as never)
    .select(VIEW_COLUMNS)
    .eq("audit_id" as never, auditId)
    .order("transport_at" as never, { ascending: true, nullsFirst: true });

  const rows = ((result as { data?: LifecycleRow[] | null }).data ?? []) as LifecycleRow[];
  if (rows.length === 0) notFound();

  // The reply facts are identical across a reply's rows — read them from the first.
  const reply = rows[0]!;
  const transports = rows.filter((r) => r.transport_id);
  const primaryStage = deriveLifecycleStage(reply);

  let org: OrgLite | null = null;
  const orgRes = await supabase
    .from("organizations" as never)
    .select("id, name, slug")
    .eq("id" as never, reply.org_id)
    .maybeSingle();
  org = ((orgRes as { data?: OrgLite | null }).data ?? null) as OrgLite | null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href="/admin/ai-receptionist" className="hover:text-slate-900">
          AI Receptionist setups
        </Link>
        <span aria-hidden>/</span>
        <Link href="/admin/ai-receptionist/deliveries" className="hover:text-slate-900">
          Reply delivery monitoring
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{org?.name ?? reply.org_id.slice(0, 8)}</span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Reply lifecycle</h1>
          <p className="mt-1 text-sm text-slate-600">
            {org?.name ?? "Unknown org"}
            {org?.slug ? (
              <>
                {" · "}
                <code className="rounded bg-slate-100 px-1">{org.slug}</code>
              </>
            ) : null}
          </p>
        </div>
        <span
          className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${LIFECYCLE_STAGE_STYLES[primaryStage]}`}
        >
          {LIFECYCLE_STAGE_LABELS[primaryStage]}
        </span>
      </header>

      {/* (1)(2) The reply + its enforcement decision */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">The reply</h2>
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
              VERDICT_STYLES[reply.verdict] ?? "bg-slate-100 text-slate-700"
            }`}
          >
            {VERDICT_LABELS[reply.verdict] ?? reply.verdict}
          </span>
        </div>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <Detail label="Channel" value={reply.channel} />
          <Detail label="Employee" value={reply.employee_slug} />
          <Detail
            label="Auto-sendable"
            value={reply.allowed ? "Yes (allowed)" : "No (held/blocked)"}
          />
          <Detail
            label="Guardrail categories"
            value={reply.categories && reply.categories.length ? reply.categories.join(", ") : null}
          />
          <Detail label="Customer ref" value={reply.customer_ref} />
          <Detail label="Produced at" value={formatLifecycleTimestamp(reply.audit_at)} />
          <div className="sm:col-span-2">
            <Detail label="Enforcement reason" value={reply.enforcement_reason} multiline />
          </div>
          <div className="sm:col-span-2">
            <Detail label="Draft" value={reply.draft} multiline />
          </div>
          {reply.safe_text ? (
            <div className="sm:col-span-2">
              <Detail label="Safe (auto-sendable) text" value={reply.safe_text} multiline />
            </div>
          ) : null}
        </dl>
        <p className="mt-3 text-[11px] text-slate-500">
          Correlation <code className="rounded bg-slate-100 px-1">{reply.correlation_id}</code>
          {reply.enquiry_id ? ` · enquiry ${reply.enquiry_id.slice(0, 8)}` : ""}
          {reply.lead_id ? ` · lead ${reply.lead_id.slice(0, 8)}` : ""}
        </p>
      </section>

      {/* (3)–(8) Transport attempts + their delivery receipts */}
      {transports.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
          <h2 className="text-base font-semibold text-slate-900">No transport attempted</h2>
          <p className="mt-1">
            This reply was {VERDICT_LABELS[reply.verdict] ?? reply.verdict}, so it never
            reached a transport. The enforcement gate (proven in SQL) forbids a transport
            for any reply that is not an auto-sendable <code>allow</code> — that is why there
            is nothing to deliver here.
          </p>
        </section>
      ) : (
        transports.map((t) => {
          const stage = deriveLifecycleStage(t);
          return (
            <section
              key={t.transport_id}
              className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-slate-900">
                  Transport attempt{t.attempt ? ` #${t.attempt}` : ""}
                </h2>
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${LIFECYCLE_STAGE_STYLES[stage]}`}
                >
                  {LIFECYCLE_STAGE_LABELS[stage]}
                </span>
              </div>

              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                <Detail label="Transport status" value={t.transport_status} />
                <Detail label="Provider" value={t.transport_provider} />
                <Detail label="Destination" value={t.to_ref} />
                <Detail label="Provider message id" value={t.provider_message_id} />
                <Detail label="Failure reason" value={t.transport_failure_reason} />
                <Detail label="Attempted at" value={formatLifecycleTimestamp(t.transport_at)} />
                <Detail
                  label="Cost (USD)"
                  value={t.cost_usd != null ? String(t.cost_usd) : null}
                />
                <Detail
                  label="Latency (ms)"
                  value={t.latency_ms != null ? String(t.latency_ms) : null}
                />
              </dl>

              <h3 className="mt-5 text-sm font-semibold text-slate-900">
                Delivery receipt
                <span className="ml-2 text-xs font-normal text-slate-500">
                  {t.receipt_count} recorded
                </span>
              </h3>
              {t.receipt_id ? (
                <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
                  <Detail label="Delivery status" value={t.delivery_status} />
                  <Detail
                    label="Terminal"
                    value={t.delivery_terminal ? "Yes (final)" : "No (interim)"}
                  />
                  <Detail label="Provider status (raw)" value={t.delivery_provider_status} />
                  <Detail label="Error code" value={t.delivery_error_code} />
                  <Detail label="Reported at" value={formatLifecycleTimestamp(t.receipt_at)} />
                </dl>
              ) : t.transport_status === "sent" ? (
                <p className="mt-2 text-sm text-blue-700">
                  Awaiting the provider&rsquo;s delivery receipt — the send was accepted but
                  no status callback has been recorded yet.
                </p>
              ) : (
                <p className="mt-2 text-sm text-slate-500">
                  No delivery receipt — this attempt failed before a provider could report
                  one.
                </p>
              )}

              {/* (7) The step timeline for this attempt. */}
              <div className="mt-5 border-t border-slate-100 pt-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Timeline
                </p>
                <ol className="mt-1 space-y-0.5 text-xs text-slate-600">
                  <li>Produced · {formatLifecycleTimestamp(reply.audit_at)}</li>
                  <li>Transport {t.transport_status} · {formatLifecycleTimestamp(t.transport_at)}</li>
                  <li>
                    {t.receipt_id
                      ? `Delivery ${t.delivery_status} · ${formatLifecycleTimestamp(t.receipt_at)}`
                      : "Delivery — not yet reported"}
                  </li>
                </ol>
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

function Detail({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string | null;
  multiline?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={
          multiline
            ? "mt-0.5 whitespace-pre-wrap text-sm text-slate-900"
            : "mt-0.5 text-sm text-slate-900"
        }
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}
