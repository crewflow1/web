"use client";

import { useState } from "react";

/**
 * GDPR erasure — the OWNER-ONLY, type-to-confirm launcher for the live
 * POST /api/gdpr/erase route. Rendered ONLY when the deployment flag
 * (FEATURE_GDPR_ERASURE) is on AND the viewer is the organisation owner —
 * the page decides that server-side; while the capability is dark the page
 * renders a contact-support panel instead of this component.
 *
 * The confirmation token is the route's REAL contract: the body's `confirm`
 * must equal the organisation slug (the route refuses anything else, and the
 * DB primitive re-verifies it). So the type-to-confirm here asks for exactly
 * that — no decorative "type ERASE" that the API would ignore. Two further
 * frictions on top: an explicit consequences checkbox, and the button stays
 * disabled until both are satisfied. There is no accidental-erase path.
 */
export function GdprEraseForm({ orgSlug }: { orgSlug: string }) {
  const [typed, setTyped] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<
    | { kind: "done"; deletedRows: number; anonymisedRows: number; storageObjectsDeleted: number }
    | { kind: "error"; message: string }
    | null
  >(null);

  const armed = typed === orgSlug && acknowledged && !busy;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!armed) return;
    setBusy(true);
    setOutcome(null);
    try {
      const res = await fetch("/api/gdpr/erase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setOutcome({
          kind: "error",
          message:
            typeof body.error === "string" ? body.error : `Erasure failed (HTTP ${res.status}).`,
        });
      } else {
        setOutcome({
          kind: "done",
          deletedRows: Number(body.deletedRows ?? 0),
          anonymisedRows: Number(body.anonymisedRows ?? 0),
          storageObjectsDeleted: Number(body.storageObjectsDeleted ?? 0),
        });
      }
    } catch {
      setOutcome({ kind: "error", message: "Network error — nothing may have been erased. Try again." });
    } finally {
      setBusy(false);
    }
  }

  if (outcome?.kind === "done") {
    return (
      <div className="rounded-md border border-slate-300 bg-slate-50 px-3 py-3 text-sm text-slate-700">
        <p className="font-semibold text-slate-900">Erasure complete.</p>
        <p className="mt-1 text-xs">
          {outcome.deletedRows.toLocaleString()} rows deleted ·{" "}
          {outcome.anonymisedRows.toLocaleString()} statutory rows anonymised in place ·{" "}
          {outcome.storageObjectsDeleted.toLocaleString()} stored files removed. The action has been
          recorded in the erasure log.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          I understand this <strong>permanently erases</strong> this organisation&apos;s personal
          data: statutory financial/tax/payroll records are anonymised in place, everything else is
          hard-deleted, and all stored files are removed. This cannot be undone.
        </span>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">
          Type your organisation slug (<code className="text-slate-800">{orgSlug}</code>) to confirm
        </span>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={orgSlug}
          className="w-full max-w-sm rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-red-400 focus:ring-2 focus:ring-red-200"
        />
      </label>

      {outcome?.kind === "error" ? (
        <p role="alert" className="text-xs text-red-700">
          {outcome.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={!armed}
        className="rounded-md border border-red-300 bg-red-600 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-red-700 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
      >
        {busy ? "Erasing…" : "Permanently erase this organisation's data"}
      </button>
    </form>
  );
}
