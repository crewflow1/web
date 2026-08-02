import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { voiceInboundFeatureEnabled } from "@/lib/telephony/config";

/**
 * Customer-facing VOICE status (Wave 8) — READ-ONLY.
 *
 * Shows whether inbound voice is live and, if so, the org's routed number. Reads
 * on the RLS client (member SELECT), so it can only ever see the org's own rows,
 * and it NEVER reads provider_auth_secret (the column grant excludes it from the
 * authenticated surface anyway). Provisioning is HQ-side (admin-write); this
 * surface only reflects state.
 *
 * DARK-AWARE: renders "not configured" when the feature flag is off.
 */

type NumberRow = { e164: string; provider: string; active: boolean };

export async function VoiceStatus({ orgId }: { orgId: string }) {
  const enabled = voiceInboundFeatureEnabled();
  const supabase = await createClient();

  const { data, error } = await (
    supabase.from("phone_numbers" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          order: (
            c: string,
            o: { ascending: boolean },
          ) => Promise<{ data: NumberRow[] | null; error: SupabaseReadError | null }>;
        };
      };
    }
  )
    .select("e164, provider, active")
    .eq("org_id", orgId)
    .order("active", { ascending: false });
  // Loud: a failed read must not render as a healthy "not configured" state.
  if (error) throw readFailure("ai receptionist settings: voice numbers", error);
  const numbers = data ?? [];
  const active = numbers.filter((n) => n.active);

  return (
    <section className="rounded-md border border-slate-200 bg-white p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-900">Voice line</h2>
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
            enabled && active.length > 0
              ? "bg-emerald-100 text-emerald-800"
              : "bg-slate-100 text-slate-600"
          }`}
        >
          {!enabled ? "Not configured" : active.length > 0 ? "Live" : "Pending"}
        </span>
      </div>

      {!enabled ? (
        <p className="mt-2 text-xs text-slate-600">
          Inbound voice answering is not yet switched on for your account. Our team enables it as
          part of your white-glove setup.
        </p>
      ) : active.length > 0 ? (
        <p className="mt-2 text-xs text-slate-600">
          Calls to{" "}
          {active.map((n, i) => (
            <span key={n.e164}>
              <span className="font-mono text-slate-900">{n.e164}</span>
              {i < active.length - 1 ? ", " : ""}
            </span>
          ))}{" "}
          are answered by your AI receptionist.
        </p>
      ) : (
        <p className="mt-2 text-xs text-slate-600">
          Your voice line is being provisioned. It will go live once our team finishes routing your
          number.
        </p>
      )}
    </section>
  );
}
