"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resendStaffInvite } from "./actions";
import type { PendingInvite } from "./_invites";

const ROLE_STYLES: Record<string, string> = {
  owner: "bg-purple-100 text-purple-800",
  admin: "bg-blue-100 text-blue-800",
  staff: "bg-slate-100 text-slate-700",
};

/**
 * Pending-invite list (H2). Invited teammates who haven't accepted yet —
 * surfaced so the directory reflects the full team. They have no account
 * yet, so they can't be assigned to shifts/jobs/leads until they accept;
 * the helper text makes that explicit. Admins can re-send the email.
 */
export function PendingInvites({ invites }: { invites: PendingInvite[] }) {
  if (invites.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-xl border border-amber-200 bg-white shadow-sm">
      <div className="border-b border-amber-200 bg-amber-50 px-6 py-3">
        <h2 className="text-sm font-semibold text-amber-900">
          Pending invites ({invites.length})
        </h2>
        <p className="mt-0.5 text-xs text-amber-800">
          These teammates have been emailed a magic link but haven&apos;t
          finished setting up yet. They can&apos;t be assigned to shifts, jobs,
          or leads until they accept.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-6 py-2">Name</th>
              <th className="px-6 py-2">Email</th>
              <th className="px-6 py-2">Role</th>
              <th className="px-6 py-2">Status</th>
              <th className="px-6 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {invites.map((inv) => (
              <InviteRow key={inv.email} invite={inv} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function InviteRow({ invite }: { invite: PendingInvite }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function onResend() {
    setMsg(null);
    startTransition(async () => {
      const result = await resendStaffInvite(invite.email);
      if (result.ok) {
        setMsg({ ok: true, text: "Sent ✓" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: result.error });
      }
    });
  }

  return (
    <tr>
      <td className="px-6 py-2 text-slate-900">{invite.full_name ?? "—"}</td>
      <td className="px-6 py-2 text-slate-600">{invite.email}</td>
      <td className="px-6 py-2">
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
            ROLE_STYLES[invite.role] ?? ROLE_STYLES.staff
          }`}
        >
          {invite.role}
        </span>
      </td>
      <td className="px-6 py-2">
        <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
          Pending
        </span>
      </td>
      <td className="px-6 py-2 text-right">
        <div className="flex items-center justify-end gap-2">
          {msg ? (
            <span
              className={`text-[11px] ${msg.ok ? "text-green-700" : "text-red-700"}`}
            >
              {msg.text}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onResend}
            disabled={pending}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {pending ? "Sending…" : "Resend invite"}
          </button>
        </div>
      </td>
    </tr>
  );
}
