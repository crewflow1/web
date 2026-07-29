import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import {
  deleteComplianceDocument,
  getComplianceDocSignedUrl,
} from "../actions";

/**
 * /compliance/[id] — view a compliance document.
 *
 * Renders metadata + a signed download link to the file in
 * `compliance-docs`. The signed URL has a 60s expiry so it&rsquo;s safe
 * to embed.
 */

type DocRow = {
  id: string;
  kind: string;
  title: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  expires_at: string | null;
  reminded_30d_at: string | null;
  reminded_7d_at: string | null;
  reminded_today_at: string | null;
  notes: string | null;
  created_at: string;
};

export default async function ComplianceDocPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data: row, error: rowError } = await (
    supabase.from("compliance_documents" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{ data: DocRow | null; error: SupabaseReadError | null }>;
          };
        };
      };
    }
  )
    .select(
      "id, kind, title, filename, mime_type, size_bytes, expires_at, reminded_30d_at, reminded_7d_at, reminded_today_at, notes, created_at",
    )
    .eq("id", id)
    // ACTIVE-org pin — a certificate in a non-active org must be
    // indistinguishable from a missing one (the page notFound()s on null).
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (rowError) throw readFailure("compliance doc: detail", rowError);

  if (!row) notFound();

  const signedUrl = await getComplianceDocSignedUrl(id).catch(() => null);

  async function downloadAction() {
    "use server";
    const url = await getComplianceDocSignedUrl(id);
    if (url) redirect(url);
    redirect(`/compliance/${id}`);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/compliance" className="hover:text-slate-900">
          Compliance
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{row.title}</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">{row.title}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {row.kind} · uploaded {row.created_at.slice(0, 10)}
        </p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Filename
            </dt>
            <dd className="text-slate-900">{row.filename ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              File type
            </dt>
            <dd className="text-slate-900">{row.mime_type ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Size
            </dt>
            <dd className="text-slate-900">
              {row.size_bytes != null
                ? `${(row.size_bytes / 1024 / 1024).toFixed(2)} MB`
                : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Expires
            </dt>
            <dd className="text-slate-900">{row.expires_at ?? "No expiry"}</dd>
          </div>
        </dl>

        {row.notes ? (
          <p className="mt-4 whitespace-pre-wrap text-sm text-slate-700">
            {row.notes}
          </p>
        ) : null}

        {row.reminded_30d_at || row.reminded_7d_at || row.reminded_today_at ? (
          <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            <p className="font-medium text-slate-700">Reminder history</p>
            <ul className="mt-1 space-y-0.5">
              {row.reminded_30d_at ? (
                <li>30-day reminder sent {row.reminded_30d_at.slice(0, 10)}</li>
              ) : null}
              {row.reminded_7d_at ? (
                <li>7-day reminder sent {row.reminded_7d_at.slice(0, 10)}</li>
              ) : null}
              {row.reminded_today_at ? (
                <li>Day-of reminder sent {row.reminded_today_at.slice(0, 10)}</li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </section>

      <div className="flex flex-wrap gap-2">
        {signedUrl ? (
          <a
            href={signedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Open document
          </a>
        ) : (
          <form action={downloadAction}>
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Get download link
            </button>
          </form>
        )}
        <form action={deleteComplianceDocument.bind(null, id)}>
          <button
            type="submit"
            className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Delete
          </button>
        </form>
      </div>
    </div>
  );
}
