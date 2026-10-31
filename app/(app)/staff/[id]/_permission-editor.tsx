"use client";

import { useMemo, useState, useTransition } from "react";
import { CAP_ACTIONS, type CapAction, type CapModule } from "@/lib/auth/capability-rules";
import {
  ACTION_HINTS,
  ACTION_LABELS,
  MODULE_GROUPS,
  MODULE_LABELS,
} from "@/lib/auth/capability-labels";
import { setAdminPermissions } from "../permission-actions";

/**
 * Owner-facing admin permission editor (R3 UI).
 *
 * Renders the module × action grant matrix for ONE admin member and saves the
 * full set via setAdminPermissions (replace-all, owner-only, re-checked
 * server-side). `manage` broadens its module, so when it's on the other actions
 * render as implied (ticked + locked). Presentation only — the server action is
 * the authority; a tampered client still can't grant what the owner didn't save.
 */

const key = (m: string, a: string) => `${m}:${a}`;
const eq = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Collapse manage-superseded per-action grants: a module that has `manage` is
 * saved as manage ONLY; a module without it keeps its explicit per-action
 * grants. This keeps the SAVED set minimal and honest WITHOUT destroying the
 * editor's in-progress granular selection — so turning `manage` back off
 * restores the view/create/edit the owner had already ticked, instead of
 * silently wiping them.
 */
export function normalize(set: ReadonlySet<string>): Set<string> {
  const managed = new Set<string>();
  for (const k of set) {
    const [m = "", a = ""] = k.split(":");
    if (a === "manage") managed.add(m);
  }
  const out = new Set<string>();
  for (const k of set) {
    const [m = "", a = ""] = k.split(":");
    if (a === "manage" || !managed.has(m)) out.add(k);
  }
  return out;
}

export function PermissionEditor({
  targetUserId,
  targetLabel,
  initialGrants,
}: {
  targetUserId: string;
  targetLabel: string;
  initialGrants: ReadonlyArray<{ module: string; action: string }>;
}) {
  const initialSet = useMemo(
    () => normalize(new Set(initialGrants.map((g) => key(g.module, g.action)))),
    [initialGrants],
  );
  const [grants, setGrants] = useState<Set<string>>(() => new Set(initialSet));
  // The last successfully-saved (normalized) set — the baseline `dirty` compares
  // against, so after a save the editor settles to "no unsaved changes".
  const [savedSet, setSavedSet] = useState<Set<string>>(() => new Set(initialSet));
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<
    { ok: true } | { ok: false; error: string } | null
  >(null);

  // Compare EFFECTIVE (normalized) sets: ticking manage over granular picks is a
  // real change; toggling manage off to reveal the same picks again is not.
  const dirty = useMemo(() => !eq(normalize(grants), savedSet), [grants, savedSet]);

  const hasManage = (m: CapModule) => grants.has(key(m, "manage"));
  const isChecked = (m: CapModule, a: CapAction) =>
    a === "manage" ? hasManage(m) : hasManage(m) || grants.has(key(m, a));

  function toggle(m: CapModule, a: CapAction) {
    setResult(null);
    setGrants((prev) => {
      const next = new Set(prev);
      const k = key(m, a);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      // Non-destructive: turning `manage` on does NOT delete the per-action
      // grants (they render as implied + locked and are collapsed away at save
      // time by normalize()); turning `manage` off brings them back untouched.
      return next;
    });
  }

  function setModule(m: CapModule, on: boolean) {
    setResult(null);
    setGrants((prev) => {
      const next = new Set(prev);
      if (on) {
        // "All" → grant full control; keep any granular picks so unchecking
        // manage later restores them (same non-destructive contract as toggle).
        next.add(key(m, "manage"));
      } else {
        // "Clear" → remove every grant for this row (the explicit clear action).
        for (const a of CAP_ACTIONS) next.delete(key(m, a));
      }
      return next;
    });
  }

  function revokeAll() {
    setResult(null);
    setGrants(new Set());
  }

  function save() {
    setResult(null);
    // Save the EFFECTIVE set: manage collapses its row to manage-only.
    const effective = normalize(grants);
    const payload = Array.from(effective).map((g) => {
      const [module = "", action = ""] = g.split(":");
      return { module, action };
    });
    startTransition(async () => {
      const res = await setAdminPermissions(targetUserId, payload);
      setResult(res);
      if (res.ok) setSavedSet(effective); // settle the dirty baseline
    });
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Admin permissions</h2>
          <p className="mt-1 max-w-prose text-sm text-slate-600">
            Choose exactly what {targetLabel} can do. Nothing is allowed until you
            grant it. <strong>Manage</strong> gives full control of an area
            (everything else in that row). Changes take effect immediately after
            you save.
          </p>
        </div>
        <button
          type="button"
          onClick={revokeAll}
          disabled={pending || grants.size === 0}
          className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          Revoke all
        </button>
      </div>

      <div className="mt-4 space-y-5">
        {MODULE_GROUPS.map((group) => (
          <div key={group.label}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {group.label}
            </h3>
            <div className="mt-2 overflow-x-auto">
              <table className="min-w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th className="w-48 py-1 pr-3 font-medium">Area</th>
                    {CAP_ACTIONS.map((a) => (
                      <th key={a} className="px-2 py-1 text-center font-medium" title={ACTION_HINTS[a]}>
                        {ACTION_LABELS[a]}
                      </th>
                    ))}
                    <th className="px-2 py-1 text-right font-medium">Row</th>
                  </tr>
                </thead>
                <tbody>
                  {group.modules.map((m) => {
                    const manage = hasManage(m);
                    return (
                      <tr key={m} className="border-t border-slate-100">
                        <td className="py-1.5 pr-3 font-medium text-slate-800">{MODULE_LABELS[m]}</td>
                        {CAP_ACTIONS.map((a) => {
                          const implied = a !== "manage" && manage;
                          return (
                            <td key={a} className="px-2 py-1.5 text-center">
                              <input
                                type="checkbox"
                                aria-label={`${MODULE_LABELS[m]} — ${ACTION_LABELS[a]}`}
                                checked={isChecked(m, a)}
                                disabled={pending || implied}
                                onChange={() => toggle(m, a)}
                                className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400 disabled:opacity-50"
                              />
                            </td>
                          );
                        })}
                        <td className="px-2 py-1.5 text-right">
                          <button
                            type="button"
                            onClick={() => setModule(m, !manage)}
                            disabled={pending}
                            className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                          >
                            {manage ? "Clear" : "All"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
        >
          {pending ? "Saving…" : "Save permissions"}
        </button>
        {!dirty && !result ? (
          <span className="text-sm text-slate-400">No unsaved changes</span>
        ) : null}
        {result?.ok ? (
          <span role="status" className="text-sm font-medium text-green-700">
            Permissions saved.
          </span>
        ) : null}
        {result && !result.ok ? (
          <span role="alert" className="text-sm font-medium text-red-700">
            {result.error === "forbidden"
              ? "Only the owner can change admin permissions."
              : result.error === "not_an_admin"
                ? "This person isn't an admin."
                : "Couldn't save permissions. Try again."}
          </span>
        ) : null}
      </div>
    </section>
  );
}
