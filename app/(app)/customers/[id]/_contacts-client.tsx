"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CONTACT_ROLES,
  CONTACT_ROLE_LABELS,
  type ContactRole,
} from "@/lib/customers/contacts";
import {
  addCustomerContact,
  updateCustomerContact,
  deleteCustomerContact,
  setPrimaryCustomerContact,
} from "../_contact-actions";

/**
 * Staff customer-contacts panel. Add / edit / delete / set-primary run through
 * the server actions inside a transition, then router.refresh() reconciles — no
 * redirect()/router.push, so the deep-swap commit race never applies (mirrors
 * the job checklist client). The server owns validation, org-pinning and RLS.
 */

export type StaffContact = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: ContactRole;
  notes: string | null;
};

const emptyDraft = { name: "", email: "", phone: "", role: "other", notes: "" };
type Draft = typeof emptyDraft;

function toFormData(d: Draft): FormData {
  const fd = new FormData();
  fd.set("name", d.name);
  fd.set("email", d.email);
  fd.set("phone", d.phone);
  fd.set("role", d.role);
  fd.set("notes", d.notes);
  return fd;
}

export function CustomerContactsClient({
  customerId,
  initialContacts,
}: {
  customerId: string;
  initialContacts: StaffContact[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();
  const [adding, setAdding] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);

  function reconcile() {
    startTransition(() => router.refresh());
  }

  async function onAdd() {
    if (adding.name.trim().length < 2) {
      setError("Enter the contact's name (2+ characters).");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await addCustomerContact(customerId, toFormData(adding));
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't add the contact.");
      return;
    }
    setAdding(emptyDraft);
    reconcile();
  }

  function beginEdit(c: StaffContact) {
    setEditingId(c.id);
    setEditDraft({
      name: c.name,
      email: c.email ?? "",
      phone: c.phone ?? "",
      role: c.role,
      notes: c.notes ?? "",
    });
    setError(null);
  }

  async function onSaveEdit(id: string) {
    setBusy(true);
    setError(null);
    const res = await updateCustomerContact(id, toFormData(editDraft));
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't save the contact.");
      return;
    }
    setEditingId(null);
    reconcile();
  }

  async function onDelete(id: string) {
    setBusy(true);
    setError(null);
    const res = await deleteCustomerContact(id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't remove the contact.");
      return;
    }
    reconcile();
  }

  async function onSetPrimary(id: string) {
    setBusy(true);
    setError(null);
    const res = await setPrimaryCustomerContact(customerId, id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't set the primary contact.");
      return;
    }
    reconcile();
  }

  return (
    <section
      id="contacts"
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <header className="border-b border-slate-200 px-6 py-3">
        <h2 className="text-base font-semibold text-slate-900">Contacts</h2>
        <p className="text-xs text-slate-500">
          The people at this customer — a spouse, a site manager, an accounts
          contact. Mark one as the primary.
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          className="mx-6 mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      ) : null}

      {initialContacts.length === 0 ? (
        <p className="px-6 py-4 text-sm text-slate-500">
          No named contacts yet. Add one below.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {initialContacts.map((c) =>
            editingId === c.id ? (
              <li key={c.id} className="px-6 py-4">
                <ContactFields draft={editDraft} onChange={setEditDraft} />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onSaveEdit(c.id)}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                </div>
              </li>
            ) : (
              <li
                key={c.id}
                className="flex flex-wrap items-start justify-between gap-3 px-6 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900">{c.name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        c.role === "primary"
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {CONTACT_ROLE_LABELS[c.role]}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {c.email ? (
                      <a href={`mailto:${c.email}`} className="hover:text-slate-900">
                        {c.email}
                      </a>
                    ) : null}
                    {c.email && c.phone ? " · " : ""}
                    {c.phone ? (
                      <a href={`tel:${c.phone}`} className="hover:text-slate-900">
                        {c.phone}
                      </a>
                    ) : null}
                  </div>
                  {c.notes ? (
                    <p className="mt-1 text-xs text-slate-500">{c.notes}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {c.role !== "primary" ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onSetPrimary(c.id)}
                      className="text-xs font-medium text-slate-500 hover:text-emerald-700 disabled:opacity-50"
                    >
                      Set primary
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => beginEdit(c)}
                    className="text-xs font-medium text-slate-500 hover:text-slate-900"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onDelete(c.id)}
                    className="text-xs font-medium text-slate-400 hover:text-red-600 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      <div className="border-t border-slate-100 px-6 py-4">
        <h3 className="text-sm font-semibold text-slate-900">Add a contact</h3>
        <div className="mt-2">
          <ContactFields draft={adding} onChange={setAdding} />
        </div>
        <button
          type="button"
          disabled={busy || adding.name.trim().length < 2}
          onClick={() => void onAdd()}
          className="mt-2 h-10 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Add contact
        </button>
      </div>
    </section>
  );
}

function ContactFields({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <input
        type="text"
        value={draft.name}
        maxLength={200}
        onChange={(e) => onChange({ ...draft, name: e.target.value })}
        placeholder="Name"
        aria-label="Contact name"
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <select
        value={draft.role}
        onChange={(e) => onChange({ ...draft, role: e.target.value })}
        aria-label="Contact role"
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
      >
        {CONTACT_ROLES.map((r) => (
          <option key={r} value={r}>
            {CONTACT_ROLE_LABELS[r]}
          </option>
        ))}
      </select>
      <input
        type="email"
        value={draft.email}
        maxLength={320}
        onChange={(e) => onChange({ ...draft, email: e.target.value })}
        placeholder="Email"
        aria-label="Contact email"
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <input
        type="tel"
        value={draft.phone}
        maxLength={50}
        onChange={(e) => onChange({ ...draft, phone: e.target.value })}
        placeholder="Phone"
        aria-label="Contact phone"
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <input
        type="text"
        value={draft.notes}
        maxLength={2000}
        onChange={(e) => onChange({ ...draft, notes: e.target.value })}
        placeholder="Notes (optional)"
        aria-label="Contact notes"
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm sm:col-span-2"
      />
    </div>
  );
}
