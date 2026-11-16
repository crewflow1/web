import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { readOrgAiEnabled } from "@/lib/ai/org-switch";
import { setAiEnabledAction } from "./actions";

/**
 * Settings → AI features. Owners switch ALL AI features off (or back on) for the
 * company. When off, no AI provider request is made for this company: the
 * refusal is enforced server-side at the AI reservation, not in this page.
 */
export default async function AiFeaturesSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();
  const enabled = await readOrgAiEnabled(supabase, ctx.org.id);
  const isOwner = ctx.membership.role === "owner";

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-8">
      <div>
        <Link href="/settings" className="text-sm text-slate-500 hover:text-slate-700">
          Settings
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">AI features</h1>
        <p className="mt-1 text-sm text-slate-600">
          Turn all AI features off for {ctx.org.name}: AI quote drafts, summaries,
          reply drafts, voice-note transcription, document reading and search
          assist. While off, nothing from your company is sent to an AI provider.
          Everything else in CrewFlow keeps working, without AI assistance.
        </p>
      </div>

      {sp.saved ? (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Saved.
        </p>
      ) : null}
      {sp.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {sp.error === "owner"
            ? "Only a company owner can change this setting."
            : "Couldn't save the setting. Try again."}
        </p>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <p className="text-sm font-medium text-slate-900">
          {enabled === null
            ? "AI status could not be loaded."
            : enabled
              ? "AI features are ON."
              : "AI features are OFF for your company."}
        </p>
        {isOwner && enabled !== null ? (
          <form action={setAiEnabledAction} className="mt-3">
            <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              {enabled ? "Turn AI features off" : "Turn AI features on"}
            </button>
          </form>
        ) : (
          <p className="mt-3 text-sm text-slate-600">
            Only a company owner can change this setting.
          </p>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Every change is recorded in an audit log with who made it and when.
        </p>
      </section>
    </div>
  );
}
