"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DEMO_LIFECYCLE_STATUSES,
  DEMO_STATUS_LABELS,
  DEMO_STATUS_PILL,
  toLifecycleStatus,
  type DemoLifecycleStatus,
} from "@/lib/hq/demo-lifecycle";
import { TURNOVER_LABELS } from "@/lib/demo/schema";
import {
  moveDemoToStatus,
  addDemoNote,
  scheduleDemo,
  logDemoContact,
} from "./actions";
import type { DemoRow } from "./_card";
import type { AdminActivityRow } from "@/server/services/hq-audit";

/**
 * Side panel rendered when the operator clicks a kanban card.
 *
 * Sections:
 *   1. Header — company, owner, contact details, current status pill,
 *      close button.
 *   2. Quick-actions row — Call (tel:), Email (mailto:), WhatsApp
 *      (wa.me/<phone>). Each link fires logDemoContact() in the
 *      background so the audit timeline records the attempt.
 *   3. Status actions — every CEO-directive button as its own form:
 *      Mark contacted · Approve (= Won) · Reject (= Lost) · Mark won ·
 *      Mark lost · Send setup payment · Mark payment received ·
 *      Active (onboarding) · Active.
 *   4. Schedule — single-input form that sets preferred_demo_time and
 *      flips status to demo_booked.
 *   5. Notes — full notes blob + append form.
 *   6. Activity timeline — admin_activity_log rows for this demo.
 *
 * Server actions handle all DB writes. No client-only state lives in
 * here beyond the React 19 useTransition for pending-button styling.
 */

const PHONE_DIGITS_RE = /[^\d+]/g;

function whatsappHref(phone: string | null): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(PHONE_DIGITS_RE, "").replace(/^\+/, "");
  if (!cleaned) return null;
  return `https://wa.me/${cleaned}`;
}

export function DemoDetailPanel({
  demo,
  activity,
  onClose,
}: {
  demo: DemoRow;
  activity: AdminActivityRow[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pendingContact, startContact] = useTransition();

  const status = toLifecycleStatus(demo.status);
  const phoneHref = demo.phone ? `tel:${demo.phone.replace(/\s/g, "")}` : null;
  const mailHref = `mailto:${demo.email}?subject=${encodeURIComponent(
    `Re: CrewFlow demo — ${demo.company}`,
  )}`;
  const waHref = whatsappHref(demo.phone);

  function recordContact(channel: "call" | "email" | "whatsapp") {
    startContact(async () => {
      await logDemoContact(demo.id, channel);
      router.refresh();
    });
  }

  return (
    <aside className="rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Demo · {demo.created_at.slice(0, 10)}
          </p>
          <h2 className="mt-0.5 truncate text-lg font-bold text-slate-900">
            {demo.company}
          </h2>
          <p className="truncate text-sm text-slate-600">
            {demo.name} ·{" "}
            <a href={mailHref} className="hover:text-slate-900">
              {demo.email}
            </a>
            {demo.phone ? (
              <>
                {" · "}
                <a href={phoneHref ?? "#"} className="hover:text-slate-900">
                  {demo.phone}
                </a>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${DEMO_STATUS_PILL[status]}`}
          >
            {DEMO_STATUS_LABELS[status]}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>
      </header>

      {/* Quick contact */}
      <section className="border-b border-slate-200 px-5 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Contact
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <ContactLink
            href={phoneHref}
            label="Call"
            onClick={() => recordContact("call")}
            disabled={!phoneHref || pendingContact}
          />
          <ContactLink
            href={mailHref}
            label="Email"
            onClick={() => recordContact("email")}
            disabled={pendingContact}
          />
          <ContactLink
            href={waHref}
            label="WhatsApp"
            onClick={() => recordContact("whatsapp")}
            disabled={!waHref || pendingContact}
            target="_blank"
            rel="noopener noreferrer"
            className="border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
          />
        </div>
      </section>

      {/* Demo info */}
      <section className="grid grid-cols-1 gap-2 border-b border-slate-200 px-5 py-3 text-sm sm:grid-cols-2">
        <Field label="Employees" value={demo.employees} />
        <Field
          label="Turnover"
          value={
            demo.turnover_range
              ? (TURNOVER_LABELS[
                  demo.turnover_range as keyof typeof TURNOVER_LABELS
                ] ?? demo.turnover_range)
              : null
          }
        />
        <Field label="Current systems" value={demo.current_systems} />
        <Field label="Source" value={demo.source} />
        <Field
          label="Preferred time"
          value={demo.preferred_demo_time}
          className="sm:col-span-2"
        />
      </section>

      {/* Status actions */}
      <section className="border-b border-slate-200 px-5 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Move status
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <StatusButton demoId={demo.id} status="contacted" label="Mark contacted" tone="neutral" />
          <StatusButton demoId={demo.id} status="won" label="Approve" tone="emerald" />
          <StatusButton demoId={demo.id} status="lost" label="Reject" tone="red" />
          <StatusButton demoId={demo.id} status="demo_done" label="Demo done" tone="neutral" />
          <StatusButton demoId={demo.id} status="won" label="Mark won" tone="emerald" />
          <StatusButton demoId={demo.id} status="lost" label="Mark lost" tone="red" />
          <StatusButton demoId={demo.id} status="payment_sent" label="Send setup payment" tone="amber" />
          <StatusButton demoId={demo.id} status="payment_received" label="Mark payment received" tone="emerald" />
          <StatusButton demoId={demo.id} status="active_onboarding" label="Move to onboarding" tone="cyan" />
          <StatusButton demoId={demo.id} status="active" label="Mark active" tone="emerald" />
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Tip: you can also drag the card between columns on the board.
        </p>
      </section>

      {/* Schedule */}
      <section className="border-b border-slate-200 px-5 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Schedule demo
        </p>
        <form
          action={scheduleDemo}
          className="mt-2 flex flex-wrap items-center gap-2"
        >
          <input type="hidden" name="demo_id" value={demo.id} />
          <input
            type="text"
            name="preferred_demo_time"
            defaultValue={demo.preferred_demo_time ?? ""}
            placeholder="e.g. Wed 14:00 BST"
            className="min-w-[200px] flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            required
            maxLength={200}
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
          >
            Set + move to Booked
          </button>
        </form>
      </section>

      {/* Notes */}
      <section className="border-b border-slate-200 px-5 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Notes
        </p>
        {demo.notes ? (
          <pre className="mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">
            {demo.notes}
          </pre>
        ) : (
          <p className="mt-2 text-xs text-slate-500">No notes yet.</p>
        )}
        <form action={addDemoNote} className="mt-2 space-y-2">
          <input type="hidden" name="demo_id" value={demo.id} />
          <textarea
            name="note"
            rows={2}
            required
            maxLength={4000}
            placeholder="Add a note — gets stamped with your email + the timestamp"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
          >
            Add note
          </button>
        </form>
      </section>

      {/* Timeline */}
      <section className="px-5 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Activity timeline
        </p>
        {activity.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">
            Nothing yet. Status moves, notes, and contact clicks all show up here.
          </p>
        ) : (
          <ol className="mt-2 space-y-2 text-xs">
            {activity.map((a) => (
              <li
                key={a.id}
                className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-800">
                    {prettyAction(a.action)}
                  </span>
                  <span className="text-[10px] text-slate-500">
                    {a.created_at.slice(0, 16).replace("T", " ")}
                  </span>
                </div>
                <p className="mt-0.5 text-slate-600">
                  {a.actor_email ?? "—"}
                </p>
                {a.metadata && Object.keys(a.metadata).length > 0 ? (
                  <p className="mt-1 text-[11px] text-slate-500">
                    {renderMetadata(a.metadata)}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

// --------------------------------------------------------------------

function Field({
  label,
  value,
  className,
}: {
  label: string;
  value: string | null;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-0.5 text-sm text-slate-800">{value ?? "—"}</p>
    </div>
  );
}

function ContactLink({
  href,
  label,
  onClick,
  disabled,
  className,
  target,
  rel,
}: {
  href: string | null;
  label: string;
  onClick: () => void;
  disabled: boolean;
  className?: string;
  target?: string;
  rel?: string;
}) {
  if (!href || disabled) {
    return (
      <span className="inline-flex cursor-not-allowed items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-400">
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      onClick={onClick}
      target={target}
      rel={rel}
      className={`inline-flex items-center gap-1 rounded-md border px-3 py-1 text-xs font-medium transition ${
        className ?? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
      }`}
    >
      {label}
    </a>
  );
}

function StatusButton({
  demoId,
  status,
  label,
  tone,
}: {
  demoId: string;
  status: DemoLifecycleStatus;
  label: string;
  tone: "neutral" | "emerald" | "red" | "amber" | "cyan";
}) {
  if (!(DEMO_LIFECYCLE_STATUSES as readonly string[]).includes(status)) {
    return null;
  }
  const cls = (() => {
    switch (tone) {
      case "emerald":
        return "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100";
      case "red":
        return "border-red-300 bg-white text-red-700 hover:bg-red-50";
      case "amber":
        return "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100";
      case "cyan":
        return "border-cyan-300 bg-cyan-50 text-cyan-900 hover:bg-cyan-100";
      default:
        return "border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
    }
  })();
  return (
    <form action={moveDemoToStatus} className="inline-block">
      <input type="hidden" name="demo_id" value={demoId} />
      <input type="hidden" name="status" value={status} />
      <button
        type="submit"
        className={`rounded-md border px-2.5 py-1 text-[11px] font-medium ${cls}`}
      >
        {label}
      </button>
    </form>
  );
}

const LIFECYCLE_LABELS: Record<string, string> = {
  "demo.created": "Demo request created",
  "demo.note_added": "Note added",
  "demo.scheduled": "Demo scheduled",
  "demo.email_sent": "Email sent",
  "demo.email_failed": "Email failed",
  "demo.customer_created": "Customer user created",
  "demo.org_created": "Customer org created",
  "demo.membership_created": "Owner membership created",
  "demo.invite_sent": "Magic-link invite sent",
  "demo.invite_skipped": "Auth user already existed (re-used)",
  "demo.invite_failed": "Magic-link invite failed",
  "demo.onboarding_created": "Onboarding provisioned",
};

function prettyAction(action: string): string {
  if (LIFECYCLE_LABELS[action]) return LIFECYCLE_LABELS[action]!;
  if (action.startsWith("demo.move_")) {
    const s = action.slice("demo.move_".length);
    return `Moved → ${DEMO_STATUS_LABELS[s as DemoLifecycleStatus] ?? s}`;
  }
  if (action.startsWith("demo.contact_")) {
    return `Contacted by ${action.slice("demo.contact_".length)}`;
  }
  return action;
}

function renderMetadata(meta: Record<string, unknown>): string {
  // Just the most useful 2-3 keys, no JSON dump in the UI.
  const out: string[] = [];
  if (typeof meta.from === "string" && typeof meta.to === "string") {
    out.push(`${meta.from} → ${meta.to}`);
  }
  if (typeof meta.preview === "string") {
    out.push(`"${meta.preview}"`);
  }
  if (typeof meta.preferred_demo_time === "string") {
    out.push(meta.preferred_demo_time);
  }
  if (typeof meta.reason === "string" && meta.reason) {
    out.push(`Reason: ${meta.reason}`);
  }
  if (typeof meta.step === "string") {
    out.push(`Step: ${meta.step}`);
  }
  if (typeof meta.subject === "string") {
    out.push(`Subject: ${meta.subject.slice(0, 60)}`);
  }
  if (typeof meta.org_id === "string") {
    out.push(`Org: ${meta.org_id.slice(0, 8)}…`);
  }
  if (typeof meta.auth_user_id === "string") {
    out.push(`User: ${meta.auth_user_id.slice(0, 8)}…`);
  }
  return out.join(" · ");
}
